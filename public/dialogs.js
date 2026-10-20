// --- Dialogs & session launch helpers ---
// Depends on globals: launchNewSession, cachedProjects, cachedAllProjects, sessionMap,
// pendingSessions, openSessions, activePtyIds, refreshSidebar, pollActiveSessions (app.js)
// Depends on: ICONS (icons.js)//
// Dialog rule: a click on the backdrop does nothing. These hold typed work, and
// a stray click used to throw it away. Escape and Cancel are the ways out.

// --- New session dialog ---
async function resolveDefaultSessionOptions(project) {
  const effective = await window.api.getEffectiveSettings(project.projectPath);
  // All quick-launch callers share the same option registry as the forms.
  // A harness reads only its own fields; explicit false/null/empty defaults
  // remain intact instead of being mistaken for missing settings.
  const keys = new Set(Object.keys(SessionConfig.FIELDS).flatMap(runtime =>
    SessionConfig.fieldsFor(runtime).map(field => field.key)));
  return Object.fromEntries([...keys].filter(key => SessionConfig.own(effective, key))
    .map(key => [key, effective[key]]));
}

async function forkSession(session, project) {
  const options = await resolveDefaultSessionOptions(project);
  options.forkFrom = session.sessionId;
  // A fork runs on the CLI that wrote the session being forked, not whatever
  // the default is — `codex fork` cannot continue a Claude transcript.
  if (session.runtime) options.runtime = session.runtime;
  launchNewSession(project, options);
}

function showNewSessionPopover(project, anchorEl) {
  // Remove any existing popover
  document.querySelectorAll('.new-session-popover').forEach(el => el.remove());

  const popover = document.createElement('div');
  popover.className = 'new-session-popover';

  function addOption(html, className, onClick) {
    const btn = document.createElement('button');
    btn.className = 'popover-option' + (className ? ' ' + className : '');
    btn.innerHTML = html;
    btn.onclick = onClick;
    popover.appendChild(btn);
    return btn;
  }

  // One pair of rows per CLI, built from what main reports rather than
  // hardcoded, so a CLI added later appears without a change here. Switching
  // one off in settings is what takes it out of the list.
  function render(harnesses) {
    popover.replaceChildren();
    for (const h of harnesses) {
      const icon = h.id === 'codex'
        ? ICONS.codex(16, 'popover-option-icon codex-icon')
        : ICONS.claude(16, 'popover-option-icon claude-icon');
      addOption(`${icon} ${escapeHtml(h.label)}`, 'popover-option-' + h.id, async () => {
        popover.remove();
        const options = await resolveDefaultSessionOptions(project);
        options.runtime = h.id;
        launchNewSession(project, options);
      });
      addOption(`${icon} ${escapeHtml(h.label)} (Configure...)`, 'popover-option-' + h.id, () => {
        popover.remove();
        showNewSessionDialog(project, h.id);
      });
    }
    addOption(
      ICONS.terminal(16, 'popover-option-icon terminal-icon') + ' Terminal',
      'popover-option-terminal',
      () => { popover.remove(); launchTerminalSession(project); }
    );
    position();
  }

  function position() {
    const rect = anchorEl.getBoundingClientRect();
    const popoverHeight = popover.offsetHeight;
    if (rect.bottom + 4 + popoverHeight > window.innerHeight) {
      popover.style.top = (rect.top - popoverHeight - 4) + 'px';
    } else {
      popover.style.top = (rect.bottom + 4) + 'px';
    }
    popover.style.left = rect.left + 'px';
  }

  document.body.appendChild(popover);
  // Claude alone until main answers, so the popover never renders empty.
  render([{ id: 'claude', label: 'Claude' }]);
  window.api.getHarnesses()
    .then(list => {
      // Every switched-on CLI is offered. Whether its binary is actually
      // installed is not something the main process can tell — sessions run
      // through a login shell with a different PATH — so launching is what
      // finds out, and the shell's own error lands in the terminal.
      const usable = (list || []).filter(h => h.enabled);
      if (popover.isConnected && usable.length) render(usable);
    })
    .catch(() => {});

  // Close on click outside
  function onClickOutside(e) {
    if (!popover.contains(e.target) && e.target !== anchorEl) {
      popover.remove();
      document.removeEventListener('mousedown', onClickOutside);
    }
  }
  setTimeout(() => document.addEventListener('mousedown', onClickOutside), 0);
}

