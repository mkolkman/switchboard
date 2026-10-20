// --- Production tab (Observability): the products as one whole ---
// The sidebar lists the products (MLC, NOHRD, WaterRower, CITYROW, Dr. Wolff,
// RP3), each with one dot for its worst signal, unfolding to its components
// with the version in production; Infra at the bottom holds the alerts no
// product owns. A product's page: what runs in production per component, what is on
// its way (internal, beta, staging), its problems (alerts) and what the
// production versions hold. A component's page: the same for one component,
// with a version picker; a backend adds its figures, Logs and the
// dashboards. Problems are a component's alerts and, for a version, its
// Bugsnag errors while it ran: new ones first, each with the version's PRs
// that changed its file, and the error rate against the version before.
// Releases and errors come through observability.js (main); everything
// Grafana from grafana-view.js, which draws the alert, dashboard and logs
// pages and calls in here for the rest. Flags: what the production version
// switches on or off, from its code and the live values (1Password .env for
// a backend, Remote Config for an app), features apart from technical ones.
// Usage: the business figures each backend exports as business_* gauges
// (users, workouts, training, subscriptions), a row on the product's page and
// a Usage page with the rest.
// Depends on: utils.js (escapeHtml), projects-view.js (PICONS),
// grafana-view.js (grafanaViewState, selectGrafana, grafanaAlertRow,
// grafanaVitalsHtml, grafanaService, renderGrafanaMain, renderGrafanaList,
// loadGrafanaVitals, paintGrafanaHeader).

const OBSERVABILITY_POLL_MS = 5 * 60 * 1000;

const observabilityState = {
  overview: null, error: null, loading: null,
  expanded: new Set(), // product ids unfolded in the sidebar
  features: new Map(), // "component|tag" or "component|staging" → { loading } | result | { error }
  problems: new Map(), // "component|tag|rate" → { loading } | Bugsnag errors | { error }
  flags: new Map(), // component id → { loading } | its production version's flags | { error }
  business: null, // product id → its business figures (grafana.js getBusiness), once read
  versions: new Map(), // component id → the tag picked on its page ("staging" for main)
  unfolded: new Set(), // folded-by-default parts opened: "chores:<feature key>", "quiet:<page>", "dash:<component>"
  timer: null,
};

