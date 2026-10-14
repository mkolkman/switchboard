// Your todo list on a Notion page, read and edited live through the Notion
// API. The page is a plain page, not a database: `## ` headings for the
// sections (This week, Next week, Later, Thinkering Ideas, Archive) between
// dividers, todos as to_do blocks with nested subtasks, and the archive as
// one toggle that holds the done items grouped under week labels. The
// /todo skill writes the same page, so every rule here (the week rotation,
// the archive layout) follows that skill.
//
// GitHub links in a todo tie it to issues and PRs: their state comes from
// github-tracker, and a todo whose issues are all closed and whose PRs are
// all merged or closed is checked off on its own (autoCheck).

const API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2025-09-03';
const PARALLEL = 3; // Notion allows about three requests a second
const APPEND_MAX = 100;

const SECTION_KINDS = [
  ['this', /this week/i],
  ['next', /next week/i],
  ['later', /\blater\b/i],
  ['ideas', /thinkering|ideas/i],
  ['archive', /archive/i],
];
const ACTIVE_KINDS = ['this', 'next', 'later', 'ideas'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// --- Page ids ---

/** The page id in a Notion URL or a bare id, dashed; null when there is none. */
function notionId(input) {
  const text = String(input || '').trim();
  const m = text.replace(/-/g, '').match(/([0-9a-f]{32})(?![0-9a-f])/i);
  if (!m) return null;
  const h = m[1].toLowerCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// --- Rich text ---

const plainOf = (rich) => (rich || []).map(r => r.plain_text ?? r.text?.content ?? '').join('');
const linkOf = (r) => r.href || r.text?.link?.url || null;

/**
 * A todo's text as you edit it: links as [text](url), a link whose text is
 * its URL as the bare URL. A page mention reads as a link to that page, and
 * markdownToRich turns it back into the same mention.
 */
function richToMarkdown(rich) {
  return (rich || []).map(r => {
    const text = r.plain_text ?? r.text?.content ?? '';
    const url = linkOf(r);
    if (!url) return text;
    return text === url ? url : `[${text}](${url})`;
  }).join('');
}

const MD_LINK = /\[([^\]]+)\]\((\S+?)\)|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g;

/**
 * Rich text for an edited todo: [text](url) and bare URLs become links,
 * and a link to a mention from `previous` becomes that mention again.
 */
function markdownToRich(source, previous = []) {
  const mentions = new Map();
  for (const r of previous || []) {
    const url = linkOf(r);
    if (r.type === 'mention' && url) mentions.set(url, r);
  }
  const out = [];
  const pushText = (content, url) => {
    if (!content) return;
    out.push({ type: 'text', text: { content, link: url ? { url } : null } });
  };
  let at = 0;
  const text = String(source || '');
  for (const m of text.matchAll(MD_LINK)) {
    pushText(text.slice(at, m.index));
    const label = m[1] ?? m[3];
    const url = m[2] ?? m[3];
    const mention = mentions.get(url);
    if (mention && (m[3] || label === plainOf([mention]))) out.push(cleanRich(mention));
    else pushText(label, url);
    at = m.index + m[0].length;
  }
  pushText(text.slice(at));
  return out;
}

/** A rich text item from a read, as the API takes it in a write. */
function cleanRich(r) {
  const out = { type: r.type, [r.type]: r[r.type] };
  if (r.annotations) out.annotations = r.annotations;
  return out;
}

/** What the view draws: text runs with their link and the bits of style it shows. */
function segmentsOf(rich) {
  return (rich || []).map(r => ({
    text: r.plain_text ?? r.text?.content ?? '',
    url: linkOf(r),
    mention: r.type === 'mention',
    bold: !!r.annotations?.bold,
    italic: !!r.annotations?.italic,
    strike: !!r.annotations?.strikethrough,
    code: !!r.annotations?.code,
  }));
}

// --- GitHub references ---

const GITHUB_URL = /^https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/(issues|pull)\/(\d+)/i;

/** The GitHub issues and PRs a todo links to, in order, each once. */
function githubRefsIn(rich) {
  const urls = [];
  for (const r of rich || []) {
    const url = linkOf(r);
    if (url) urls.push(url);
    const text = r.plain_text ?? r.text?.content ?? '';
    for (const m of text.matchAll(/https?:\/\/github\.com\/\S+/g)) urls.push(m[0]);
  }
  const seen = new Set();
  const refs = [];
  for (const url of urls) {
    const m = url.match(GITHUB_URL);
    if (!m) continue;
    const key = `${m[1]}/${m[2]}#${m[4]}`;
    if (seen.has(key.toLowerCase())) continue;
    seen.add(key.toLowerCase());
    refs.push({ key, repo: `${m[1]}/${m[2]}`, number: Number(m[4]), kind: m[3].toLowerCase() === 'pull' ? 'pull' : 'issue', url: m[0] });
  }
  return refs;
}

// --- Page shape ---

const richOfBlock = (b) => b?.[b.type]?.rich_text || [];
const isEmptyParagraph = (b) => b.type === 'paragraph' && !plainOf(richOfBlock(b)).trim() && !b.has_children;

/** A to_do block, and its loaded subtasks, as the view shows it. */
function shapeTodo(b) {
  const rich = richOfBlock(b);
  return {
    id: b.id,
    type: b.type,
    checked: b.type === 'to_do' ? !!b.to_do.checked : null,
    text: richToMarkdown(rich),
    segments: segmentsOf(rich),
    refs: githubRefsIn(rich),
    children: (b.children || []).filter(c => !isEmptyParagraph(c)).map(shapeTodo),
  };
}

const sectionKind = (title) => (SECTION_KINDS.find(([, re]) => re.test(title)) || ['other'])[0];

/**
 * The page's sections from its top-level blocks: each `## ` heading starts
 * one and runs to the next divider or heading. `blocks` keeps the raw
 * blocks, which the writes below anchor on.
 */
function shapeSections(topBlocks) {
  const sections = [];
  let current = null;
  for (const b of topBlocks) {
    if (/^heading_[123]$/.test(b.type)) {
      const title = plainOf(richOfBlock(b));
      current = { id: b.id, kind: sectionKind(title), title, heading: b, blocks: [] };
      sections.push(current);
    } else if (b.type === 'divider') {
      current = null;
    } else if (current) {
      current.blocks.push(b);
    }
  }
  for (const s of sections) {
    s.items = s.blocks.filter(b => !isEmptyParagraph(b) && b.type !== 'toggle').map(shapeTodo);
    const toggle = s.blocks.find(b => b.type === 'toggle');
    if (toggle) s.toggle = toggle;
  }
  return sections;
}

/** The sections as the renderer gets them: no raw blocks. */
function publicSections(sections) {
  return sections.map(s => ({
    id: s.id, kind: s.kind, title: s.title, items: s.items,
    archived: s.toggle ? archivedCount(plainOf(richOfBlock(s.toggle))) : null,
  }));
}

const archivedCount = (summary) => {
  const m = String(summary || '').match(/\((\d+)\s+items?\)/i);
  return m ? Number(m[1]) : null;
};

// --- Weeks ---

/** Monday 00:00 (local) of the week `date` is in; Saturday and Sunday belong to the week just past. */
function mondayOf(date) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d;
}

