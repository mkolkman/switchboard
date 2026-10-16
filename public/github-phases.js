// github-phases.js — the phases of a GitHub-backed plan.
//
// A phase is a group of the plan's issues, taken from one of two places:
// a GitHub issue field (an organisation-wide property such as "Wave") or the
// issues' milestones. Loaded by the renderer as a classic script and required
// by main and the tests, like plan-parser.js.

(function (root) {
  // A field is known by its key: an organisation issue field by its lowercased
  // name, a Project field by "projectId|fieldId" (two Projects can both have
  // a "Status"). Field types that can hold a phase; dates and multi-selects cannot.
  const PHASE_FIELD_TYPES = new Set(['single_select', 'text', 'number']);
  const PREFERRED_FIELD = /^(wave|phase)s?$/i;

  function fieldKey(f) {
    return f.key || String(f.name || '').toLowerCase();
  }

  /** Where phases can come from for this tracker: its usable fields, then milestones. */
  function phaseSources(source) {
    const fields = (source?.issueFields || []).filter(f => PHASE_FIELD_TYPES.has(f.type));
    return [
      ...fields.map(f => ({ kind: 'field', key: fieldKey(f), name: f.name, label: f.label || f.name })),
      { kind: 'milestone', name: null, label: 'Milestones' },
    ];
  }

  /**
   * The source to use: the one picked before if it still exists, else a field
   * called "Wave" or "Phase", else milestones.
   */
  function pickPhaseSource(source, saved) {
    const sources = phaseSources(source);
    if (saved) {
      const match = sources.find(s => s.kind === saved.kind && (s.kind === 'milestone'
        || (saved.key && s.key === saved.key)
        || (!saved.key && s.name.toLowerCase() === String(saved.name || '').toLowerCase())));
      if (match) return match;
    }
    return sources.find(s => s.kind === 'field' && PREFERRED_FIELD.test(s.name)) || sources[sources.length - 1];
  }

  function fieldDefinition(source, key) {
    return (source?.issueFields || []).find(f => fieldKey(f) === key) || null;
  }

  // The phase an item is in for `by`, as { key, title, order, dueOn } or null.
  function phaseOf(item, by, definition) {
    if (by.kind === 'milestone') {
      const m = item.milestone;
      return m ? { key: m.title.trim().toLowerCase(), title: m.title.trim(), dueOn: m.dueOn || null } : null;
    }
    const value = item.fields?.[by.key || String(by.name).toLowerCase()];
    if (!value || value.value === null || value.value === undefined || value.value === '') return null;
    const title = String(value.value).trim();
    const option = definition?.options?.find(o => o.id === value.optionId || o.name.toLowerCase() === title.toLowerCase());
    return { key: title.toLowerCase(), title, order: option ? option.priority : (typeof value.value === 'number' ? value.value : null) };
  }

  /**
   * The plan's phases for `by` (a phaseSources entry; milestones by default).
   * Milestones belong to one repository, so a milestone phase is every
   * milestone with the same title across the plan's repos. A single-select
   * field lists every option, even one no issue has yet, in the option order
   * set on GitHub. Otherwise: due date, then the number in the title
   * ("Wave 2" before "Wave 10"), then first appearance in the plan.
   * Issues without a phase are left out (they show under "No phase").
   */
  function phasesFrom(items, by = { kind: 'milestone' }, definition = null) {
    const byKey = new Map();
    const ensure = (p, first) => {
      if (!byKey.has(p.key)) byKey.set(p.key, { title: p.title, dueOn: null, order: p.order ?? null, first, items: [] });
      return byKey.get(p.key);
    };
    if (by.kind === 'field' && definition?.type === 'single_select') {
      (definition.options || []).forEach((o, i) => ensure({ key: o.name.toLowerCase(), title: o.name, order: o.priority ?? i }, -1));
    }
    (items || []).forEach((item, index) => {
      const p = phaseOf(item, by, definition);
      if (!p) return;
      const phase = ensure(p, index);
      if (phase.first === -1) phase.first = index;
      if (p.dueOn && (!phase.dueOn || p.dueOn < phase.dueOn)) phase.dueOn = p.dueOn;
      phase.items.push(item);
    });
    const num = (t) => { const m = String(t).match(/\d+/); return m ? Number(m[0]) : null; };
    const phases = [...byKey.values()].sort((a, b) => {
      if (a.order !== null || b.order !== null) {
        if (a.order === null) return 1;
        if (b.order === null) return -1;
        if (a.order !== b.order) return a.order - b.order;
      }
      if (a.dueOn || b.dueOn) {
        if (!a.dueOn) return 1;
        if (!b.dueOn) return -1;
        if (a.dueOn !== b.dueOn) return a.dueOn < b.dueOn ? -1 : 1;
      }
      const na = num(a.title), nb = num(b.title);
      if (na !== null && nb !== null && na !== nb) return na - nb;
      if ((na === null) !== (nb === null)) return na === null ? 1 : -1;
      return a.first - b.first;
    });
    for (const p of phases) {
      const counted = p.items.filter(i => i.status !== 'dropped');
      p.total = counted.length;
      p.done = counted.filter(i => i.status === 'done').length;
      p.complete = p.total > 0 && p.done === p.total;
    }
    return phases;
  }

  /** The issues not in any phase for `by`. */
  function unphasedItems(items, by = { kind: 'milestone' }, definition = null) {
    return (items || []).filter(item => !phaseOf(item, by, definition));
  }

  const isOpen = (item) => item.status !== 'done' && item.status !== 'dropped';
  const itemRef = (item) => `${item.repo}#${item.number}`;

  /** Whether `by` takes only phases that already exist: a single-select's options are set on GitHub. */
  function phasesAreFixed(by, definition) {
    return by.kind === 'field' && definition?.type === 'single_select';
  }

  /** The open issues without a phase, the ones a sort session places. */
  function unphasedOpen(unphased) {
    return (unphased || []).filter(i => i.number && !i.isPullRequest && isOpen(i));
  }

  /**
   * The prompt for a session that sorts the plan's open issues without a
   * phase into its phases, or into new ones where none fits. The session
   * writes nothing to GitHub; its answer ends with a <phases> list that
   * phaseAssignmentsFrom reads, and Switchboard makes the changes.
   */
  function phaseSortPrompt(source, { by, def, phases, unphased }) {
    const fixed = phasesAreFixed(by, def);
    const numeric = by.kind === 'field' && def?.type === 'number';
    const holder = by.kind === 'milestone' ? 'milestones' : `the "${by.label || by.name}" field`;
    const read = source.kind === 'issue'
      ? `Read the plan first, comments included: \`gh issue view ${source.url} --comments\`.`
      : `The plan is the GitHub Project ${source.url}. Its README:\n\n${String(source.plan?.body || '(empty)').trim()}`;
    const phaseLines = phases.length
      ? phases.flatMap(p => [`- ${p.title}${p.complete ? ' (done)' : ''}`, ...p.items.slice(0, 8).map(i => `  - ${itemRef(i)}: ${i.title}`)])
      : ['(none yet)'];
    const rule = fixed
      ? `Use only these phases: they are the options of ${holder} and cannot be added from here. An issue that fits none of them goes in the list as "none".`
      : `Put each issue in the phase it belongs to. When none fits, name a new phase in the style of the existing ones${numeric ? ' (a number)' : ''}, and give issues that belong together the same new phase. Prefer an open phase over one that is done.`;
    return [
      `Sort the issues without a phase into the phases of the plan "${source.title}" (${source.url}). Phases are ${holder}.`,
      read,
      '',
      'The phases, with some of their issues:',
      ...phaseLines,
      '',
      'Issues without a phase:',
      ...unphasedOpen(unphased).map(i => `- ${itemRef(i)}: ${i.title}`),
      '',
      `Read each of these issues (\`gh issue view <number> -R <owner/repo>\`) and decide where it goes. ${rule}`,
      'Change nothing on GitHub yourself: Switchboard makes the changes from your answer once I agree.',
      'End your answer with the list, one issue per line, exactly like this:',
      '',
      '<phases>',
      'owner/repo#123 -> Phase title',
      '</phases>',
      '',
      'Above the list, say in a sentence or two why, for any issue that was not obvious.',
    ].join('\n');
  }

  /**
   * The assignments in a sort session's answer: its last <phases> list, read
   * against the plan. A title that matches a phase (case aside) takes that
   * phase's spelling; another is a new phase, unless phases are fixed. Lines
   * for issues that are not waiting for a phase are left out. Returns null
   * when the answer has no list.
   */
  function phaseAssignmentsFrom(text, { by, def, phases, unphased }) {
    const blocks = [...String(text || '').matchAll(/<phases>([\s\S]*?)<\/phases>/gi)];
    if (!blocks.length) return null;
    const fixed = phasesAreFixed(by, def);
    const numeric = by.kind === 'field' && def?.type === 'number';
    const waiting = new Map(unphasedOpen(unphased).map(i => [itemRef(i).toLowerCase(), i]));
    const known = new Map(phases.map(p => [p.title.trim().toLowerCase(), p.title]));
    const assignments = [];
    const skipped = [];
    const seen = new Set();
    for (const line of blocks[blocks.length - 1][1].split('\n')) {
      const m = line.match(/^\s*[-*]?\s*`?([\w.-]+\/[\w.-]+#\d+)`?\s*(?:->|→)\s*(.+?)\s*$/);
      if (!m) continue;
      const item = waiting.get(m[1].toLowerCase());
      if (!item || seen.has(item)) continue;
      seen.add(item);
      const wanted = m[2].replace(/^["'`]+|["'`]+$/g, '').trim();
      if (!wanted || /^none$/i.test(wanted)) { skipped.push({ item, reason: 'no phase fits' }); continue; }
      const existing = known.get(wanted.toLowerCase());
      if (existing) { assignments.push({ item, title: existing, isNew: false }); continue; }
      if (fixed) { skipped.push({ item, reason: `"${wanted}" is not an option` }); continue; }
      if (numeric && !Number.isFinite(Number(wanted))) { skipped.push({ item, reason: `"${wanted}" is not a number` }); continue; }
      assignments.push({ item, title: wanted, isNew: true });
    }
    return { assignments, skipped };
  }

  const api = { phaseSources, pickPhaseSource, fieldDefinition, phasesFrom, unphasedItems, phasesAreFixed, unphasedOpen, phaseSortPrompt, phaseAssignmentsFrom, PHASE_FIELD_TYPES };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else Object.assign(root, api);
})(typeof window !== 'undefined' ? window : globalThis);