const obsAttr = (value) => escapeHtml(value ?? '').replace(/"/g, '&quot;');
const obsDay = (date) => (date ? new Date(date).toLocaleDateString([], { day: 'numeric', month: 'short' }) : '');

// --- Loading ---

/** The products and their components' releases; one read at a time. */
function loadObservabilityOverview({ force = false } = {}) {
  const s = observabilityState;
  if (s.loading) return s.loading;
  s.loading = window.api.getObservabilityOverview({ force }).then(result => {
    if (result?.error) s.error = result.error;
    else { s.error = null; s.overview = result; loadObservabilityHealth(); }
    return loadObservabilityBusiness();
  }).catch(err => { s.error = err?.message || String(err); }).finally(() => { s.loading = null; });
  return s.loading;
}

/** What a version holds, read once; the page repaints when it comes in. */
function loadObservabilityFeatures(componentId, tag) {
  const s = observabilityState;
  const key = `${componentId}|${tag}`;
  if (s.features.has(key)) return;
  s.features.set(key, { loading: true });
  const spec = tag === 'staging' ? { component: componentId, staging: true } : { component: componentId, tag };
  window.api.getObservabilityFeatures(spec).then(result => {
    s.features.set(key, result || { error: 'No answer.' });
  }).catch(err => s.features.set(key, { error: err?.message || String(err) })).finally(() => {
    if (activeTab === 'grafana') renderGrafanaMain();
  });
}

/** A version's Bugsnag errors (with `rate`, also the events an hour against the version before), read once. */
function loadObservabilityProblems(componentId, tag, rate = false) {
  const s = observabilityState;
  const key = `${componentId}|${tag}|${rate ? 1 : 0}`;
  if (s.problems.has(key)) return;
  s.problems.set(key, { loading: true });
  window.api.getObservabilityProblems({ component: componentId, tag, rate }).then(result => {
    s.problems.set(key, result || { error: 'No answer.' });
  }).catch(err => s.problems.set(key, { error: err?.message || String(err) })).finally(() => {
    if (activeTab !== 'grafana') return;
    renderGrafanaList();
    if (['product', 'component'].includes(grafanaViewState.selected.kind)) renderGrafanaMain();
  });
}

/** Every product's business figures from Prometheus; again on each poll. */
async function loadObservabilityBusiness() {
  if (!grafanaViewState.config?.hasToken) return;
  const result = await window.api.getGrafanaBusiness().catch(() => null);
  if (result && !result.error) observabilityState.business = result.products || {};
}

/** A component's production flags, read once (1Password may ask to unlock). */
function loadObservabilityFlags(componentId) {
  const s = observabilityState;
  if (s.flags.has(componentId)) return;
  s.flags.set(componentId, { loading: true });
  window.api.getObservabilityFlags({ component: componentId }).then(result => {
    s.flags.set(componentId, result || { error: 'No answer.' });
  }).catch(err => s.flags.set(componentId, { error: err?.message || String(err) })).finally(() => {
    if (activeTab === 'grafana' && ['product', 'component'].includes(grafanaViewState.selected.kind)) renderGrafanaMain();
  });
}

/** The production version's errors of every component, for the dots; main paces them to Bugsnag's limit. */
function loadObservabilityHealth() {
  for (const p of observabilityState.overview?.products || []) {
    for (const c of p.components) {
      const prod = !c.error && c.bugsnag?.length ? observabilityProductionTag(c) : null;
      if (prod) loadObservabilityProblems(c.id, prod.tag);
    }
  }
}

/** The production version's errors as far as read (with or without the rate), or null. */
function observabilityProductionProblems(component) {
  const prod = observabilityProductionTag(component);
  if (!prod) return null;
  const s = observabilityState;
  const done = (r) => (r && !r.loading && !r.error ? r : null);
  return done(s.problems.get(`${component.id}|${prod.tag}|1`)) || done(s.problems.get(`${component.id}|${prod.tag}|0`));
}

/** While the tab is open, the releases are read again every few minutes. */
function startObservabilityPolling() {
  clearInterval(observabilityState.timer);
  observabilityState.timer = setInterval(async () => {
    if (activeTab !== 'grafana') return;
    await loadObservabilityOverview();
    // Errors come in over time: read them again, paced.
    for (const [key, value] of observabilityState.problems) if (!value.loading) observabilityState.problems.delete(key);
    await loadObservabilityBusiness();
    loadObservabilityHealth();
    renderGrafanaList();
    if (['product', 'component', 'infra'].includes(grafanaViewState.selected.kind)) renderGrafanaMain();
  }, OBSERVABILITY_POLL_MS);
}

// --- The model ---

function observabilityProduct(id) {
  return observabilityState.overview?.products?.find(p => p.id === id) || null;
}

function observabilityComponent(id) {
  for (const p of observabilityState.overview?.products || []) {
    const c = p.components.find(x => x.id === id);
    if (c) return c;
  }
  return null;
}

/** "NOHRD", "NOHRD · Account": a page's name for the back button. */
function observabilityPlaceLabel(sel) {
  if (!sel) return null;
  if (sel.kind === 'infra') return 'Infra';
  if (sel.kind === 'product') return observabilityProduct(sel.id)?.label || null;
  if (sel.kind === 'component') {
    const c = observabilityComponent(sel.id);
    return c ? `${observabilityProduct(c.product)?.label} · ${c.label}` : null;
  }
  if (sel.kind === 'usage') return `${observabilityProduct(sel.id)?.label || ''} usage`;
  if (sel.kind === 'changes') {
    const [id, tag] = String(sel.id).split('|');
    const c = observabilityComponent(id);
    return c ? `${c.label} ${tag} changes` : null;
  }
  return null;
}

/** A component's alerts: its platform's, narrowed to its service when the alert names services. */
function observabilityAlerts(component) {
  const g = component?.grafana;
  if (!g) return [];
  return (grafanaViewState.alerts || []).filter(a => a.platform === g.platform && (!a.apps?.length || a.apps.includes(g.app)));
}

/** Alerts of a product's components, each once. */
function observabilityProductAlerts(product) {
  const seen = new Map();
  for (const c of product?.components || []) for (const a of observabilityAlerts(c)) seen.set(a.uid, a);
  return [...seen.values()];
}

const OBS_ACTIVE = (a) => a.state === 'firing' || a.state === 'pending';

/** The worst of a list of alerts as a dot: firing, pending (or new errors), or ok. */
function observabilityStatus(alerts, error = null, newErrors = 0) {
  if (alerts.some(a => a.state === 'firing')) return 'firing';
  if (alerts.some(a => a.state === 'pending') || newErrors) return 'pending';
  return error ? 'none' : 'normal';
}

/** New errors in a component's production version (0 until read). */
function observabilityNewErrors(component) {
  return (observabilityProductionProblems(component)?.errors || []).filter(e => e.isNew).length;
}

/** A component's dot. */
function observabilityComponentStatus(c) {
  return observabilityStatus(observabilityAlerts(c), c.error, observabilityNewErrors(c));
}

/** A product's dot: the worst of its components. */
function observabilityProductStatus(p) {
  const order = ['firing', 'pending', 'none', 'normal'];
  return (p?.components || []).map(observabilityComponentStatus).sort((a, b) => order.indexOf(a) - order.indexOf(b))[0] || 'normal';
}

/** The newest tag any of a component's targets runs in production, with its date. */
function observabilityProductionTag(component) {
  const order = (component.tags || []).map(t => t.name); // newest first
  const prod = (component.targets || []).map(t => t.stages?.production).filter(Boolean);
  prod.sort((a, b) => order.indexOf(a.tag) - order.indexOf(b.tag));
  return prod[0] || null;
}

/** The version a component's page opens on: the one picked, else production, else the newest tag. */
function observabilityVersion(component) {
  return observabilityState.versions.get(component.id) || observabilityProductionTag(component)?.tag || component.tags?.[0]?.name || null;
}

// --- Sidebar ---

function renderObservabilityList() {
  if (!grafanaViewContent) return;
  const s = observabilityState;
  const g = grafanaViewState;
  const sel = g.selected;
  const products = s.overview?.products || [];
  const infra = (g.alerts || []).filter(a => !a.platform);
  const row = (attrs, active, dot, title, extra = '', cls = '') => `<button type="button" class="gfv-row${cls}${active ? ' active' : ''}" ${attrs}>
      <span class="gfv-dot gfv-dot--${obsAttr(dot)}"></span><span class="gfv-row-title">${escapeHtml(title)}</span>${extra}</button>`;
  const list = products.map(p => {
    const open = s.expanded.has(p.id) || (sel.kind === 'component' && observabilityComponent(sel.id)?.product === p.id);
    const firing = observabilityProductAlerts(p).filter(OBS_ACTIVE).length + p.components.reduce((n, c) => n + observabilityNewErrors(c), 0);
    const active = s.business?.[p.id]?.users?.active?.['7d']?.now;
    const head = `<div class="obs-prod-row"><button type="button" class="obs-fold" data-obs-fold="${obsAttr(p.id)}" title="${open ? 'Fold' : 'Show the components'}"><span class="ghv-fold${open ? '' : ' shut'}">${PICONS.chevronDown(9)}</span></button>
      ${row(`data-obs-product="${obsAttr(p.id)}"`, sel.kind === 'product' && sel.id === p.id, observabilityProductStatus(p), p.label, `${active != null ? `<span class="obs-side-users" title="Active users, last 7 days">${escapeHtml(obsCount(active))}</span>` : ''}${firing ? `<span class="ghv-count" title="Active alerts and new errors">${firing}</span>` : ''}`)}</div>`;
    const comps = open ? p.components.map(c => {
      const prod = c.error ? null : observabilityProductionTag(c);
      const extra = `<span class="obs-ver" title="${obsAttr(c.error || (prod ? `In production since ${obsDay(prod.date)}` : 'Nothing in production'))}">${escapeHtml(c.error ? '!' : prod?.tag || '–')}</span>`;
      return row(`data-obs-component="${obsAttr(c.id)}"`, sel.kind === 'component' && sel.id === c.id, observabilityComponentStatus(c), c.label, extra, ' obs-comp-row');
    }).join('') : '';
    return head + comps;
  }).join('');
  grafanaViewContent.innerHTML = `
    <div class="ghv-head"><span class="ghv-title">Production</span><span class="ws-flex"></span>
      <button type="button" class="ws-ghost" id="obs-refresh" title="Read the releases and Grafana again">${PICONS.refresh(12)}</button></div>
    ${s.error ? `<div class="ghv-empty gh-error">${escapeHtml(s.error)}</div>` : ''}
    ${g.alertsError ? `<div class="ghv-empty gh-error">${escapeHtml(g.alertsError)}</div>` : ''}
    <div class="ghv-list">
      ${products.length ? list : `<div class="ghv-empty">${s.loading ? 'Loading…' : 'Nothing to show.'}</div>`}
      <div class="obs-sep"></div>
      ${row('data-obs-infra="1"', sel.kind === 'infra', observabilityStatus(infra), 'Infra', infra.filter(OBS_ACTIVE).length ? `<span class="ghv-count">${infra.filter(OBS_ACTIVE).length}</span>` : '')}
    </div>`;
  grafanaViewContent.querySelector('#obs-refresh').onclick = async () => {
    grafanaViewState.config = null;
    observabilityState.features.clear();
    observabilityState.flags.clear();
    await Promise.all([loadObservabilityOverview({ force: true }), loadGrafanaView()]);
    renderGrafanaView();
  };
  grafanaViewContent.querySelectorAll('[data-obs-fold]').forEach(b => {
    b.onclick = () => { const id = b.dataset.obsFold; if (s.expanded.has(id)) s.expanded.delete(id); else s.expanded.add(id); renderObservabilityList(); };
  });
  grafanaViewContent.querySelectorAll('[data-obs-product]').forEach(b => { b.onclick = () => { s.expanded.add(b.dataset.obsProduct); selectGrafana({ kind: 'product', id: b.dataset.obsProduct }); }; });
  grafanaViewContent.querySelectorAll('[data-obs-component]').forEach(b => { b.onclick = () => selectGrafana({ kind: 'component', id: b.dataset.obsComponent }); });
  grafanaViewContent.querySelector('[data-obs-infra]').onclick = () => selectGrafana({ kind: 'infra', id: null });
}

// --- Pieces of the pages ---

/** "50%" for a rollout under way; nothing at 100. */
const obsRollout = (stage) => (stage && stage.rollout < 100 ? ` <span class="obs-rollout" title="Rolled out to ${stage.rollout}%">${stage.rollout}%</span>` : '');

/** One line per target (or the backend's one line): where it runs now. */
function observabilityRunsHtml(component) {
  if (component.error) return `<div class="gh-error obs-err">${escapeHtml(component.error)}</div>`;
  const cells = (t) => ['internal', 'beta', 'production'].map(stage => {
    const at = t.stages?.[stage];
    return `<span class="obs-stage${at ? '' : ' obs-stage--none'}">${at ? `<b>${escapeHtml(at.tag)}</b>${obsRollout(at)} <span class="gh-muted">${escapeHtml(obsDay(at.date))}</span>` : '–'}</span>`;
  }).join('');
  if (component.model === 'tagged') {
    const prod = component.targets[0]?.stages?.production;
    return `<div class="obs-runs"><div class="obs-run"><span class="obs-target">production</span><span class="obs-stage">${prod ? `<b>${escapeHtml(prod.tag)}</b> <span class="gh-muted">deployed ${escapeHtml(obsDay(prod.date))}</span>` : '–'}</span>
        <span class="obs-stage">${component.staging ? `<span class="gh-muted">staging: ${escapeHtml(component.branch)}, deployed ${escapeHtml(obsDay(component.staging.date))}</span>` : ''}</span></div></div>`;
  }
  if (!component.targets.length) return '<div class="gh-muted">No targets in its releases.</div>';
  return `<div class="obs-runs"><div class="obs-run obs-run--h"><span class="obs-target"></span>${['internal', 'beta', 'production'].map(x => `<span class="obs-stage">${x}</span>`).join('')}</div>
      ${component.targets.map(t => `<div class="obs-run"><span class="obs-target" title="${obsAttr(t.name)}">${escapeHtml(t.name)}</span>${cells(t)}</div>`).join('')}</div>`;
}

/** A product page's short form: one line per production tag with the targets on it, then those without one. */
function observabilityProductionHtml(component) {
  if (component.error || component.model === 'tagged') return observabilityRunsHtml(component);
  const order = (component.tags || []).map(t => t.name);
  const byTag = new Map();
  const none = [];
  for (const t of component.targets) {
    const prod = t.stages?.production;
    if (!prod) { none.push(t.name); continue; }
    const key = `${prod.tag}|${prod.rollout}`;
    if (!byTag.has(key)) byTag.set(key, { ...prod, names: [] });
    byTag.get(key).names.push(t.name);
  }
  const lines = [...byTag.values()].sort((a, b) => order.indexOf(a.tag) - order.indexOf(b.tag));
  return `<div class="obs-runs">${lines.map(l => `<div class="obs-prod"><span class="obs-stage"><b>${escapeHtml(l.tag)}</b>${obsRollout(l)} <span class="gh-muted">${escapeHtml(obsDay(l.date))}</span></span><span class="obs-names">${escapeHtml(l.names.join(', '))}</span></div>`).join('')}
      ${none.length ? `<div class="obs-prod"><span class="obs-stage obs-stage--none">not in production</span><span class="obs-names gh-muted">${escapeHtml(none.join(', '))}</span></div>` : ''}</div>`;
}

/** What is on its way: tags on internal or beta newer than production, and staging ahead of production. */
function observabilityComingHtml(component) {
  if (component.error) return '';
  const order = (component.tags || []).map(t => t.name);
  const newer = (a, b) => !b || order.indexOf(a) < order.indexOf(b);
  if (component.model === 'tagged') {
    const key = `${component.id}|staging`;
    const f = observabilityState.features.get(key);
    const count = f && !f.loading && !f.error ? f.groups.reduce((n, g) => n + g.issues.length, 0) + f.other.length : null;
    return component.staging ? `<button type="button" class="obs-coming" data-obs-version="${obsAttr(component.id)}|staging">staging (${escapeHtml(component.branch)}) <span class="gh-muted">${count == null ? '' : count ? `${count} change${count === 1 ? '' : 's'} not in production yet` : 'nothing new'}</span></button>` : '';
  }
  const lines = [];
  for (const t of component.targets) {
    const prod = t.stages?.production?.tag;
    for (const stage of ['beta', 'internal']) {
      const at = t.stages?.[stage];
      if (at && newer(at.tag, prod) && !lines.some(l => l.tag === at.tag && l.stage === stage)) lines.push({ tag: at.tag, stage, date: at.date, targets: [] });
      const line = lines.find(l => l.tag === at?.tag && l.stage === stage);
      if (line && at && newer(at.tag, prod)) line.targets.push(t.name);
    }
  }
  return lines.map(l => `<button type="button" class="obs-coming" data-obs-version="${obsAttr(component.id)}|${obsAttr(l.tag)}"><b>${escapeHtml(l.tag)}</b> on ${escapeHtml(l.stage)} <span class="gh-muted">${escapeHtml(obsDay(l.date))} · ${escapeHtml(l.targets.join(', '))}</span></button>`).join('');
}

const obsLink = (url, text, title = '') => `<button type="button" class="obs-link" data-obs-url="${obsAttr(url)}"${title ? ` title="${obsAttr(title)}"` : ''}>${escapeHtml(text)}</button>`;

/** A version's PRs: per issue under its pitch or map, then the loose PRs, then the upkeep folded. */
function observabilityFeaturesHtml(componentId, tag) {
  const key = `${componentId}|${tag}`;
  const f = observabilityState.features.get(key);
  if (!f || f.loading) return '<div class="gh-muted">Loading…</div>';
  if (f.error) return `<div class="gh-error obs-err">${escapeHtml(f.error)}</div>`;
  if (f.first) return '<div class="gh-muted">The first tag: nothing to compare it with.</div>';
  const prs = (list) => list.map(p => obsLink(p.url, `#${p.number}`, p.title)).join(' ');
  const issueRow = ({ issue, prs: list }) => `<div class="obs-feat">${obsLink(issue.url, `#${issue.number}`)}<span class="obs-feat-t">${escapeHtml(issue.title)}</span><span class="obs-prs">${prs(list)}</span></div>`;
  const prRow = (p) => `<div class="obs-feat">${obsLink(p.url, `#${p.number}`)}<span class="obs-feat-t">${escapeHtml(p.title)}</span></div>`;
  const groups = f.groups.map(g => `${g.parent ? `<div class="obs-parent">${obsLink(g.parent.url, `#${g.parent.number}`)}<span>${escapeHtml(g.parent.title)}</span></div>` : ''}
      <div class="${g.parent ? 'obs-under' : ''}">${g.issues.map(issueRow).join('')}</div>`).join('');
  const choresOpen = observabilityState.unfolded.has(`chores:${key}`);
  const nothing = !f.groups.length && !f.other.length;
  return `<div class="obs-feats">
      ${groups}
      ${f.other.length ? `${f.groups.length ? '<div class="obs-parent obs-parent--plain">Other changes</div>' : ''}${f.other.map(prRow).join('')}` : ''}
      ${nothing ? '<div class="gh-muted">No changes a user would notice.</div>' : ''}
      ${f.chores.length ? `<button type="button" class="obs-chores" data-obs-unfold="chores:${obsAttr(key)}"><span class="ghv-fold${choresOpen ? '' : ' shut'}">${PICONS.chevronDown(9)}</span>Upkeep (${f.chores.length})</button>${choresOpen ? f.chores.map(prRow).join('') : ''}` : ''}
      ${f.truncated ? '<div class="gh-muted">Over 300 commits: the list stops there.</div>' : ''}
      <div class="obs-range gh-muted">${escapeHtml(f.base || '')} → ${escapeHtml(f.head || '')}</div>
    </div>`;
}

/** Alert rows (active ones, the quiet ones folded), or a calm line; `quietOnly` where the active ones show above. */
function observabilityAlertsHtml(alerts, foldId, { quietOnly = false } = {}) {
  const active = alerts.filter(OBS_ACTIVE);
  const quiet = alerts.filter(a => !OBS_ACTIVE(a));
  if (!grafanaViewState.config?.hasToken) return '<div class="gh-muted">Grafana is not connected. <button type="button" class="obs-link" data-obs-connect="1">Connect</button></div>';
  const open = observabilityState.unfolded.has(foldId);
  return `${quietOnly ? '' : active.length ? active.map(grafanaAlertRow).join('') : '<div class="gh-muted">Nothing firing.</div>'}
    ${quiet.length ? `<button type="button" class="obs-chores" data-obs-unfold="${obsAttr(foldId)}"><span class="ghv-fold${open ? '' : ' shut'}">${PICONS.chevronDown(9)}</span>Quiet alert rules (${quiet.length})</button>${open ? quiet.map(grafanaAlertRow).join('') : ''}` : ''}`;
}

const OBS_BUGSNAG_SETUP = 'security add-generic-password -U -s switchboard-bugsnag-token -a bugsnag -w';

/** "31/h since the deploy, 7.5/h on the version before (×4.1)"; the whole backend, also where only part of it is shown. */
function observabilityRateHtml(r) {
  if (!r?.rates) return '';
  const { now, before, hours } = r.rates;
  const fmt = (v) => (v < 10 ? v.toFixed(1) : String(Math.round(v)));
  const ratio = before > 0 ? now / before : null;
  const level = ratio != null && ratio >= 2 && now >= 5 ? 'bad' : ratio != null && ratio >= 1.3 && now >= 2 ? 'warn' : 'ok';
  return `<div class="obs-rate obs-rate--${level}" title="${obsAttr(`Bugsnag events an hour over the first ${Math.round(hours)} hours of each version, the whole project`)}">
      <b>${fmt(now)}/h</b> errors since this version came out, <b>${fmt(before)}/h</b> on the version before${ratio != null && Math.abs(ratio - 1) >= 0.1 ? ` <span class="obs-ratio">×${ratio.toFixed(1)}</span>` : ''}</div>`;
}

/** One Bugsnag error: new or not, what and where, how often, the version's PRs on its file, Bugsnag and Ask Claude. */
function observabilityErrorRow(e, component, tag) {
  const what = [e.errorClass, e.message].filter(Boolean).join(': ');
  return `<div class="obs-error">
      <span class="gfv-dot gfv-dot--${e.isNew ? 'pending' : 'none'}"></span>
      <div class="obs-error-b">
        <div class="obs-error-t" title="${obsAttr(what)}">${e.isNew ? '<span class="obs-new">new</span>' : ''}${escapeHtml(what)}</div>
        <div class="obs-error-m gh-muted">${escapeHtml([e.context, e.file].filter(Boolean).join(' · '))}</div>
      </div>
      <span class="obs-error-n" title="While this version ran">${e.events} event${e.events === 1 ? '' : 's'}${e.users ? ` · ${e.users} user${e.users === 1 ? '' : 's'}` : ''}</span>
      ${e.prs.length ? `<span class="obs-prs" title="PRs of this version that changed ${obsAttr(e.file)}">${e.prs.map(p => obsLink(p.url, `#${p.number}`, p.title)).join(' ')}</span>` : ''}
      ${obsLink(e.url, 'Bugsnag')}
      <button type="button" class="obs-link obs-ask" data-obs-ask="${obsAttr(`${component.id}|${tag}|${e.id}`)}" title="Start a session that looks into this error">Ask Claude</button>
    </div>`;
}

/** A version's Bugsnag errors, at most `limit` (the rest on the component's page). */
function observabilityErrorsHtml(c, tag, { rate = false, limit = null } = {}) {
  if (!c.bugsnag?.length) return '';
  const r = observabilityState.problems.get(`${c.id}|${tag}|${rate ? 1 : 0}`);
  if (!r || r.loading) return '<div class="gh-muted">Reading Bugsnag…</div>';
  if (r.error) return `<div class="gh-error obs-err">${escapeHtml(r.error)}</div>`;
  if (r.noToken) return `<div class="gh-muted">Bugsnag is not connected. In a terminal: <code>${escapeHtml(OBS_BUGSNAG_SETUP)}</code></div>`;
  const list = limit ? r.errors.slice(0, limit) : r.errors;
  const rest = r.errors.length - list.length;
  return `${rate ? observabilityRateHtml(r) : ''}
    ${list.length ? list.map(e => observabilityErrorRow(e, c, tag)).join('') : '<div class="gh-muted">No errors while this version ran.</div>'}
    ${rest > 0 ? `<button type="button" class="obs-chores" data-obs-component="${obsAttr(c.id)}">${rest} more on its page</button>` : ''}`;
}

// --- Flags ---

const obsPill = (value) => `<span class="obs-flag obs-flag--${value === 'on' ? 'on' : value === 'off' ? 'off' : 'val'}">${escapeHtml(value ?? '?')}</span>`;

/** How one platform (or a backend) decides a flag: its value and why. */
function observabilityFlagState(entry) {
  if (!entry) return '';
  if (entry.how === 'debug') return `${obsPill('off')}<span class="gh-muted">debug builds only</span>`;
  if (entry.how === 'fixed') return `${obsPill(entry.value)}<span class="gh-muted">in code</span>`;
  const conditions = (entry.conditions || []).filter(c => c.value !== entry.value)
    .map(c => `${escapeHtml(c.value)} for ${escapeHtml(c.name)}${c.percent != null && c.percent < 100 ? ` (${c.percent}%)` : ''}`);
  return `${obsPill(entry.value)}${conditions.length ? `<span class="obs-flag-cond">${conditions.join(', ')}</span>` : ''}
    ${entry.missing ? '<span class="gh-muted">not in Remote Config</span>' : ''}${entry.notInCode ? '<span class="gh-muted">not read by this version</span>' : ''}`;
}

function observabilityFlagRow(f) {
  const pr = f.pr ? obsLink(f.pr.url, `#${f.pr.number}`, `Added in: ${f.pr.title}`) : '';
  if (f.platforms) {
    const platforms = Object.entries(f.platforms);
    return `<div class="obs-flag-row"><span class="obs-flag-name" title="${obsAttr(platforms.map(([, e]) => e.key).filter(Boolean).join(', '))}">${escapeHtml(f.name)}</span>
        <div class="obs-flag-states">${platforms.map(([p, e]) => `<div class="obs-flag-state">${platforms.length > 1 || p === 'iOS' ? `<span class="obs-flag-plat">${escapeHtml(p)}</span>` : ''}${observabilityFlagState(e)}</div>`).join('')}</div>${pr}</div>`;
  }
  return `<div class="obs-flag-row"><span class="obs-flag-name" title="${obsAttr(f.file || '')}">${escapeHtml(f.name)}</span>
      <div class="obs-flag-states"><div class="obs-flag-state">${obsPill(f.value)}${f.from === 'default' ? '<span class="gh-muted">default, not set in the .env</span>' : ''}</div></div>${pr}</div>`;
}

/** A component's flags: the features, the technical ones folded (or both open on its own page). */
function observabilityFlagsHtml(c, { compact = false } = {}) {
  const r = observabilityState.flags.get(c.id);
  if (!r || r.loading) return '<div class="gh-muted">Reading the flags…</div>';
  if (r.error) return `<div class="gh-error obs-err">${escapeHtml(r.error)}</div>`;
  const features = r.flags.filter(f => f.kind === 'feature');
  const technical = r.flags.filter(f => f.kind === 'technical');
  const techKey = `tech:${c.id}`;
  const techOpen = observabilityState.unfolded.has(techKey);
  const remoteOnlyKey = `rconly:${c.id}`;
  const notes = [];
  if (r.env) notes.push(`<span>Values from 1Password "${escapeHtml(r.env.title)}", last changed ${escapeHtml(obsDay(r.env.updated))}</span>`);
  const late = r.env?.changedAfterDeploy ? `<span class="obs-flag-warn">changed after the deploy of ${escapeHtml(obsDay(r.env.deployed))}: the server may still run the values before it</span>` : '';
  if (late) notes.push(late);
  if (r.envError) notes.push(`<span class="gh-error">${escapeHtml(r.envError)}</span>`);
  if (r.remote) notes.push(`<span>Remote Config of ${escapeHtml(r.remote.project)}${r.remote.updated ? `, last changed ${escapeHtml(obsDay(r.remote.updated))}` : ''}</span>`);
  if (r.remoteError) notes.push(`<span class="gh-error">${escapeHtml(r.remoteError)}</span>`);
  if (compact) {
    // On a product's page: the switchable features that are on for anyone; the rest only counted.
    const entries = (f) => (f.platforms ? Object.values(f.platforms) : [f]);
    const fixed = features.filter(f => entries(f).every(e => e.how === 'fixed' || e.how === 'debug'));
    const live = (f) => entries(f).some(e => e.value !== 'off' || (e.conditions || []).some(x => x.value !== 'off'));
    const on = features.filter(f => !fixed.includes(f) && live(f));
    const off = features.length - fixed.length - on.length;
    const counts = [off && `${off} feature flag${off === 1 ? '' : 's'} off`, fixed.length && `${fixed.length} fixed in code`, technical.length && `${technical.length} technical`].filter(Boolean).join(', ');
    return `${late ? `<div class="obs-flag-notes">${late}</div>` : ''}
      ${on.map(observabilityFlagRow).join('')}
      <div class="obs-feat-more gh-muted">${on.length ? '' : 'No switchable feature on. '}${escapeHtml(counts)}
        <button type="button" class="obs-link" data-obs-component="${obsAttr(c.id)}">All flags ›</button></div>`;
  }
  return `${notes.length ? `<div class="obs-flag-notes gh-muted">${notes.join(' · ')}</div>` : ''}
    ${compact && late ? `<div class="obs-flag-notes">${late}</div>` : ''}
    ${features.length ? features.map(observabilityFlagRow).join('') : '<div class="gh-muted">No feature flags.</div>'}
    ${technical.length ? `<button type="button" class="obs-chores" data-obs-unfold="${obsAttr(techKey)}"><span class="ghv-fold${techOpen ? '' : ' shut'}">${PICONS.chevronDown(9)}</span>Technical (${technical.length})</button>${techOpen ? technical.map(observabilityFlagRow).join('') : ''}` : ''}
    ${r.remoteOnly?.length ? `<button type="button" class="obs-chores" data-obs-unfold="${obsAttr(remoteOnlyKey)}"><span class="ghv-fold${observabilityState.unfolded.has(remoteOnlyKey) ? '' : ' shut'}">${PICONS.chevronDown(9)}</span>Only in Remote Config (${r.remoteOnly.length})</button>
      ${observabilityState.unfolded.has(remoteOnlyKey) ? r.remoteOnly.map(x => `<div class="obs-flag-row"><span class="obs-flag-name">${escapeHtml(x.key)}</span><div class="obs-flag-states"><div class="obs-flag-state">${observabilityFlagState({ how: 'remote', ...x })}</div></div></div>`).join('') : ''}` : ''}`;
}

// --- At a glance ---

/** "just now", "3 h ago", "2 days ago". */
function obsAgo(date) {
  if (!date) return '';
  const hours = (Date.now() - new Date(date).getTime()) / 3600000;
  if (hours < 1) return 'just now';
  if (hours < 24) return `${Math.round(hours)} h ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

/** The backend services of some components, each once (MLC Web and CITYROW's part of it are one). */
function observabilityServices(components) {
  const seen = new Map();
  for (const c of components) if (c.kind === 'backend' && c.grafana) seen.set(`${c.grafana.platform}|${c.grafana.app}`, c.grafana);
  return [...seen.values()];
}

/** The services of the page on screen, whose figures the poll keeps fresh. */
function observabilityPageServices() {
  const sel = grafanaViewState.selected;
  if (sel.kind === 'product') return observabilityServices(observabilityProduct(sel.id)?.components || []);
  if (sel.kind === 'component') return observabilityServices([observabilityComponent(sel.id)].filter(Boolean));
  return [];
}

/** A service's latest value of one of the figures (grafana-view.js GRAFANA_VITALS), or null. */
function observabilityVital(service, key) {
  const series = grafanaViewState.vitals.get(`${service.platform}|${service.app}`)?.[key];
  return series?.length ? series[series.length - 1][1] : null;
}

/** Errors an hour now and on the version before, over the production versions of some components; null before Bugsnag answered. */
function observabilityErrorRates(components) {
  let now = 0;
  let before = 0;
  let any = false;
  const seen = new Set();
  for (const c of components) {
    const prod = c.bugsnag?.length && !c.error ? observabilityProductionTag(c) : null;
    const r = prod && observabilityState.problems.get(`${c.id}|${prod.tag}|1`);
    // Two components on one Bugsnag project (MLC Web and CITYROW's part) count once.
    if (!r?.rates || seen.has(c.bugsnag.join())) continue;
    seen.add(c.bugsnag.join());
    now += r.rates.now;
    before += r.rates.before;
    any = true;
  }
  return any ? { now, before } : null;
}

/** Targets rolling out (under 100%) in production: [{ component, target, tag, rollout, date }]. */
function observabilityRollouts(components) {
  const out = [];
  for (const c of components) {
    for (const t of c.error ? [] : c.targets || []) {
      const prod = t.stages?.production;
      if (prod && prod.rollout < 100) out.push({ component: c, target: t.name, tag: prod.tag, rollout: prod.rollout, date: prod.date });
    }
  }
  return out;
}

/** What waits to go to production: changes on staging, and versions on internal or beta newer than production. */
function observabilityWaiting(components) {
  let changes = 0;
  let versions = 0;
  for (const c of components) {
    if (c.error) continue;
    if (c.model === 'tagged') {
      const f = observabilityState.features.get(`${c.id}|staging`);
      if (f && !f.loading && !f.error) changes += f.groups.reduce((n, g) => n + g.issues.length, 0) + f.other.length;
      continue;
    }
    const order = (c.tags || []).map(t => t.name);
    const waiting = new Set();
    for (const t of c.targets) {
      const prod = t.stages?.production?.tag;
      for (const stage of ['beta', 'internal']) {
        const at = t.stages?.[stage]?.tag;
        if (at && (!prod || order.indexOf(at) < order.indexOf(prod))) waiting.add(at);
      }
    }
    versions += waiting.size;
  }
  return { changes, versions };
}

const obsFmt = (v) => (v < 10 ? v.toFixed(1) : String(Math.round(v)));

/** One figure: a label, the value, a line under it, and how worried to be. */
function obsFigure(label, value, sub = '', level = 'ok', title = '') {
  return `<div class="obs-kpi obs-kpi--${level}"${title ? ` title="${obsAttr(title)}"` : ''}><span class="obs-kpi-l">${escapeHtml(label)}</span><span class="obs-kpi-v">${value}</span><span class="obs-kpi-s">${sub}</span></div>`;
}

/** The figures at the top of a product's (or a component's) page. */
function observabilityKeyFiguresHtml(components) {
  const alerts = [...new Map(components.flatMap(observabilityAlerts).map(a => [a.uid, a])).values()];
  const firing = alerts.filter(a => a.state === 'firing').length;
  const pending = alerts.filter(a => a.state === 'pending').length;
  const newErrors = components.reduce((n, c) => n + observabilityNewErrors(c), 0);
  const rollouts = observabilityRollouts(components);
  const status = firing ? ['bad', `${firing} firing`] : pending || newErrors ? ['warn', [pending && `${pending} pending`, newErrors && `${newErrors} new error${newErrors === 1 ? '' : 's'}`].filter(Boolean).join(', ')] : ['ok', 'All clear'];
  const figures = [obsFigure('Status', escapeHtml(status[1]), alerts.length ? `${alerts.length} alert rule${alerts.length === 1 ? '' : 's'}` : '', status[0])];

  // The newest release of any component.
  const latest = components.map(c => ({ c, prod: c.error ? null : observabilityProductionTag(c) })).filter(x => x.prod).sort((a, b) => new Date(b.prod.date) - new Date(a.prod.date))[0];
  if (latest) figures.push(obsFigure('Latest release', escapeHtml(obsAgo(latest.prod.date)), `${escapeHtml(components.length > 1 ? `${latest.c.label} ` : '')}${escapeHtml(latest.prod.tag)}`, 'ok', obsDay(latest.prod.date)));

  if (components.some(c => c.bugsnag?.length)) {
    const rates = observabilityErrorRates(components);
    const ratio = rates && rates.before > 0 ? rates.now / rates.before : null;
    const level = ratio != null && ratio >= 2 && rates.now >= 5 ? 'bad' : ratio != null && ratio >= 1.3 && rates.now >= 2 ? 'warn' : 'ok';
    figures.push(obsFigure('Errors', rates ? `${obsFmt(rates.now)}/h` : '…', rates ? `${obsFmt(rates.before)}/h before${ratio != null && Math.abs(ratio - 1) >= 0.1 ? ` · ×${ratio.toFixed(1)}` : ''}` : 'reading Bugsnag', level, 'Bugsnag events an hour since the production version came out, against the version before'));
    figures.push(obsFigure('New errors', String(newErrors), 'since the release', newErrors ? 'warn' : 'ok'));
  }

  // Grafana's figures over the backends: requests added up, the worst 5xx and p95.
  const services = observabilityServices(components);
  if (services.length && grafanaViewState.config?.hasToken) {
    const values = (key) => services.map(sv => observabilityVital(sv, key)).filter(v => v != null);
    const req = values('requests');
    const err = values('errors5xx');
    const p95 = values('p95');
    const unit = (key) => GRAFANA_VITALS.find(m => m.key === key);
    const lvl = (key, v) => { const m = unit(key); return m.bad != null && v >= m.bad ? 'bad' : m.warn != null && v >= m.warn ? 'warn' : 'ok'; };
    if (req.length) figures.push(obsFigure('Requests', unit('requests').unit(req.reduce((a, b) => a + b, 0)), 'last minute'));
    if (err.length) figures.push(obsFigure('5xx', unit('errors5xx').unit(Math.max(...err)), 'worst service', lvl('errors5xx', Math.max(...err))));
    if (p95.length) figures.push(obsFigure('p95', unit('p95').unit(Math.max(...p95)), 'slowest service', lvl('p95', Math.max(...p95))));
  }

  if (rollouts.length) figures.push(obsFigure('Rolling out', String(rollouts.length), rollouts.slice(0, 2).map(r => `${r.target} ${r.rollout}%`).join(', '), 'info'));
  const waiting = observabilityWaiting(components);
  if (waiting.changes || waiting.versions) {
    figures.push(obsFigure('Waiting', String(waiting.changes + waiting.versions), [waiting.changes && `${waiting.changes} change${waiting.changes === 1 ? '' : 's'} on staging`, waiting.versions && `${waiting.versions} version${waiting.versions === 1 ? '' : 's'} in testing`].filter(Boolean).join(', '), 'info'));
  }
  return `<div class="obs-kpis">${figures.join('')}</div>`;
}

/** What wants a look now: firing alerts, new errors, a jump in errors, rollouts under way, an .env changed after its deploy. */
function observabilityAttentionHtml(components) {
  const rows = [];
  const alerts = [...new Map(components.flatMap(observabilityAlerts).filter(OBS_ACTIVE).map(a => [a.uid, a])).values()];
  rows.push(...alerts.map(grafanaAlertRow));
  const seenErrors = new Set();
  for (const c of components) {
    const prod = observabilityProductionTag(c);
    const problems = observabilityProductionProblems(c);
    for (const e of (problems?.errors || []).filter(x => x.isNew)) {
      if (seenErrors.has(e.id)) continue;
      seenErrors.add(e.id);
      rows.push(observabilityErrorRow(e, c, prod.tag));
    }
  }
  for (const c of components) {
    const r = observabilityState.problems.get(`${c.id}|${observabilityProductionTag(c)?.tag}|1`);
    const ratio = r?.rates?.before > 0 ? r.rates.now / r.rates.before : null;
    if (ratio != null && ratio >= 2 && r.rates.now >= 5) {
      rows.push(`<div class="obs-att"><span class="gfv-dot gfv-dot--firing"></span><span class="obs-att-t">${escapeHtml(c.label)}: ${obsFmt(r.rates.now)} errors/h since ${escapeHtml(observabilityProductionTag(c).tag)}, ×${ratio.toFixed(1)} the version before</span><button type="button" class="obs-link" data-obs-component="${obsAttr(c.id)}">Errors</button></div>`);
    }
  }
  for (const r of observabilityRollouts(components)) {
    rows.push(`<div class="obs-att"><span class="gfv-dot gfv-dot--info"></span><span class="obs-att-t">${escapeHtml(r.component.label)} ${escapeHtml(r.target)}: ${escapeHtml(r.tag)} rolled out to ${r.rollout}%, started ${escapeHtml(obsAgo(r.date))}</span><button type="button" class="obs-link" data-obs-component="${obsAttr(r.component.id)}">Where it runs</button></div>`);
  }
  for (const c of components) {
    const f = observabilityState.flags.get(c.id);
    if (f?.env?.changedAfterDeploy) rows.push(`<div class="obs-att"><span class="gfv-dot gfv-dot--pending"></span><span class="obs-att-t">${escapeHtml(c.label)}: the production .env changed ${escapeHtml(obsAgo(f.env.updated))}, after the deploy; the server may still run the values before it</span><button type="button" class="obs-link" data-obs-component="${obsAttr(c.id)}">Flags</button></div>`);
  }
  if (!grafanaViewState.config?.hasToken && components.some(c => c.grafana)) rows.push('<div class="gh-muted">Grafana is not connected. <button type="button" class="obs-link" data-obs-connect="1">Connect</button></div>');
  return rows.length ? rows.join('') : '<div class="obs-clear">All clear: no alerts firing, no new errors.</div>';
}

/** One row per component: its version in production, since when, its health, its errors and a summary of what the version holds. */
function observabilityProductTableHtml(p) {
  const head = `<div class="obs-tr obs-tr--h"><span></span><span>Component</span><span>Version</span><span>Since</span><span>Errors</span><span>What it holds</span></div>`;
  const rows = p.components.map(c => {
    if (c.error) return `<div class="obs-tr"><span class="gfv-dot gfv-dot--none"></span><button type="button" class="obs-comp-link" data-obs-component="${obsAttr(c.id)}">${escapeHtml(c.label)}</button><span class="gh-error obs-err" style="grid-column: span 4">${escapeHtml(c.error)}</span></div>`;
    const prod = observabilityProductionTag(c);
    const lines = observabilityRollouts([c]);
    const others = c.model === 'staged' ? new Set(c.targets.map(t => t.stages?.production?.tag).filter(x => x && x !== prod?.tag)).size : 0;
    const r = prod && observabilityState.problems.get(`${c.id}|${prod.tag}|1`);
    const errors = !c.bugsnag?.length ? '<span class="gh-muted">–</span>'
      : r?.rates ? `${obsFmt(r.rates.now)}/h${r.rates.before > 0 && Math.abs(r.rates.now / r.rates.before - 1) >= 0.1 ? ` <span class="obs-ratio obs-ratio--${r.rates.now / r.rates.before >= 2 && r.rates.now >= 5 ? 'bad' : r.rates.now / r.rates.before >= 1.3 ? 'warn' : 'ok'}">×${(r.rates.now / r.rates.before).toFixed(1)}</span>` : ''}${observabilityNewErrors(c) ? ` · <span class="obs-new">${observabilityNewErrors(c)} new</span>` : ''}`
      : r && !r.loading && !r.error ? `<span class="gh-muted" title="Under an hour in production: too early to compare">too new</span>${observabilityNewErrors(c) ? ` · <span class="obs-new">${observabilityNewErrors(c)} new</span>` : ''}`
      : '<span class="gh-muted">…</span>';
    return `<div class="obs-tr"><span class="gfv-dot gfv-dot--${obsAttr(observabilityComponentStatus(c))}"></span>
        <button type="button" class="obs-comp-link" data-obs-component="${obsAttr(c.id)}" title="${obsAttr(`${c.repo}${c.filtered ? ', its part of the code' : ''}`)}">${escapeHtml(c.label)}</button>
        <span class="obs-tr-v">${prod ? `<b>${escapeHtml(prod.tag)}</b>${lines.length ? ` <span class="obs-rollout">${lines.map(l => `${l.rollout}%`).join(', ')}</span>` : ''}${others ? ` <span class="gh-muted" title="Targets on older versions">+${others} older</span>` : ''}` : '<span class="gh-muted">not in production</span>'}</span>
        <span class="gh-muted">${prod ? escapeHtml(obsAgo(prod.date)) : ''}</span>
        <span>${prod ? errors : ''}</span>
        <span class="obs-tr-sum">${prod ? observabilityChangesLineHtml(c, prod.tag) : ''}</span></div>`;
  }).join('');
  return `<div class="obs-table">${head}${rows}</div>`;
}

/** A version's changes in one line: how many, the first pitch or issue, and the way to all of them. */
function observabilityChangesLineHtml(c, tag) {
  const f = observabilityState.features.get(`${c.id}|${tag}`);
  if (!f || f.loading) return '<span class="gh-muted">…</span>';
  if (f.error) return `<span class="gh-error" title="${obsAttr(f.error)}">could not read</span>`;
  const issues = f.groups.reduce((n, g) => n + g.issues.length, 0);
  const count = issues + f.other.length;
  if (!count) return `<span class="gh-muted">${f.chores.length ? `upkeep only (${f.chores.length})` : 'no changes'}</span>`;
  const first = f.groups[0]?.parent?.title || f.groups[0]?.issues[0]?.issue.title || f.other[0]?.title || '';
  return `<button type="button" class="obs-sum-link" data-obs-changes="${obsAttr(`${c.id}|${tag}`)}" title="All changes in ${obsAttr(tag)}"><b>${count}</b> change${count === 1 ? '' : 's'}<span class="obs-sum-first">${escapeHtml(first)}</span></button>`;
}

/** A version's changes as a short summary: the pitches and issues by title, counts for the rest, and "All changes". */
function observabilityChangesSummaryHtml(c, tag) {
  const f = observabilityState.features.get(`${c.id}|${tag}`);
  if (!f || f.loading) return '<div class="gh-muted">Loading…</div>';
  if (f.error) return `<div class="gh-error obs-err">${escapeHtml(f.error)}</div>`;
  if (f.first) return '<div class="gh-muted">The first tag: nothing to compare it with.</div>';
  const items = [];
  for (const g of f.groups) {
    if (g.parent) items.push({ title: g.parent.title, url: g.parent.url, number: g.parent.number, n: g.issues.length });
    else for (const i of g.issues) items.push({ title: i.issue.title, url: i.issue.url, number: i.issue.number, n: 0 });
  }
  const shown = items.slice(0, 5);
  const rest = items.length - shown.length;
  const counts = [rest > 0 && `${rest} more issue${rest === 1 ? '' : 's'}`, f.other.length && `${f.other.length} other change${f.other.length === 1 ? '' : 's'}`, f.chores.length && `${f.chores.length} upkeep`].filter(Boolean);
  return `<div class="obs-feats">
      ${shown.map(i => `<div class="obs-feat">${obsLink(i.url, `#${i.number}`)}<span class="obs-feat-t">${escapeHtml(i.title)}</span>${i.n ? `<span class="gh-muted">${i.n} issue${i.n === 1 ? '' : 's'}</span>` : ''}</div>`).join('')}
      ${!shown.length && !f.other.length ? '<div class="gh-muted">No changes a user would notice.</div>' : ''}
      <div class="obs-feat-more">${counts.length ? `<span class="gh-muted">${escapeHtml(counts.join(', '))}</span>` : ''}
        <button type="button" class="obs-link" data-obs-changes="${obsAttr(`${c.id}|${tag}`)}">All changes ›</button></div>
    </div>`;
}

// --- Usage: the business figures ---

/** 1234 → "1,234"; 12345 → "12.3k". */
function obsCount(v) {
  if (v == null || !Number.isFinite(v)) return '–';
  if (Math.abs(v) >= 10000) return `${(v / 1000).toFixed(Math.abs(v) >= 100000 ? 0 : 1)}k`;
  return Math.round(v).toLocaleString('en-US');
}

const obsMinutes = (sec) => (sec == null ? '–' : sec < 3600 ? `${Math.round(sec / 60)} min` : `${Math.floor(sec / 3600)} h ${Math.round((sec % 3600) / 60)} min`);
const obsMeters = (m) => (m == null ? '–' : m >= 1000 ? `${(m / 1000).toFixed(m >= 10000 ? 0 : 1)} km` : `${Math.round(m)} m`);
const obsEuros = (v) => (v == null ? '–' : `€${Math.round(v).toLocaleString('en-US')}`);

/** "▲ 8%" against one window back; nothing without history. */
function obsTrend(pair) {
  if (!pair || pair.before == null || !pair.before) return '';
  const pct = Math.round(((pair.now - pair.before) / pair.before) * 100);
  if (!pct) return '<span class="obs-trend">±0%</span>';
  return `<span class="obs-trend obs-trend--${pct > 0 ? 'up' : 'down'}">${pct > 0 ? '▲' : '▼'} ${Math.abs(pct)}%</span>`;
}

/** The core figures at the top of a product's page: who uses it, how much they train, and what it earns. */
function observabilityUsageRowHtml(p) {
  const b = observabilityState.business?.[p.id];
  if (!b) {
    return `<div class="gh-muted">${observabilityState.business ? 'No usage figures for this product yet: they come once its backends export the business metrics.' : grafanaViewState.config?.hasToken ? 'Reading the usage figures…' : 'Usage figures come from Grafana, which is not connected.'}</div>`;
  }
  const w = (pair) => (pair ? obsCount(pair.now) : '–');
  const sub = (kind) => `1d ${w(b.users[kind]?.['1d'])} · 30d ${w(b.users[kind]?.['30d'])}`;
  const figures = [];
  if (b.users.active) figures.push(obsFigure('Active users · 7d', `${w(b.users.active['7d'])} ${obsTrend(b.users.active['7d'])}`, sub('active'), 'ok', 'Users with an authenticated request in the last 7 days'));
  if (b.users.training) figures.push(obsFigure('Training users · 7d', `${w(b.users.training['7d'])} ${obsTrend(b.users.training['7d'])}`, sub('training'), 'ok', 'Users who logged a workout in the last 7 days'));
  if (b.workouts.all['7d']) figures.push(obsFigure('Workouts · 7d', `${w(b.workouts.all['7d'])} ${obsTrend(b.workouts.all['7d'])}`, `1d ${w(b.workouts.all['1d'])} · 30d ${w(b.workouts.all['30d'])}`, 'ok', 'Workouts in the last 7 days'));
  if (b.mrr != null) figures.push(obsFigure('MRR', escapeHtml(obsEuros(b.mrr)), b.subscriptions != null ? `${obsCount(b.subscriptions)} subscriptions` : '', 'ok', 'Monthly recurring revenue (RevenueCat)'));
  else if (b.subscriptions != null) figures.push(obsFigure('Subscriptions', obsCount(b.subscriptions), '', 'ok'));
  return figures.length ? `<div class="obs-kpis obs-kpis--usage">${figures.join('')}</div>` : '<div class="gh-muted">No usage figures yet.</div>';
}

/** A product's Usage page: every business figure, by window, with its trend. */
function observabilityUsageHtml(p) {
  if (!p) return '<div class="ghv-empty">This product is gone.</div>';
  const b = observabilityState.business?.[p.id];
  const head = `<div class="gfv-title"><button type="button" class="obs-comp-link obs-comp-link--up" data-obs-product="${obsAttr(p.id)}">${escapeHtml(p.label)}</button> · Usage</div>`;
  if (!b) return `<div class="gfv-page obs-page">${head}<div class="gfv-sec">${observabilityUsageRowHtml(p)}</div></div>`;
  const windows = ['1d', '7d', '30d'];
  const cell = (pair) => `<span>${pair ? `${escapeHtml(obsCount(pair.now))} ${obsTrend(pair)}` : '–'}</span>`;
  const table = (rows) => `<div class="obs-utable"><div class="obs-utr obs-utr--h"><span></span>${windows.map(x => `<span>${x}</span>`).join('')}</div>${rows.join('')}</div>`;
  const userRows = [['active', 'Active users'], ['training', 'Training users'], ['new', 'New accounts']]
    .filter(([k]) => b.users[k]).map(([k, label]) => `<div class="obs-utr"><span>${label}</span>${windows.map(x => cell(b.users[k][x])).join('')}</div>`);
  const types = Object.entries(b.workouts.types).sort((a, c) => (c[1]['7d']?.now || 0) - (a[1]['7d']?.now || 0));
  const max = Math.max(1, ...types.map(([, v]) => v['7d']?.now || 0));
  const channels = Object.entries(b.workouts.channels);
  const medians = (field, fmt) => {
    const rows = Object.entries(b[field]).sort(([a], [c]) => (a === 'all' ? -1 : c === 'all' ? 1 : a.localeCompare(c)));
    return rows.length ? `<div class="obs-utable"><div class="obs-utr obs-utr--h"><span></span>${windows.map(x => `<span>${x}</span>`).join('')}</div>
      ${rows.map(([type, v]) => `<div class="obs-utr"><span>${escapeHtml(type === 'all' ? 'All workouts' : type)}</span>${windows.map(x => `<span>${escapeHtml(fmt(v[x]))}</span>`).join('')}</div>`).join('')}</div>` : '<div class="gh-muted">–</div>';
  };
  const training = Object.entries(b.training);
  const extras = Object.entries(b.extra);
  const share = b.strava != null && b.accounts ? ` (${Math.round((b.strava / b.accounts) * 100)}% of accounts)` : '';
  const kv = (label, value) => `<div class="obs-kv"><span>${escapeHtml(label)}</span><span>${escapeHtml(value)}</span></div>`;
  const windowed = (v) => Object.entries(v).map(([x, n]) => `${x === 'all' ? '' : `${x} `}${obsCount(n)}`).join(' · ');
  return `<div class="gfv-page obs-page">${head}
      <div class="gfv-meta"><span>From the backends' business metrics, refreshed every 15 minutes. Trends compare with one window earlier.</span></div>
      <div class="gfv-sec">${observabilityUsageRowHtml(p)}</div>
      ${userRows.length ? `<div class="gfv-sec"><div class="gh-sec-h">Users</div>${table(userRows)}${b.accounts != null ? `<div class="obs-feat-more gh-muted">${escapeHtml(obsCount(b.accounts))} accounts in all</div>` : ''}</div>` : ''}
      ${types.length ? `<div class="gfv-sec"><div class="gh-sec-h">Workouts by type, last 7 days</div>
        ${types.map(([type, v]) => `<div class="obs-bar"><span class="obs-bar-l">${escapeHtml(type)}</span><span class="obs-bar-t"><span class="obs-bar-f" style="width:${Math.round(((v['7d']?.now || 0) / max) * 100)}%"></span></span><span class="obs-bar-n">${escapeHtml(obsCount(v['7d']?.now))} ${obsTrend(v['7d'])}</span></div>`).join('')}
        ${channels.length > 1 ? `<div class="obs-feat-more gh-muted">${channels.map(([ch, v]) => `${escapeHtml(ch)} ${escapeHtml(obsCount(v['7d']?.now))}`).join(' · ')}</div>` : ''}</div>` : ''}
      <div class="gfv-sec"><div class="gh-sec-h">Median duration</div>${medians('duration', obsMinutes)}</div>
      ${Object.keys(b.distance).length ? `<div class="gfv-sec"><div class="gh-sec-h">Median distance</div>${medians('distance', obsMeters)}</div>` : ''}
      ${b.strava != null ? `<div class="gfv-sec"><div class="gh-sec-h">Connections</div>${kv('Strava', `${obsCount(b.strava)} accounts${share}`)}</div>` : ''}
      ${training.length ? `<div class="gfv-sec"><div class="gh-sec-h">Training</div>${training.map(([kind, v]) => kv(kind.replace(/_/g, ' '), windowed(v))).join('')}</div>` : ''}
      ${b.subscriptions != null || b.mrr != null ? `<div class="gfv-sec"><div class="gh-sec-h">Subscriptions</div>${kv('Active', obsCount(b.subscriptions))}${b.mrr != null ? kv('Monthly recurring revenue', obsEuros(b.mrr)) : ''}</div>` : ''}
      ${extras.length ? `<div class="gfv-sec"><div class="gh-sec-h">More</div>${extras.map(([name, v]) => kv(name.replace(/_/g, ' '), windowed(v))).join('')}</div>` : ''}
    </div>`;
}

// --- The pages ---

function observabilityPageHtml() {
  const s = observabilityState;
  const sel = grafanaViewState.selected;
  if (!s.overview) return `<div class="ghv-empty">${s.error ? escapeHtml(s.error) : 'Loading…'}</div>`;
  if (sel.kind === 'infra') return observabilityInfraHtml();
  if (sel.kind === 'changes') return observabilityChangesHtml(sel.id);
  if (sel.kind === 'usage') return observabilityUsageHtml(observabilityProduct(sel.id));
  if (sel.kind === 'component') {
    const c = observabilityComponent(sel.id);
    return c ? observabilityComponentHtml(c) : '<div class="ghv-empty">This component is gone.</div>';
  }
  const p = observabilityProduct(sel.id) || s.overview.products[0];
  return p ? observabilityProductHtml(p) : '';
}

function observabilityProductHtml(p) {
  const coming = p.components.map(c => {
    const html = observabilityComingHtml(c);
    return html ? `<div class="obs-coming-row"><span class="obs-comp-l">${escapeHtml(c.label)}</span><div class="obs-coming-list">${html}</div></div>` : '';
  }).join('');
  const flagged = p.components.filter(c => c.flags && !c.error);
  return `<div class="gfv-page obs-page">
      <div class="gfv-title"><span class="gfv-dot gfv-dot--${obsAttr(observabilityProductStatus(p))}"></span> ${escapeHtml(p.label)}</div>
      ${p.owner ? `<div class="gfv-meta"><span>Part of <button type="button" class="obs-comp-link" data-obs-product="${obsAttr(p.owner)}">${escapeHtml(observabilityProduct(p.owner)?.label || p.owner)}</button></span></div>` : ''}
      <div class="gfv-sec"><div class="gh-sec-h obs-ver-h">Usage <button type="button" class="obs-link" data-obs-usage="${obsAttr(p.id)}">All usage ›</button></div>${observabilityUsageRowHtml(p)}</div>
      <div class="gfv-sec"><div class="gh-sec-h">Health</div>${observabilityKeyFiguresHtml(p.components)}</div>
      <div class="gfv-sec"><div class="gh-sec-h">Needs attention</div>${observabilityAttentionHtml(p.components)}</div>
      <div class="gfv-sec"><div class="gh-sec-h">In production</div>${observabilityProductTableHtml(p)}</div>
      ${coming ? `<div class="gfv-sec"><div class="gh-sec-h">On its way</div>${coming}</div>` : ''}
      ${flagged.length ? `<div class="gfv-sec"><div class="gh-sec-h">Flags in production</div>
        ${flagged.map(c => `<div class="obs-block"><div class="obs-block-h"><button type="button" class="obs-comp-link" data-obs-component="${obsAttr(c.id)}">${escapeHtml(c.label)}</button>
          <b>${escapeHtml(observabilityProductionTag(c)?.tag || c.tags?.[0]?.name || '')}</b></div>${observabilityFlagsHtml(c, { compact: true })}</div>`).join('')}</div>` : ''}
    </div>`;
}

function observabilityComponentHtml(c) {
  const product = observabilityProduct(c.product);
  const version = observabilityVersion(c);
  const tag = (c.tags || []).find(t => t.name === version);
  const options = [
    ...(c.model === 'tagged' && c.staging ? [`<option value="staging"${version === 'staging' ? ' selected' : ''}>staging (${escapeHtml(c.branch)})</option>`] : []),
    ...(c.tags || []).map(t => {
      const prod = c.model === 'tagged' ? (c.targets[0]?.stages?.production?.tag === t.name ? 'production' : '') : t.stages.join(', ');
      return `<option value="${obsAttr(t.name)}"${t.name === version ? ' selected' : ''}>${escapeHtml(t.name)}${prod ? ` · ${escapeHtml(prod)}` : ''} · ${escapeHtml(obsDay(t.date))}</option>`;
    }),
  ].join('');
  const backend = c.kind === 'backend' && c.grafana;
  const folders = new Map();
  for (const d of grafanaViewState.dashboards || []) folders.set(d.folder, [...(folders.get(d.folder) || []), d]);
  const dashOpen = observabilityState.unfolded.has(`dash:${c.id}`);
  return `<div class="gfv-page obs-page">
      <div class="gfv-title"><span class="gfv-dot gfv-dot--${obsAttr(observabilityComponentStatus(c))}"></span> <button type="button" class="obs-comp-link obs-comp-link--up" data-obs-product="${obsAttr(c.product)}">${escapeHtml(product?.label || '')}</button> · ${escapeHtml(c.label)}</div>
      <div class="gfv-meta"><span>${escapeHtml(c.repo)}${c.filtered ? ', only its part of the code' : ''}</span><span class="ws-flex"></span>
        ${backend && grafanaViewState.config?.hasToken ? `<button type="button" class="ws-ghost" data-obs-logs="${obsAttr(c.id)}">${PICONS.list(12)}<span>Logs</span></button>` : ''}
        ${c.url ? `<button type="button" class="ws-ghost" data-obs-url="${obsAttr(`${c.url}/releases`)}">${PICONS.open(12)}<span>Releases</span></button>` : ''}</div>
      ${observabilityKeyFiguresHtml([c])}
      <div class="gfv-sec"><div class="gh-sec-h">Needs attention</div>${observabilityAttentionHtml([c])}</div>
      <div class="gfv-sec"><div class="gh-sec-h">Where it runs</div>${observabilityRunsHtml(c)}</div>
      <div class="gfv-sec"><div class="gh-sec-h obs-ver-h">Version <select class="gfv-select" id="obs-version">${options}</select>
          ${tag?.url ? obsLink(tag.url, 'Release on GitHub') : ''}</div>
        ${tag?.summary ? `<div class="obs-summary">${escapeHtml(tag.summary)}</div>` : ''}
        ${c.bugsnag?.length ? `<div class="obs-sub">Errors while it ran</div>${version === 'staging' ? '<div class="gh-muted">Only production is followed; pick a tag.</div>' : version ? observabilityErrorsHtml(c, version, { rate: true }) : ''}` : ''}
        <div class="obs-sub">What it holds</div>
        ${version ? observabilityChangesSummaryHtml(c, version) : '<div class="gh-muted">No tags yet.</div>'}</div>
      ${c.flags ? `<div class="gfv-sec"><div class="gh-sec-h">Flags in production <span class="obs-h-tag">${escapeHtml(observabilityProductionTag(c)?.tag || c.tags?.[0]?.name || '')}</span></div>${observabilityFlagsHtml(c)}</div>` : ''}
      ${backend && observabilityAlerts(c).some(a => !OBS_ACTIVE(a)) ? `<div class="gfv-sec">${observabilityAlertsHtml(observabilityAlerts(c), `quiet:${c.id}`, { quietOnly: true })}</div>` : ''}
      ${backend ? `<div class="gfv-sec"><div class="gh-sec-h">Now</div>${grafanaVitalsHtml(c.grafana)}</div>` : ''}
      ${backend && folders.size ? `<div class="gfv-sec"><button type="button" class="obs-chores" data-obs-unfold="dash:${obsAttr(c.id)}"><span class="ghv-fold${dashOpen ? '' : ' shut'}">${PICONS.chevronDown(9)}</span>Dashboards (${(grafanaViewState.dashboards || []).length})</button>
        ${dashOpen ? [...folders].map(([folder, list]) => `<div class="obs-parent obs-parent--plain">${escapeHtml(folder)}</div>${list.map(d => `<button type="button" class="gfv-row" data-obs-dashboard="${obsAttr(d.uid)}">${PICONS.tree(12)}<span class="gfv-row-title">${escapeHtml(d.title)}</span></button>`).join('')}`).join('') : ''}</div>` : ''}
    </div>`;
}

/** A version's whole list of changes, the page "All changes" leads to. */
function observabilityChangesHtml(ref) {
  const [id, tag] = String(ref).split('|');
  const c = observabilityComponent(id);
  if (!c) return '<div class="ghv-empty">This component is gone.</div>';
  const product = observabilityProduct(c.product);
  const t = (c.tags || []).find(x => x.name === tag);
  return `<div class="gfv-page obs-page">
      <div class="gfv-title"><button type="button" class="obs-comp-link obs-comp-link--up" data-obs-product="${obsAttr(c.product)}">${escapeHtml(product?.label || '')}</button> ·
        <button type="button" class="obs-comp-link obs-comp-link--up" data-obs-component="${obsAttr(c.id)}">${escapeHtml(c.label)}</button> · ${escapeHtml(tag === 'staging' ? `staging (${c.branch})` : tag)}</div>
      <div class="gfv-meta"><span>All changes${tag === 'staging' ? ' not in production yet' : ''}${t?.date ? `, released ${escapeHtml(obsDay(t.date))}` : ''}</span><span class="ws-flex"></span>${t?.url ? obsLink(t.url, 'Release on GitHub') : ''}</div>
      ${t?.summary ? `<div class="obs-summary">${escapeHtml(t.summary)}</div>` : ''}
      <div class="gfv-sec">${observabilityFeaturesHtml(c.id, tag)}</div>
    </div>`;
}

function observabilityInfraHtml() {
  const alerts = (grafanaViewState.alerts || []).filter(a => !a.platform);
  const folders = new Map();
  for (const d of grafanaViewState.dashboards || []) folders.set(d.folder, [...(folders.get(d.folder) || []), d]);
  return `<div class="gfv-page obs-page">
      <div class="gfv-title"><span class="gfv-dot gfv-dot--${obsAttr(observabilityStatus(alerts))}"></span> Infra</div>
      <div class="gfv-meta"><span>Alerts about the monitoring stack and the servers, no product of their own</span></div>
      <div class="gfv-sec"><div class="gh-sec-h">Problems</div>${observabilityAlertsHtml(alerts, 'quiet:infra')}</div>
      ${folders.size ? `<div class="gfv-sec"><div class="gh-sec-h">Dashboards</div>${[...folders].map(([folder, list]) => `<div class="obs-parent obs-parent--plain">${escapeHtml(folder)}</div>${list.map(d => `<button type="button" class="gfv-row" data-obs-dashboard="${obsAttr(d.uid)}">${PICONS.tree(12)}<span class="gfv-row-title">${escapeHtml(d.title)}</span></button>`).join('')}`).join('')}</div>` : ''}
    </div>`;
}

/** Wire the page just drawn, and start reading what it shows and does not have yet. */
function bindObservabilityPage() {
  const s = observabilityState;
  const g = grafanaViewState;
  const root = grafanaViewer;
  const sel = g.selected;
  if (sel.kind === 'product') {
    for (const c of observabilityProduct(sel.id)?.components || []) {
      if (c.error) continue;
      const prod = observabilityProductionTag(c);
      if (prod) loadObservabilityFeatures(c.id, prod.tag);
      if (prod && c.bugsnag?.length) loadObservabilityProblems(c.id, prod.tag, true);
      if (c.flags) loadObservabilityFlags(c.id);
      if (c.model === 'tagged' && c.staging) loadObservabilityFeatures(c.id, 'staging');
    }
  }
  for (const service of observabilityPageServices()) {
    if (!g.vitals.has(`${service.platform}|${service.app}`)) loadGrafanaVitals(service).then(() => { if (activeTab === 'grafana' && g.vitals.has(`${service.platform}|${service.app}`)) renderGrafanaMain(); });
  }
  if (sel.kind === 'changes') loadObservabilityFeatures(...String(sel.id).split('|'));
  if (sel.kind === 'component') {
    const c = observabilityComponent(sel.id);
    const prod = c && !c.error && observabilityProductionTag(c);
    if (prod && c.bugsnag?.length) loadObservabilityProblems(c.id, prod.tag, true);
    if (c?.model === 'tagged' && c.staging) loadObservabilityFeatures(c.id, 'staging');
    const version = c && observabilityVersion(c);
    if (version) loadObservabilityFeatures(c.id, version);
    if (version && version !== 'staging' && c.bugsnag?.length) loadObservabilityProblems(c.id, version, true);
    if (c?.flags) loadObservabilityFlags(c.id);
  }
  root.querySelectorAll('[data-obs-url]').forEach(b => { b.onclick = (e) => { e.stopPropagation(); window.api.openExternal(b.dataset.obsUrl); }; });
  root.querySelectorAll('[data-obs-component]').forEach(b => { b.onclick = () => selectGrafana({ kind: 'component', id: b.dataset.obsComponent }); });
  root.querySelectorAll('[data-obs-product]').forEach(b => { b.onclick = () => selectGrafana({ kind: 'product', id: b.dataset.obsProduct }); });
  root.querySelectorAll('[data-obs-version]').forEach(b => {
    b.onclick = () => {
      const [id, tag] = b.dataset.obsVersion.split('|');
      s.versions.set(id, tag);
      selectGrafana({ kind: 'component', id });
    };
  });
  root.querySelectorAll('[data-obs-unfold]').forEach(b => {
    b.onclick = () => { const k = b.dataset.obsUnfold; if (s.unfolded.has(k)) s.unfolded.delete(k); else s.unfolded.add(k); renderGrafanaMain(); };
  });
  root.querySelectorAll('[data-alert]').forEach(b => { b.onclick = () => selectGrafana({ kind: 'alert', id: b.dataset.alert }); });
  root.querySelectorAll('[data-obs-dashboard]').forEach(b => { b.onclick = () => selectGrafana({ kind: 'dashboard', id: b.dataset.obsDashboard }); });
  root.querySelectorAll('[data-obs-logs]').forEach(b => { b.onclick = () => selectGrafana({ kind: 'logs', id: b.dataset.obsLogs }); });
  root.querySelectorAll('[data-obs-connect]').forEach(b => { b.onclick = () => selectGrafana({ kind: 'setup', id: null }); });
  root.querySelectorAll('[data-obs-usage]').forEach(b => { b.onclick = () => selectGrafana({ kind: 'usage', id: b.dataset.obsUsage }); });
  root.querySelectorAll('[data-obs-changes]').forEach(b => { b.onclick = () => selectGrafana({ kind: 'changes', id: b.dataset.obsChanges }); });
  root.querySelectorAll('[data-obs-ask]').forEach(b => { b.onclick = () => askClaudeAboutObservabilityError(...b.dataset.obsAsk.split('|')); });
  const picker = root.querySelector('#obs-version');
  if (picker) picker.onchange = () => { s.versions.set(sel.id, picker.value); renderGrafanaMain(); };
}

// --- Asking Claude about an error ---

/** The error as read for its version's page or the product's (whichever has it). */
function observabilityError(componentId, tag, errorId) {
  for (const rate of [1, 0]) {
    const e = observabilityState.problems.get(`${componentId}|${tag}|${rate}`)?.errors?.find(x => x.id === errorId);
    if (e) return { error: e, problems: observabilityState.problems.get(`${componentId}|${tag}|${rate}`) };
  }
  return null;
}

/** A session in the component's repo, beside the page, that looks into a Bugsnag error (startGrafanaSession). */
async function askClaudeAboutObservabilityError(componentId, tag, errorId) {
  const c = observabilityComponent(componentId);
  const found = observabilityError(componentId, tag, errorId);
  if (!c || !found) return;
  const { error: e, problems } = found;
  const product = observabilityProduct(c.product);
  const note = await window.api.getBugsnagSessionNote();
  const prompt = [
    `Bugsnag error in ${product?.label} ${c.label} (${c.repo}), production version ${tag}${e.isNew ? ', new in this version' : ''}:`,
    `${e.errorClass}${e.message ? `: ${e.message}` : ''}`,
    `Route: ${e.context || 'unknown'}. Top file of ours: ${e.file || 'unknown'}.`,
    `${e.events} events and ${e.users} users while this version ran (since ${problems.since}); first seen ${e.firstSeen}.`,
    `Bugsnag: ${e.url} (project ${e.project}, id ${e.projectId}; error ${e.id})`,
    e.prs.length ? `PRs of this version that changed that file: ${e.prs.map(p => `#${p.number} ${p.title}`).join('; ')}.` : '',
    '',
    `Find out why it happens and what to do about it: read its events in Bugsnag and look in this repository's code at ${tag}. Investigate only: do not change code, deploy or write anywhere unless I ask for it here.`,
    '',
    note,
  ].filter(line => line !== '').join('\n');
  // A logged error's class says only "Log error": its message names it.
  const name = /^Log \w+$/.test(e.errorClass) && e.message ? e.message : e.errorClass || e.message;
  await startGrafanaSession(`error:${componentId}|${tag}|${errorId}`, { repos: [c.repo], prompt, label: `Error: ${name}` });
}

/** Show a component's version page from anywhere (a session's link back to its error). */
function openObservabilityError(ref) {
  const [componentId, tag] = String(ref).split('|');
  observabilityState.versions.set(componentId, tag);
  const tab = document.querySelector('.sidebar-tab[data-tab="grafana"]');
  if (tab && activeTab !== 'grafana') {
    grafanaViewState.selected = { kind: 'component', id: componentId };
    tab.click();
  } else selectGrafana({ kind: 'component', id: componentId });
}