const WEEK_RANGE = /\b([A-Z][a-z]{2})\s+(\d{1,2})\s*[-–—]\s*(?:([A-Z][a-z]{2})\s+)?(\d{1,2})\b/;

/**
 * The first day of a range like "Oct 12-16" or "Sep 28-Oct 02" in a heading.
 * Headings carry no year: it is the latest such date on or before `today`.
 */
function weekStart(heading, today) {
  const m = String(heading || '').match(WEEK_RANGE);
  if (!m) return null;
  const month = MONTHS.indexOf(m[1]);
  if (month < 0) return null;
  const day = Number(m[2]);
  let d = new Date(today.getFullYear(), month, day);
  if (d.getMonth() !== month) return null;
  if (d > today) d = new Date(today.getFullYear() - 1, month, day);
  return d;
}

const dd = (n) => String(n).padStart(2, '0');

/** "Oct 19-23", or "Sep 28-Oct 02" across a month: Monday to Friday of the week starting `monday`. */
function formatWeek(monday) {
  const friday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 4);
  const from = `${MONTHS[monday.getMonth()]} ${dd(monday.getDate())}`;
  return friday.getMonth() === monday.getMonth() ? `${from}-${dd(friday.getDate())}` : `${from}-${MONTHS[friday.getMonth()]} ${dd(friday.getDate())}`;
}

/** A heading with its week range swapped for `range`, or null when it has none. */
function withWeek(heading, range) {
  return WEEK_RANGE.test(heading) ? heading.replace(WEEK_RANGE, range) : null;
}

