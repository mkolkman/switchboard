// --- Help Scout tab: the support inbox, worked from Switchboard ---
// The sidebar groups the conversations the way Help Scout's folders do
// (Unassigned, Mine, Assigned, Closed, Spam), plus the suggestions the
// customer-support skill saved to log later. The main area is one
// conversation: its threads, its status and assignee, a note, and your
// draft reply. A reply is only ever a draft; "Send in Help Scout" opens the
// conversation there, because the API cannot publish a draft. Main does the
// API calls (helpscout.js).
// Depends on: utils.js (escapeHtml, formatDate), projects-view.js (PICONS,
// showContextMenu), dialogs.js (resolveDefaultSessionOptions), app.js
// (launchNewSession, openSession, encodeProjectPath), project-github-view.js
// (prSessionRowInner, refreshPrLastMessage, prSessionLabels, currentSession).

const helpscoutViewContent = document.getElementById('helpscout-content');
const helpscoutViewer = document.getElementById('helpscout-viewer');
const HELPSCOUT_VIEW_REFRESH_MS = 2 * 60 * 1000;
const HELPSCOUT_GROUPS = [
  { id: 'unassigned', label: 'Unassigned', hint: 'Open conversations nobody has' },
  { id: 'mine', label: 'Mine', hint: 'Open conversations assigned to you' },
  { id: 'assigned', label: 'Assigned', hint: 'Open conversations assigned to someone else' },
  { id: 'closed', label: 'Closed', hint: 'The most recently closed conversations' },
  { id: 'spam', label: 'Spam', hint: 'The most recent spam' },
];
const HELPSCOUT_STATUSES = ['active', 'pending', 'closed', 'spam'];
// The skill that logs each kind of suggestion; the rest go back to customer-support.
const HELPSCOUT_LOG_SKILLS = {
  faq: '/movelab-claude-skills:log-nohrd-faq',
  feature: '/movelab-claude-skills:log-feature-request',
  incident: '/movelab-claude-skills:log-machine-incident',
};
const HELPSCOUT_SUPPORT_SKILL = '/movelab-claude-skills:customer-support';

const helpscoutViewState = {
  inbox: null, error: null, loading: false, timer: null,
  mailbox: null, // a mailbox id to show only that one, or null for all
  collapsed: new Set(['closed', 'spam']),
  selectedId: null, conversation: null, convError: null, convLoading: false,
  composer: 'reply', busy: null, notice: null,
  scrolledTo: null, // the conversation last scrolled to its end, on opening it
  splitSession: null, // the session shown beside the ticket
  splitHiddenFor: null, // a ticket whose session was hidden by hand
};

const hsvAttr = (value) => escapeHtml(value).replace(/"/g, '&quot;');

/** "3h", "2d": how long ago, short, for the list. */
function helpscoutAgo(iso) {
  if (!iso) return '';
  const mins = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
  if (mins < 60) return `${mins}m`;
  if (mins < 48 * 60) return `${Math.round(mins / 60)}h`;
  return `${Math.round(mins / 1440)}d`;
}

/** Thread text with its links clickable; everything else escaped. */
function helpscoutLinkify(text) {
  return escapeHtml(text).replace(/https?:\/\/[^\s<>"]+[^\s<>".,;:!?)]/g, url => `<a class="hsv-link" href="${url}">${url}</a>`);
}

async function loadHelpscoutView({ quiet = false } = {}) {
  if (helpscoutViewState.loading) return;
  helpscoutViewState.loading = true;
  if (!quiet) renderHelpscoutViewList();
  const result = await window.api.getHelpscoutInbox().catch(err => ({ error: err?.message || String(err) }));
  helpscoutViewState.loading = false;
  if (result?.error) helpscoutViewState.error = result.error;
  else { helpscoutViewState.error = null; helpscoutViewState.inbox = result; }
  renderHelpscoutViewList();
}

async function openHelpscoutConversation(id, { quiet = false } = {}) {
  const s = helpscoutViewState;
  if (s.selectedId !== id) { s.conversation = null; s.notice = null; s.composer = 'reply'; }
  s.selectedId = id;
  s.convLoading = true;
  renderHelpscoutViewList();
  if (!quiet) renderHelpscoutViewMain();
  const result = await window.api.getHelpscoutConversation(id).catch(err => ({ error: err?.message || String(err) }));
  if (s.selectedId !== id) return;
  s.convLoading = false;
  if (result?.error) s.convError = result.error;
  else { s.convError = null; s.conversation = result; }
  renderHelpscoutViewMain();
  // The ticket's own session comes along; another ticket's goes.
  if (!quiet || !s.splitSession) showHelpscoutTicketSession(id);
}

