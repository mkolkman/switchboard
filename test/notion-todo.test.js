const test = require('node:test');
const assert = require('node:assert/strict');

const {
  notionId, richToMarkdown, markdownToRich, githubRefsIn, shapeSections, publicSections,
  mondayOf, weekStart, formatWeek, rotationPlan, autoCheckCandidates, readPage, rotate, applyEdit,
} = require('../notion-todo');

// --- An in-memory Notion: blocks under parents, in order ---

const text = (content, url = null) => ({ type: 'text', text: { content, link: url ? { url } : null }, plain_text: content, href: url, annotations: { bold: false } });

function fakeNotion(tree) {
  const blocks = new Map();
  const children = new Map();
  let n = 0;
  const add = (parentId, spec) => {
    const id = `b${++n}`;
    const block = { object: 'block', id, type: spec.type, [spec.type]: { ...spec[spec.type] }, has_children: false };
    if (block[block.type].rich_text) block[block.type].rich_text = block[block.type].rich_text.map(r => ({ plain_text: r.text?.content ?? r.plain_text, href: r.text?.link?.url ?? null, ...r }));
    blocks.set(id, block);
    children.set(id, []);
    return { id, block, kids: spec.children || [] };
  };
  const insert = (parentId, specs, index) => {
    const list = children.get(parentId);
    const made = specs.map(s => add(parentId, s));
    list.splice(index, 0, ...made.map(m => m.id));
    if (blocks.has(parentId)) blocks.get(parentId).has_children = list.length > 0;
    for (const m of made) if (m.kids.length) insert(m.id, m.kids, 0);
    return made.map(m => m.block);
  };
  children.set('page', []);
  insert('page', tree, 0);
  const calls = [];
  const api = {
    calls,
    async call(method, apiPath, body) {
      calls.push([method, apiPath]);
      let m = apiPath.match(/^\/blocks\/([^/?]+)\/children/);
      if (m && method === 'GET') return { results: children.get(m[1]).map(id => blocks.get(id)), has_more: false };
      if (m && method === 'PATCH') {
        const list = children.get(m[1]);
        let index = list.length;
        if (body.position?.type === 'start') index = 0;
        if (body.position?.type === 'after_block') index = list.indexOf(body.position.after_block.id) + 1;
        assert.ok(body.children.every(c => !c.children), 'one level per request');
        return { results: insert(m[1], body.children, index) };
      }
      m = apiPath.match(/^\/blocks\/([^/]+)$/);
      if (m && method === 'DELETE') {
        for (const list of children.values()) { const i = list.indexOf(m[1]); if (i >= 0) list.splice(i, 1); }
        return {};
      }
      if (m && method === 'PATCH') {
        const block = blocks.get(m[1]);
        const patch = body[block.type];
        if (patch.rich_text) patch.rich_text = patch.rich_text.map(r => ({ plain_text: r.text?.content ?? r.plain_text, href: r.text?.link?.url ?? null, ...r }));
        Object.assign(block[block.type], patch);
        return block;
      }
      throw new Error(`fake: ${method} ${apiPath}`);
    },
    // The page as the /todo skill would read it: one line per block, tabs for depth.
    dump(id = 'page', depth = 0) {
      return children.get(id).flatMap(cid => {
        const b = blocks.get(cid);
        const t = (b[b.type].rich_text || []).map(r => r.plain_text).join('');
        const mark = b.type === 'to_do' ? `[${b.to_do.checked ? 'x' : ' '}] ` : b.type === 'divider' ? '---' : b.type.startsWith('heading') ? '## ' : b.type === 'toggle' ? '> ' : '';
        return [`${'\t'.repeat(depth)}${mark}${t}`, ...this.dump(cid, depth + 1)];
      });
    },
  };
  return api;
}

const h2 = (t) => ({ type: 'heading_2', heading_2: { rich_text: [text(t)] } });
const todo = (t, checked = false, kids = [], url = null) => ({ type: 'to_do', to_do: { rich_text: url ? [text(t, url)] : [text(t)], checked }, children: kids });
const para = (t = '') => ({ type: 'paragraph', paragraph: { rich_text: t ? [text(t)] : [] } });
const divider = () => ({ type: 'divider', divider: {} });
const toggle = (t, kids) => ({ type: 'toggle', toggle: { rich_text: [text(t)] }, children: kids });

const DASH = '—';
const samplePage = () => fakeNotion([
  h2(`\u{1F4C5} This week ${DASH} Oct 05-09`),
  todo('done thing', true, [todo('sub done', true, [todo('deep', true)])]),
  todo('open thing', false, [todo('sub', true)]),
  divider(),
  h2(`\u{1F4C5} Next week ${DASH} Oct 12-16`),
  todo('planned'),
  todo('planned and done', true),
  divider(),
  h2('\u{1F52E} Later'),
  todo('someday'),
  divider(),
  h2('\u{1F9EA} Thinkering Ideas'),
  para(),
  divider(),
  h2('\u{1F5C4}️ Archive'),
  toggle('✅ Done (2 items)', [para('\u{1F4C5} Sep 28-Oct 02'), todo('old one', true), todo('old two', true)]),
]);

