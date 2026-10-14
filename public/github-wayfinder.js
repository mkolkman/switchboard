// --- Wayfinder: pick up the next ticket on a map's frontier ---
// A project that follows a /wayfinder map (an issue labelled wayfinder:map)
// gets a "Next ticket" button on its plan. It works out the frontier the way
// the skill does: the map's open sub-issues with no open blocker and no
// assignee, the first in map order winning. You see the ticket first; only on
// Start does a session begin, running the skill on the map with that ticket.
// The session claims the ticket itself (its first write), so nothing is
// written to GitHub here.
// Depends on: project-github-view.js (githubTabState, githubItemKey, githubAttr,
// findLocalClone, rememberClonePick, repaintGithubTabIfShown), projects-view.js (launchTargetFor),
// dialogs.js (resolveDefaultSessionOptions), app.js (launchNewSession).

const WAYFINDER_SKILL = '/mattpocock-skills:wayfinder';
// Who answers a ticket of each type: the skill's HITL and AFK.
const WAYFINDER_TYPES = {
  research: { label: 'Research', mode: 'AFK', hint: 'a research subagent resolves it' },
  prototype: { label: 'Prototype', mode: 'HITL', hint: 'worked with you' },
  grilling: { label: 'Grilling', mode: 'HITL', hint: 'worked with you' },
  task: { label: 'Task', mode: 'HITL or AFK', hint: 'manual work a decision waits on' },
};

/** A ticket's type from its wayfinder:<type> label, or null. */
function wayfinderType(item) {
  const label = (item.labels || []).find(l => /^wayfinder:/.test(l) && l !== 'wayfinder:map');
  const type = label ? label.slice('wayfinder:'.length) : null;
  return type ? { id: type, ...(WAYFINDER_TYPES[type] || { label: type, mode: '', hint: '' }) } : null;
}

/**
 * The map's tickets sorted out: the frontier in map order (its first is
 * next), and the open tickets that are claimed or blocked. A blocker counts
 * as open by its own state, so a closed blocker unblocks.
 */
function wayfinderFrontier(result) {
  const byKey = new Map((result?.items || []).map(i => [githubItemKey(i).toLowerCase(), i]));
  const frontier = [];
  const claimed = [];
  const blocked = [];
  for (const key of result?.wayfinder?.tickets || []) {
    const item = byKey.get(key);
    if (!item || item.state !== 'OPEN') continue;
    const openBlockers = (item.blockedBy || []).filter(b => b.state === 'OPEN');
    if (item.assignees?.length) claimed.push(item);
    else if (openBlockers.length) blocked.push(item);
    else frontier.push(item);
  }
  return { next: frontier[0] || null, frontier, claimed, blocked };
}

