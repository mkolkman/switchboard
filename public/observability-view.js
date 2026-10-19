// --- Observability tab: the products as one whole ---
// The sidebar lists the products (MLC, NOHRD, WaterRower, CITYROW, Dr. Wolff,
// RP3), each with one dot for its worst signal, unfolding to its components
// with the version in production; Infra at the bottom holds the alerts no
// product owns. A product's page: what runs in production per component, what is on
// its way (internal, beta, staging), its problems (alerts) and what the
// production versions hold. A component's page: the same for one component,
// with a version picker; a backend adds its figures, Logs and the
// dashboards. Releases come from GitHub through observability.js (main);
// everything Grafana from grafana-view.js, which draws the alert, dashboard
// and logs pages and calls in here for the rest.
// Depends on: utils.js (escapeHtml), projects-view.js (PICONS),
// grafana-view.js (grafanaViewState, selectGrafana, grafanaAlertRow,
// grafanaVitalsHtml, grafanaService, renderGrafanaMain, renderGrafanaList,
// loadGrafanaVitals, paintGrafanaHeader).

const OBSERVABILITY_POLL_MS = 5 * 60 * 1000;

const observabilityState = {
  overview: null, error: null, loading: null,
  expanded: new Set(), // product ids unfolded in the sidebar
  features: new Map(), // "component|tag" or "component|staging" → { loading } | result | { error }
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
    else { s.error = null; s.overview = result; }
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

/** While the tab is open, the releases are read again every few minutes. */
function startObservabilityPolling() {
  clearInterval(observabilityState.timer);
  observabilityState.timer = setInterval(async () => {
    if (activeTab !== 'grafana') return;
    await loadObservabilityOverview();
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

/** The worst of a list of alerts as a dot: firing, pending, or ok. */
function observabilityStatus(alerts, error = null) {
  if (alerts.some(a => a.state === 'firing')) return 'firing';
  if (alerts.some(a => a.state === 'pending')) return 'pending';
  return error ? 'none' : 'normal';
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
    const firing = observabilityProductAlerts(p).filter(OBS_ACTIVE).length;
    const head = `<div class="obs-prod-row"><button type="button" class="obs-fold" data-obs-fold="${obsAttr(p.id)}" title="${open ? 'Fold' : 'Show the components'}"><span class="ghv-fold${open ? '' : ' shut'}">${PICONS.chevronDown(9)}</span></button>
      ${row(`data-obs-product="${obsAttr(p.id)}"`, sel.kind === 'product' && sel.id === p.id, observabilityStatus(observabilityProductAlerts(p), p.components.some(c => c.error)), p.label, firing ? `<span class="ghv-count">${firing}</span>` : '')}</div>`;
    const comps = open ? p.components.map(c => {
      const prod = c.error ? null : observabilityProductionTag(c);
      const extra = `<span class="obs-ver" title="${obsAttr(c.error || (prod ? `In production since ${obsDay(prod.date)}` : 'Nothing in production'))}">${escapeHtml(c.error ? '!' : prod?.tag || '–')}</span>`;
      return row(`data-obs-component="${obsAttr(c.id)}"`, sel.kind === 'component' && sel.id === c.id, observabilityStatus(observabilityAlerts(c), c.error), c.label, extra, ' obs-comp-row');
    }).join('') : '';
    return head + comps;
  }).join('');
  grafanaViewContent.innerHTML = `
    <div class="ghv-head"><span class="ghv-title">Observability</span><span class="ws-flex"></span>
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

/** Alert rows (active ones, the quiet ones folded), or a calm line. */
function observabilityAlertsHtml(alerts, foldId) {
  const active = alerts.filter(OBS_ACTIVE);
  const quiet = alerts.filter(a => !OBS_ACTIVE(a));
  if (!grafanaViewState.config?.hasToken) return '<div class="gh-muted">Grafana is not connected. <button type="button" class="obs-link" data-obs-connect="1">Connect</button></div>';
  const open = observabilityState.unfolded.has(foldId);
  return `${active.length ? active.map(grafanaAlertRow).join('') : '<div class="gh-muted">Nothing firing.</div>'}
    ${quiet.length ? `<button type="button" class="obs-chores" data-obs-unfold="${obsAttr(foldId)}"><span class="ghv-fold${open ? '' : ' shut'}">${PICONS.chevronDown(9)}</span>Quiet alert rules (${quiet.length})</button>${open ? quiet.map(grafanaAlertRow).join('') : ''}` : ''}`;
}

// --- The pages ---

function observabilityPageHtml() {
  const s = observabilityState;
  const sel = grafanaViewState.selected;
  if (!s.overview) return `<div class="ghv-empty">${s.error ? escapeHtml(s.error) : 'Loading…'}</div>`;
  if (sel.kind === 'infra') return observabilityInfraHtml();
  if (sel.kind === 'component') {
    const c = observabilityComponent(sel.id);
    return c ? observabilityComponentHtml(c) : '<div class="ghv-empty">This component is gone.</div>';
  }
  const p = observabilityProduct(sel.id) || s.overview.products[0];
  return p ? observabilityProductHtml(p) : '';
}

function observabilityProductHtml(p) {
  const alerts = observabilityProductAlerts(p);
  const coming = p.components.map(c => {
    const html = observabilityComingHtml(c);
    return html ? `<div class="obs-coming-row"><span class="obs-comp-l">${escapeHtml(c.label)}</span><div class="obs-coming-list">${html}</div></div>` : '';
  }).join('');
  const features = p.components.map(c => {
    const prod = c.error ? null : observabilityProductionTag(c);
    if (!prod) return '';
    return `<div class="obs-block"><div class="obs-block-h"><button type="button" class="obs-comp-link" data-obs-component="${obsAttr(c.id)}">${escapeHtml(c.label)}</button>
        <b>${escapeHtml(prod.tag)}</b><span class="gh-muted">since ${escapeHtml(obsDay(prod.date))}</span></div>${observabilityFeaturesHtml(c.id, prod.tag)}</div>`;
  }).join('');
  return `<div class="gfv-page obs-page">
      <div class="gfv-title"><span class="gfv-dot gfv-dot--${obsAttr(observabilityStatus(alerts))}"></span> ${escapeHtml(p.label)}</div>
      ${p.owner ? `<div class="gfv-meta"><span>Part of <button type="button" class="obs-comp-link" data-obs-product="${obsAttr(p.owner)}">${escapeHtml(observabilityProduct(p.owner)?.label || p.owner)}</button></span></div>` : ''}
      <div class="gfv-sec"><div class="gh-sec-h">In production</div>
        ${p.components.map(c => `<div class="obs-block"><div class="obs-block-h"><button type="button" class="obs-comp-link" data-obs-component="${obsAttr(c.id)}">${escapeHtml(c.label)}</button>
          <span class="gh-muted">${escapeHtml(c.repo)}${c.filtered ? ', its part of the code' : ''}</span>
          ${observabilityAlerts(c).filter(OBS_ACTIVE).length ? `<span class="gfv-pill gfv-pill--${obsAttr(observabilityStatus(observabilityAlerts(c)))}">${observabilityAlerts(c).filter(OBS_ACTIVE).length} alert${observabilityAlerts(c).filter(OBS_ACTIVE).length === 1 ? '' : 's'}</span>` : ''}</div>
          ${observabilityProductionHtml(c)}</div>`).join('')}
      </div>
      ${coming ? `<div class="gfv-sec"><div class="gh-sec-h">On its way</div>${coming}</div>` : ''}
      <div class="gfv-sec"><div class="gh-sec-h">Problems</div>${observabilityAlertsHtml(alerts, `quiet:${p.id}`)}</div>
      <div class="gfv-sec"><div class="gh-sec-h">In the production versions</div>${features || '<div class="gh-muted">Nothing in production.</div>'}</div>
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
      <div class="gfv-title"><button type="button" class="obs-comp-link obs-comp-link--up" data-obs-product="${obsAttr(c.product)}">${escapeHtml(product?.label || '')}</button> · ${escapeHtml(c.label)}</div>
      <div class="gfv-meta"><span>${escapeHtml(c.repo)}${c.filtered ? ', only its part of the code' : ''}</span><span class="ws-flex"></span>
        ${backend && grafanaViewState.config?.hasToken ? `<button type="button" class="ws-ghost" data-obs-logs="${obsAttr(c.id)}">${PICONS.list(12)}<span>Logs</span></button>` : ''}
        ${c.url ? `<button type="button" class="ws-ghost" data-obs-url="${obsAttr(`${c.url}/releases`)}">${PICONS.open(12)}<span>Releases</span></button>` : ''}</div>
      ${backend ? grafanaVitalsHtml(c.grafana) : ''}
      <div class="gfv-sec"><div class="gh-sec-h">Where it runs</div>${observabilityRunsHtml(c)}</div>
      <div class="gfv-sec"><div class="gh-sec-h">Problems</div>${backend ? observabilityAlertsHtml(observabilityAlerts(c), `quiet:${c.id}`) : '<div class="gh-muted">Crash reports come here next.</div>'}</div>
      <div class="gfv-sec"><div class="gh-sec-h obs-ver-h">Version <select class="gfv-select" id="obs-version">${options}</select>
          ${tag?.url ? obsLink(tag.url, 'Release on GitHub') : ''}</div>
        ${tag?.summary ? `<div class="obs-summary">${escapeHtml(tag.summary)}</div>` : ''}
        ${version ? observabilityFeaturesHtml(c.id, version) : '<div class="gh-muted">No tags yet.</div>'}</div>
      ${backend && folders.size ? `<div class="gfv-sec"><button type="button" class="obs-chores" data-obs-unfold="dash:${obsAttr(c.id)}"><span class="ghv-fold${dashOpen ? '' : ' shut'}">${PICONS.chevronDown(9)}</span>Dashboards (${(grafanaViewState.dashboards || []).length})</button>
        ${dashOpen ? [...folders].map(([folder, list]) => `<div class="obs-parent obs-parent--plain">${escapeHtml(folder)}</div>${list.map(d => `<button type="button" class="gfv-row" data-obs-dashboard="${obsAttr(d.uid)}">${PICONS.tree(12)}<span class="gfv-row-title">${escapeHtml(d.title)}</span></button>`).join('')}`).join('') : ''}</div>` : ''}
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
      if (c.model === 'tagged' && c.staging) loadObservabilityFeatures(c.id, 'staging');
    }
  }
  if (sel.kind === 'component') {
    const c = observabilityComponent(sel.id);
    const version = c && observabilityVersion(c);
    if (version) loadObservabilityFeatures(c.id, version);
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
  const picker = root.querySelector('#obs-version');
  if (picker) picker.onchange = () => { s.versions.set(sel.id, picker.value); renderGrafanaMain(); };
}