// --- Pure parts ---

test('notionId reads page links and bare ids', () => {
  assert.equal(notionId('https://app.notion.com/p/1eb94a15c9a2801ea297f5c94c718589'), '1eb94a15-c9a2-801e-a297-f5c94c718589');
  assert.equal(notionId('https://www.notion.so/My-TODO-1eb94a15c9a2801ea297f5c94c718589?pvs=4'), '1eb94a15-c9a2-801e-a297-f5c94c718589');
  assert.equal(notionId('1eb94a15-c9a2-801e-a297-f5c94c718589'), '1eb94a15-c9a2-801e-a297-f5c94c718589');
  assert.equal(notionId('not a page'), null);
});

test('a todo edits as markdown and comes back with its links and mentions', () => {
  const mention = { type: 'mention', mention: { type: 'page', page: { id: 'p1' } }, plain_text: 'Plan', href: 'https://app.notion.com/p/p1', annotations: {} };
  const rich = [text('CityRow ('), text('bouwplan #2201', 'https://github.com/o/r/issues/2201'), text(') see '), mention, text(' and '), text('https://x.io/a', 'https://x.io/a')];
  const md = richToMarkdown(rich);
  assert.equal(md, 'CityRow ([bouwplan #2201](https://github.com/o/r/issues/2201)) see [Plan](https://app.notion.com/p/p1) and https://x.io/a');
  const back = markdownToRich(`${md} plus https://github.com/o/r/pull/9.`, rich);
  assert.deepEqual(back.map(r => r.type === 'mention' ? 'mention' : [r.text.content, r.text.link?.url || null]), [
    ['CityRow (', null], ['bouwplan #2201', 'https://github.com/o/r/issues/2201'], [') see ', null], 'mention',
    [' and ', null], ['https://x.io/a', 'https://x.io/a'], [' plus ', null], ['https://github.com/o/r/pull/9', 'https://github.com/o/r/pull/9'], ['.', null],
  ]);
});

test('githubRefsIn finds issue and PR links once each, in order', () => {
  const refs = githubRefsIn([
    text('#2227', 'https://github.com/MoveLab-Studio/MoveLab-Connect-Web/pull/2227'),
    text(', '),
    text('plan', 'https://github.com/MoveLab-Studio/MoveLab-Connect-Web/issues/2201#issuecomment-1'),
    text(' again https://github.com/MoveLab-Studio/MoveLab-Connect-Web/pull/2227 and helpscout', 'https://secure.helpscout.net/x'),
  ]);
  assert.deepEqual(refs.map(r => [r.key, r.kind]), [
    ['MoveLab-Studio/MoveLab-Connect-Web#2227', 'pull'],
    ['MoveLab-Studio/MoveLab-Connect-Web#2201', 'issue'],
  ]);
});

test('weeks: Mondays, headings without a year, and the short range format', () => {
  const tue = new Date(2026, 9, 13);
  assert.equal(mondayOf(tue).getDate(), 12);
  assert.equal(mondayOf(new Date(2026, 9, 18)).getDate(), 12, 'Sunday is still the week just past');
  assert.deepEqual(weekStart(`This week ${DASH} Oct 12-16`, tue), new Date(2026, 9, 12));
  assert.deepEqual(weekStart('This week - Dec 29-Jan 02', new Date(2027, 0, 1)), new Date(2026, 11, 29));
  assert.equal(weekStart('This week', tue), null);
  assert.equal(formatWeek(new Date(2026, 9, 19)), 'Oct 19-23');
  assert.equal(formatWeek(new Date(2026, 8, 28)), 'Sep 28-Oct 02');
  assert.equal(formatWeek(new Date(2026, 9, 5)), 'Oct 05-09');
});

test('rotationPlan only rotates a past week', async () => {
  const api = samplePage();
  const { sections } = await readPage(api, 'page');
  assert.equal(rotationPlan(sections, new Date(2026, 9, 9)), null, 'still that week');
  const plan = rotationPlan(sections, new Date(2026, 9, 14));
  assert.equal(plan.label, 'Oct 05-09');
  assert.deepEqual(plan.archive.map(b => b.to_do.rich_text[0].plain_text), ['done thing', 'planned and done']);
  assert.deepEqual(plan.pull.map(b => b.to_do.rich_text[0].plain_text), ['planned']);
  assert.equal(plan.thisTitle, `\u{1F4C5} This week ${DASH} Oct 12-16`);
  assert.equal(plan.nextTitle, `\u{1F4C5} Next week ${DASH} Oct 19-23`);
});