/** Start or reattach a raw terminal without routing it through a CLI harness. */
async function openRawTerminalSession(session, { show = true } = {}) {
  const { sessionId, projectPath } = session;
  const entry = openSessions.get(sessionId) || createTerminalEntry(session);
  const result = await window.api.openTerminal(sessionId, projectPath, true, {
    type: 'terminal',
    projectId: session.projectId || null,
  });
  if (!result.ok) {
    entry.terminal.write(`\r\nError: ${result.error}\r\n`);
    entry.closed = true;
    return result;
  }
  entry.closed = false;
  persistTerminalSession(session);
  if (show) showSession(sessionId);
  return result;
}

async function launchTerminalSession(project) {
  const session = {
    sessionId: crypto.randomUUID(),
    summary: 'Terminal',
    firstPrompt: '',
    projectPath: project.projectPath,
    name: null,
    starred: 0,
    archived: 0,
    messageCount: 0,
    modified: new Date().toISOString(),
    created: new Date().toISOString(),
    type: 'terminal',
  };
  // Started from a project: the terminal belongs there, so it shows in the
  // project's list and not only in its own window.
  if (project.projectId) session.projectId = project.projectId;

  // Track as pending
  const { sessionId, projectPath } = session;
  const folder = encodeProjectPath(projectPath);
  pendingSessions.set(sessionId, { session, projectPath, folder });

  // Inject into cached project data
  sessionMap.set(sessionId, session);
  for (const projList of [cachedProjects, cachedAllProjects]) {
    let proj = projList.find(p => p.projectPath === projectPath);
    if (!proj) {
      proj = { folder, projectPath, sessions: [] };
      projList.unshift(proj);
    }
    proj.sessions.unshift(session);
  }
  if (typeof injectPendingIntoTree === 'function') injectPendingIntoTree(session);
  refreshSidebar();

  await openRawTerminalSession(session);
  pollActiveSessions();
}

async function showNewSessionDialog(project, runtime = 'claude') {
  const effective = await window.api.getEffectiveSettings(project.projectPath);
  const overlay = document.createElement('div');
  overlay.className = 'new-session-overlay';
  const dialog = document.createElement('div');
  dialog.className = 'new-session-dialog';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.innerHTML = `
    <h3>New ${escapeHtml(runtime === 'codex' ? 'Codex' : runtime === 'claude' ? 'Claude' : runtime)} Session — ${escapeHtml(shortProjectPath(project.projectPath))}</h3>
    <div class="session-config-fields"></div>
    <div class="session-config-error" role="alert" hidden></div>
    <div class="new-session-actions">
      <button type="button" class="new-session-cancel-btn">Cancel</button>
      <button type="button" class="new-session-start-btn">Start</button>
    </div>`;
  const form = SessionConfigForm.mount(dialog.querySelector('.session-config-fields'), { runtime, defaults: effective });
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);
  function close() { overlay.remove(); document.removeEventListener('keydown', onKey); }
  function start() {
    let options;
    try { options = form.getOptions(); } catch (err) {
      const error = dialog.querySelector('.session-config-error');
      error.textContent = err.message; error.hidden = false;
      return;
    }
    close();
    launchNewSession(project, { ...options, runtime });
  }
  dialog.querySelector('.new-session-cancel-btn').onclick = close;
  dialog.querySelector('.new-session-start-btn').onclick = start;
  function onKey(e) {
    if (e.key === 'Escape') close();
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) start();
  }
  document.addEventListener('keydown', onKey);
}