/**
 * What a new week needs, or null when This week is current (or unreadable,
 * then `unreadable` says so). Checked top-level todos from every active
 * section go to the archive under the old This week label; open Next week
 * todos move into This week; both headings get the current ranges.
 */
function rotationPlan(sections, today) {
  const thisWeek = sections.find(s => s.kind === 'this');
  const nextWeek = sections.find(s => s.kind === 'next');
  if (!thisWeek) return null;
  const start = weekStart(thisWeek.title, today);
  if (!start) return { unreadable: true };
  const monday = mondayOf(today);
  if (mondayOf(start) >= monday) return null;
  const label = thisWeek.title.match(WEEK_RANGE)[0];
  const archive = [];
  for (const s of sections) {
    if (!ACTIVE_KINDS.includes(s.kind)) continue;
    for (const b of s.blocks) if (b.type === 'to_do' && b.to_do.checked) archive.push(b);
  }
  const pull = nextWeek ? nextWeek.blocks.filter(b => b.type === 'to_do' && !b.to_do.checked) : [];
  const following = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 7);
  return {
    label,
    archive,
    pull,
    rolledOver: thisWeek.blocks.filter(b => b.type === 'to_do' && !b.to_do.checked).length,
    thisTitle: withWeek(thisWeek.title, formatWeek(monday)),
    nextTitle: nextWeek ? withWeek(nextWeek.title, formatWeek(following)) : null,
  };
}

// --- Auto check ---

/** A ref's GitHub state counts as done: a closed issue, a merged or closed PR. */
const refDone = (state) => state === 'CLOSED' || state === 'MERGED';

/** Open todos (at any depth) whose GitHub links are all done. */
function autoCheckCandidates(sections, states) {
  const out = [];
  const visit = (item) => {
    if (item.checked === false && item.refs.length && item.refs.every(r => refDone(states[r.key.toLowerCase()]))) out.push(item);
    item.children.forEach(visit);
  };
  for (const s of sections) if (ACTIVE_KINDS.includes(s.kind)) s.items.forEach(visit);
  return out;
}

// --- Notion API ---

function notionClient(token) {
  let running = 0;
  const waiting = [];
  const slot = () => (running < PARALLEL ? Promise.resolve() : new Promise(r => waiting.push(r)));
  const release = () => { running--; waiting.shift()?.(); };
  async function call(method, apiPath, body) {
    await slot();
    running++;
    try {
      for (let attempt = 0; ; attempt++) {
        const res = await fetch(API + apiPath, {
          method,
          headers: { Authorization: `Bearer ${token}`, 'Notion-Version': NOTION_VERSION, 'Content-Type': 'application/json' },
          body: body ? JSON.stringify(body) : undefined,
        });
        if (res.status === 429 && attempt < 4) {
          await new Promise(r => setTimeout(r, (Number(res.headers.get('retry-after')) || 1) * 1000));
          continue;
        }
        const json = await res.json().catch(() => ({}));
        if (res.status === 401) throw new Error('Notion refused the token. Check it in Settings.');
        if (res.status === 404 && /^\/blocks\/[^/]+\/children/.test(apiPath)) {
          throw new Error('Notion cannot find the page. Share it with your integration (••• > Connections).');
        }
        if (!res.ok) throw new Error(json.message || `Notion answered ${res.status}`);
        return json;
      }
    } finally { release(); }
  }
  return { call };
}

async function listChildren(api, id) {
  const out = [];
  let cursor;
  do {
    const page = await api.call('GET', `/blocks/${id}/children?page_size=100${cursor ? `&start_cursor=${cursor}` : ''}`);
    out.push(...page.results);
    cursor = page.has_more ? page.next_cursor : null;
  } while (cursor);
  return out;
}

/** Load `blocks`' children into `.children`, all the way down; toggles (the archive) stay shut. */
async function loadSubtrees(api, blocks) {
  await Promise.all(blocks.map(async (b) => {
    if (!b.has_children || b.type === 'toggle') return;
    b.children = await listChildren(api, b.id);
    await loadSubtrees(api, b.children);
  }));
}

/** A read block as a new block to write, without its children. */
function blockToCreate(b) {
  const content = { ...b[b.type] };
  if (content.rich_text) content.rich_text = content.rich_text.map(cleanRich);
  delete content.children;
  return { object: 'block', type: b.type, [b.type]: content };
}