/** Run a write, then read the conversation and the list again. */
async function helpscoutViewWrite(label, call, done) {
  const s = helpscoutViewState;
  s.busy = label;
  s.notice = null;
  renderHelpscoutViewMain();
  const result = await call().catch(err => ({ error: err?.message || String(err) }));
  s.busy = null;
  s.notice = result?.error ? { bad: true, text: result.error } : { text: done };
  if (s.selectedId) await openHelpscoutConversation(s.selectedId, { quiet: true });
  loadHelpscoutView({ quiet: true });
  return !result?.error;
}

// --- Sessions ---

// --- Sessions on a ticket ---
// A session started from a ticket (its Claude session, or logging one of its
// suggestions) stays linked to it: the ticket lists it with its state and last
// step (the PR panel's rows, project-github-view.js), the session header links
// back to the ticket, and when the session closes the ticket comes back.

const HELPSCOUT_SESSIONS_KEY = 'helpscoutSessionLinks';
const HELPSCOUT_SESSIONS_KEEP = 300;
const helpscoutSessionLinks = new Map(); // sessionId → { conversation, number, subject }
let helpscoutSessionTicker = null;

window.api.getSetting(HELPSCOUT_SESSIONS_KEY).then((saved) => {
  for (const [id, link] of Object.entries(saved || {})) helpscoutSessionLinks.set(id, link);
}).catch(() => {});

function linkHelpscoutSession(sessionId, conv) {
  helpscoutSessionLinks.delete(sessionId);
  helpscoutSessionLinks.set(sessionId, { conversation: conv.id, number: conv.number, subject: conv.subject });
  const kept = [...helpscoutSessionLinks].slice(-HELPSCOUT_SESSIONS_KEEP);
  window.api.setSetting(HELPSCOUT_SESSIONS_KEY, Object.fromEntries(kept)).catch(() => {});
}

/** The ticket a session works on, or null. */
function helpscoutLinkFor(sessionId) {
  return helpscoutSessionLinks.get(sessionId) || null;
}

/** A ticket's sessions that still exist, newest first. */
function helpscoutSessionIds(conversationId) {
  return [...helpscoutSessionLinks].filter(([, link]) => link.conversation === conversationId).map(([id]) => id)
    .filter(id => openSessions.has(id) || sessionMap.has(id)).reverse();
}

/** Show a ticket in the Help Scout tab, from anywhere. */
function openHelpscoutTicket(conversationId) {
  const tab = document.querySelector('.sidebar-tab[data-tab="helpscout"]');
  if (tab && activeTab !== 'helpscout') tab.click();
  // Already the tab, with a session drawn over it: put the ticket back.
  else showHelpscoutView();
  openHelpscoutConversation(conversationId);
}

/** A linked session closed while on screen: show its ticket again. */
function returnToHelpscoutTicket(sessionId) {
  const link = helpscoutLinkFor(sessionId);
  if (link && (activeTab === 'sessions' || activeTab === 'helpscout')) openHelpscoutTicket(link.conversation);
}

async function helpscoutViewSession(conv, prompt, label) {
  const folder = await window.api.getChatFolder();
  if (!folder || folder.error) { alert(`Could not create the chat folder: ${folder?.error || 'unknown error'}`); return; }
  const target = { folder: encodeProjectPath(folder), projectPath: folder, sessions: [] };
  const options = await resolveDefaultSessionOptions(target);
  options.runtime = 'claude';
  options.initialPrompt = prompt;
  delete options.worktree;
  delete options.worktreeName;
  // Started from the Help Scout tab it opens beside the ticket (onHelpscoutSessionShown).
  const sessionId = await launchNewSession(target, options, { focus: true });
  if (!sessionId) return;
  linkHelpscoutSession(sessionId, conv);
  prSessionLabels.set(sessionId, label);
  if (typeof updateTerminalHeaderTicket === 'function') updateTerminalHeaderTicket();
  if (activeTab === 'helpscout' && helpscoutViewState.selectedId === conv.id) renderHelpscoutViewMain();
}

function helpscoutSupportSession(conv) {
  helpscoutViewSession(conv, `${HELPSCOUT_SUPPORT_SKILL} Help Scout ticket #${conv.number}: ${conv.url}`, `Support on #${conv.number}`);
}

function helpscoutLogSession(sug) {
  const skill = HELPSCOUT_LOG_SKILLS[sug.kind];
  const close = `When it is logged, mark suggestion ${sug.id} as logged with the customer-support skill's helpscout_api.py: \`close ${sug.id}\`.`;
  helpscoutViewSession({ id: sug.conversation, number: sug.number, subject: sug.subject }, skill
    ? `${skill} ${sug.text}\n\nFrom Help Scout ticket #${sug.number} (${sug.url}). ${close}`
    : `${HELPSCOUT_SUPPORT_SKILL} Log this saved ${sug.kind} suggestion from Help Scout ticket #${sug.number} (${sug.url}):\n\n${sug.text}\n\n${close}`, `Logging the ${sug.kind} from #${sug.number}`);
}