test('rotate archives, rolls over and pulls in like /todo does', async () => {
  const api = samplePage();
  const { sections } = await readPage(api, 'page');
  const result = await rotate(api, 'page', sections, rotationPlan(sections, new Date(2026, 9, 14)));
  assert.deepEqual(result, { archived: 2, rolledOver: 1, pulledIn: 1, label: 'Oct 05-09' });
  assert.deepEqual(api.dump(), [
    `## \u{1F4C5} This week ${DASH} Oct 12-16`,
    '[ ] open thing', '\t[x] sub',
    '[ ] planned',
    '---',
    `## \u{1F4C5} Next week ${DASH} Oct 19-23`,
    '',
    '---',
    '## \u{1F52E} Later', '[ ] someday',
    '---',
    '## \u{1F9EA} Thinkering Ideas', '',
    '---',
    '## \u{1F5C4}️ Archive',
    '> ✅ Done (4 items)',
    '\t\u{1F4C5} Oct 05-09',
    '\t[x] done thing', '\t\t[x] sub done', '\t\t\t[x] deep',
    '\t[x] planned and done',
    '\t\u{1F4C5} Sep 28-Oct 02', '\t[x] old one', '\t[x] old two',
  ]);
});

test('rotate adds to the newest archive group when it has the same label', async () => {
  const api = fakeNotion([
    h2(`This week ${DASH} Sep 28-Oct 02`), todo('late one', true), divider(),
    h2('Archive'), toggle('Done (2 items)', [para('\u{1F4C5} Sep 28-Oct 02'), todo('early one', true), para('\u{1F4C5} Sep 21-25'), todo('older', true)]),
  ]);
  const { sections } = await readPage(api, 'page');
  await rotate(api, 'page', sections, rotationPlan(sections, new Date(2026, 9, 6)));
  assert.deepEqual(api.dump().slice(-6), ['> Done (3 items)', '\t\u{1F4C5} Sep 28-Oct 02', '\t[x] early one', '\t[x] late one', '\t\u{1F4C5} Sep 21-25', '\t[x] older']);
  assert.deepEqual(api.dump().slice(0, 3), [`## This week ${DASH} Oct 05-09`, '', '---']);
});

test('edits: add into an empty section, a subtask, move with subtasks, rename, delete', async () => {
  const api = samplePage();
  let { sections } = await readPage(api, 'page');
  const ideas = sections.find(s => s.kind === 'ideas');
  await applyEdit(api, 'page', sections, { op: 'add', sectionId: ideas.id, text: 'try [Kotlin](https://kotlinlang.org)' });
  ({ sections } = await readPage(api, 'page'));
  const open = sections.find(s => s.kind === 'this').items.find(i => i.text === 'open thing');
  await applyEdit(api, 'page', sections, { op: 'add', parentId: open.id, text: 'new sub' });
  ({ sections } = await readPage(api, 'page'));
  const later = sections.find(s => s.kind === 'later');
  await applyEdit(api, 'page', sections, { op: 'move', id: open.id, sectionId: later.id });
  ({ sections } = await readPage(api, 'page'));
  const someday = sections.find(s => s.kind === 'later').items[0];
  await applyEdit(api, 'page', sections, { op: 'text', id: someday.id, text: 'someday soon' });
  const planned = sections.find(s => s.kind === 'next').items.find(i => i.text === 'planned');
  await applyEdit(api, 'page', sections, { op: 'delete', id: planned.id });
  ({ sections } = await readPage(api, 'page'));
  const view = publicSections(sections);
  assert.deepEqual(view.find(s => s.kind === 'ideas').items.map(i => [i.text, i.refs.length]), [['try [Kotlin](https://kotlinlang.org)', 0]]);
  assert.deepEqual(view.find(s => s.kind === 'this').items.map(i => i.text), ['done thing']);
  assert.deepEqual(view.find(s => s.kind === 'later').items.map(i => [i.text, i.children.map(c => c.text)]), [['someday soon', []], ['open thing', ['sub', 'new sub']]]);
  assert.deepEqual(view.find(s => s.kind === 'next').items.map(i => i.text), ['planned and done']);
  assert.equal(view.find(s => s.kind === 'archive').archived, 2);
  assert.ok(!api.dump().slice(api.dump().indexOf('## \u{1F9EA} Thinkering Ideas')).slice(1, 3).includes(''), 'the empty block went');
});

test('autoCheckCandidates: open todos whose every link is done, at any depth', () => {
  const sections = shapeSections([
    { id: 'h', type: 'heading_2', heading_2: { rich_text: [text('This week')] } },
    {
      id: 't1', type: 'to_do', to_do: { checked: false, rich_text: [text('#1', 'https://github.com/o/r/issues/1'), text('#2', 'https://github.com/o/r/pull/2')] },
      children: [{ id: 't2', type: 'to_do', to_do: { checked: false, rich_text: [text('#3', 'https://github.com/o/r/pull/3')] } }],
    },
    { id: 't3', type: 'to_do', to_do: { checked: false, rich_text: [text('no links')] } },
    { id: 't4', type: 'to_do', to_do: { checked: true, rich_text: [text('#1', 'https://github.com/o/r/issues/1')] } },
  ]);
  const ids = (states) => autoCheckCandidates(sections, states).map(i => i.id);
  assert.deepEqual(ids({ 'o/r#1': 'CLOSED', 'o/r#2': 'OPEN', 'o/r#3': 'MERGED' }), ['t2']);
  assert.deepEqual(ids({ 'o/r#1': 'CLOSED', 'o/r#2': 'CLOSED', 'o/r#3': 'OPEN' }), ['t1']);
  assert.deepEqual(ids({ 'o/r#1': 'CLOSED' }), [], 'an unknown state is not done');
});
