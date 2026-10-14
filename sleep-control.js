const { execFile } = require('child_process');

// The Mac's "never sleep" switch, `pmset disablesleep`, for the sidebar toolbar's
// sleep button. Reading needs no privileges. Writing first tries `sudo -n`,
// which is silent when sudoers lets pmset through without a password, and
// otherwise asks through macOS's own administrator dialog; cancelling that
// leaves the switch where it was. Ported from Joris Blaak's fork (5d93643).

const PMSET = '/usr/bin/pmset';

/**
 * True when sleep is disabled, false when it is allowed, null when the output
 * is not pmset's. Only the SleepDisabled flag counts: the "sleep prevented by"
 * list holds temporary assertions (caffeinate and the like) that end on their
 * own and are not what the switch controls.
 */
function parseSleepDisabled(pmsetOutput) {
  const text = String(pmsetOutput || '');
  const match = /^\s*SleepDisabled\s+(\d+)\s*$/m.exec(text);
  if (match) return match[1] !== '0';
  // pmset leaves the line out until the switch has been set once: allowed.
  return /System-wide power settings/.test(text) ? false : null;
}

/** The pmset arguments that put the switch in this position. */
function disableSleepArgs(disabled) {
  return ['disablesleep', disabled ? '1' : '0'];
}

function run(file, args) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: 60000 }, (err, stdout) => resolve(err ? null : stdout));
  });
}

async function isSleepDisabled() {
  if (process.platform !== 'darwin') return null;
  const output = await run(PMSET, ['-g']);
  return output === null ? null : parseSleepDisabled(output);
}

/** Flip the switch, then read it back: the state it is in, whatever the prompt did. */
async function setSleepDisabled(disabled, log) {
  if (process.platform !== 'darwin') return null;
  const args = disableSleepArgs(!!disabled);
  const viaSudo = await run('/usr/bin/sudo', ['-n', PMSET, ...args]);
  if (viaSudo === null) {
    const command = [PMSET, ...args].join(' ');
    const viaPrompt = await run('/usr/bin/osascript', ['-e', `do shell script "${command}" with administrator privileges`]);
    if (viaPrompt === null) log?.info(`[sleep] ${command} not applied (prompt cancelled or failed)`);
  }
  return isSleepDisabled();
}

module.exports = { parseSleepDisabled, disableSleepArgs, isSleepDisabled, setSleepDisabled };
