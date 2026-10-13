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

  const api = { phaseSources, pickPhaseSource, fieldDefinition, phasesFrom, unphasedItems, PHASE_FIELD_TYPES };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else Object.assign(root, api);
})(typeof window !== 'undefined' ? window : globalThis);