const todoBlock = (rich, checked = false) => ({ object: 'block', type: 'to_do', to_do: { rich_text: rich, checked, color: 'default' } });
const paragraphBlock = (rich = []) => ({ object: 'block', type: 'paragraph', paragraph: { rich_text: rich, color: 'default' } });
const textRich = (content) => [{ type: 'text', text: { content, link: null } }];

/**
 * Write `blocks` (read blocks with loaded `.children`, or new ones) under
 * `parentId` at `position`, then their children under each new block.
 * One level per request keeps clear of Notion's nesting limit.
 */
async function appendTree(api, parentId, blocks, position) {
  const created = [];
  for (let i = 0; i < blocks.length; i += APPEND_MAX) {
    const chunk = blocks.slice(i, i + APPEND_MAX);
    const at = created.length ? { type: 'after_block', after_block: { id: created[created.length - 1].id } } : position;
    const body = { children: chunk.map(b => (b.id ? blockToCreate(b) : b)) };
    if (at) body.position = at;
    const res = await api.call('PATCH', `/blocks/${parentId}/children`, body);
    created.push(...res.results);
  }
  for (let i = 0; i < blocks.length; i++) {
    const kids = blocks[i].children;
    if (kids?.length) await appendTree(api, created[i].id, kids, null);
  }
  return created;
}

const after = (id) => ({ type: 'after_block', after_block: { id } });

// --- The todo list ---

/** Read the page: its sections with every todo and subtask. */
async function readPage(api, pageId) {
  const top = await listChildren(api, pageId);
  await loadSubtrees(api, top.filter(b => b.type !== 'toggle'));
  return { top, sections: shapeSections(top) };
}

/** A section's last block, which a new todo goes after; empty paragraphs go once it has one. */
async function insertIntoSection(api, pageId, section, blocks) {
  const anchor = section.blocks.length ? section.blocks[section.blocks.length - 1].id : section.id;
  const created = await appendTree(api, pageId, blocks, after(anchor));
  for (const b of section.blocks) if (isEmptyParagraph(b)) await api.call('DELETE', `/blocks/${b.id}`);
  return created;
}

/** Keep `<empty-block/>` in a section whose last todo left. */
async function keepSectionOpen(api, pageId, section, removedIds) {
  const left = section.blocks.filter(b => !removedIds.has(b.id));
  if (!left.length) await appendTree(api, pageId, [paragraphBlock()], after(section.id));
}

async function setHeading(api, heading, title) {
  const rich = richOfBlock(heading);
  const annotations = rich[0]?.annotations;
  await api.call('PATCH', `/blocks/${heading.id}`, {
    [heading.type]: { rich_text: [{ type: 'text', text: { content: title, link: null }, ...(annotations ? { annotations } : {}) }] },
  });
}