async function showResumeSessionDialog(session) {
  const effective = await window.api.getEffectiveSettings(session.projectPath);

  const overlay = document.createElement('div');
  overlay.className = 'new-session-overlay';

  const dialog = document.createElement('div');
  dialog.className = 'new-session-dialog';

  let selectedMode = effective.permissionMode || null;
  let dangerousSkip = effective.dangerouslySkipPermissions || false;

  const modes = PERMISSION_MODES;

  function renderModeGrid() {
    return modes.map(m => {
      const isSelected = !dangerousSkip && selectedMode === m.value;
      return `<button class="permission-option${isSelected ? ' selected' : ''}" data-mode="${m.value}"><span class="perm-name">${m.label}</span><span class="perm-desc">${m.desc}</span></button>`;
    }).join('') +
    `<button class="permission-option dangerous${dangerousSkip ? ' selected' : ''}" data-mode="dangerous-skip"><span class="perm-name">Dangerous Skip</span><span class="perm-desc">Skip all safety prompts (use with caution)</span></button>`;
  }

  const sessionName = session.name || session.aiTitle || session.summary || session.sessionId.slice(0, 8);

  dialog.innerHTML = `
    <h3>Resume Session — ${escapeHtml(sessionName)}</h3>
    <div class="settings-field">
      <div class="settings-label">Permission Mode</div>
      <div class="permission-grid" id="rsd-mode-grid">${renderModeGrid()}</div>
    </div>
    <div class="settings-field">
      <div class="settings-field-info">
        <span class="settings-label">Chrome</span>
        <div class="settings-description">Enable Chrome browser automation</div>
      </div>
      <div class="settings-field-control">
        <label class="settings-toggle"><input type="checkbox" id="rsd-chrome" ${effective.chrome ? 'checked' : ''}><span class="settings-toggle-slider"></span></label>
      </div>
    </div>
    <div class="settings-field settings-field-wide">
      <div class="settings-field-info">
        <span class="settings-label">Pre-launch Command</span>
        <div class="settings-description">Prepended to the claude command</div>
      </div>
      <div class="settings-field-control">
        <input type="text" class="settings-input" id="rsd-pre-launch" placeholder="e.g. aws-vault exec profile --" value="${escapeHtml(effective.preLaunchCmd || '')}">
      </div>
    </div>
    <div class="settings-field settings-field-wide">
      <div class="settings-field-info">
        <span class="settings-label">Additional Directories</span>
        <div class="settings-description">Extra directories to include (comma-separated)</div>
      </div>
      <div class="settings-field-control">
        <input type="text" class="settings-input" id="rsd-add-dirs" placeholder="/path/to/dir1, /path/to/dir2" value="${escapeHtml(effective.addDirs || '')}">
      </div>
    </div>
    <div class="new-session-actions">
      <button class="new-session-cancel-btn">Cancel</button>
      <button class="new-session-start-btn">Resume</button>
    </div>
  `;

  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  // Bind mode grid clicks
  const modeGrid = dialog.querySelector('#rsd-mode-grid');
  modeGrid.addEventListener('click', (e) => {
    const btn = e.target.closest('.permission-option');
    if (!btn) return;
    const mode = btn.dataset.mode;
    if (mode === 'dangerous-skip') {
      dangerousSkip = !dangerousSkip;
      if (dangerousSkip) selectedMode = null;
    } else {
      dangerousSkip = false;
      selectedMode = mode === 'null' ? null : mode;
    }
    modeGrid.innerHTML = renderModeGrid();
  });

  function close() {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
  }

  function resume() {
    const options = {};
    if (dangerousSkip) {
      options.dangerouslySkipPermissions = true;
    } else if (selectedMode) {
      options.permissionMode = selectedMode;
    }
    if (dialog.querySelector('#rsd-chrome').checked) {
      options.chrome = true;
    }
    const preLaunch = dialog.querySelector('#rsd-pre-launch').value.trim();
    if (preLaunch) options.preLaunchCmd = preLaunch;
    options.addDirs = dialog.querySelector('#rsd-add-dirs').value.trim();
    if (effective.mcpEmulation === false) options.mcpEmulation = false;
    close();
    openSession(session, options);
  }

  dialog.querySelector('.new-session-cancel-btn').onclick = close;
  dialog.querySelector('.new-session-start-btn').onclick = resume;

  function onKey(e) {
    if (e.key === 'Escape') close();
    if (e.key === 'Enter' && !e.target.matches('input')) resume();
  }
  document.addEventListener('keydown', onKey);
}

// Settings viewer is in settings-panel.js (openSettingsViewer / closeSettingsViewer)
// Global settings button & add project button bindings are in app.js (need DOM refs)

