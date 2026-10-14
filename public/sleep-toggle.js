// --- The sidebar toolbar's "can this Mac sleep?" button ---
// It mirrors `pmset disablesleep` (sleep-control.js): a faint zzz while the
// Mac may sleep, an amber coffee cup while sleep is disabled, so a Mac left
// awake by accident does not go unseen. Clicking flips it. The switch is also
// flipped from a terminal, so the state is read again when the window gets
// focus and once a minute. Hidden on hosts that cannot answer.
// Ported from Joris Blaak's fork (5d93643).

const SLEEP_TOGGLE_POLL_MS = 60 * 1000;
const SLEEP_ICONS = {
  coffee: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2v2"/><path d="M10 2v2"/><path d="M14 2v2"/><path d="M16 8a1 1 0 0 1 1 1v8a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4V9a1 1 0 0 1 1-1h14a4 4 0 1 1 0 8h-1"/></svg>',
  sleep: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11h7l-7 9h7"/><path d="M14 3h6l-6 7h6"/></svg>',
};

function installSleepToggle() {
  const button = document.getElementById('sleep-toggle-btn');
  if (!button) return;
  let disabled = null;
  const render = () => {
    button.hidden = disabled === null;
    button.classList.toggle('sleep-disabled', disabled === true);
    button.innerHTML = disabled ? `${SLEEP_ICONS.coffee}<span>Awake</span>` : SLEEP_ICONS.sleep;
    button.title = disabled
      ? 'Sleep is disabled: this Mac stays awake. Click to allow sleep'
      : 'This Mac can sleep. Click to keep it awake';
  };
  const refresh = async () => {
    if (button.disabled) return;
    disabled = await window.api.getSleepDisabled().catch(() => null);
    render();
  };
  button.addEventListener('click', async () => {
    if (disabled === null || button.disabled) return;
    // The result decides, not the click: it may open a password prompt, and a
    // cancelled one leaves the switch as it was.
    button.disabled = true;
    try { disabled = await window.api.setSleepDisabled(!disabled); } finally { button.disabled = false; }
    render();
  });
  window.addEventListener('focus', refresh);
  setInterval(refresh, SLEEP_TOGGLE_POLL_MS);
  refresh();
}

installSleepToggle();