const labelText = (b) => plainOf(richOfBlock(b)).replace(/^[\s#]*\u{1F4C5}\s*/u, '').trim();
const isWeekLabel = (b) => (b.type === 'paragraph' || /^heading_/.test(b.type)) && /^\s*\u{1F4C5}/u.test(plainOf(richOfBlock(b)));

/**
 * Archive `blocks` (read todos with loaded children) under the week `label`:
 * into the newest group when it has that label, else as a new group at the
 * top. The summary's count goes up by the number of todos.
 */
async function archiveTodos(api, toggle, blocks, label) {
  if (!blocks.length) return;
  const groups = await listChildren(api, toggle.id);
  const first = groups[0];
  if (first && isWeekLabel(first) && labelText(first) === label) {
    const nextLabel = groups.findIndex((b, i) => i > 0 && isWeekLabel(b));
    const last = groups[(nextLabel < 0 ? groups.length : nextLabel) - 1];
    await appendTree(api, toggle.id, blocks, after(last.id));
  } else {
    await appendTree(api, toggle.id, [paragraphBlock(textRich(`\u{1F4C5} ${label}`)), ...blocks], { type: 'start' });
  }
  const summary = plainOf(richOfBlock(toggle));
  const n = archivedCount(summary);
  if (n !== null) {
    await api.call('PATCH', `/blocks/${toggle.id}`, {
      toggle: { rich_text: textRich(summary.replace(/\(\d+\s+items?\)/i, `(${n + blocks.length} items)`)) },
    });
  }
}

/** The new-week rotation of the /todo skill: archive, roll over, pull in. Returns what it did. */
async function rotate(api, pageId, sections, plan) {
  const thisWeek = sections.find(s => s.kind === 'this');
  const nextWeek = sections.find(s => s.kind === 'next');
  const archive = sections.find(s => s.kind === 'archive');
  // Copy first, delete after: a failure in between leaves a duplicate, never a loss.
  if (plan.archive.length && archive?.toggle) await archiveTodos(api, archive.toggle, plan.archive, plan.label);
  if (plan.pull.length) await insertIntoSection(api, pageId, thisWeek, plan.pull);
  const removed = new Set([...(archive?.toggle ? plan.archive : []), ...plan.pull].map(b => b.id));
  for (const id of removed) await api.call('DELETE', `/blocks/${id}`);
  for (const s of sections) {
    if (ACTIVE_KINDS.includes(s.kind) && s !== thisWeek) await keepSectionOpen(api, pageId, s, removed);
  }
  if (!plan.pull.length) await keepSectionOpen(api, pageId, thisWeek, removed);
  if (plan.thisTitle) await setHeading(api, thisWeek.heading, plan.thisTitle);
  if (plan.nextTitle && nextWeek) await setHeading(api, nextWeek.heading, plan.nextTitle);
  return {
    archived: archive?.toggle ? plan.archive.length : 0,
    rolledOver: plan.rolledOver,
    pulledIn: plan.pull.length,
    label: plan.label,
  };
}

/** Where a block sits: its section, or for a subtask the todo it is under. */
function locate(sections, id) {
  for (const s of sections) {
    const top = s.blocks.find(b => b.id === id);
    if (top) return { section: s, block: top, parent: null };
    const stack = s.blocks.map(b => ({ b, parent: null }));
    while (stack.length) {
      const { b, parent } = stack.pop();
      for (const c of b.children || []) {
        if (c.id === id) return { section: s, block: c, parent: b };
        stack.push({ b: c, parent: b });
      }
    }
  }
  return null;
}

/**
 * Change the list. `op` is one of:
 *   { op: 'check', id, checked }
 *   { op: 'text', id, text }              text as richToMarkdown gives it
 *   { op: 'add', sectionId | parentId, text }
 *   { op: 'delete', id }
 *   { op: 'move', id, sectionId }         a todo with its subtasks, to the end of a section
 */
async function applyEdit(api, pageId, sections, edit) {
  if (edit.op === 'check') {
    await api.call('PATCH', `/blocks/${edit.id}`, { to_do: { checked: !!edit.checked } });
    return;
  }
  if (edit.op === 'add') {
    const block = todoBlock(markdownToRich(edit.text));
    if (edit.parentId) await api.call('PATCH', `/blocks/${edit.parentId}/children`, { children: [block] });
    else {
      const section = sections.find(s => s.id === edit.sectionId);
      if (!section) throw new Error('That section is gone. Refresh the list.');
      await insertIntoSection(api, pageId, section, [block]);
    }
    return;
  }
  const at = locate(sections, edit.id);
  if (!at) throw new Error('That todo is gone. Refresh the list.');
  if (edit.op === 'text') {
    const rich = markdownToRich(edit.text, richOfBlock(at.block));
    await api.call('PATCH', `/blocks/${edit.id}`, { [at.block.type]: { rich_text: rich } });
  } else if (edit.op === 'delete') {
    await api.call('DELETE', `/blocks/${edit.id}`);
    if (!at.parent) await keepSectionOpen(api, pageId, at.section, new Set([edit.id]));
  } else if (edit.op === 'move') {
    const target = sections.find(s => s.id === edit.sectionId);
    if (!target) throw new Error('That section is gone. Refresh the list.');
    if (target === at.section && !at.parent) return;
    await insertIntoSection(api, pageId, target, [at.block]);
    await api.call('DELETE', `/blocks/${edit.id}`);
    if (!at.parent) await keepSectionOpen(api, pageId, at.section, new Set([edit.id]));
  } else {
    throw new Error(`Unknown edit: ${edit.op}`);
  }
}

module.exports = {
  notionId, richToMarkdown, markdownToRich, segmentsOf, githubRefsIn, shapeSections, publicSections,
  mondayOf, weekStart, formatWeek, withWeek, rotationPlan, refDone, autoCheckCandidates, archivedCount,
  notionClient, readPage, rotate, applyEdit,
};