function helpscoutSessionsSection(conv) {
  const ids = helpscoutSessionIds(conv.id);
  if (!ids.length) return '';
  const shown = mainEl.classList.contains('hsv-split') && ids.includes(helpscoutViewState.splitSession);
  const hide = shown ? '<span class="ws-flex"></span><button type="button" class="ws-ghost ws-ghost--sm" id="hsv-hide-session" title="Show the ticket alone; Open on a session brings it back">Hide session</button>' : '';
  return `<div class="gh-sec gh-sessions hsv-sessions"><div class="gh-sec-h">Claude on this ticket${hide}</div>${ids.map(id =>
    `<div class="gh-sess-row" data-session="${hsvAttr(id)}">${prSessionRowInner(id)}</div>`).join('')}</div>`;
}

function bindHelpscoutSessionRow(row) {
  row.querySelector('[data-act="open"]').onclick = () => {
    const session = currentSession(row.dataset.session);
    if (session) openSession(session);
  };
}

// --- A ticket's Claude session beside it ---
// In this tab a shown session sits on the right of the ticket instead of
// covering it: showSession hides every viewer, then calls this to put the
// ticket back on the left.

function onHelpscoutSessionShown(sessionId) {
  if (activeTab !== 'helpscout' || gridViewActive) return;
  helpscoutViewState.splitSession = sessionId;
  helpscoutViewState.splitHiddenFor = null;
  mainEl.classList.add('hsv-split');
  helpscoutViewer.style.display = 'flex';
  placeholder.style.display = 'none';
  terminalArea.style.display = '';
  // Its Hide button and row state follow the split.
  if (helpscoutViewState.conversation) renderHelpscoutViewMain();
  requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
}

function leaveHelpscoutSplit() {
  helpscoutViewState.splitSession = null;
  if (!mainEl.classList.contains('hsv-split')) return;
  mainEl.classList.remove('hsv-split');
  if (activeTab === 'helpscout') terminalArea.style.display = 'none';
}

/** A ticket's newest running session beside it, or the ticket alone (also after Hide). */
function showHelpscoutTicketSession(conversationId) {
  const id = helpscoutViewState.splitHiddenFor === conversationId ? null
    : helpscoutSessionIds(conversationId).find(sid => openSessions.has(sid) && !openSessions.get(sid).closed);
  if (id) showSession(id);
  else leaveHelpscoutSplit();
}

// Every 3 s while a ticket with sessions is on screen: redraw just its rows.
function tickHelpscoutSessions() {
  clearInterval(helpscoutSessionTicker);
  helpscoutSessionTicker = setInterval(async () => {
    const rows = helpscoutViewer.querySelectorAll('.hsv-sessions .gh-sess-row');
    if (activeTab !== 'helpscout' || !rows.length) { clearInterval(helpscoutSessionTicker); helpscoutSessionTicker = null; return; }
    for (const row of rows) {
      await refreshPrLastMessage(row.dataset.session);
      const html = prSessionRowInner(row.dataset.session);
      if (row.innerHTML !== html) { row.innerHTML = html; bindHelpscoutSessionRow(row); }
    }
  }, 3000);
}

async function helpscoutSetSuggestion(sid, status) {
  const result = await window.api.setHelpscoutSuggestion(sid, status).catch(err => ({ error: err?.message || String(err) }));
  if (result?.error) { alert(result.error); return; }
  const s = helpscoutViewState;
  if (s.inbox) s.inbox.suggestions = result.suggestions;
  if (s.conversation) s.conversation.suggestions = result.suggestions.filter(x => x.conversation === s.conversation.id);
  renderHelpscoutViewList();
  renderHelpscoutViewMain();
}

// --- Sidebar ---

