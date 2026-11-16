// Which app the Help Scout tab works on: Help Scout (helpscout.js), or
// Support Desk (support-desk.js), MoveLab's own inbox that replaces it. Both
// return the same shapes, so the tab (public/helpscout-view.js) and its IPC
// channels stay as they are; each call asks for the backend anew, so switching
// in Settings needs no restart.

const BACKEND_SETTING = 'supportBackend';
const BACKENDS = ['helpscout', 'support-desk'];

/** The saved choice, Help Scout unless Support Desk was picked. */
const backendName = (saved) => (saved === 'support-desk' ? 'support-desk' : 'helpscout');

/** Run a call for the renderer; errors become { error } like the rest of IPC. */
function asResult(promise) {
  return Promise.resolve(promise).then(v => ({ ok: true, ...v })).catch(err => ({ error: err.message || String(err) }));
}

/**
 * The tab's IPC handlers by channel. `backend()` is the module to use now,
 * `attachmentDir()` where a ticket's files go for its sessions, `openPath`
 * opens a file in its app (Electron's shell.openPath: '' or an error).
 */
function helpscoutHandlers({ backend, attachmentDir, openPath }) {
  // A call that throws before returning a promise still answers { error }.
  const call = (fn) => asResult(Promise.resolve().then(fn));
  return {
    'helpscout-inbox': () => call(() => backend().getInbox()),
    'helpscout-conversation': (_e, id) => call(() => backend().getConversation(id)),
    'helpscout-statuses': (_e, ids) => call(() => backend().getStatuses(Array.isArray(ids) ? ids : [])),
    'helpscout-save-draft': (_e, id, spec) => call(() => backend().saveDraft(id, spec || {})),
    'helpscout-send-reply': (_e, id, spec) => call(() => backend().sendReply(id, spec || {})),
    'helpscout-add-note': (_e, id, text) => call(() => backend().addNote(id, String(text || ''))),
    'helpscout-assign': (_e, id, assigneeId) => call(() => backend().assign(id, assigneeId || null)),
    'helpscout-set-status': (_e, id, status) => call(() => backend().setStatus(id, String(status || ''))),
    'helpscout-attachment': (_e, convId, attId) => call(() => backend().getAttachment(convId, attId)),
    'helpscout-open-attachment': (_e, convId, attId, name) => call(async () => {
      const { file } = await backend().openAttachment(convId, attId, String(name || ''));
      const err = await openPath(file);
      if (err) throw new Error(err);
      return {};
    }),
    'helpscout-draft-prompt': (_e, id, extra) => call(() => backend().getDraftPrompt(id, String(extra || ''), attachmentDir())),
    'helpscout-session-attachments': (_e, id) => call(() => backend().getSessionAttachments(id, attachmentDir())),
    'helpscout-set-suggestion': (_e, sid, status) => call(() => backend().setSuggestionStatus(sid, String(status || ''))),
  };
}

/** What the backend modules must both export for the handlers above. */
const BACKEND_METHODS = [
  'getInbox', 'getConversation', 'getStatuses', 'saveDraft', 'sendReply', 'addNote', 'assign', 'setStatus',
  'getAttachment', 'openAttachment', 'getDraftPrompt', 'getSessionAttachments', 'setSuggestionStatus', 'splitDraftReply',
];

module.exports = { BACKEND_SETTING, BACKENDS, BACKEND_METHODS, backendName, asResult, helpscoutHandlers };