// --- New session picker ---
// One popup for starting a session: a chat outside any repository, or a session
// in one of the repositories (and plain folders) the sidebar knows. Type to
// filter (fuzzy: "swb" finds switchboard), arrows move, Enter starts Claude
// there with that folder's defaults. Ported from Joris Blaak's fork
// (ab3bc73, 7064b6c, d496d0d, dc2b954), with the chat as its first row.
function newSessionPickerTargets() {
  const targets = repoLaunchTargets().map(({ info, project, folders, lastActivity }) => ({
    kind: 'repo', label: info.name, sub: info.owner, path: project.projectPath, project, folders, lastActivity,
  }));
  const inRepo = new Set(targets.flatMap(t => t.folders.map(f => f.projectPath)));
  for (const project of cachedAllProjects) {
    if (inRepo.has(project.projectPath) || isChatFolder(project.projectPath) || repoInfoByPath.get(project.projectPath)) continue;
    targets.push({ kind: 'folder', label: folderBaseName(project.projectPath), sub: shortProjectPath(project.projectPath), path: project.projectPath, project, folders: [project], lastActivity: lastActivityOf(project.sessions) });
  }
  return targets;
}

function showProjectPickerDialog() {
  if (document.querySelector('.project-picker-dialog')) return;
  const overlay = document.createElement('div');
  overlay.className = 'add-project-overlay';
  const dialog = document.createElement('div');
  dialog.className = 'add-project-dialog project-picker-dialog';
  dialog.innerHTML = `
    <h3>New session</h3>
    <input type="text" class="project-picker-filter" placeholder="Filter repositories…" autocomplete="off" spellcheck="false">
    <div class="project-picker-list"></div>`;
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);
  const filterInput = dialog.querySelector('.project-picker-filter');
  const listEl = dialog.querySelector('.project-picker-list');
  const targets = newSessionPickerTargets();

  // Focus stays in the filter, so the highlighted row is tracked here rather
  // than with DOM focus. `rows` is rebuilt by every render().
  let rows = [];
  let selected = 0;
  const setSelected = (index, { scroll = true } = {}) => {
    if (!rows.length) { selected = 0; return; }
    selected = Math.max(0, Math.min(index, rows.length - 1));
    rows.forEach((row, i) => row.el.classList.toggle('selected', i === selected));
    if (scroll) rows[selected].el.scrollIntoView({ block: 'nearest' });
  };
  const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };

  // The matched characters picked out, one span per contiguous run.
  const paintLabel = (el, label, positions) => {
    el.textContent = '';
    const matched = new Set(positions || []);
    for (let i = 0; i < label.length;) {
      const isMatch = matched.has(i);
      let j = i + 1;
      while (j < label.length && matched.has(j) === isMatch) j++;
      const part = label.slice(i, j);
      if (isMatch) {
        const mark = document.createElement('span');
        mark.className = 'project-picker-match';
        mark.textContent = part;
        el.appendChild(mark);
      } else el.appendChild(document.createTextNode(part));
      i = j;
    }
  };

  const addRow = ({ label, positions, sub, icon, count, running, title, actions = [], start }) => {
    const row = document.createElement('div');
    row.className = 'project-picker-row';
    row.title = title || '';
    const iconEl = document.createElement('span');
    iconEl.className = 'project-picker-icon';
    iconEl.innerHTML = icon;
    const name = document.createElement('div');
    name.className = 'project-picker-name';
    const main = document.createElement('span');
    paintLabel(main, label, positions);
    name.appendChild(main);
    if (sub) {
      const subEl = document.createElement('span');
      subEl.className = 'project-picker-sub';
      subEl.textContent = sub;
      name.appendChild(subEl);
    }
    const countEl = document.createElement('span');
    countEl.className = `project-picker-count${running ? ' running' : ''}`;
    countEl.textContent = count || '';
    const actionsEl = document.createElement('div');
    actionsEl.className = 'project-picker-actions';
    for (const a of actions) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.dataset.tooltip = a.label;
      btn.setAttribute('aria-label', a.label);
      btn.innerHTML = a.icon;
      btn.onclick = (e) => { e.stopPropagation(); a.onClick(); };
      actionsEl.appendChild(btn);
    }
    row.append(iconEl, name, countEl, actionsEl);
    const activate = () => { close(); start(); };
    row.onclick = activate;
    // The highlight follows the pointer, so the mouse and the keys never
    // disagree about which row Enter would open.
    const index = rows.length;
    row.addEventListener('mouseenter', () => setSelected(index, { scroll: false }));
    rows.push({ el: row, activate });
    listEl.appendChild(row);
  };

  function render() {
    const query = filterInput.value.trim();
    listEl.innerHTML = '';
    rows = [];
    const chatMatch = fuzzyMatch(query, 'New chat');
    if (chatMatch) {
      addRow({ label: 'New chat', positions: query ? chatMatch.positions : null, sub: 'no repository', icon: ICONS.claude(14), title: 'A session outside any repository, in the Chats folder', start: () => launchChatSession() });
    }
    // The name first: a match that needs the owner ranks below every name
    // match. Then score, then recency. Not the full path: it holds so many
    // letters that a short query matches nearly every folder.
    const matches = [];
    for (const t of targets) {
      const nameMatch = fuzzyMatch(query, t.label);
      const match = nameMatch || (t.kind === 'repo' ? fuzzyMatch(query, `${t.sub}/${t.label}`) : null);
      if (match) matches.push({ t, onName: !!nameMatch, score: match.score, positions: nameMatch ? nameMatch.positions : [] });
    }
    matches.sort((a, b) => (b.onName - a.onName) || (b.score - a.score) || (b.t.lastActivity - a.t.lastActivity));
    for (const { t, positions } of matches) {
      const sessions = t.folders.flatMap(f => f.sessions);
      const live = sessions.filter(s => activePtyIds.has(s.sessionId)).length;
      addRow({
        label: t.label,
        positions: query ? positions : null,
        sub: t.kind === 'repo' ? t.sub : 'folder',
        icon: t.kind === 'repo' ? PICONS.branch(13) : PICONS.folder(13),
        count: live ? `${live} running` : `${sessions.length} session${sessions.length === 1 ? '' : 's'}`,
        running: live > 0,
        title: t.path,
        actions: [{
          label: 'Folder settings',
          icon: ICONS.gear(14),
          onClick: () => { close(); openSettingsViewer('project', t.path); },
        }],
        start: async () => launchWithDefaultCli(t.project, await resolveDefaultSessionOptions(t.project)),
      });
    }
    if (!rows.length) {
      const empty = document.createElement('div');
      empty.className = 'project-picker-empty';
      empty.textContent = 'No matching repositories.';
      listEl.appendChild(empty);
    }
    setSelected(selected, { scroll: false });
  }

  filterInput.addEventListener('input', () => { selected = 0; render(); });
  filterInput.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!rows.length) return;
      setSelected((selected + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      rows[selected]?.activate();
    }
  });
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  function onKey(e) { if (e.key === 'Escape') close(); }
  document.addEventListener('keydown', onKey);
  render();
  filterInput.focus();
}