/** The "## Question" of a ticket body, or its first lines when it has none. */
function wayfinderQuestion(body) {
  const text = String(body || '');
  const m = text.match(/^#{1,3}\s*Question\s*$/im);
  let question = text;
  if (m) {
    const rest = text.slice(m.index + m[0].length);
    const next = rest.search(/^#{1,3}\s/m);
    question = next < 0 ? rest : rest.slice(0, next);
  }
  question = question.trim();
  return question.length > 900 ? `${question.slice(0, 900).trimEnd()}…` : question;
}

function wayfinderPrompt(result, ticket) {
  return `${WAYFINDER_SKILL} ${result.url}\n\nWork this ticket, which I chose from the frontier: "${ticket.title}" (${ticket.url}).`;
}

// --- The button and the dialog ---

function wayfinderNextButton(refText) {
  return `<button type="button" class="ws-ghost wf-next" data-ref="${githubAttr(refText)}" title="Show the next ticket on this wayfinder map's frontier, then start a session on it">${PICONS.play(10)}<span>Next ticket</span></button>`;
}

/** Read the map again (claims and blockers change), then offer its next ticket. */
async function pickWayfinderTicket(project, refText, btn) {
  const state = githubTabState(project.id);
  if (btn) { btn.disabled = true; btn.querySelector('span').textContent = 'Reading…'; }
  const result = await window.api.getGithubTracker(refText, { force: true }).catch(err => ({ error: err?.message || String(err) }));
  if (result && !result.error) state.results.set(refText, result);
  repaintGithubTabIfShown(project);
  if (!result || result.error) { alert(`Could not read the map: ${result?.error || 'no answer from GitHub.'}`); return; }
  const sorted = wayfinderFrontier(result);
  let body = '';
  if (sorted.next) {
    const issue = await window.api.getGithubIssue(githubTarget(githubItemKey(sorted.next))).catch(() => null);
    body = issue?.body || '';
  }
  if (await showWayfinderDialog(result, sorted, body)) startWayfinderSession(project, result, sorted.next);
}

const wayfinderName = (item) => `<a class="wf-name" href="${githubAttr(item.url)}" title="${githubAttr(`${item.repo}#${item.number}`)}">${escapeHtml(item.title)}</a>`;

/** Resolves true when you choose Start. */
function showWayfinderDialog(result, sorted, body) {
  return new Promise(resolve => {
    const { next, frontier, claimed, blocked } = sorted;
    const type = next && wayfinderType(next);
    const others = frontier.slice(1);
    const overlay = document.createElement('div');
    overlay.className = 'add-project-overlay';
    const dialog = document.createElement('div');
    dialog.className = 'add-project-dialog wf-dialog';
    const waiting = `${claimed.length} claimed, ${blocked.length} waiting on a blocker`;
    dialog.innerHTML = next ? `
      <h3>Next ticket on ${escapeHtml(result.title)}</h3>
      <div class="wf-ticket">
        <div class="wf-ticket-h">${wayfinderName(next)}</div>
        <div class="wf-ticket-meta"><span class="mono">${escapeHtml(githubRepoName(next.repo))}#${next.number}</span>
          ${type ? `<span class="wf-type" title="${githubAttr(type.hint)}">${escapeHtml(type.label)}${type.mode ? ` · ${escapeHtml(type.mode)}` : ''}</span>` : ''}</div>
        ${body ? `<div class="wf-question">${escapeHtml(wayfinderQuestion(body))}</div>` : ''}
      </div>
      <div class="add-project-hint">The session runs ${escapeHtml(WAYFINDER_SKILL)} on the map with this ticket, and claims it on GitHub first.
        ${others.length ? `<br>Also on the frontier: ${others.map(wayfinderName).join(', ')}.` : ''}
        <br>Elsewhere on the map: ${escapeHtml(waiting)}.</div>
      <div class="add-project-actions">
        <button class="add-project-cancel-btn" type="button">Cancel</button>
        <button class="add-project-add-btn" type="button">Start session</button>
      </div>` : `
      <h3>Nothing on the frontier</h3>
      <div class="add-project-hint">${escapeHtml(result.title)} has no open ticket that is unblocked and unclaimed: ${escapeHtml(waiting)}.${claimed.length ? `<br>Claimed: ${claimed.map(wayfinderName).join(', ')}.` : ''}</div>
      <div class="add-project-actions"><button class="add-project-cancel-btn" type="button">Close</button></div>`;
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
    const finish = (start) => { overlay.remove(); document.removeEventListener('keydown', onKey); resolve(start); };
    const onKey = (e) => { if (e.key === 'Escape') finish(false); };
    document.addEventListener('keydown', onKey);
    dialog.querySelector('.add-project-cancel-btn').onclick = () => finish(false);
    const start = dialog.querySelector('.add-project-add-btn');
    if (start) { start.onclick = () => finish(true); start.focus(); }
    dialog.querySelectorAll('a.wf-name').forEach(a => {
      a.onclick = (e) => { e.preventDefault(); window.api.openExternal(a.href); };
    });
  });
}

/** A session in the map's repository, filed under the project and linked to the ticket. */
async function startWayfinderSession(project, result, ticket) {
  let clone = await findLocalClone(project, result.repo);
  if (!clone) {
    if (!confirm(`No local clone of ${result.repo} found.\n\nPick the folder where it is checked out?`)) return;
    const picked = await window.api.browseFolder();
    if (!picked) return;
    const info = (await window.api.getRepoInfo([picked]).catch(() => null))?.[picked];
    if (!info || `${info.owner}/${info.name}`.toLowerCase() !== result.repo.toLowerCase()) { alert(`${picked} is not a clone of ${result.repo}.`); return; }
    rememberClonePick(result.repo, info.root);
    clone = info.root;
  }
  const target = { ...launchTargetFor(project, null), projectPath: clone };
  const options = await resolveDefaultSessionOptions(target);
  options.runtime = 'claude';
  options.initialPrompt = wayfinderPrompt(result, ticket);
  delete options.worktree;
  delete options.worktreeName;
  // Linked like a PR session (startPrSession), so the ticket shows the session.
  options.planItem = { file: 'todos', itemText: githubItemKey(ticket) };
  const sessionId = await launchNewSession(target, options, { focus: true });
  if (sessionId) loadProjectPlan(project).catch(() => {});
}