function helpscoutViewRow(c, selectedId) {
  const who = c.group === 'assigned' && c.assignee ? c.assignee.name : c.customer.name || c.customer.email;
  const ago = helpscoutAgo(c.group === 'closed' || c.group === 'spam' ? c.updatedAt : c.waitingSince || c.updatedAt);
  return `<div class="ghv-row${c.id === selectedId ? ' selected' : ''}" data-conv="${c.id}" title="${hsvAttr(`#${c.number} ${c.subject}\n${c.preview}`)}">
      <div class="ghv-row-title">${escapeHtml(c.subject)}</div>
      <div class="ghv-row-meta"><span class="ghv-row-ref">#${c.number}</span><span class="ghv-row-author">${escapeHtml(who)}</span>
        ${c.status === 'pending' ? '<span class="hsv-pending">pending</span>' : ''}<span class="ws-flex"></span><span class="gh-muted">${escapeHtml(ago)}</span></div>
    </div>`;
}

function helpscoutSuggestionRow(sug) {
  return `<div class="ghv-row hsv-sug-row" data-sug-conv="${hsvAttr(sug.conversation)}" title="${hsvAttr(sug.text)}">
      <div class="ghv-row-title">${escapeHtml(sug.text.split('\n')[0])}</div>
      <div class="ghv-row-meta"><span class="hsv-kind hsv-kind--${hsvAttr(sug.kind)}">${escapeHtml(sug.kind)}</span><span class="ghv-row-ref">#${sug.number}</span></div>
    </div>`;
}

function renderHelpscoutViewList() {
  if (!helpscoutViewContent) return;
  const s = helpscoutViewState;
  const inbox = s.inbox;
  const status = s.loading ? 'Loading…' : inbox?.fetchedAt ? `Updated ${escapeHtml(formatDate(new Date(inbox.fetchedAt)))}` : '';
  const convs = (inbox?.conversations || []).filter(c => !s.mailbox || c.mailboxId === s.mailbox);
  const groups = HELPSCOUT_GROUPS.map(g => {
    const items = convs.filter(c => c.group === g.id);
    const open = !s.collapsed.has(g.id);
    return `<div class="ghv-section"><div class="ghv-section-h hsv-group-h" data-group="${g.id}" title="${hsvAttr(g.hint)}"><span class="hsv-arrow${open ? '' : ' shut'}">${PICONS.chevronDown(9)}</span>${escapeHtml(g.label)}<span class="ghv-count">${items.length}</span></div>
      ${open ? (items.length ? items.map(c => helpscoutViewRow(c, s.selectedId)).join('') : '<div class="ghv-empty">Nothing here.</div>') : ''}</div>`;
  }).join('');
  const toLog = (inbox?.suggestions || []).filter(x => x.status === 'open');
  const mailboxes = inbox?.mailboxes || [];
  helpscoutViewContent.innerHTML = `
    <div class="ghv-head"><span class="ghv-head-title">Help Scout</span><span class="ws-flex"></span>
      <span class="gh-muted">${status}</span>
      <button type="button" class="ws-ghost ws-ghost--sm" id="hsv-refresh" title="Read Help Scout again">${PICONS.refresh(12)}</button></div>
    ${mailboxes.length > 1 ? `<div class="hsv-mailboxes">${[{ id: null, name: 'All' }, ...mailboxes].map(m => `<button type="button" class="ws-ghost ws-ghost--sm${s.mailbox === m.id ? ' active' : ''}" data-mailbox="${m.id ?? ''}">${escapeHtml(m.name)}</button>`).join('')}</div>` : ''}
    ${s.error ? `<div class="ghv-empty gh-error">${escapeHtml(s.error)}</div>` : ''}
    ${groups}
    ${toLog.length ? `<div class="ghv-section"><div class="ghv-section-h" title="Suggestions the customer-support skill saved to log later">To log<span class="ghv-count">${toLog.length}</span></div>${toLog.map(helpscoutSuggestionRow).join('')}</div>` : ''}`;
  helpscoutViewContent.querySelector('#hsv-refresh').onclick = () => loadHelpscoutView();
  helpscoutViewContent.querySelectorAll('[data-mailbox]').forEach(btn => {
    btn.onclick = () => { s.mailbox = btn.dataset.mailbox ? Number(btn.dataset.mailbox) : null; renderHelpscoutViewList(); };
  });
  helpscoutViewContent.querySelectorAll('.hsv-group-h').forEach(h => {
    h.onclick = () => { const id = h.dataset.group; if (s.collapsed.has(id)) s.collapsed.delete(id); else s.collapsed.add(id); renderHelpscoutViewList(); };
  });
  helpscoutViewContent.querySelectorAll('[data-conv]').forEach(row => { row.onclick = () => openHelpscoutConversation(Number(row.dataset.conv)); });
  helpscoutViewContent.querySelectorAll('[data-sug-conv]').forEach(row => { row.onclick = () => openHelpscoutConversation(Number(row.dataset.sugConv)); });
  if (typeof renderSidebarRail === 'function') renderSidebarRail();
}

// --- One conversation ---

const HELPSCOUT_THREAD_LABELS = { customer: 'Customer', message: 'Reply', reply: 'Reply', note: 'Note', forwardparent: 'Forwarded', forwardchild: 'Forward', chat: 'Chat', phone: 'Phone' };

// HEIC is an image Chromium cannot draw; it opens in Preview like any other file.
function helpscoutIsImage(a) {
  return /^image\/(?!hei[cf])/i.test(a.mimeType || '') || /\.(png|jpe?g|gif|webp|bmp)$/i.test(a.name || '');
}

function helpscoutThread(t) {
  if (t.type === 'lineitem') return `<div class="hsv-lineitem">${escapeHtml(t.action || '')} · ${escapeHtml(formatDate(new Date(t.createdAt)))}</div>`;
  const label = t.draft ? 'Draft reply' : t.byClaude ? 'Note by Claude' : HELPSCOUT_THREAD_LABELS[t.type] || t.type;
  const kind = t.draft ? 'draft' : t.type === 'note' ? 'note' : t.type === 'customer' ? 'customer' : 'reply';
  return `<div class="hsv-thread hsv-thread--${kind}">
      <div class="hsv-thread-h"><span class="hsv-thread-kind">${escapeHtml(label)}</span><span class="hsv-thread-from" title="${hsvAttr(t.fromEmail)}">${escapeHtml(t.from)}</span>
        <span class="ws-flex"></span><span class="gh-muted">${t.createdAt ? escapeHtml(formatDate(new Date(t.createdAt))) : ''}</span></div>
      <div class="hsv-thread-text">${helpscoutLinkify(t.text)}</div>
      ${t.attachments.length ? `<div class="hsv-attachments">${t.attachments.map(a => `<button type="button" class="hsv-att" data-att="${a.id}" title="${hsvAttr(helpscoutIsImage(a) ? 'Show the image' : 'Open in its app')}">${PICONS.file(11)}<span>${escapeHtml(a.name)}</span></button>`).join('')}</div>` : ''}
    </div>`;
}

function helpscoutSuggestion(sug) {
  const skill = HELPSCOUT_LOG_SKILLS[sug.kind] || HELPSCOUT_SUPPORT_SKILL;
  return `<div class="hsv-sug${sug.status === 'open' ? '' : ' hsv-sug--done'}" data-sug="${sug.id}">
      <div class="hsv-sug-h"><span class="hsv-kind hsv-kind--${hsvAttr(sug.kind)}">${escapeHtml(sug.kind)}</span>
        ${sug.status === 'open' ? '' : `<span class="gh-muted">${escapeHtml(sug.status)}</span>`}<span class="ws-flex"></span>
        ${sug.status === 'open' ? `<button type="button" class="ws-ghost ws-ghost--sm" data-sug-act="log" title="${hsvAttr(`A Claude session with ${skill}`)}">${ICONS.claude(11)} Log with Claude</button>
          <button type="button" class="ws-ghost ws-ghost--sm" data-sug-act="logged">Logged</button>
          <button type="button" class="ws-ghost ws-ghost--sm" data-sug-act="dismissed">Dismiss</button>`
          : '<button type="button" class="ws-ghost ws-ghost--sm" data-sug-act="open">Reopen</button>'}</div>
      <div class="hsv-sug-text">${helpscoutLinkify(sug.text)}</div>
    </div>`;
}

function renderHelpscoutViewMain() {
  if (!helpscoutViewer || activeTab !== 'helpscout') return;
  const s = helpscoutViewState;
  const c = s.conversation;
  // A repaint while typing would throw the text away; keep what is typed.
  const typed = helpscoutViewer.querySelector('#hsv-compose')?.value;
  const scroll = helpscoutViewer.querySelector('.hsv-body')?.scrollTop || 0;
  if (!s.selectedId) { helpscoutViewer.innerHTML = '<div class="hsv-body"><div class="ghv-empty">Pick a conversation.</div></div>'; return; }
  if (!c) {
    helpscoutViewer.innerHTML = `<div class="hsv-body"><div class="ghv-empty${s.convError ? ' gh-error' : ''}">${escapeHtml(s.convError || 'Loading…')}</div></div>`;
    return;
  }
  const inbox = s.inbox;
  const mailbox = inbox?.mailboxes?.find(m => m.id === c.mailboxId)?.name || '';
  const draft = c.threads.find(t => t.draft);
  const people = inbox?.people || [];
  const busy = s.busy ? ' disabled' : '';
  const composeValue = typed !== undefined && s.composerKept === `${c.id}:${s.composer}` ? typed : s.composer === 'reply' ? (draft?.text || '') : '';
  s.composerKept = `${c.id}:${s.composer}`;
  helpscoutViewer.innerHTML = `<div class="hsv-body"><div class="hsv-page">
    <div class="hsv-head">
      <div class="hsv-subject">${escapeHtml(c.subject)}</div>
      <div class="hsv-meta"><span class="mono">#${c.number}</span>${mailbox ? `<span>${escapeHtml(mailbox)}</span>` : ''}
        <span title="${hsvAttr(c.customer.email)}">${escapeHtml(c.customer.name || c.customer.email)}${c.customer.name && c.customer.email ? ` &lt;${escapeHtml(c.customer.email)}&gt;` : ''}</span>
        ${c.tags.map(t => `<span class="hsv-tag">${escapeHtml(t)}</span>`).join('')}</div>
      <div class="hsv-controls">
        <label class="hsv-control">Status <select id="hsv-status"${busy}>${HELPSCOUT_STATUSES.map(st => `<option value="${st}"${c.status === st ? ' selected' : ''}>${st[0].toUpperCase() + st.slice(1)}</option>`).join('')}</select></label>
        <label class="hsv-control">Assignee <select id="hsv-assignee"${busy}><option value="">Unassigned</option>${people.map(p => `<option value="${p.id}"${c.assignee?.id === p.id ? ' selected' : ''}>${escapeHtml(p.name)}${p.id === inbox?.me?.id ? ' (you)' : p.team ? ' (team)' : ''}</option>`).join('')}</select></label>
        <span class="ws-flex"></span>
        <button type="button" class="ws-ghost" id="hsv-session" title="${hsvAttr(`A Claude session with ${HELPSCOUT_SUPPORT_SKILL} on this ticket`)}">${ICONS.claude(12)}<span>Claude session</span></button>
        <button type="button" class="ws-ghost" id="hsv-open" title="Open the conversation in Help Scout">${PICONS.open(12)}<span>Help Scout</span></button>
      </div>
    </div>
    ${s.notice ? `<div class="hsv-notice${s.notice.bad ? ' gh-error' : ''}">${escapeHtml(s.notice.text)}</div>` : ''}
    ${helpscoutSessionsSection(c)}
    ${c.suggestions.length ? `<div class="hsv-sugs">${c.suggestions.map(helpscoutSuggestion).join('')}</div>` : ''}
    <div class="hsv-threads">${[...c.threads].reverse().filter(t => !t.draft).map(helpscoutThread).join('')}</div>
    <div class="hsv-composer">
      <div class="hsv-tabs">
        <button type="button" class="ws-ghost ws-ghost--sm${s.composer === 'reply' ? ' active' : ''}" data-composer="reply">${draft ? 'Draft reply' : 'Reply'}</button>
        <button type="button" class="ws-ghost ws-ghost--sm${s.composer === 'note' ? ' active' : ''}" data-composer="note">Note</button>
        <span class="ws-flex"></span>
        <span class="gh-muted">${s.composer === 'reply' ? 'Saved as a draft in Help Scout; you send it there.' : 'Only your team sees a note.'}</span>
      </div>
      <textarea id="hsv-compose" class="hsv-compose" rows="${s.composer === 'reply' ? 9 : 4}" spellcheck="true" placeholder="${s.composer === 'reply' ? `Reply to ${hsvAttr(c.customer.name || c.customer.email)}` : 'A note for the team; type @ to mention someone'}">${escapeHtml(composeValue)}</textarea>
      <div class="hsv-compose-acts">
        ${s.composer === 'reply'
          ? `<button type="button" class="ws-btn" id="hsv-save-draft"${busy}>${s.busy === 'draft' ? 'Saving…' : draft ? 'Save draft' : 'Save as draft'}</button>
             <button type="button" class="ws-btn ws-btn--primary" id="hsv-send"${busy} title="Save the draft, then open the conversation in Help Scout to send it">Send in Help Scout</button>`
          : `<button type="button" class="ws-btn ws-btn--primary" id="hsv-add-note"${busy}>${s.busy === 'note' ? 'Adding…' : 'Add note'}</button>`}
      </div>
    </div>
  </div></div>`;
  // Oldest first, like a chat: a conversation opens at its newest message and the reply box.
  const body = helpscoutViewer.querySelector('.hsv-body');
  body.scrollTop = s.scrolledTo === c.id ? scroll : body.scrollHeight;
  s.scrolledTo = c.id;
  bindHelpscoutViewMain(c, draft);
}

function bindHelpscoutViewMain(c, draft) {
  const s = helpscoutViewState;
  const $ = (sel) => helpscoutViewer.querySelector(sel);
  $('#hsv-open').onclick = () => window.api.openExternal(c.url);
  $('#hsv-session').onclick = () => helpscoutSupportSession(c);
  $('#hsv-status').onchange = (e) => {
    const status = e.target.value;
    if (status === 'spam' && !confirm(`Mark #${c.number} as spam?`)) { e.target.value = c.status; return; }
    helpscoutViewWrite('status', () => window.api.setHelpscoutStatus(c.id, status), `Status set to ${status}.`);
  };
  $('#hsv-assignee').onchange = (e) => {
    const id = e.target.value ? Number(e.target.value) : null;
    const name = e.target.selectedOptions[0]?.textContent || 'nobody';
    helpscoutViewWrite('assign', () => window.api.assignHelpscout(c.id, id), id ? `Assigned to ${name}.` : 'Unassigned.');
  };
  helpscoutViewer.querySelectorAll('[data-composer]').forEach(btn => {
    btn.onclick = () => { s.composer = btn.dataset.composer; s.composerKept = null; renderHelpscoutViewMain(); };
  });
  const text = () => $('#hsv-compose').value;
  const saveDraft = () => helpscoutViewWrite('draft', () => window.api.saveHelpscoutDraft(c.id, { threadId: draft?.id || null, text: text() }), 'Draft saved in Help Scout.');
  if ($('#hsv-save-draft')) $('#hsv-save-draft').onclick = () => saveDraft();
  if ($('#hsv-send')) $('#hsv-send').onclick = async () => { if (await saveDraft()) window.api.openExternal(c.url); };
  if (s.composer === 'note') bindHelpscoutMentions($('#hsv-compose'), s.inbox?.people || []);
  if ($('#hsv-add-note')) {
    $('#hsv-add-note').onclick = async () => {
      if (await helpscoutViewWrite('note', () => window.api.addHelpscoutNote(c.id, text()), 'Note added.')) {
        s.composerKept = null;
        renderHelpscoutViewMain();
      }
    };
  }
  helpscoutViewer.querySelectorAll('.hsv-sug').forEach(el => {
    const sug = c.suggestions.find(x => String(x.id) === el.dataset.sug);
    el.querySelectorAll('[data-sug-act]').forEach(btn => {
      btn.onclick = () => (btn.dataset.sugAct === 'log' ? helpscoutLogSession(sug) : helpscoutSetSuggestion(sug.id, btn.dataset.sugAct));
    });
  });
  if ($('#hsv-hide-session')) {
    $('#hsv-hide-session').onclick = () => { s.splitHiddenFor = c.id; leaveHelpscoutSplit(); renderHelpscoutViewMain(); };
  }
  const sessionRows = helpscoutViewer.querySelectorAll('.hsv-sessions .gh-sess-row');
  sessionRows.forEach(row => {
    bindHelpscoutSessionRow(row);
    refreshPrLastMessage(row.dataset.session).then(changed => {
      if (changed && row.isConnected) { row.innerHTML = prSessionRowInner(row.dataset.session); bindHelpscoutSessionRow(row); }
    });
  });
  if (sessionRows.length) tickHelpscoutSessions();
  helpscoutViewer.querySelectorAll('.hsv-att').forEach(btn => {
    btn.onclick = () => openHelpscoutAttachment(c, Number(btn.dataset.att));
  });
  helpscoutViewer.querySelectorAll('a.hsv-link').forEach(a => {
    a.onclick = (e) => { e.preventDefault(); if (/^https?:/i.test(a.href)) window.api.openExternal(a.href); };
  });
}