function showAddProjectDialog() {
  const overlay = document.createElement('div');
  overlay.className = 'add-project-overlay';

  const dialog = document.createElement('div');
  dialog.className = 'add-project-dialog';

  dialog.innerHTML = `
    <h3>Add Folder</h3>
    <div class="add-project-hint">Select a folder. Its sessions appear in the Sessions tab. To start a session in a folder that is already listed, use the + on its header.</div>
    <div class="folder-input-row">
      <input type="text" id="add-project-path" placeholder="/path/to/folder" autocomplete="off" spellcheck="false">
      <button class="add-project-browse-btn">Browse</button>
    </div>
    <div class="add-project-error" id="add-project-error"></div>
    <div class="add-project-actions">
      <button class="add-project-cancel-btn">Cancel</button>
      <button class="add-project-add-btn">Add</button>
    </div>
  `;

  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  const pathInput = dialog.querySelector('#add-project-path');
  const errorEl = dialog.querySelector('#add-project-error');
  pathInput.focus();

  function close() {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
  }

  async function addProject() {
    const projectPath = pathInput.value.trim();
    if (!projectPath) {
      errorEl.textContent = 'Please enter a folder path.';
      errorEl.style.display = 'block';
      return;
    }
    errorEl.style.display = 'none';
    const result = await window.api.addProject(projectPath);
    if (result.error) {
      errorEl.textContent = result.error;
      errorEl.style.display = 'block';
      return;
    }
    close();

    await loadProjects();
  }

  dialog.querySelector('.add-project-browse-btn').onclick = async () => {
    const folder = await window.api.browseFolder();
    if (folder) pathInput.value = folder;
  };

  dialog.querySelector('.add-project-cancel-btn').onclick = close;
  dialog.querySelector('.add-project-add-btn').onclick = addProject;

  function onKey(e) {
    if (e.key === 'Escape') close();
    if (e.key === 'Enter') addProject();
  }
  document.addEventListener('keydown', onKey);
}
