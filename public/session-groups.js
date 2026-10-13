// --- Sidebar grouping ---
// Pure helpers behind the Sessions tab's "Group by" choice: which group a
// session lands in for each mode, and how the customer mapping is written.
// Loaded in the renderer as globals and required by the tests.

const SIDEBAR_GROUP_MODES = [
  { id: 'folder', label: 'Folder' },
  { id: 'repo', label: 'Repository' },
  { id: 'customer', label: 'Customer' },
  { id: 'status', label: 'Status' },
];
const DEFAULT_GROUP_MODE = 'folder';
const OTHER_CUSTOMER = 'Other';

// Shown in this order, which is also the order they need you in.
const STATUS_GROUPS = [
  { id: 'attention', label: 'Needs you', description: 'Waiting for your permission or input' },
  { id: 'unread', label: 'Unread', description: 'Finished a turn you have not looked at yet' },
  { id: 'working', label: 'Working', description: 'The agent is busy right now' },
  { id: 'idle', label: 'Idle', description: 'Running, waiting for your next prompt' },
  { id: 'recent', label: 'Recent', description: 'Not running, active within the session max age' },
  { id: 'stale', label: 'Stale', description: 'Not running, older than the session max age' },
];

function isGroupMode(id) {
  return SIDEBAR_GROUP_MODES.some(m => m.id === id);
}

/** Which status group a session is in. Signals are booleans; times are ms. */
function sessionStatus({ attention, unread, busy, running, modifiedMs, nowMs, maxAgeDays }) {
  if (attention) return 'attention';
  if (unread) return 'unread';
  if (running && busy) return 'working';
  if (running) return 'idle';
  const age = nowMs - (Number.isFinite(modifiedMs) ? modifiedMs : 0);
  return age > maxAgeDays * 86400000 ? 'stale' : 'recent';
}

// `*` is any run of characters, `?` one; everything else is literal.
function globToRegExp(pattern) {
  const escaped = String(pattern).trim()
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp('^' + escaped + '$', 'i');
}

/**
 * The customer mapping as written in Settings, one customer per line:
 * "CityRow: CityRow-*, crgo-*". Blank lines and lines starting with # are
 * skipped; a line without a colon names a customer matched by its own name.
 */
function parseCustomerMapping(text) {
  const customers = [];
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const colon = line.indexOf(':');
    const name = (colon === -1 ? line : line.slice(0, colon)).trim();
    if (!name) continue;
    const patterns = colon === -1
      ? [name]
      : line.slice(colon + 1).split(',').map(p => p.trim()).filter(Boolean);
    const existing = customers.find(c => c.name.toLowerCase() === name.toLowerCase());
    if (existing) existing.patterns.push(...patterns);
    else customers.push({ name, patterns });
  }
  return customers;
}

function formatCustomerMapping(customers) {
  return (customers || []).map(c => `${c.name}: ${c.patterns.join(', ')}`).join('\n');
}

/**
 * The first customer with a pattern matching any of `names` (the repo name,
 * then the folder name), or OTHER_CUSTOMER. Customers are tried in the order
 * they are written, so a more specific line can go first.
 */
function customerFor(names, customers) {
  const candidates = (names || []).filter(Boolean);
  for (const customer of customers || []) {
    for (const pattern of customer.patterns) {
      const re = globToRegExp(pattern);
      if (candidates.some(n => re.test(n))) return customer.name;
    }
  }
  return OTHER_CUSTOMER;
}

/** Last path segment, ignoring a trailing slash or backslash. */
function folderBaseName(projectPath) {
  const parts = String(projectPath || '').split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || String(projectPath || '');
}

/**
 * Groups ordered by their latest activity, newest first. A group without
 * sessions has activity 0 and sinks, in name order among its peers.
 */
function sortGroupsByActivity(groups) {
  return [...groups].sort((a, b) => {
    if (b.lastActivity !== a.lastActivity) return b.lastActivity - a.lastActivity;
    return String(a.label).localeCompare(String(b.label));
  });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    SIDEBAR_GROUP_MODES, DEFAULT_GROUP_MODE, OTHER_CUSTOMER, STATUS_GROUPS,
    isGroupMode, sessionStatus, globToRegExp, parseCustomerMapping, formatCustomerMapping,
    customerFor, folderBaseName, sortGroupsByActivity,
  };
}
