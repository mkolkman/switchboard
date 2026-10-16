// --- Sidebar rendering ---
// Depends on globals: sidebarContent, openSessions, activeSessionId, activePtyIds,
// pendingSessions, sessionMap, sortedOrder, searchMatchIds,
// searchMatchProjectPaths, showStarredOnly, showRunningOnly, showTodayOnly,
// visibleSessionCount, sessionMaxAgeDays, attentionSessions, responseReadySessions,
// sessionBusyState, cachedProjects, cachedAllProjects, gridCards, gridViewActive (app.js)
// Depends on: cleanDisplayName, formatDate, escapeHtml (utils.js), ICONS (icons.js),
// showSession (terminal-manager.js), confirmAndStopSession, pollActiveSessions,
// showNewSessionPopover, openSettingsViewer, showResumeSessionDialog,
// showJsonlViewer, forkSession, openSession, loadProjects, markUnread,
// clearUnread, refreshSidebar (app.js/dialogs.js)

// A session counts as running while its PTY is alive, or while it's pending —
// a just-launched session has no PTY in activePtyIds until the next poll. A
// pending session whose process died is marked exited and no longer counts.
function isSessionRunning(sessionId) {
  if (activePtyIds.has(sessionId)) return true;
  const pending = pendingSessions.get(sessionId);
  return !!pending && !pending.exited;
}

