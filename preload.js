const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Invoke (request-response)
  getPlans: () => ipcRenderer.invoke('get-plans'),
  readPlan: (filename) => ipcRenderer.invoke('read-plan', filename),
  savePlan: (filePath, content) => ipcRenderer.invoke('save-plan', filePath, content),
  getStats: () => ipcRenderer.invoke('get-stats'),
  refreshStats: () => ipcRenderer.invoke('refresh-stats'),
  getUsage: () => ipcRenderer.invoke('get-usage'),
  getCodexUsage: () => ipcRenderer.invoke('get-codex-usage'),
  getMemories: () => ipcRenderer.invoke('get-memories'),
  readMemory: (filePath) => ipcRenderer.invoke('read-memory', filePath),
  saveMemory: (filePath, content) => ipcRenderer.invoke('save-memory', filePath, content),
  getProjects: (showArchived) => ipcRenderer.invoke('get-projects', showArchived),
  getHarnesses: () => ipcRenderer.invoke('get-harnesses'),
  getCodexModels: () => ipcRenderer.invoke('get-codex-models'),
  getActiveSessions: () => ipcRenderer.invoke('get-active-sessions'),
  getActiveTerminals: () => ipcRenderer.invoke('get-active-terminals'),
  stopSession: (id) => ipcRenderer.invoke('stop-session', id),
  toggleStar: (id) => ipcRenderer.invoke('toggle-star', id),
  renameSession: (id, name) => ipcRenderer.invoke('rename-session', id, name),
  archiveSession: (id, archived) => ipcRenderer.invoke('archive-session', id, archived),
  openTerminal: (id, projectPath, isNew, sessionOptions) => ipcRenderer.invoke('open-terminal', id, projectPath, isNew, sessionOptions),
  search: (type, query, titleOnly) => ipcRenderer.invoke('search', type, query, titleOnly),
  searchSessionIds: (query, sessionIds) => ipcRenderer.invoke('search-session-ids', query, sessionIds),
  readSessionJsonl: (sessionId) => ipcRenderer.invoke('read-session-jsonl', sessionId),
  getSessionLastMessage: (sessionId) => ipcRenderer.invoke('get-session-last-message', sessionId),
  getSessionGlance: (sessionId) => ipcRenderer.invoke('get-session-glance', sessionId),

  // Settings
  getSetting: (key) => ipcRenderer.invoke('get-setting', key),
  setSetting: (key, value) => ipcRenderer.invoke('set-setting', key, value),
  deleteSetting: (key) => ipcRenderer.invoke('delete-setting', key),
  getEffectiveSettings: (projectPath) => ipcRenderer.invoke('get-effective-settings', projectPath),
  getShellProfiles: () => ipcRenderer.invoke('get-shell-profiles'),

  // Project/worktree tasks
  listProjectTasks: (projectPath) => ipcRenderer.invoke('list-project-tasks', projectPath),
  listTasksForProjects: (projectPaths) => ipcRenderer.invoke('list-tasks-for-projects', projectPaths),
  getTaskRun: (projectPath, label) => ipcRenderer.invoke('get-task-run', projectPath, label),
  startTask: (projectPath, label) => ipcRenderer.invoke('start-task', projectPath, label),
  stopTask: (projectPath, label) => ipcRenderer.invoke('stop-task', projectPath, label),
  stopAllTasks: (projectPath) => ipcRenderer.invoke('stop-all-tasks', projectPath),
  restartTask: (projectPath, label) => ipcRenderer.invoke('restart-task', projectPath, label),

  browseFolder: () => ipcRenderer.invoke('browse-folder'),
  addProject: (projectPath) => ipcRenderer.invoke('add-project', projectPath),
  removeProject: (projectPath) => ipcRenderer.invoke('remove-project', projectPath),

  // Projects (a piece of work with a folder on disk; see projects.js)
  getProjectTree: (showArchived) => ipcRenderer.invoke('get-project-tree', showArchived),
  createProject: (spec) => ipcRenderer.invoke('create-project', spec),
  updateProject: (id, patch) => ipcRenderer.invoke('update-project', id, patch),
  deleteProject: (id) => ipcRenderer.invoke('delete-project', id),
  attachProjectFolder: (id, spec) => ipcRenderer.invoke('attach-project-folder', id, spec),
  detachProjectFolder: (id, folderPath, opts) => ipcRenderer.invoke('detach-project-folder', id, folderPath, opts),
  setSessionAssignment: (sessionId, projectId, trackId) => ipcRenderer.invoke('set-session-assignment', sessionId, projectId, trackId),
  getProjectsRoot: () => ipcRenderer.invoke('get-projects-root'),
  getChatFolder: () => ipcRenderer.invoke('get-chat-folder'),
  getRepoInfo: (paths) => ipcRenderer.invoke('get-repo-info', paths),
  getGithubTracker: (ref, opts) => ipcRenderer.invoke('get-github-tracker', ref, opts),
  getGithubPullRequest: (target) => ipcRenderer.invoke('github-pull-request', target),
  getGithubIssue: (target) => ipcRenderer.invoke('github-issue', target),
  getGithubPullRequestFiles: (target) => ipcRenderer.invoke('github-pr-files', target),
  getMyGithubPullRequests: () => ipcRenderer.invoke('github-my-prs'),
  setGithubAutoMerge: (target, opts) => ipcRenderer.invoke('github-set-automerge', target, opts),
  getGithubFileContent: (target, filePath, ref) => ipcRenderer.invoke('github-file-content', target, filePath, ref),
  getSleepDisabled: () => ipcRenderer.invoke('get-sleep-disabled'),
  setSleepDisabled: (disabled) => ipcRenderer.invoke('set-sleep-disabled', disabled),
  getGrafanaConfig: () => ipcRenderer.invoke('grafana-config'),
  saveGrafanaConfig: (spec) => ipcRenderer.invoke('grafana-save-config', spec),
  getGrafanaAlerts: () => ipcRenderer.invoke('grafana-alerts'),
  getGrafanaDashboards: () => ipcRenderer.invoke('grafana-dashboards'),
  getGrafanaVitals: (platform) => ipcRenderer.invoke('grafana-vitals', platform),
  getGrafanaLogs: (spec) => ipcRenderer.invoke('grafana-logs', spec),
  getGrafanaLogContext: (spec) => ipcRenderer.invoke('grafana-log-context', spec),
  getGrafanaAlertSeries: (spec) => ipcRenderer.invoke('grafana-alert-series', spec),
  getGrafanaSessionNote: () => ipcRenderer.invoke('grafana-session-note'),
  getHelpscoutInbox: () => ipcRenderer.invoke('helpscout-inbox'),
  getHelpscoutConversation: (id) => ipcRenderer.invoke('helpscout-conversation', id),
  saveHelpscoutDraft: (id, spec) => ipcRenderer.invoke('helpscout-save-draft', id, spec),
  sendHelpscoutReply: (id, spec) => ipcRenderer.invoke('helpscout-send-reply', id, spec),
  addHelpscoutNote: (id, text) => ipcRenderer.invoke('helpscout-add-note', id, text),
  assignHelpscout: (id, assigneeId) => ipcRenderer.invoke('helpscout-assign', id, assigneeId),
  setHelpscoutStatus: (id, status) => ipcRenderer.invoke('helpscout-set-status', id, status),
  getHelpscoutAttachment: (convId, attId) => ipcRenderer.invoke('helpscout-attachment', convId, attId),
  openHelpscoutAttachment: (convId, attId, name) => ipcRenderer.invoke('helpscout-open-attachment', convId, attId, name),
  getHelpscoutDraftPrompt: (id, extra) => ipcRenderer.invoke('helpscout-draft-prompt', id, extra),
  getHelpscoutDraftReply: (sessionId) => ipcRenderer.invoke('helpscout-draft-reply', sessionId),
  setHelpscoutSuggestion: (sid, status) => ipcRenderer.invoke('helpscout-set-suggestion', sid, status),
  getNotionTodoConfig: () => ipcRenderer.invoke('notion-todo-config'),
  setNotionTodoConfig: (spec) => ipcRenderer.invoke('notion-todo-set-config', spec),
  loadNotionTodo: (opts) => ipcRenderer.invoke('notion-todo-load', opts),
  editNotionTodo: (edit) => ipcRenderer.invoke('notion-todo-edit', edit),
  onNotionTodoChanged: (callback) => {
    ipcRenderer.on('notion-todo-changed', (_event, result) => callback(result));
  },
  getGithubReleaseStatus: (prs, opts) => ipcRenderer.invoke('github-release-status', prs, opts),
  getGithubReviewComments: (target) => ipcRenderer.invoke('github-review-comments', target),
  createGithubReviewComment: (target, spec) => ipcRenderer.invoke('github-create-review-comment', target, spec),
  replyGithubReviewComment: (target, id, body) => ipcRenderer.invoke('github-reply-review-comment', target, id, body),
  addGithubComment: (target, body) => ipcRenderer.invoke('github-add-comment', target, body),
  setGithubThreadResolved: (threadId, resolved) => ipcRenderer.invoke('github-set-thread-resolved', threadId, resolved),
  markGithubReviewed: (target, headOid) => ipcRenderer.invoke('github-mark-reviewed', target, headOid),
  getGithubReviewCandidates: (target) => ipcRenderer.invoke('github-review-candidates', target),
  setGithubReviewRequest: (target, login, on) => ipcRenderer.invoke('github-set-review-request', target, login, on),
  setGithubAutorebase: (target, on) => ipcRenderer.invoke('github-set-autorebase', target, on),
  mergeGithubPullRequest: (target, opts) => ipcRenderer.invoke('github-merge', target, opts),
  setGithubIssueClosed: (target, closed) => ipcRenderer.invoke('github-set-issue-closed', target, closed),
  renameGithubIssue: (target, title) => ipcRenderer.invoke('github-rename-issue', target, title),
  createGithubTodo: (ref, spec) => ipcRenderer.invoke('github-create-todo', ref, spec),
  updateGithubPlan: (ref, body, expectedUpdatedAt) => ipcRenderer.invoke('github-update-plan', ref, body, expectedUpdatedAt),
  setGithubMilestone: (target, title) => ipcRenderer.invoke('github-set-milestone', target, title),
  seedGithubMilestones: (ref, column, opts) => ipcRenderer.invoke('github-seed-milestones', ref, column, opts),
  setGithubField: (target, field, value) => ipcRenderer.invoke('github-set-field', target, field, value),
  seedGithubField: (ref, column, field, opts) => ipcRenderer.invoke('github-seed-field', ref, column, field, opts),
  findLocalClones: (repos, knownPaths) => ipcRenderer.invoke('find-local-clones', repos, knownPaths),
  cloneGithubRepo: (repo) => ipcRenderer.invoke('github-clone-repo', repo),
  getProjectGitStatus: (id, opts) => ipcRenderer.invoke('get-project-git-status', id, opts),
  getProjectGitInfo: (id) => ipcRenderer.invoke('get-project-git-info', id),
  getProjectGitDiff: (id, folderPath, filePath) => ipcRenderer.invoke('get-project-git-diff', id, folderPath, filePath),
  getFolderGitStatus: (folderPath) => ipcRenderer.invoke('get-folder-git-status', folderPath),
  listEnvFiles: (folderPath) => ipcRenderer.invoke('list-env-files', folderPath),
  saveProjectBrief: (id, content) => ipcRenderer.invoke('save-project-brief', id, content),
  createProjectFile: (id, name, content) => ipcRenderer.invoke('create-project-file', id, name, content),
  addProjectFiles: (id, sourcePaths) => ipcRenderer.invoke('add-project-files', id, sourcePaths),
  listRecentProjectFiles: (id) => ipcRenderer.invoke('list-recent-project-files', id),
  getProjectPlan: (id) => ipcRenderer.invoke('get-project-plan', id),
  setPlanItem: (id, kind, line, done) => ipcRenderer.invoke('set-plan-item', id, kind, line, done),
  appendPlanItem: (id, kind, text) => ipcRenderer.invoke('append-plan-item', id, kind, text),
  editPlanItem: (id, kind, line, text) => ipcRenderer.invoke('edit-plan-item', id, kind, line, text),
  adoptPlan: (id, filename, opts) => ipcRenderer.invoke('adopt-plan', id, filename, opts),
  listTemplates: () => ipcRenderer.invoke('list-templates'),
  onProjectPlanChanged: (callback) => {
    ipcRenderer.on('project-plan-changed', (_event, projectId) => callback(projectId));
  },
  listSchedules: () => ipcRenderer.invoke('list-schedules'),
  createSchedule: (spec) => ipcRenderer.invoke('create-schedule', spec),
  updateSchedule: (id, patch) => ipcRenderer.invoke('update-schedule', id, patch),
  deleteSchedule: (id) => ipcRenderer.invoke('delete-schedule', id),
  resolveScheduleLaunch: (id) => ipcRenderer.invoke('resolve-schedule-launch', id),
  getScheduleContext: (spec) => ipcRenderer.invoke('get-schedule-context', spec),
  onScheduleDue: (callback) => {
    ipcRenderer.on('schedule-due', (_event, launch) => callback(launch));
  },
  createTrack: (projectId, spec) => ipcRenderer.invoke('create-track', projectId, spec),
  updateTrack: (id, patch) => ipcRenderer.invoke('update-track', id, patch),
  deleteTrack: (id, options) => ipcRenderer.invoke('delete-track', id, options),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  openPath: (target) => ipcRenderer.invoke('open-path', target),
  writeClipboard: (text) => ipcRenderer.invoke('clipboard-write-text', text),

  // Send (fire-and-forget)
  sendInput: (id, data) => ipcRenderer.send('terminal-input', id, data),
  resizeTerminal: (id, cols, rows) => ipcRenderer.send('terminal-resize', id, cols, rows),
  closeTerminal: (id) => ipcRenderer.send('close-terminal', id),
  sendTaskInput: (projectPath, label, data) => ipcRenderer.send('task-input', projectPath, label, data),
  resizeTask: (projectPath, label, cols, rows) => ipcRenderer.send('task-resize', projectPath, label, cols, rows),

  // Listeners (main → renderer)
  onLaunchSession: (callback) => {
    ipcRenderer.on('launch-session', (_event, launch) => callback(launch));
    ipcRenderer.send('launch-session-ready');
  },
  onTerminalData: (callback) => {
    ipcRenderer.on('terminal-data', (_event, sessionId, data) => callback(sessionId, data));
  },
  onSessionDetected: (callback) => {
    ipcRenderer.on('session-detected', (_event, tempId, realId) => callback(tempId, realId));
  },
  onHarnessesChanged: (callback) => {
    ipcRenderer.on('harnesses-changed', () => callback());
  },
  onProcessExited: (callback) => {
    ipcRenderer.on('process-exited', (_event, sessionId, exitCode, signal, userStopped) =>
      callback(sessionId, exitCode, signal, userStopped));
  },
  onTerminalNotification: (callback) => {
    ipcRenderer.on('terminal-notification', (_event, sessionId, message, kind) => callback(sessionId, message, kind));
  },
  onCliBusyState: (callback) => {
    ipcRenderer.on('cli-busy-state', (_event, sessionId, busy) => callback(sessionId, busy));
  },
  onSessionForked: (callback) => {
    ipcRenderer.on('session-forked', (_event, oldId, newId) => callback(oldId, newId));
  },
  onProjectsChanged: (callback) => {
    ipcRenderer.on('projects-changed', (_e, reason) => callback(reason || 'project'));
  },
  onStatusUpdate: (callback) => {
    ipcRenderer.on('status-update', (_event, text, type) => callback(text, type));
  },
  onTaskOutput: (callback) => {
    ipcRenderer.on('task-output', (_event, projectPath, label, data) => callback(projectPath, label, data));
  },
  onTaskStateChanged: (callback) => {
    ipcRenderer.on('task-state-changed', (_event, run) => callback(run));
  },
  onProjectTasksChanged: (callback) => {
    ipcRenderer.on('project-tasks-changed', (_event, projectPath) => callback(projectPath));
  },
  onFullscreenChanged: (callback) => {
    ipcRenderer.on('fullscreen-changed', (_event, isFullscreen) => callback(isFullscreen));
  },

  // File drag-and-drop
  getPathForFile: (file) => webUtils.getPathForFile(file),

  // Platform
  platform: process.platform,

  // App version
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),

  // Auto-updater
  updaterCheck: () => ipcRenderer.invoke('updater-check'),
  updaterDownload: () => ipcRenderer.invoke('updater-download'),
  updaterInstall: () => ipcRenderer.invoke('updater-install'),
  onUpdaterEvent: (callback) => {
    ipcRenderer.on('updater-event', (_event, type, data) => callback(type, data));
  },

  // MCP bridge (main → renderer)
  onMcpOpenDiff: (callback) => {
    ipcRenderer.on('mcp-open-diff', (_event, sessionId, diffId, data) => callback(sessionId, diffId, data));
  },
  onMcpOpenFile: (callback) => {
    ipcRenderer.on('mcp-open-file', (_event, sessionId, data) => callback(sessionId, data));
  },
  onMcpCloseAllDiffs: (callback) => {
    ipcRenderer.on('mcp-close-all-diffs', (_event, sessionId) => callback(sessionId));
  },
  onPreviewOpen: (callback) => {
    ipcRenderer.on('preview-open', (_event, sessionId, url, source) => callback(sessionId, url, source));
  },
  onMcpCloseTab: (callback) => {
    ipcRenderer.on('mcp-close-tab', (_event, sessionId, diffId) => callback(sessionId, diffId));
  },

  // MCP bridge (renderer → main)
  mcpDiffResponse: (sessionId, diffId, action, editedContent) => {
    ipcRenderer.send('mcp-diff-response', sessionId, diffId, action, editedContent);
  },
  readFileForPanel: (filePath) => ipcRenderer.invoke('read-file-for-panel', filePath),
  openFileExternally: (filePath, projectRoot) => ipcRenderer.invoke('open-file-externally', filePath, projectRoot),
  resolveTerminalFiles: (references, context) => ipcRenderer.invoke('resolve-terminal-files', references, context),
  listProjectDirectory: (projectPath, relativePath) => ipcRenderer.invoke('list-project-directory', projectPath, relativePath),
  readProjectFile: (projectPath, relativePath) => ipcRenderer.invoke('read-project-file', projectPath, relativePath),
  manageProjectEntry: (projectPath, relativePath, action, newName) => ipcRenderer.invoke('manage-project-entry', projectPath, relativePath, action, newName),
  saveFileForPanel: (filePath, content) => ipcRenderer.invoke('save-file-for-panel', filePath, content),
  watchFile: (filePath) => ipcRenderer.invoke('watch-file', filePath),
  unwatchFile: (filePath) => ipcRenderer.invoke('unwatch-file', filePath),
  onFileChanged: (callback) => {
    ipcRenderer.on('file-changed', (_event, filePath) => callback(filePath));
  },
});