// --- @mentions in a note: a list of people over the box while an @word is typed ---

/** The @word the caret is in, or null: { start, query }. */
function helpscoutMentionAt(textarea) {
  const before = textarea.value.slice(0, textarea.selectionStart);
  const m = /(^|[\s(])@([\w-]*)$/.exec(before);
  return m ? { start: before.length - m[2].length - 1, query: m[2].toLowerCase() } : null;
}

function bindHelpscoutMentions(textarea, people) {
  const handles = people.filter(p => p.mention);
  if (!textarea || !handles.length) return;
  const holder = textarea.parentElement;
  let list = [];
  let index = 0;
  let at = null;
  const close = () => { holder.querySelector('.hsv-mention')?.remove(); list = []; at = null; };
  const pick = (person) => {
    const end = textarea.selectionStart;
    const text = `@${person.mention} `;
    textarea.setRangeText(text, at.start, end, 'end');
    close();
    textarea.focus();
  };
  const paint = () => {
    holder.querySelector('.hsv-mention')?.remove();
    if (!list.length) return;
    const box = document.createElement('div');
    box.className = 'hsv-mention';
    box.innerHTML = list.map((p, i) => `<button type="button" class="hsv-mention-row${i === index ? ' active' : ''}" data-i="${i}"><span class="hsv-mention-handle">@${escapeHtml(p.mention)}</span><span class="gh-muted">${escapeHtml(p.name)}${p.team ? ' (team)' : ''}</span></button>`).join('');
    // mousedown: the textarea keeps its focus and caret.
    box.querySelectorAll('.hsv-mention-row').forEach(row => { row.onmousedown = (e) => { e.preventDefault(); pick(list[Number(row.dataset.i)]); }; });
    // Above the box: it sits at the bottom of the conversation.
    box.style.bottom = `${holder.clientHeight - textarea.offsetTop + 4}px`;
    box.style.left = `${textarea.offsetLeft}px`;
    holder.appendChild(box);
  };
  const update = () => {
    at = helpscoutMentionAt(textarea);
    if (!at) { close(); return; }
    // The handle or any word of the name starts with what is typed.
    list = handles.filter(p => [p.mention, ...p.name.split(/\s+/)].some(w => w.toLowerCase().startsWith(at.query))).slice(0, 8);
    index = Math.min(index, Math.max(list.length - 1, 0));
    paint();
  };
  textarea.addEventListener('input', update);
  textarea.addEventListener('click', update);
  textarea.addEventListener('blur', () => setTimeout(close, 100));
  textarea.addEventListener('keydown', (e) => {
    if (!list.length) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      index = (index + (e.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length;
      paint();
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      pick(list[index]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  });
}

// --- Attachments: images in a popup over the tab, ← → between them ---

const helpscoutImageCache = new Map(); // attachment id → data: URL

/** An image opens in the popup; any other file in its own app. */
async function openHelpscoutAttachment(c, attId) {
  const all = [...c.threads].reverse().filter(t => !t.draft).flatMap(t => t.attachments);
  const att = all.find(a => a.id === attId);
  if (!att) return;
  if (!helpscoutIsImage(att)) {
    const result = await window.api.openHelpscoutAttachment(c.id, att.id, att.name);
    if (result?.error) { helpscoutViewState.notice = { bad: true, text: result.error }; renderHelpscoutViewMain(); }
    return;
  }
  const images = all.filter(helpscoutIsImage);
  showHelpscoutLightbox(c.id, images, images.indexOf(att));
}

function showHelpscoutLightbox(convId, images, start) {
  document.querySelector('.hsv-lightbox')?.remove();
  let index = start;
  const box = document.createElement('div');
  box.className = 'hsv-lightbox';
  const close = () => { box.remove(); document.removeEventListener('keydown', onKey, true); };
  const show = async () => {
    const att = images[index];
    const many = images.length > 1;
    box.innerHTML = `<div class="hsv-lightbox-bar"><span class="hsv-lightbox-name">${escapeHtml(att.name)}</span>
        ${many ? `<span class="gh-muted">${index + 1} / ${images.length}</span>` : ''}<span class="ws-flex"></span>
        <button type="button" class="ws-ghost" data-lb="close" title="Close (Esc)">${PICONS.x(14)}</button></div>
      <div class="hsv-lightbox-stage">
        ${many ? `<button type="button" class="hsv-lightbox-nav hsv-lightbox-nav--prev" data-lb="prev" title="Previous (←)">${PICONS.back(18)}</button>` : ''}
        <div class="hsv-lightbox-img"><span class="gh-muted">Loading…</span></div>
        ${many ? `<button type="button" class="hsv-lightbox-nav hsv-lightbox-nav--next" data-lb="next" title="Next (→)">${PICONS.chevronRight(18)}</button>` : ''}
      </div>`;
    box.querySelectorAll('[data-lb]').forEach(btn => {
      btn.onclick = (e) => { e.stopPropagation(); step(btn.dataset.lb); };
    });
    let url = helpscoutImageCache.get(att.id);
    if (!url) {
      const result = await window.api.getHelpscoutAttachment(convId, att.id);
      if (result?.error) {
        if (images[index] === att) box.querySelector('.hsv-lightbox-img').innerHTML = `<span class="gh-error">${escapeHtml(result.error)}</span>`;
        return;
      }
      url = `data:${att.mimeType || 'image/png'};base64,${result.data}`;
      helpscoutImageCache.set(att.id, url);
    }
    // Moved on while it loaded: that image draws itself.
    if (images[index] !== att || !box.isConnected) return;
    const holder = box.querySelector('.hsv-lightbox-img');
    holder.innerHTML = '';
    const img = document.createElement('img');
    img.src = url;
    img.alt = att.name;
    holder.appendChild(img);
  };
  const step = (what) => {
    if (what === 'close') { close(); return; }
    index = (index + (what === 'next' ? 1 : -1) + images.length) % images.length;
    show();
  };
  // Capture, so the arrows do not also move the sidebar list underneath.
  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    else if (images.length > 1 && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
      e.preventDefault(); e.stopPropagation(); step(e.key === 'ArrowRight' ? 'next' : 'prev');
    }
  };
  document.addEventListener('keydown', onKey, true);
  box.onclick = (e) => { if (e.target === box || e.target.classList.contains('hsv-lightbox-stage')) close(); };
  document.body.appendChild(box);
  show();
}

/** Called when the Help Scout tab is opened (app.js). */
function showHelpscoutView() {
  hideAllViewers();
  // The ticket's session comes back with the ticket (openHelpscoutConversation).
  helpscoutViewState.splitSession = null;
  // hideAllViewers puts the terminal area back; this tab covers it instead.
  placeholder.style.display = 'none';
  terminalArea.style.display = 'none';
  helpscoutViewer.style.display = 'flex';
  renderHelpscoutViewList();
  renderHelpscoutViewMain();
  const s = helpscoutViewState;
  const stale = !s.inbox || Date.now() - Date.parse(s.inbox.fetchedAt) > HELPSCOUT_VIEW_REFRESH_MS;
  if (stale) loadHelpscoutView({ quiet: !!s.inbox });
  if (s.selectedId) openHelpscoutConversation(s.selectedId, { quiet: true });
  clearInterval(s.timer);
  s.timer = setInterval(() => {
    if (activeTab !== 'helpscout') { clearInterval(s.timer); s.timer = null; return; }
    loadHelpscoutView({ quiet: true });
  }, HELPSCOUT_VIEW_REFRESH_MS);
}

function hideHelpscoutView() {
  if (helpscoutViewer) helpscoutViewer.style.display = 'none';
  // showSession passes through here too; onHelpscoutSessionShown puts the split back.
  mainEl.classList.remove('hsv-split');
}