function slugId(slug) {
  return 'slug-' + slug.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function folderId(projectPath) {
  return 'project-' + projectPath.replace(/[^a-zA-Z0-9_-]/g, '_');
}

// --- Grouping (session-groups.js holds the pure rules) ---
// sidebarGroupMode, customerMapping, repoInfoByPath and chatFolderPath live in
// app.js; the "Group by" control and Settings write them.

function isChatFolder(projectPath) {
  return !!chatFolderPath && projectPath === chatFolderPath;
}

function repoNameFor(projectPath) {
  if (isChatFolder(projectPath)) return null;
  return repoInfoByPath.get(projectPath)?.name || null;
}

// What a session row says it belongs to: the repo name, the folder name when
// the folder has no remote, or "Chat" for a repo-less chat.
function sessionSourceLabel(projectPath) {
  if (!projectPath) return '';
  if (isChatFolder(projectPath)) return 'Chat';
  return repoNameFor(projectPath) || folderBaseName(projectPath);
}

function sessionSourceTitle(projectPath) {
  const info = repoInfoByPath.get(projectPath);
  return info ? `${info.owner}/${info.name}\n${projectPath}` : projectPath;
}

function lastActivityOf(sessions) {
  let latest = 0;
  for (const s of sessions) {
    const t = new Date(s.modified).getTime();
    if (Number.isFinite(t) && t > latest) latest = t;
  }
  return latest;
}

function statusOfSession(session) {
  const id = session.sessionId;
  return sessionStatus({
    attention: attentionSessions.has(id),
    unread: responseReadySessions.has(id),
    busy: sessionBusyState.get(id) === true,
    running: isSessionRunning(id),
    modifiedMs: new Date(session.modified).getTime(),
    nowMs: Date.now(),
    maxAgeDays: sessionMaxAgeDays,
  });
}

// Status grouping moves rows when a session's state changes, which the
// in-place class updates alone cannot do. Coalesced so a burst of busy/idle
// signals costs one render.
let statusRegroupTimer = null;
let renderedStatuses = new Map(); // sessionId → status it was rendered under
function onSessionStatusChanged() {
  if (sidebarGroupMode !== 'status' || statusRegroupTimer) return;
  statusRegroupTimer = setTimeout(() => {
    statusRegroupTimer = null;
    // The running poll calls in every few seconds; only a move re-renders.
    for (const [id, status] of renderedStatuses) {
      const session = sessionMap.get(id);
      if (session && statusOfSession(session) !== status) {
        refreshSidebar({ reason: 'sessions' });
        return;
      }
    }
  }, 250);
}

// Every folder the app knows, with this render's sessions, so a group whose
// sessions are filtered out or archived still shows. A search narrows the
// list to what matched instead.
function withAllFolders(projects) {
  if (searchMatchIds !== null) return projects;
  const known = new Set(projects.map(p => p.projectPath));
  const extra = cachedAllProjects
    .filter(p => !known.has(p.projectPath))
    .map(p => ({ folder: p.folder, projectPath: p.projectPath, sessions: [] }));
  return extra.length ? [...projects, ...extra] : projects;
}

function buildSlugGroup(slug, sessions) {
  const group = document.createElement('div');
  const id = slugId(slug);
  const expanded = getExpandedSlugs().has(id);
  group.className = expanded ? 'slug-group' : 'slug-group collapsed';
  group.id = id;

  const mostRecent = sessions.reduce((a, b) =>
    new Date(b.modified) > new Date(a.modified) ? b : a);
  const displayName = cleanDisplayName(mostRecent.name || mostRecent.aiTitle || mostRecent.summary || slug);
  const mostRecentTime = new Date(mostRecent.modified);
  const timeStr = formatDate(mostRecentTime);

  const header = document.createElement('div');
  header.className = 'slug-group-header';

  const row = document.createElement('div');
  row.className = 'slug-group-row';

  const expand = document.createElement('span');
  expand.className = 'slug-group-expand';
  expand.innerHTML = '<span class="arrow">&#9654;</span>';

  const info = document.createElement('div');
  info.className = 'slug-group-info';

  const nameEl = document.createElement('div');
  nameEl.className = 'slug-group-name';
  nameEl.textContent = displayName;

  const hasRunning = sessions.some(s => activePtyIds.has(s.sessionId));

  const meta = document.createElement('div');
  meta.className = 'slug-group-meta';
  meta.innerHTML = `<span class="slug-group-dot${hasRunning ? ' running' : ''}"></span><span class="slug-group-count">${sessions.length} sessions</span> ${escapeHtml(timeStr)}`;

  const archiveSlugBtn = document.createElement('button');
  archiveSlugBtn.className = 'slug-group-archive-btn';
  archiveSlugBtn.title = 'Archive every session in this conversation thread';
  archiveSlugBtn.innerHTML = ICONS.archive(14);

  info.appendChild(nameEl);
  info.appendChild(meta);
  row.appendChild(expand);
  row.appendChild(info);
  row.appendChild(archiveSlugBtn);
  header.appendChild(row);

  const sessionsContainer = document.createElement('div');
  sessionsContainer.className = 'slug-group-sessions';

  const promoted = [];
  const rest = [];
  for (const session of sessions) {
    if (activePtyIds.has(session.sessionId)) {
      promoted.push(session);
    } else {
      rest.push(session);
    }
  }

  if (promoted.length > 0) {
    group.classList.add('has-promoted');
    for (const session of promoted) {
      sessionsContainer.appendChild(buildSessionItem(session));
    }
    if (rest.length > 0) {
      const moreBtn = document.createElement('div');
      moreBtn.className = 'slug-group-more';
      moreBtn.id = 'sgm-' + id;
      moreBtn.textContent = `+ ${rest.length} more`;

      const olderDiv = document.createElement('div');
      olderDiv.className = 'slug-group-older';
      olderDiv.id = 'sgo-' + id;
      for (const session of rest) {
        olderDiv.appendChild(buildSessionItem(session));
      }

      sessionsContainer.appendChild(moreBtn);
      sessionsContainer.appendChild(olderDiv);
    }
  } else {
    for (const session of sessions) {
      sessionsContainer.appendChild(buildSessionItem(session));
    }
  }

  group.appendChild(header);
  group.appendChild(sessionsContainer);
  return group;
}

// Process a list of sessions: filter, sort, slug-group, order, and truncate.
// `project` needs `.sessions`, a `.projectPath` used as the order key, and an
// optional `._projectMatchedOnly`. The Projects tab passes a synthetic key
// ("project:<id>") and its own previous order list.
// Returns { filtered, visible, older, sortOrderEntry } or null if the group
// should be skipped.
function processProjectSessions(project, resort, previousOrder = sortedOrder) {
  let filtered = project.sessions;
  if (showStarredOnly) filtered = filtered.filter(s => s.starred);
  if (showRunningOnly) filtered = filtered.filter(s => activePtyIds.has(s.sessionId));
  if (showTodayOnly) {
    const now = new Date();
    const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    filtered = filtered.filter(s => {
      if (!s.modified) return false;
      const d = new Date(s.modified);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` === todayStr;
    });
  }
  // Groups stay on screen when a filter empties them; only a search, which
  // is asking where something is, drops the ones that did not match.
  if (filtered.length === 0 && !project._projectMatchedOnly && searchMatchIds !== null) return null;

  // Sort
  filtered = [...filtered].sort((a, b) => {
    const aRunning = isSessionRunning(a.sessionId);
    const bRunning = isSessionRunning(b.sessionId);
    const aPri = (a.starred && aRunning ? 3 : aRunning ? 2 : a.starred ? 1 : 0);
    const bPri = (b.starred && bRunning ? 3 : bRunning ? 2 : b.starred ? 1 : 0);
    if (aPri !== bPri) return bPri - aPri;
    return new Date(b.modified) - new Date(a.modified);
  });

  // Slug grouping
  const slugMap = new Map();
  const ungrouped = [];
  for (const session of filtered) {
    if (session.slug) {
      if (!slugMap.has(session.slug)) slugMap.set(session.slug, []);
      slugMap.get(session.slug).push(session);
    } else {
      ungrouped.push(session);
    }
  }
  const allItems = [];
  for (const session of ungrouped) {
    const isRunning = isSessionRunning(session.sessionId);
    allItems.push({ sortTime: new Date(session.modified).getTime(), pinned: !!session.starred, running: isRunning, element: buildSessionItem(session) });
  }
  for (const [slug, sessions] of slugMap) {
    const mostRecentTime = Math.max(...sessions.map(s => new Date(s.modified).getTime()));
    const hasRunning = sessions.some(s => isSessionRunning(s.sessionId));
    const hasPinned = sessions.some(s => s.starred);
    const element = sessions.length === 1 ? buildSessionItem(sessions[0]) : buildSlugGroup(slug, sessions);
    allItems.push({ sortTime: mostRecentTime, pinned: hasPinned, running: hasRunning, element });
  }

  // Sort render items
  const prevEntry = previousOrder.find(e => e.projectPath === project.projectPath);
  if (resort || !prevEntry) {
    allItems.sort((a, b) => {
      const aPri = (a.pinned && a.running ? 3 : a.running ? 2 : a.pinned ? 1 : 0);
      const bPri = (b.pinned && b.running ? 3 : b.running ? 2 : b.pinned ? 1 : 0);
      if (aPri !== bPri) return bPri - aPri;
      return b.sortTime - a.sortTime;
    });
  } else {
    const orderIndex = new Map(prevEntry.itemIds.map((id, i) => [id, i]));
    allItems.sort((a, b) => {
      const aPos = orderIndex.get(a.element.id);
      const bPos = orderIndex.get(b.element.id);
      if (aPos !== undefined && bPos !== undefined) return aPos - bPos;
      if (aPos === undefined && bPos !== undefined) return -1;
      if (aPos !== undefined && bPos === undefined) return 1;
      return b.sortTime - a.sortTime;
    });
  }

  // Truncate
  let visible = [];
  let older = [];
  if (searchMatchIds !== null || showStarredOnly || showRunningOnly || showTodayOnly) {
    visible = allItems;
  } else {
    let count = 0;
    const ageCutoff = Date.now() - sessionMaxAgeDays * 86400000;
    for (const item of allItems) {
      if (item.running || item.pinned || (count < visibleSessionCount && item.sortTime >= ageCutoff)) {
        visible.push(item);
        count++;
      } else {
        older.push(item);
      }
    }
    if (visible.length === 0 && older.length > 0) { visible = older; older = []; }
  }

  return {
    filtered, visible, older,
    sortOrderEntry: { projectPath: project.projectPath, itemIds: allItems.map(item => item.element.id) },
  };
}

// Build the sessions list DOM (shared between folders, worktrees and projects)
function buildSessionsList(fId, visible, older) {
  const sessionsList = document.createElement('div');
  sessionsList.className = 'project-sessions';
  sessionsList.id = 'sessions-' + fId;
  for (const item of visible) sessionsList.appendChild(item.element);
  if (older.length > 0) {
    const moreBtn = document.createElement('div');
    moreBtn.className = 'sessions-more-toggle';
    moreBtn.id = 'older-' + fId;

    const moreLabel = document.createElement('span');
    moreLabel.className = 'sessions-more-label';

    const archiveOlderBtn = document.createElement('button');
    archiveOlderBtn.className = 'sessions-older-archive-btn';
    archiveOlderBtn.title = 'Archive all older sessions in this group';
    archiveOlderBtn.setAttribute('aria-label', archiveOlderBtn.title);
    archiveOlderBtn.innerHTML = ICONS.archive(14);

    moreBtn.appendChild(moreLabel);
    moreBtn.appendChild(archiveOlderBtn);
    const olderList = document.createElement('div');
    olderList.className = 'sessions-older';
    olderList.id = 'older-list-' + fId;
    olderList.style.display = 'none';
    for (const item of older) olderList.appendChild(item.element);
    // An older render item can be a slug group containing several sessions.
    // Count the actual unarchived session rows so this label matches the
    // archive confirmation and the work the archive button will perform.
    const olderSessionCount = olderList.querySelectorAll('.session-item:not(.archived-item)').length;
    moreLabel.textContent = `+ ${olderSessionCount} older`;
    sessionsList.appendChild(moreBtn);
    sessionsList.appendChild(olderList);
  }
  return sessionsList;
}

// morphdom callback: carry DOM-only state (collapse, expansion, an open rename)
// from the element on screen to its replacement. Shared with the Projects tab.
function preserveSidebarDomState(fromEl, toEl) {
  // The keyboard cursor (sidebar-keyboard.js) stays where it was.
  if (fromEl.classList.contains('kbd-cursor')) toEl.classList.add('kbd-cursor');
  // Skip updating session items that have an active rename input
  if (fromEl.classList.contains('session-item') && fromEl.querySelector('.session-rename-input')) {
    return false;
  }
  if (fromEl.classList.contains('project-header')) {
    if (fromEl.classList.contains('collapsed')) {
      toEl.classList.add('collapsed');
    } else {
      toEl.classList.remove('collapsed');
    }
  }
  if (fromEl.classList.contains('slug-group') || fromEl.classList.contains('worktree-header')) {
    if (fromEl.classList.contains('collapsed')) {
      toEl.classList.add('collapsed');
    } else {
      toEl.classList.remove('collapsed');
    }
  }
  if (fromEl.classList.contains('sessions-older') && fromEl.style.display !== 'none') {
    toEl.style.display = '';
  }
  if (fromEl.classList.contains('sessions-more-toggle') && fromEl.classList.contains('expanded')) {
    toEl.classList.add('expanded');
    const label = toEl.querySelector('.sessions-more-label');
    if (label) label.textContent = '- hide older';
  }
  if (fromEl.classList.contains('slug-group-older') && fromEl.style.display !== 'none') {
    toEl.style.display = '';
  }
  if (fromEl.classList.contains('slug-group-more') && fromEl.classList.contains('expanded')) {
    toEl.classList.add('expanded');
  }
  return true;
}

function renderProjects(projects, resort) {
  const newSidebar = document.createElement('div');
  const { newSortedOrder, boundProjects } = sidebarGroupMode === 'folder'
    ? buildFolderGroups(newSidebar, projects, resort)
    : buildVirtualGroups(newSidebar, projects, resort, sidebarGroupMode);

  // Re-apply active state
  if (activeSessionId) {
    const activeItem = newSidebar.querySelector(`[data-session-id="${activeSessionId}"]`);
    if (activeItem) activeItem.classList.add('active');
  }

  morphdom(sidebarContent, newSidebar, {
    childrenOnly: true,
    onBeforeElUpdated: preserveSidebarDomState,
    getNodeKey(node) {
      return node.id || undefined;
    }
  });

  // Save the full sorted order (project order + item order) as source of truth
  sortedOrder = newSortedOrder;

  rebindSidebarEvents(boundProjects);

  // Restore terminal focus after morphdom DOM updates, but not if the user is
  // interacting with an input/textarea (search box, rename input, dialogs, etc.)
  const ae = document.activeElement;
  const isUserTyping = ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable || ae.closest('.modal-overlay'));
  const listHasKeyboard = typeof isSidebarFocused === 'function' && isSidebarFocused();
  if (activeSessionId && openSessions.has(activeSessionId) && !isUserTyping && !listHasKeyboard) {
    openSessions.get(activeSessionId).terminal.focus();
  }
  if (typeof renderSidebarRail === 'function') renderSidebarRail();
}

// Folder mode: one group per folder, Claude worktrees nested under their parent.
function buildFolderGroups(newSidebar, projects, resort) {
  projects = withAllFolders(projects);

  // Detect worktree projects and group them under their parent
  const worktreePattern = /^(.+?)\/\.claude\/worktrees\/([^/]+)\/?$/;
  const worktreeMap = new Map(); // parentPath → [worktreeProject, ...]
  const worktreeSet = new Set();
  for (const project of projects) {
    const match = project.projectPath.match(worktreePattern);
    if (match) {
      const parentPath = match[1];
      if (!worktreeMap.has(parentPath)) worktreeMap.set(parentPath, []);
      worktreeMap.get(parentPath).push(project);
      worktreeSet.add(project.projectPath);
    }
  }

  // Latest activity first on a re-sort (a worktree's sessions count for its
  // parent); otherwise keep the order on screen, new folders at the top.
  if (resort || sortedOrder.length === 0) {
    const activity = (p) => Math.max(lastActivityOf(p.sessions),
      ...(worktreeMap.get(p.projectPath) || []).map(wt => lastActivityOf(wt.sessions)));
    projects = [...projects]
      .map(p => ({ p, t: activity(p) }))
      .sort((a, b) => b.t - a.t || a.p.projectPath.localeCompare(b.p.projectPath))
      .map(({ p }) => p);
  } else {
    const orderIndex = new Map(sortedOrder.map((e, i) => [e.projectPath, i]));
    projects = [...projects].sort((a, b) => {
      const aPos = orderIndex.get(a.projectPath);
      const bPos = orderIndex.get(b.projectPath);
      if (aPos !== undefined && bPos !== undefined) return aPos - bPos;
      if (aPos === undefined && bPos !== undefined) return -1;
      if (aPos !== undefined && bPos === undefined) return 1;
      return 0;
    });
  }

  const newSortedOrder = [];

  for (const project of projects) {
    // Skip worktree projects — they'll be rendered nested under their parent
    if (worktreeSet.has(project.projectPath)) continue;

    const result = processProjectSessions(project, resort);
    if (!result) continue;
    const { filtered, visible, older, sortOrderEntry } = result;
    newSortedOrder.push(sortOrderEntry);
    const fId = folderId(project.projectPath);

    // Build DOM
    const group = document.createElement('div');
    group.className = 'project-group' + (filtered.length === 0 ? ' is-empty' : '');
    group.id = fId;

    const header = document.createElement('div');
    header.className = 'project-header';
    header.id = 'ph-' + fId;
    // A folder that sits inside a project's folder is labelled by the project
    // ("<project> · repos/website") instead of by its last two path segments.
    const rootLabel = typeof projectRootLabel === 'function' ? projectRootLabel(project.projectPath) : null;
    const shortName = rootLabel || shortProjectPath(project.projectPath);
    header.title = project.projectPath;
    if (rootLabel) header.classList.add('project-header--in-project');
    // A project worktree (checked out under <project>/repos/) gets the same
    // branch mark a Claude worktree has.
    const folderMode = typeof projectFolderMode === 'function' ? projectFolderMode(project.projectPath) : null;
    const branchMark = folderMode === 'worktree'
      ? '<span class="worktree-branch-icon project-worktree-icon"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 8c0-2.76-2.46-5-5.5-5S2 5.24 2 8h2l1-1 1 1h4"/><path d="M13 7.14A5.82 5.82 0 0 1 16.5 6c3.04 0 5.5 2.24 5.5 5h-3l-1-1-1 1h-3"/><path d="M5.89 9.71c-2.15 2.15-2.3 5.47-.35 7.43l4.24-4.25.7-.7.71-.71 2.12-2.12c-1.95-1.96-5.27-1.8-7.42.35"/><path d="M11 15.5c.5 2.5-.17 4.5-1 6.5h4c2-5.5-.5-12-1-14"/></svg></span> '
      : '';
    header.innerHTML = `<span class="arrow">&#9660;</span> ${branchMark}<span class="project-name">${escapeHtml(shortName)}</span>`;

    const taskBtn = createProjectTaskButton(project);
    if (taskBtn) header.appendChild(taskBtn);

    // The folder's scheduled tasks: a plain clock opens the dialog for a new
    // one; with schedules it is tinted, counts them, and lists them.
    const scheduleBtn = document.createElement('button');
    scheduleBtn.className = 'project-schedule-btn';
    scheduleBtn.innerHTML = ICONS.schedule(16);
    decorateScheduleButton(scheduleBtn, schedulesForFolder(project.projectPath));
    header.appendChild(scheduleBtn);

    const settingsBtn = document.createElement('button');
    settingsBtn.className = 'project-settings-btn';
    settingsBtn.title = `Folder settings for ${shortName} (CLI options, launch defaults)`;
    settingsBtn.innerHTML = ICONS.gear(16);
    header.appendChild(settingsBtn);

    const archiveGroupBtn = document.createElement('button');
    archiveGroupBtn.className = 'project-archive-btn';
    archiveGroupBtn.title = `Archive all sessions in ${shortName}`;
    archiveGroupBtn.innerHTML = ICONS.archive(18);
    header.appendChild(archiveGroupBtn);

    const newBtn = document.createElement('button');
    newBtn.className = 'project-new-btn';
    newBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5"><line x1="6" y1="2" x2="6" y2="10"/><line x1="2" y1="6" x2="10" y2="6"/></svg>';
    newBtn.title = `New session in ${shortName}`;
    header.appendChild(newBtn);

    const sessionsList = buildSessionsList(fId, visible, older);

    // Auto-collapse if most recent session is older than threshold, or project matched with no sessions
    if (project._projectMatchedOnly) {
      header.classList.add('collapsed');
    } else if (searchMatchIds === null && !showStarredOnly && !showRunningOnly) {
      const mostRecent = filtered[0]?.modified;
      if (mostRecent && (Date.now() - new Date(mostRecent)) > sessionMaxAgeDays * 86400000) {
        header.classList.add('collapsed');
      }
    }

    group.appendChild(header);
    group.appendChild(sessionsList);

    // Render nested worktree sub-groups
    const childWorktrees = worktreeMap.get(project.projectPath) || [];
    for (const wt of childWorktrees) {
      const wtResult = processProjectSessions(wt, resort);
      if (!wtResult) continue;
      newSortedOrder.push(wtResult.sortOrderEntry);

      const wtName = wt.projectPath.match(worktreePattern)?.[2] || wt.projectPath.split('/').pop();
      const wtFId = folderId(wt.projectPath);

      const wtGroup = document.createElement('div');
      wtGroup.className = 'worktree-group';
      wtGroup.id = wtFId;

      const wtHeader = document.createElement('div');
      wtHeader.className = 'worktree-header';
      wtHeader.id = 'ph-' + wtFId;
      wtHeader.innerHTML = `<span class="worktree-branch-icon"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 8c0-2.76-2.46-5-5.5-5S2 5.24 2 8h2l1-1 1 1h4"/><path d="M13 7.14A5.82 5.82 0 0 1 16.5 6c3.04 0 5.5 2.24 5.5 5h-3l-1-1-1 1h-3"/><path d="M5.89 9.71c-2.15 2.15-2.3 5.47-.35 7.43l4.24-4.25.7-.7.71-.71 2.12-2.12c-1.95-1.96-5.27-1.8-7.42.35"/><path d="M11 15.5c.5 2.5-.17 4.5-1 6.5h4c2-5.5-.5-12-1-14"/></svg></span> <span class="worktree-name">${escapeHtml(wtName)}</span>`;

      const wtHideBtn = document.createElement('button');
      wtHideBtn.className = 'worktree-hide-btn';
      wtHideBtn.title = 'Hide this worktree from the sidebar (no files are deleted)';
      wtHideBtn.innerHTML = '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
      wtHeader.appendChild(wtHideBtn);

      const wtTaskBtn = createProjectTaskButton(wt, true);
      if (wtTaskBtn) wtHeader.appendChild(wtTaskBtn);

      const wtNewBtn = document.createElement('button');
      wtNewBtn.className = 'project-new-btn worktree-new-btn';
      wtNewBtn.innerHTML = '<svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5"><line x1="6" y1="2" x2="6" y2="10"/><line x1="2" y1="6" x2="10" y2="6"/></svg>';
      wtNewBtn.title = `New session in worktree ${wtName}`;
      wtHeader.appendChild(wtNewBtn);

      const wtSessionsList = buildSessionsList(wtFId, wtResult.visible, wtResult.older);
      wtSessionsList.className = 'worktree-sessions';

      // Auto-collapse worktree if stale
      if (searchMatchIds === null && !showStarredOnly && !showRunningOnly) {
        const mostRecent = wtResult.filtered[0]?.modified;
        if (mostRecent && (Date.now() - new Date(mostRecent)) > sessionMaxAgeDays * 86400000) {
          wtHeader.classList.add('collapsed');
        }
      }

      wtGroup.appendChild(wtHeader);
      wtGroup.appendChild(wtSessionsList);
      sessionsList.appendChild(wtGroup);
    }

    newSidebar.appendChild(group);
  }

  return { newSortedOrder, boundProjects: projects };
}

// Repository, customer and status modes: a group gathers sessions from any
// number of folders. Each renders like a folder group under a synthetic path
// ("group:<mode>:<key>"), so its row order and collapse state carry across
// renders the same way a folder's do.
function collectGroups(projects, mode) {
  const groups = new Map();
  const statuses = new Map();
  const ensure = (key, label, title) => {
    const path = `group:${mode}:${key}`;
    if (!groups.has(path)) groups.set(path, { path, key, label, title, sessions: [], folders: [], lastActivity: 0 });
    return groups.get(path);
  };

  // Groups that exist whether or not anything is in them.
  if (mode === 'status') {
    for (const status of STATUS_GROUPS) ensure(status.id, status.label, status.description);
  } else if (mode === 'customer') {
    for (const c of customerMapping) ensure('c:' + c.name.toLowerCase(), c.name, `Repositories matching ${c.patterns.join(', ')}`);
    ensure('c:' + OTHER_CUSTOMER.toLowerCase(), OTHER_CUSTOMER, 'Repositories that match no customer in Settings › Customers');
  }

  for (const project of projects) {
    const p = project.projectPath;
    let folderGroup = null;
    if (mode !== 'status') {
      if (isChatFolder(p)) {
        folderGroup = ensure('chats', 'Chats', 'Chats started with New chat, outside any repository');
        folderGroup.chat = true;
      } else if (mode === 'repo') {
        const info = repoInfoByPath.get(p);
        folderGroup = info
          ? ensure(`r:${info.owner}/${info.name}`.toLowerCase(), info.name, `${info.owner}/${info.name}`)
          : ensure('d:' + p, folderBaseName(p), `${p}\n(no git remote)`);
      } else {
        const name = customerFor([repoNameFor(p), folderBaseName(p)], customerMapping);
        folderGroup = ensure('c:' + name.toLowerCase(), name, 'Repositories that match no customer in Settings › Customers');
      }
      folderGroup.folders.push(project);
    }
    for (const session of project.sessions) {
      if (folderGroup) { folderGroup.sessions.push(session); continue; }
      const status = statusOfSession(session);
      statuses.set(session.sessionId, status);
      ensure(status).sessions.push(session);
    }
  }
  if (mode === 'status') renderedStatuses = statuses;

  for (const group of groups.values()) {
    group.lastActivity = lastActivityOf(group.sessions);
    // A repo's + starts in its main checkout: the shortest of its folders,
    // since worktrees sit below it.
    if (mode === 'repo' && !group.chat && group.folders.length) {
      group.newSessionProject = [...group.folders].sort((a, b) => a.projectPath.length - b.projectPath.length)[0];
    }
  }
  return [...groups.values()];
}

// Status groups keep their fixed order (what needs you first). Others sort by
// latest activity on a re-sort, and otherwise keep their place on screen with
// newly appearing groups on top, like folders do.
function orderGroups(groups, mode, resort) {
  if (mode === 'status') {
    const rank = new Map(STATUS_GROUPS.map((s, i) => [s.id, i]));
    return [...groups].sort((a, b) => rank.get(a.key) - rank.get(b.key));
  }
  const byActivity = sortGroupsByActivity(groups);
  if (resort) return byActivity;
  const orderIndex = new Map(sortedOrder.map((e, i) => [e.projectPath, i]));
  const known = byActivity.filter(g => orderIndex.has(g.path)).sort((a, b) => orderIndex.get(a.path) - orderIndex.get(b.path));
  return [...byActivity.filter(g => !orderIndex.has(g.path)), ...known];
}

// Status headers fold; open or shut is remembered per status. Stale starts shut.
const STATUS_FOLDS_KEY = 'statusSectionFolds';
function statusSectionOpen(key) {
  try {
    const saved = JSON.parse(localStorage.getItem(STATUS_FOLDS_KEY) || '{}');
    return key in saved ? !!saved[key] : key !== 'stale';
  } catch { return key !== 'stale'; }
}
function toggleStatusSection(key) {
  try {
    const saved = JSON.parse(localStorage.getItem(STATUS_FOLDS_KEY) || '{}');
    saved[key] = !statusSectionOpen(key);
    localStorage.setItem(STATUS_FOLDS_KEY, JSON.stringify(saved));
  } catch {}
  refreshSidebar();
}

function buildVirtualGroups(newSidebar, projects, resort, mode) {
  const groups = orderGroups(collectGroups(withAllFolders(projects), mode), mode, resort);
  const newSortedOrder = [];
  const boundProjects = [];

  for (const g of groups) {
    const project = { projectPath: g.path, sessions: g.sessions, label: g.label, chat: !!g.chat, newSessionProject: g.newSessionProject || null };
    const result = processProjectSessions(project, resort);
    if (!result) continue;
    const { filtered, visible, older, sortOrderEntry } = result;
    newSortedOrder.push(sortOrderEntry);
    boundProjects.push(project);
    const fId = folderId(g.path);

    // Status: one list with a header per status that has sessions, as in Joris
    // Blaak's fork (ab3bc73); a header folds its sessions away.
    if (mode === 'status') {
      if (!filtered.length) continue;
      // A search or filter shows everything it found, folded or not.
      const open = statusSectionOpen(g.key) || searchMatchIds !== null || showStarredOnly || showRunningOnly;
      const section = document.createElement('div');
      section.className = 'status-section';
      section.id = fId;
      const label = document.createElement('div');
      label.className = `session-section-label session-section-label--${g.key}`;
      label.dataset.statusFold = g.key;
      label.title = `${g.title || g.label}\nClick to ${open ? 'fold' : 'unfold'}`;
      label.innerHTML = `<span class="session-section-fold${open ? '' : ' shut'}"><svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg></span>${escapeHtml(g.label)}<span class="session-section-count">${filtered.length}</span>`;
      section.appendChild(label);
      if (open) section.appendChild(buildSessionsList(fId, visible, older));
      newSidebar.appendChild(section);
      continue;
    }

    const group = document.createElement('div');
    group.className = 'project-group' + (filtered.length === 0 ? ' is-empty' : '');
    group.id = fId;

    const header = document.createElement('div');
    header.className = 'project-header';
    header.id = 'ph-' + fId;
    header.title = g.title || g.label;
    header.innerHTML = `<span class="arrow">&#9660;</span> <span class="project-name">${escapeHtml(g.label)}</span><span class="project-group-count" title="${filtered.length} session${filtered.length === 1 ? '' : 's'} shown">${filtered.length}</span>`;

    const archiveGroupBtn = document.createElement('button');
    archiveGroupBtn.className = 'project-archive-btn';
    archiveGroupBtn.title = `Archive all sessions in ${g.label}`;
    archiveGroupBtn.innerHTML = ICONS.archive(18);
    header.appendChild(archiveGroupBtn);

    if (project.chat || project.newSessionProject) {
      const newBtn = document.createElement('button');
      newBtn.className = 'project-new-btn';
      newBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5"><line x1="6" y1="2" x2="6" y2="10"/><line x1="2" y1="6" x2="10" y2="6"/></svg>';
      newBtn.title = project.chat ? 'New chat' : `New session in ${shortProjectPath(project.newSessionProject.projectPath)}`;
      header.appendChild(newBtn);
    }

    // Collapse what has been quiet past the max age, the Stale group always.
    if (searchMatchIds === null && !showStarredOnly && !showRunningOnly) {
      const quiet = g.lastActivity && (Date.now() - g.lastActivity) > sessionMaxAgeDays * 86400000;
      if (quiet || (mode === 'status' && g.key === 'stale')) header.classList.add('collapsed');
    }

    group.appendChild(header);
    group.appendChild(buildSessionsList(fId, visible, older));
    newSidebar.appendChild(group);
  }

  return { newSortedOrder, boundProjects };
}

function rebindSidebarEvents(projects) {
  for (const project of projects) {
    const fId = folderId(project.projectPath);
    const header = document.getElementById('ph-' + fId);
    if (!header) continue;
    const newBtn = header.querySelector('.project-new-btn');
    if (newBtn) {
      newBtn.onclick = (e) => {
        e.stopPropagation();
        if (project.chat) launchChatSession();
        else showNewSessionPopover(project.newSessionProject || project, newBtn);
      };
    }
    const taskBtn = header.querySelector('.project-task-btn');
    if (taskBtn) {
      taskBtn.onclick = (e) => { e.stopPropagation(); showTaskPopover(project, taskBtn); };
    }
    const scheduleBtn = header.querySelector('.project-schedule-btn');
    if (scheduleBtn) {
      scheduleBtn.onclick = (e) => { e.stopPropagation(); showFolderScheduleMenu(project.projectPath, scheduleBtn); };
    }
    const settingsBtn = header.querySelector('.project-settings-btn');
    if (settingsBtn) {
      settingsBtn.onclick = (e) => { e.stopPropagation(); openSettingsViewer('project', project.projectPath); };
    }
    const archiveGroupBtn = header.querySelector('.project-archive-btn');
    if (archiveGroupBtn) {
      archiveGroupBtn.onclick = async (e) => {
        e.stopPropagation();
        const sessions = project.sessions.filter(s => !s.archived);
        if (sessions.length === 0) return;
        const shortName = project.label || shortProjectPath(project.projectPath);
        if (!confirm(`Archive all ${sessions.length} session${sessions.length > 1 ? 's' : ''} in ${shortName}?`)) return;
        for (const s of sessions) {
          if (activePtyIds.has(s.sessionId)) {
            await window.api.stopSession(s.sessionId);
          }
          await window.api.archiveSession(s.sessionId, 1);
          closeArchivedSession(s.sessionId);
          s.archived = 1;
        }
        pollActiveSessions();
        loadProjects();
      };
    }
    header.onclick = (e) => {
      if (e.target.closest('.project-new-btn') || e.target.closest('.project-archive-btn') || e.target.closest('.project-settings-btn') || e.target.closest('.project-schedule-btn') || e.target.closest('.project-task-btn')) return;
      header.classList.toggle('collapsed');
    };
  }

  // Bind worktree header events
  sidebarContent.querySelectorAll('.worktree-header').forEach(wtHeader => {
    const wtFId = wtHeader.id.replace('ph-', '');
    const wtProject = projects.find(p => folderId(p.projectPath) === wtFId);
    if (!wtProject) return;

    const wtNewBtn = wtHeader.querySelector('.worktree-new-btn');
    if (wtNewBtn) {
      wtNewBtn.onclick = (e) => { e.stopPropagation(); showNewSessionPopover(wtProject, wtNewBtn); };
    }
    const wtTaskBtn = wtHeader.querySelector('.worktree-task-btn');
    if (wtTaskBtn) {
      wtTaskBtn.onclick = (e) => { e.stopPropagation(); showTaskPopover(wtProject, wtTaskBtn); };
    }
    const wtHideBtn = wtHeader.querySelector('.worktree-hide-btn');
    if (wtHideBtn) {
      wtHideBtn.onclick = async (e) => {
        e.stopPropagation();
        const name = wtProject.projectPath.split('/').pop();
        if (!confirm(`Hide worktree "${name}"?\n\nSession files are not deleted.`)) return;
        await window.api.removeProject(wtProject.projectPath);
        loadProjects();
      };
    }
    wtHeader.onclick = (e) => {
      if (e.target.closest('.worktree-new-btn') || e.target.closest('.worktree-hide-btn') || e.target.closest('.project-task-btn')) return;
      wtHeader.classList.toggle('collapsed');
    };
  });

  bindSessionListEvents(sidebarContent);
}

// Per-row handlers for every session list: slug groups, "+N older" toggles and
// the session items themselves. Shared by the Sessions tab (sidebarContent)
// and the Projects tab (projectsContent).
function bindSessionListEvents(container) {
  container.querySelectorAll('.slug-group-header').forEach(header => {
    const archiveBtn = header.querySelector('.slug-group-archive-btn');
    if (archiveBtn) {
      archiveBtn.onclick = async (e) => {
        e.stopPropagation();
        const group = header.parentElement;
        const sessionItems = group.querySelectorAll('.session-item');
        for (const item of sessionItems) {
          const sid = item.dataset.sessionId;
          const session = sessionMap.get(sid);
          if (!session || session.archived) continue;
          if (activePtyIds.has(sid)) await window.api.stopSession(sid);
          await window.api.archiveSession(sid, 1);
          closeArchivedSession(sid);
          session.archived = 1;
        }
        pollActiveSessions();
        loadProjects();
      };
    }
    header.onclick = (e) => {
      if (e.target.closest('.slug-group-archive-btn')) return;
      header.parentElement.classList.toggle('collapsed');
      saveExpandedSlugs();
    };
  });

  container.querySelectorAll('.slug-group-more').forEach(moreBtn => {
    moreBtn.onclick = () => {
      const group = moreBtn.closest('.slug-group');
      if (group) {
        group.classList.remove('collapsed');
        saveExpandedSlugs();
      }
    };
  });

  container.querySelectorAll('[data-status-fold]').forEach(label => {
    label.onclick = () => toggleStatusSection(label.dataset.statusFold);
  });

  container.querySelectorAll('.sessions-more-toggle').forEach(moreBtn => {
    const olderList = moreBtn.nextElementSibling;
    if (!olderList || !olderList.classList.contains('sessions-older')) return;
    const count = olderList.querySelectorAll('.session-item:not(.archived-item)').length;
    const moreLabel = moreBtn.querySelector('.sessions-more-label');
    moreBtn.onclick = (e) => {
      if (e.target.closest('.sessions-older-archive-btn')) return;
      const showing = olderList.style.display !== 'none';
      olderList.style.display = showing ? 'none' : '';
      moreBtn.classList.toggle('expanded', !showing);
      if (moreLabel) moreLabel.textContent = showing ? `+ ${count} older` : '- hide older';
    };

    const archiveOlderBtn = moreBtn.querySelector('.sessions-older-archive-btn');
    if (archiveOlderBtn) {
      archiveOlderBtn.onclick = async (e) => {
        e.stopPropagation();
        const sessions = [...olderList.querySelectorAll('.session-item')]
          .map(item => sessionMap.get(item.dataset.sessionId))
          .filter(session => session && !session.archived);
        if (sessions.length === 0) return;
        if (!confirm(`Archive all ${sessions.length} older session${sessions.length > 1 ? 's' : ''}?`)) return;
        for (const session of sessions) {
          if (activePtyIds.has(session.sessionId)) {
            await window.api.stopSession(session.sessionId);
          }
          await window.api.archiveSession(session.sessionId, 1);
          closeArchivedSession(session.sessionId);
          session.archived = 1;
        }
        pollActiveSessions();
        loadProjects();
      };
    }
  });

  container.querySelectorAll('.session-item').forEach(item => {
    const sessionId = item.dataset.sessionId;
    const session = sessionMap.get(sessionId);
    if (!session) return;

    item.onclick = () => openSession(session);

    const pin = item.querySelector('.session-pin');
    if (pin) {
      pin.onclick = async (e) => {
        e.stopPropagation();
        const { starred } = await window.api.toggleStar(session.sessionId);
        session.starred = starred;
        refreshSidebar({ resort: true });
      };
    }

    const summaryEl = item.querySelector('.session-summary');
    if (summaryEl) {
      summaryEl.ondblclick = (e) => { e.stopPropagation(); startRename(summaryEl, session); };
    }

    const stopBtn = item.querySelector('.session-stop-btn');
    if (stopBtn) {
      stopBtn.onclick = (e) => {
        e.stopPropagation();
        // Nothing to stop on a session that never started: the same control
        // clears the row instead, which is otherwise unremovable.
        if (isDismissibleSession(session.sessionId)) dismissSession(session.sessionId);
        else confirmAndStopSession(session.sessionId);
      };
    }

    const unreadBtn = item.querySelector('.session-unread-btn');
    if (unreadBtn) {
      unreadBtn.onclick = (e) => {
        e.stopPropagation();
        if (responseReadySessions.has(session.sessionId)) {
          clearUnread(session.sessionId);
        } else {
          markUnread(session.sessionId);
        }
        refreshSidebar();
      };
    }

    const forkBtn = item.querySelector('.session-fork-btn');
    if (forkBtn) {
      forkBtn.onclick = async (e) => {
        e.stopPropagation();
        // Find the project for this session
        const project = [...cachedAllProjects, ...cachedProjects].find(p =>
          p.sessions.some(s => s.sessionId === session.sessionId)
        );
        if (project) {
          forkSession(session, project);
        }
      };
    }

    const moreBtn = item.querySelector('.session-more-btn');
    if (moreBtn) {
      moreBtn.onclick = (e) => {
        e.stopPropagation();
        const menuItems = [
          { label: 'Rename session', onClick: () => startRename(item.querySelector('.session-summary'), session) },
          { label: 'Copy session ID', onClick: () => window.api.writeClipboard(session.sessionId) },
        ];
        if (session.type !== 'terminal') {
          menuItems.push(
            { label: 'View messages', onClick: () => showJsonlViewer(session) },
            { label: 'Move to project…', onClick: () => showMovePopover(session, moreBtn) },
          );
          if (!isSessionRunning(session.sessionId)) {
            menuItems.unshift({ label: 'Resume with config…', onClick: () => showResumeSessionDialog(session) });
          }
        }
        if (isDismissibleSession(session.sessionId)) {
          menuItems.push({ label: 'Dismiss session', onClick: () => dismissSession(session.sessionId) });
        }
        showContextMenu(menuItems, { anchor: moreBtn });
      };
    }

    const archiveBtn = item.querySelector('.session-archive-btn');
    if (archiveBtn) {
      archiveBtn.onclick = async (e) => {
        e.stopPropagation();
        const newVal = session.archived ? 0 : 1;
        if (newVal && activePtyIds.has(session.sessionId)) {
          await window.api.stopSession(session.sessionId);
          pollActiveSessions();
        }
        await window.api.archiveSession(session.sessionId, newVal);
        if (newVal) closeArchivedSession(session.sessionId);
        session.archived = newVal;
        loadProjects();
      };
    }
  });

  // Auto-expand slug group if it contains the active session
  if (activeSessionId) {
    const activeItem = container.querySelector(`[data-session-id="${activeSessionId}"]`);
    const collapsedGroup = activeItem?.closest('.slug-group.collapsed');
    if (collapsedGroup) {
      collapsedGroup.classList.remove('collapsed');
      saveExpandedSlugs();
    }
  }
}

function buildSessionItem(session) {
  const item = document.createElement('div');
  item.className = 'session-item';
  item.id = 'si-' + session.sessionId;
  if (session.type === 'terminal') item.classList.add('is-terminal');
  if (session.runtime && session.runtime !== 'claude') item.classList.add('is-' + session.runtime);
  if (session.archived) item.classList.add('archived-item');
  if (activePtyIds.has(session.sessionId)) item.classList.add('has-running-pty');
  if (attentionSessions.has(session.sessionId)) item.classList.add('needs-attention');
  if (responseReadySessions.has(session.sessionId)) item.classList.add('response-ready');
  if (sessionBusyState.get(session.sessionId)) item.classList.add('cli-busy');
  item.dataset.sessionId = session.sessionId;

  const modified = new Date(session.modified);
  const timeStr = formatDate(modified);
  const displayName = cleanDisplayName(session.name || session.aiTitle || session.summary);

  const row = document.createElement('div');
  row.className = 'session-row';

  // Title and star share the top line; status and actions sit below.
  const pin = document.createElement('button');
  pin.className = 'session-pin' + (session.starred ? ' pinned' : '');
  pin.type = 'button';
  pin.title = session.starred ? 'Unstar session' : 'Star session (keeps it at the top of its group)';
  pin.setAttribute('aria-label', pin.title);
  pin.setAttribute('aria-pressed', String(!!session.starred));
  pin.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="${session.starred ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3 2.78 5.63L21 9.54l-4.5 4.39 1.06 6.2L12 17.2l-5.56 2.93 1.06-6.2L3 9.54l6.22-.91L12 3z"/></svg>`;

  // Keep the status dot separate so running, busy and unread updates still apply.
  const mark = document.createElement('span');
  mark.className = 'session-mark';

  const markIcon = document.createElement('span');
  markIcon.className = 'session-mark-icon';
  if (session.type === 'terminal') {
    markIcon.innerHTML = ICONS.terminal(14);
    mark.title = 'Terminal session';
  } else if (session.runtime === 'codex') {
    markIcon.innerHTML = ICONS.codex(14);
    mark.title = 'Codex session';
  } else {
    markIcon.innerHTML = ICONS.claude(14);
    mark.title = 'Claude session';
  }

  const dot = document.createElement('span');
  dot.className = 'session-status-dot' + (activePtyIds.has(session.sessionId) ? ' running' : '');
  mark.append(markIcon, dot);

  const header = document.createElement('div');
  header.className = 'session-header';
  const summaryEl = document.createElement('div');
  summaryEl.className = 'session-summary';
  summaryEl.textContent = displayName;
  header.append(summaryEl, pin);

  // Which project and repo the session is in, except where the group already
  // says which repo.
  let sourceEl = null;
  const owner = typeof projectForSession === 'function' ? projectForSession(session) : null;
  const showRepo = sidebarGroupMode !== 'repo' && session.projectPath
    && !(owner && session.projectPath === owner.project.root);
  if (owner || showRepo) {
    sourceEl = document.createElement('div');
    sourceEl.className = 'session-source';
    const titles = [];
    if (owner) {
      const chip = document.createElement('span');
      chip.className = 'session-project';
      chip.innerHTML = markHtml(owner.project, 13, 'proj-mark--sm');
      const name = document.createElement('span');
      name.className = 'session-project-name';
      name.textContent = owner.project.name;
      chip.appendChild(name);
      sourceEl.appendChild(chip);
      titles.push(`Project: ${owner.project.name}`);
    }
    if (showRepo) {
      const repo = document.createElement('span');
      repo.className = 'session-source-repo';
      repo.textContent = (owner ? '\u00b7 ' : '') + sessionSourceLabel(session.projectPath);
      sourceEl.appendChild(repo);
      titles.push(sessionSourceTitle(session.projectPath));
    }
    sourceEl.title = titles.join('\n');
  }

  const footer = document.createElement('div');
  footer.className = 'session-footer';
  const metaEl = document.createElement('div');
  metaEl.className = 'session-meta';
  // The 30-second ticker updates this span, including the message count.
  const timeEl = document.createElement('span');
  timeEl.className = 'session-time';
  timeEl.title = `Last active ${Number.isFinite(modified.getTime()) ? modified.toLocaleString() : 'unknown'}\nSession ID ${session.sessionId}`;
  timeEl.textContent = timeStr + (session.messageCount ? ' \u00b7 ' + session.messageCount + ' msgs' : '');
  metaEl.append(mark, timeEl);
  // Started by a scheduled task: a clock, with which one and when in its tooltip.
  if (session.scheduleId && typeof scheduleChipHtml === 'function') {
    const chip = document.createElement('span');
    chip.className = 'session-schedule-chip';
    chip.innerHTML = scheduleChipHtml(session, { compact: true });
    metaEl.appendChild(chip);
  }

  // Action buttons container
  const actions = document.createElement('div');
  actions.className = 'session-actions';

  const stopBtn = document.createElement('button');
  const dismissible = typeof isDismissibleSession === 'function' && isDismissibleSession(session.sessionId);
  stopBtn.className = 'session-stop-btn' + (dismissible ? ' session-dismiss-btn' : '');
  stopBtn.title = dismissible ? 'Dismiss: remove this session, it never started' : 'Stop session (ends its process, the conversation is kept)';
  stopBtn.innerHTML = dismissible
    ? '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M3 3l6 6M9 3l-6 6"/></svg>'
    : '<svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor"><rect x="2" y="2" width="8" height="8" rx="1"/></svg>';

  const archiveBtn = document.createElement('button');
  archiveBtn.className = 'session-archive-btn';
  archiveBtn.title = session.archived ? 'Unarchive session' : 'Archive session (stops it if running)';
  archiveBtn.innerHTML = ICONS.archive(16);

  const forkBtn = document.createElement('button');
  forkBtn.className = 'session-fork-btn';
  forkBtn.title = 'Fork: start a new session that continues from this conversation';
  forkBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 3h5v5"/><path d="M8 3h-5v5"/><path d="M21 3l-7.536 7.536a5 5 0 0 0-1.464 3.534v6.93"/><path d="M3 3l7.536 7.536a5 5 0 0 1 1.464 3.534v.93"/></svg>';

  const isUnread = responseReadySessions.has(session.sessionId);
  const unreadBtn = document.createElement('button');
  unreadBtn.className = 'session-unread-btn';
  unreadBtn.title = isUnread ? 'Mark as read' : 'Mark as unread (flag it to come back to)';
  unreadBtn.innerHTML = isUnread ? ICONS.markRead(14) : ICONS.markUnread(14);

  const moreBtn = document.createElement('button');
  moreBtn.className = 'session-more-btn';
  moreBtn.title = 'More actions: rename, copy ID, view messages, move to project';
  moreBtn.setAttribute('aria-haspopup', 'menu');
  moreBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>';

  if (session.type !== 'terminal') {
    actions.append(archiveBtn, forkBtn);
  }
  actions.append(unreadBtn, stopBtn, moreBtn);
  for (const button of actions.children) {
    button.type = 'button';
    button.setAttribute('aria-label', button.title);
  }

  footer.append(metaEl, actions);
  row.append(header);
  if (sourceEl) row.append(sourceEl);
  row.append(footer);
  item.appendChild(row);

  return item;
}

function startRename(summaryEl, session) {
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'session-rename-input';
  input.value = session.name || session.aiTitle || session.summary;

  summaryEl.replaceWith(input);
  input.focus();
  input.select();

  const save = async () => {
    const newName = input.value.trim();
    const fallback = session.aiTitle || session.summary;
    const nameToSave = (newName && newName !== fallback) ? newName : null;
    await window.api.renameSession(session.sessionId, nameToSave);
    session.name = nameToSave;

    const newSummary = document.createElement('div');
    newSummary.className = 'session-summary';
    newSummary.textContent = nameToSave || fallback;
    newSummary.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      startRename(newSummary, session);
    });
    input.replaceWith(newSummary);
  };

  input.addEventListener('blur', save);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') input.blur();
    if (e.key === 'Escape') {
      input.removeEventListener('blur', save);
      const restored = document.createElement('div');
      restored.className = 'session-summary';
      restored.textContent = session.name || session.aiTitle || session.summary;
      restored.addEventListener('dblclick', (ev) => {
        ev.stopPropagation();
        startRename(restored, session);
      });
      input.replaceWith(restored);
    }
  });
}
