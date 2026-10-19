// --- Observability tab (data-tab "grafana"): the Grafana side ---
// The tab shows MoveLab's products as one whole (observability-view.js: the
// sidebar, product, component and Infra pages). This file holds what comes
// from Grafana: the alerts (read every minute, also while another tab is
// open: the tab icon gets a badge, an alert that starts firing raises a
// notification), a backend's five figures over the last hour, an alert's
// page with its query's graph, a dashboard in a webview (Grafana's kiosk
// mode, its own login kept in persist:grafana) and Logs as a search over
// Loki. "Ask Claude" on an alert or on log lines starts a session in the
// platform's repo, beside the page, that may query Grafana itself with the
// same read-only token. Production only; main does the API calls (grafana.js).
// Depends on: utils.js (escapeHtml, formatDate), projects-view.js (PICONS,
// mainEl), app.js (launchNewSession, encodeProjectPath, showSession,
// openSessions), dialogs.js (resolveDefaultSessionOptions),
// project-github-view.js (findLocalClone, githubMarkdown),
// observability-view.js (renderObservabilityList, observabilityPageHtml,
// bindObservabilityPage, observabilityComponent, loadObservabilityOverview).

const grafanaViewContent = document.getElementById('grafana-content');
const grafanaViewer = document.getElementById('grafana-viewer');
const GRAFANA_POLL_MS = 60 * 1000;
const GRAFANA_LIVE_MS = 5 * 1000;
const GRAFANA_SELECTED_KEY = 'observabilitySelected';
const GRAFANA_LEVELS = ['error', 'critical', 'warning', 'info', 'debug'];
const GRAFANA_RANGES = [['15m', 900], ['1h', 3600], ['6h', 21600], ['24h', 86400], ['7d', 604800]];

const grafanaViewState = {
  config: null, error: null,
  alerts: null, alertsError: null, dashboards: null,
  platform: 'mlc', // the logs' platform, set from the component they are opened on
  vitals: new Map(), // "platform|app" → a backend's figures
  // product, component or infra (observability-view.js); alert (uid), dashboard (uid) or logs (component id or null)
  selected: (() => { try { return JSON.parse(localStorage.getItem(GRAFANA_SELECTED_KEY)) || { kind: 'product', id: 'mlc' }; } catch { return { kind: 'product', id: 'mlc' }; } })(),
  back: null, // the page an alert, dashboard or logs was opened from
  firing: null, // alert uids firing at the last read, for notifications
  timer: null,
  logs: {
    levels: ['error', 'critical', 'warning'], app: '', contains: '', range: 3600, raw: '', useRaw: false,
    live: false, liveTimer: null, lines: [], query: '', loading: false, error: null,
    checked: new Set(), open: null, context: new Map(), question: '',
  },
  alertSeries: new Map(), // alert uid → its query's series
  sessions: new Map(), // 'alert:<uid>' or 'logs:<platform>' → the session started there
  splitSession: null,
};

const gfvAttr = (value) => escapeHtml(value ?? '').replace(/"/g, '&quot;');

function grafanaPlatform(id = grafanaViewState.platform) {
  return grafanaViewState.config?.platforms?.find(p => p.id === id) || null;
}

// --- Loading ---

async function loadGrafanaConfig() {
  const result = await window.api.getGrafanaConfig().catch(err => ({ error: err?.message || String(err) }));
  grafanaViewState.config = result?.error ? null : result;
  grafanaViewState.error = result?.error || null;
  return grafanaViewState.config;
}

/** Alerts (and the badge, and notifications for newly firing ones). */
async function loadGrafanaAlerts() {
  const s = grafanaViewState;
  const result = await window.api.getGrafanaAlerts().catch(err => ({ error: err?.message || String(err) }));
  if (result?.error) { s.alertsError = result.error; return; }
  s.alertsError = null;
  s.alerts = result.alerts || [];
  const firing = new Set(s.alerts.filter(a => a.state === 'firing').map(a => a.uid));
  // The first read only sets the baseline: what fired before the app started is no news.
  if (s.firing) {
    for (const a of s.alerts) if (firing.has(a.uid) && !s.firing.has(a.uid)) notifyGrafanaAlert(a);
  }
  s.firing = firing;
  paintGrafanaBadge();
}

/** The backend service the page is about ({ platform, app } of grafana.js), or null. */
function grafanaService() {
  const s = grafanaViewState;
  if (s.selected.kind === 'component') return observabilityComponent(s.selected.id)?.grafana || null;
  if (s.selected.kind === 'logs') return observabilityComponent(s.selected.id)?.grafana || { platform: s.platform, app: '' };
  return null;
}

async function loadGrafanaVitals(service = grafanaService()) {
  if (!service || !grafanaViewState.config?.hasToken) return;
  const result = await window.api.getGrafanaVitals(service.platform, service.app).catch(() => null);
  if (result && !result.error) grafanaViewState.vitals.set(`${service.platform}|${service.app}`, result);
}

/** Everything the tab shows; quiet keeps what is on screen while it loads. */
async function loadGrafanaView() {
  const s = grafanaViewState;
  if (!s.config) await loadGrafanaConfig();
  const overview = loadObservabilityOverview();
  if (!s.config?.hasToken) { renderGrafanaView(); await overview; renderGrafanaView(); return; }
  const dash = window.api.getGrafanaDashboards().then(r => { if (!r?.error) s.dashboards = r.dashboards || []; }).catch(() => {});
  await Promise.all([loadGrafanaAlerts(), loadGrafanaVitals(), dash, overview]);
  renderGrafanaView();
  if (s.selected.kind === 'logs' && !s.logs.lines.length && !s.logs.loading) loadGrafanaLogs();
}

/** Every minute, also while another tab is open: the badge and notifications need it. */
function startGrafanaPolling() {
  clearInterval(grafanaViewState.timer);
  grafanaViewState.timer = setInterval(async () => {
    if (!grafanaViewState.config?.hasToken) return;
    await loadGrafanaAlerts();
    if (activeTab === 'grafana') {
      await loadGrafanaVitals();
      renderGrafanaList();
      if (['product', 'component', 'infra'].includes(grafanaViewState.selected.kind)) renderGrafanaMain();
      else paintGrafanaHeader();
    }
    if (typeof renderSidebarRail === 'function') renderSidebarRail();
  }, GRAFANA_POLL_MS);
}

// --- Badge and notifications ---

// On the tab, or on the ••• button while the tab sits in its menu (Global settings).
function paintGrafanaBadge() {
  const tab = document.querySelector('.sidebar-tab[data-tab="grafana"]');
  const more = document.getElementById('sidebar-more-btn');
  if (!tab) return;
  document.querySelectorAll('.gfv-tab-badge').forEach(b => b.remove());
  const alerts = grafanaViewState.alerts || [];
  const kind = alerts.some(a => a.state === 'firing') ? 'firing' : alerts.some(a => a.state === 'pending') ? 'pending' : null;
  if (!kind) return;
  const host = tab.style.display === 'none' && more ? more : tab;
  const badge = document.createElement('span');
  host.appendChild(badge);
  badge.className = `gfv-tab-badge gfv-tab-badge--${kind}`;
}

function notifyGrafanaAlert(alert) {
  if (typeof Notification === 'undefined') return;
  const platform = grafanaPlatform(alert.platform)?.label;
  const n = new Notification(`Firing: ${alert.title}`, { body: [platform, alert.annotations?.summary || alert.group].filter(Boolean).join(' · ') });
  n.onclick = () => openGrafanaAlert(alert.uid);
}

/** Show an alert in the Observability tab, from anywhere. */
function openGrafanaAlert(uid) {
  const tab = document.querySelector('.sidebar-tab[data-tab="grafana"]');
  if (tab && activeTab !== 'grafana') {
    grafanaViewState.selected = { kind: 'alert', id: uid };
    tab.click();
  } else selectGrafana({ kind: 'alert', id: uid });
}

// --- Alert rows (the sidebar and the pages are in observability-view.js) ---

function grafanaAlertRow(a) {
  const s = grafanaViewState;
  const platform = grafanaPlatform(a.platform)?.label;
  const active = s.selected.kind === 'alert' && s.selected.id === a.uid;
  return `<button type="button" class="gfv-row${active ? ' active' : ''}" data-alert="${gfvAttr(a.uid)}" title="${gfvAttr(`${a.title}\n${a.group}${a.activeAt ? `\nsince ${formatDate(new Date(a.activeAt))}` : ''}`)}">
      <span class="gfv-dot gfv-dot--${gfvAttr(a.state)}"></span><span class="gfv-row-title">${escapeHtml(a.title)}</span>
      ${platform ? `<span class="gfv-plat">${escapeHtml(platform)}</span>` : ''}</button>`;
}

function renderGrafanaList() {
  renderObservabilityList();
}

const GRAFANA_PAGES = ['product', 'component', 'infra'];

/**
 * Go to a page of the tab. An alert, dashboard or logs remember the page they
 * were opened from (the header's back); logs take the component's service.
 */
function selectGrafana(sel) {
  const s = grafanaViewState;
  if (!GRAFANA_PAGES.includes(sel.kind) && GRAFANA_PAGES.includes(s.selected.kind)) s.back = { ...s.selected };
  if (GRAFANA_PAGES.includes(sel.kind)) s.back = null;
  if (sel.kind === 'logs') {
    const service = observabilityComponent(sel.id)?.grafana;
    if (service && (service.platform !== s.platform || service.app !== s.logs.app)) {
      s.platform = service.platform;
      s.logs.app = service.app;
      s.logs.lines = [];
      s.logs.checked.clear();
      s.logs.open = null;
    }
  }
  s.selected = sel;
  try { localStorage.setItem(GRAFANA_SELECTED_KEY, JSON.stringify(GRAFANA_PAGES.includes(sel.kind) ? sel : s.back || sel)); } catch {}
  renderGrafanaView();
  if (sel.kind === 'logs' && !s.logs.lines.length) loadGrafanaLogs();
  if (grafanaService() && !s.vitals.has(`${grafanaService().platform}|${grafanaService().app}`)) loadGrafanaVitals().then(paintGrafanaHeader);
  showGrafanaItemSession();
}

// --- Header: where you are, and a backend's figures ---

const GRAFANA_VITALS = [
  { key: 'requests', label: 'Requests', unit: (v) => `${v < 10 ? v.toFixed(1) : Math.round(v)}/s`, warn: null, bad: null },
  { key: 'errors5xx', label: '5xx', unit: (v) => `${(v * 100).toFixed(v < 0.01 ? 2 : 1)}%`, warn: 0.01, bad: 0.05 },
  { key: 'p95', label: 'p95', unit: (v) => (v < 1 ? `${Math.round(v * 1000)} ms` : `${v.toFixed(2)} s`), warn: 1, bad: 2 },
  { key: 'errorLogs', label: 'Error logs', unit: (v) => `${Math.round(v)}/min`, warn: 5, bad: 20 },
  { key: 'backlog', label: 'Queue', unit: (v) => `${Math.round(v)}`, warn: 100, bad: 1000 },
];

/** A small line for a series [[t, v], ...]; empty when there is nothing to draw. */
function grafanaSparkline(points, w = 56, h = 20) {
  const pts = (points || []).filter(([, v]) => Number.isFinite(v));
  if (pts.length < 2) return '';
  const t0 = pts[0][0], t1 = pts[pts.length - 1][0];
  const vs = pts.map(([, v]) => v);
  const lo = Math.min(...vs), hi = Math.max(...vs);
  const x = (t) => ((t - t0) / Math.max(t1 - t0, 1)) * w;
  const y = (v) => h - 1 - ((v - lo) / Math.max(hi - lo, 1e-9)) * (h - 2);
  return `<svg class="gfv-spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><polyline fill="none" stroke="currentColor" stroke-width="1.4" points="${pts.map(([t, v]) => `${x(t).toFixed(1)},${y(v).toFixed(1)}`).join(' ')}"/></svg>`;
}

/** The five figures of a backend service, or nothing without Grafana. */
function grafanaVitalsHtml(service) {
  const s = grafanaViewState;
  if (!service || !s.config?.hasToken) return '';
  const vit = s.vitals.get(`${service.platform}|${service.app}`);
  const tiles = GRAFANA_VITALS.map(m => {
    const series = vit?.[m.key];
    const last = series?.length ? series[series.length - 1][1] : null;
    if (last == null) return `<div class="gfv-vital gfv-vital--none" title="No ${m.label.toLowerCase()} for this service"><span class="gfv-vital-l">${m.label}</span><span class="gfv-vital-v">–</span></div>`;
    const level = m.bad != null && last >= m.bad ? 'bad' : m.warn != null && last >= m.warn ? 'warn' : 'ok';
    let extra = '';
    if (m.key === 'requests' && vit.requestsWeekAgo?.length) {
      const ago = vit.requestsWeekAgo[vit.requestsWeekAgo.length - 1][1];
      if (ago > 0) { const pct = Math.round(((last - ago) / ago) * 100); extra = `<span class="gfv-vital-d">${pct >= 0 ? '+' : ''}${pct}% vs 7d</span>`; }
    }
    return `<button type="button" class="gfv-vital gfv-vital--${level}" data-vital="${m.key}" title="${gfvAttr(`${m.label}, last hour. Open Platform health`)}"><span class="gfv-vital-l">${m.label}</span><span class="gfv-vital-v">${m.unit(last)}</span>${extra}${grafanaSparkline(series)}</button>`;
  }).join('');
  return `<div class="gfv-vitals">${vit ? tiles : '<span class="gh-muted">Loading…</span>'}</div>`;
}

/** Above an alert, a dashboard or logs: the way back to the page it was opened from, and the service's figures. */
function grafanaHeaderHtml() {
  const s = grafanaViewState;
  const back = s.back ? observabilityPlaceLabel(s.back) : null;
  const here = s.selected.kind === 'logs' ? ['Logs', observabilityPlaceLabel({ kind: 'component', id: s.selected.id }) || grafanaPlatform()?.label].filter(Boolean).join(' · ')
    : s.selected.kind === 'alert' ? 'Alert' : 'Dashboard';
  return `<div class="gfv-head">
      <div class="gfv-head-top">${back ? `<button type="button" class="ws-ghost ws-ghost--sm" id="gfv-back" title="Back to ${gfvAttr(back)}">‹ ${escapeHtml(back)}</button>` : ''}<span class="gfv-here">${escapeHtml(here)}</span></div>
      ${s.selected.kind === 'logs' ? grafanaVitalsHtml(grafanaService()) : ''}
    </div>`;
}

function paintGrafanaHeader() {
  const head = grafanaViewer?.querySelector('.gfv-head');
  if (head) { head.outerHTML = grafanaHeaderHtml(); bindGrafanaHeader(); return; }
  // On a component page the figures sit in the page itself.
  const vitals = grafanaViewer?.querySelector('.obs-page .gfv-vitals');
  if (vitals) { vitals.outerHTML = grafanaVitalsHtml(grafanaService()); bindGrafanaHeader(); }
}

function bindGrafanaHeader() {
  const s = grafanaViewState;
  const back = grafanaViewer.querySelector('#gfv-back');
  if (back) back.onclick = () => selectGrafana(s.back);
  grafanaViewer.querySelectorAll('[data-vital]').forEach(b => {
    b.onclick = () => {
      const health = (s.dashboards || []).find(d => /platform health/i.test(d.title));
      if (health) selectGrafana({ kind: 'dashboard', id: health.uid });
    };
  });
}

// --- Main area ---

function renderGrafanaView() {
  renderGrafanaList();
  renderGrafanaMain();
  if (typeof renderSidebarRail === 'function') renderSidebarRail();
}

function renderGrafanaMain() {
  if (!grafanaViewer || activeTab !== 'grafana') return;
  const s = grafanaViewState;
  const page = GRAFANA_PAGES.includes(s.selected.kind);
  if (s.selected.kind === 'setup' || (!page && !s.config?.hasToken)) { renderGrafanaSetup(); return; }
  // A dashboard's webview survives repaints of the rest: reloading it would lose its state.
  const keepWebview = s.selected.kind === 'dashboard' && grafanaViewer.querySelector(`webview[data-uid="${CSS.escape(s.selected.id || '')}"]`);
  if (keepWebview) { paintGrafanaHeader(); return; }
  let body = '';
  if (page) body = observabilityPageHtml();
  else if (s.selected.kind === 'alert') body = grafanaAlertHtml(s.alerts?.find(a => a.uid === s.selected.id));
  else if (s.selected.kind === 'dashboard') body = grafanaDashboardHtml((s.dashboards || []).find(d => d.uid === s.selected.id));
  else body = grafanaLogsHtml();
  // The same page keeps its scroll; another one starts at the top.
  const pageKey = `${s.selected.kind}:${s.selected.id || ''}`;
  const scroll = grafanaViewer.dataset.page === pageKey ? grafanaViewer.querySelector('.gfv-body')?.scrollTop || 0 : 0;
  grafanaViewer.dataset.page = pageKey;
  grafanaViewer.innerHTML = `${page ? '' : grafanaHeaderHtml()}<div class="gfv-body${s.selected.kind === 'dashboard' ? ' gfv-body--dash' : ''}">${body}</div>`;
  const bodyEl = grafanaViewer.querySelector('.gfv-body');
  if (s.selected.kind !== 'dashboard') bodyEl.scrollTop = scroll;
  bindGrafanaHeader();
  if (page) bindObservabilityPage();
  else if (s.selected.kind === 'alert') bindGrafanaAlert();
  else if (s.selected.kind === 'dashboard') bindGrafanaDashboard();
  else bindGrafanaLogs();
}

/** Grafana's connect form: on the alert, dashboard and logs pages until a token is set, and from a page's Connect button. */
function renderGrafanaSetup() {
  const s = grafanaViewState;
  grafanaViewer.dataset.page = 'setup';
  grafanaViewer.innerHTML = `<div class="gfv-body">${s.back ? `<button type="button" class="ws-ghost ws-ghost--sm" id="gfv-setup-back">‹ Back</button>` : ''}<div class="gfv-setup">
      <h3>Connect Grafana</h3>
      <p>Switchboard reads alerts, figures and logs with a read-only token. In Grafana: Administration, Users and access, Service accounts, Add service account with the <b>Viewer</b> role, then Add service account token. The token is kept in the keychain.</p>
      <label class="gfv-field">URL <input type="text" class="ws-input" id="gfv-url" value="${gfvAttr(s.config?.url || 'https://monitoring.mls-cdn.net')}" spellcheck="false"></label>
      <label class="gfv-field">Token <input type="password" class="ws-input" id="gfv-token" placeholder="glsa_…" spellcheck="false"></label>
      ${s.error ? `<div class="gh-error">${escapeHtml(s.error)}</div>` : ''}
      <button type="button" class="ws-btn ws-btn--primary" id="gfv-save">Connect</button>
    </div></div>`;
  const back = grafanaViewer.querySelector('#gfv-setup-back');
  if (back) back.onclick = () => selectGrafana(s.back);
  grafanaViewer.querySelector('#gfv-save').onclick = async () => {
    const result = await window.api.saveGrafanaConfig({ url: grafanaViewer.querySelector('#gfv-url').value, token: grafanaViewer.querySelector('#gfv-token').value });
    if (result?.error) { s.error = result.error; renderGrafanaSetup(); return; }
    s.error = null;
    s.config = null;
    if (s.selected.kind === 'setup' && s.back) s.selected = s.back;
    await loadGrafanaView();
    startGrafanaPolling();
  };
}

// --- An alert ---

function grafanaLineChart(series, w = 640, h = 140) {
  const all = series.flatMap(s => s.points).filter(([, v]) => Number.isFinite(v));
  if (all.length < 2) return '<div class="gh-muted">No data for this query in the last hour.</div>';
  const t0 = Math.min(...all.map(p => p[0])), t1 = Math.max(...all.map(p => p[0]));
  const lo = Math.min(0, ...all.map(p => p[1])), hi = Math.max(...all.map(p => p[1]));
  const x = (t) => 4 + ((t - t0) / Math.max(t1 - t0, 1)) * (w - 8);
  const y = (v) => h - 14 - ((v - lo) / Math.max(hi - lo, 1e-9)) * (h - 24);
  const hues = [230, 150, 30, 330, 190, 60, 280, 0];
  const lines = series.map((s, i) => `<polyline fill="none" stroke="hsl(${hues[i % hues.length]},70%,65%)" stroke-width="1.5" points="${s.points.filter(([, v]) => Number.isFinite(v)).map(([t, v]) => `${x(t).toFixed(1)},${y(v).toFixed(1)}`).join(' ')}"/>`).join('');
  const fmt = (v) => (Math.abs(v) >= 100 ? Math.round(v) : Number(v.toPrecision(3)));
  return `<svg class="gfv-chart" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">${lines}
      <text x="4" y="10" class="gfv-chart-t">${fmt(hi)}</text><text x="4" y="${h - 2}" class="gfv-chart-t">${new Date(t0 * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</text>
      <text x="${w - 4}" y="${h - 2}" text-anchor="end" class="gfv-chart-t">${new Date(t1 * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</text></svg>`;
}

function grafanaAlertHtml(a) {
  if (!a) return '<div class="ghv-empty">This alert rule is gone.</div>';
  const s = grafanaViewState;
  const series = s.alertSeries.get(a.uid);
  const platform = grafanaPlatform(a.platform);
  const notes = [a.annotations?.summary, a.annotations?.description].filter(Boolean).join('\n\n');
  const labels = Object.entries(a.labels || {});
  return `<div class="gfv-page">
      <div class="gfv-title"><span class="gfv-pill gfv-pill--${gfvAttr(a.state)}">${escapeHtml(a.state)}</span>${escapeHtml(a.title)}</div>
      <div class="gfv-meta">${platform ? `<span class="gfv-plat">${escapeHtml(platform.label)}</span>` : '<span>infrastructure</span>'}<span>${escapeHtml(a.group)}</span>
        ${a.activeAt ? `<span>since ${escapeHtml(formatDate(new Date(a.activeAt)))}</span>` : ''}${a.value != null ? `<span>value ${escapeHtml(String(a.value))}</span>` : ''}
        <span class="ws-flex"></span>
        <button type="button" class="ws-ghost" id="gfv-alert-open">${PICONS.open(12)}<span>Open in Grafana</span></button>
        <button type="button" class="ws-btn ws-btn--sm" id="gfv-alert-claude">${ICONS.claude(12)}<span>Ask Claude</span></button></div>
      ${notes ? `<div class="gfv-notes gh-md">${githubMarkdown(notes)}</div>` : ''}
      <div class="gfv-sec"><div class="gh-sec-h">Query, the hour around it</div>${series ? grafanaLineChart(series) : '<div class="gh-muted">Loading…</div>'}
        <pre class="gfv-query">${escapeHtml(a.query)}</pre></div>
      ${a.instances.length ? `<div class="gfv-sec"><div class="gh-sec-h">Instances</div>${a.instances.map(i => `<div class="gfv-inst"><span class="gfv-dot gfv-dot--${gfvAttr(i.state)}"></span>${Object.entries(i.labels).filter(([k]) => !k.startsWith('__') && k !== 'alertname' && k !== 'grafana_folder').map(([k, v]) => `<span class="gfv-label">${escapeHtml(k)}=${escapeHtml(v)}</span>`).join('')}${i.value != null ? `<span class="gh-muted">${escapeHtml(String(i.value))}</span>` : ''}</div>`).join('')}</div>` : ''}
      ${labels.length ? `<div class="gfv-sec"><div class="gh-sec-h">Labels</div>${labels.map(([k, v]) => `<span class="gfv-label">${escapeHtml(k)}=${escapeHtml(v)}</span>`).join('')}</div>` : ''}
    </div>`;
}

function bindGrafanaAlert() {
  const s = grafanaViewState;
  const a = s.alerts?.find(x => x.uid === s.selected.id);
  if (!a) return;
  if (!s.alertSeries.has(a.uid)) {
    window.api.getGrafanaAlertSeries({ query: a.query, activeAt: a.activeAt }).then(r => {
      s.alertSeries.set(a.uid, r?.series || []);
      if (s.selected.kind === 'alert' && s.selected.id === a.uid) renderGrafanaMain();
    });
  }
  grafanaViewer.querySelector('#gfv-alert-open').onclick = () => window.api.openExternal(`${s.config.url}/alerting/grafana/${encodeURIComponent(a.uid)}/view`);
  grafanaViewer.querySelector('#gfv-alert-claude').onclick = () => askClaudeAboutGrafanaAlert(a);
}

// --- A dashboard ---

function grafanaDashboardHtml(d) {
  if (!d) return '<div class="ghv-empty">This dashboard is gone.</div>';
  const url = `${grafanaViewState.config.url}${d.url}?orgId=1&kiosk&var-env=prod`;
  return `<div class="gfv-dash-bar"><span class="gfv-dash-title">${escapeHtml(d.title)}</span><span class="gh-muted">${escapeHtml(d.folder)}</span><span class="ws-flex"></span>
      <button type="button" class="ws-ghost" id="gfv-dash-reload" title="Load the dashboard again">${PICONS.refresh(12)}</button>
      <button type="button" class="ws-ghost" id="gfv-dash-open">${PICONS.open(12)}<span>Open in browser</span></button></div>
    <webview class="gfv-webview" data-uid="${gfvAttr(d.uid)}" src="${gfvAttr(url)}" partition="persist:grafana"></webview>`;
}

function bindGrafanaDashboard() {
  const d = (grafanaViewState.dashboards || []).find(x => x.uid === grafanaViewState.selected.id);
  if (!d) return;
  const view = grafanaViewer.querySelector('webview');
  grafanaViewer.querySelector('#gfv-dash-reload').onclick = () => view?.reload();
  grafanaViewer.querySelector('#gfv-dash-open').onclick = () => window.api.openExternal(`${grafanaViewState.config.url}${d.url}?orgId=1&var-env=prod`);
}

// --- Logs ---

function grafanaLevelOf(line) {
  const l = String(line.labels?.level || '').toLowerCase();
  if (l) return l;
  const m = /\.(ERROR|CRITICAL|EMERGENCY|ALERT|WARNING|INFO|DEBUG|NOTICE)\b/.exec(line.line);
  return m ? m[1].toLowerCase() : '';
}

function grafanaLogsHtml() {
  const s = grafanaViewState;
  const L = s.logs;
  const p = grafanaPlatform();
  const services = (p?.apps || []).length > 1 ? `<select id="gfv-log-app" class="gfv-select"><option value="">All services</option>${p.apps.map(a => `<option value="${gfvAttr(a)}"${L.app === a ? ' selected' : ''}>${escapeHtml(a)}</option>`).join('')}</select>` : '';
  const filters = L.useRaw
    ? `<textarea id="gfv-log-raw" class="ws-input gfv-raw" rows="2" spellcheck="false" placeholder='{app="MoveLabConnect", env="prod"} |= "Exception"'>${escapeHtml(L.raw || L.query)}</textarea>`
    : `<div class="gfv-levels">${GRAFANA_LEVELS.map(l => `<label class="gfv-level gfv-level--${l}"><input type="checkbox" data-level="${l}"${L.levels.includes(l) ? ' checked' : ''}>${l}</label>`).join('')}</div>
       ${services}<input type="text" id="gfv-log-contains" class="ws-input gfv-contains" placeholder="Contains…" value="${gfvAttr(L.contains)}" spellcheck="false">`;
  const checked = L.checked.size;
  const rows = L.lines.map((line, i) => {
    const level = grafanaLevelOf(line);
    const first = line.line.split('\n')[0];
    const open = L.open === line.ts;
    const ctx = open ? L.context.get(line.ts) : null;
    return `<div class="gfv-log${open ? ' open' : ''}" data-i="${i}">
        <div class="gfv-log-h"><input type="checkbox" class="gfv-log-check" data-i="${i}"${L.checked.has(i) ? ' checked' : ''}>
          <span class="gfv-log-t">${escapeHtml(new Date(line.time).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }))}</span>
          ${level ? `<span class="gfv-lvl gfv-lvl--${gfvAttr(level)}">${escapeHtml(level)}</span>` : ''}${(p?.apps || []).length > 1 ? `<span class="gfv-plat">${escapeHtml(line.labels.app || '')}</span>` : ''}
          <span class="gfv-log-first">${escapeHtml(first.slice(0, 400))}</span></div>
        ${open ? `<pre class="gfv-log-full">${escapeHtml(line.line)}</pre>
          <div class="gfv-log-acts">${ctx ? '' : '<button type="button" class="ws-ghost ws-ghost--sm" data-context="1">Show the lines around it</button>'}</div>
          ${ctx ? `<div class="gfv-ctx">${ctx.map(c => `<div class="gfv-ctx-line${c.ts === line.ts ? ' here' : ''}"><span class="gfv-log-t">${escapeHtml(new Date(c.time).toLocaleTimeString())}</span>${escapeHtml(c.line.split('\n')[0].slice(0, 300))}</div>`).join('')}</div>` : ''}` : ''}
      </div>`;
  }).join('');
  return `<div class="gfv-page gfv-page--logs">
      <div class="gfv-logbar">${filters}
        <select id="gfv-log-range" class="gfv-select">${GRAFANA_RANGES.map(([label, sec]) => `<option value="${sec}"${L.range === sec ? ' selected' : ''}>${label}</option>`).join('')}</select>
        <label class="gfv-live${L.live ? ' on' : ''}" title="Add new lines every few seconds"><input type="checkbox" id="gfv-log-live"${L.live ? ' checked' : ''}>Live</label>
        <button type="button" class="ws-ghost ws-ghost--sm" id="gfv-log-mode" title="${L.useRaw ? 'Back to the filters' : 'Write the LogQL yourself'}">${L.useRaw ? 'Filters' : 'LogQL'}</button>
        <button type="button" class="ws-btn ws-btn--sm ws-btn--primary" id="gfv-log-search">${L.loading ? 'Searching…' : 'Search'}</button>
      </div>
      <div class="gfv-ask">
        <input type="text" id="gfv-log-question" class="ws-input" placeholder="${checked ? `Ask Claude about the ${checked} checked line${checked === 1 ? '' : 's'}…` : 'Ask Claude about these logs…'}" value="${gfvAttr(L.question)}">
        <button type="button" class="ws-btn ws-btn--sm" id="gfv-log-claude">${ICONS.claude(12)}<span>Ask Claude</span></button>
      </div>
      ${L.error ? `<div class="gh-error gfv-log-error">${escapeHtml(L.error)}</div>` : ''}
      <div class="gfv-log-sum gh-muted">${L.lines.length ? `${L.lines.length} line${L.lines.length === 1 ? '' : 's'}, newest first${L.lines.length >= 500 ? ' (the first 500)' : ''}` : L.loading ? 'Searching…' : 'No lines.'}<span class="ws-flex"></span><code>${escapeHtml(L.query)}</code></div>
      <div class="gfv-logs">${rows}</div>
    </div>`;
}

function grafanaLogSpec() {
  const L = grafanaViewState.logs;
  return { platform: grafanaViewState.platform, app: L.app, levels: L.levels, contains: L.contains, raw: L.useRaw ? L.raw : '', rangeSeconds: L.range, limit: 500 };
}

async function loadGrafanaLogs() {
  const s = grafanaViewState;
  const L = s.logs;
  L.loading = true;
  L.error = null;
  renderGrafanaMain();
  const result = await window.api.getGrafanaLogs(grafanaLogSpec()).catch(err => ({ error: err?.message || String(err) }));
  L.loading = false;
  if (result?.error) L.error = result.error;
  else { L.lines = result.lines || []; L.query = result.query; L.checked.clear(); L.open = null; }
  renderGrafanaMain();
  scheduleGrafanaLive();
}

/** Live: every few seconds, the lines that came after the newest one shown go on top. */
function scheduleGrafanaLive() {
  const L = grafanaViewState.logs;
  clearTimeout(L.liveTimer);
  if (!L.live) return;
  L.liveTimer = setTimeout(async () => {
    if (!L.live || activeTab !== 'grafana' || grafanaViewState.selected.kind !== 'logs') { scheduleGrafanaLive(); return; }
    const since = L.lines[0]?.ts;
    const result = await window.api.getGrafanaLogs({ ...grafanaLogSpec(), since }).catch(() => null);
    if (result && !result.error && result.lines?.length) {
      // Checked lines and the open one keep their place: indexes move by the count added.
      const added = result.lines.length;
      L.checked = new Set([...L.checked].map(i => i + added));
      L.lines = [...result.lines, ...L.lines].slice(0, 2000);
      const typing = document.activeElement?.id === 'gfv-log-question' || document.activeElement?.id === 'gfv-log-contains';
      if (!typing) renderGrafanaMain();
    }
    scheduleGrafanaLive();
  }, GRAFANA_LIVE_MS);
}

function bindGrafanaLogs() {
  const s = grafanaViewState;
  const L = s.logs;
  const $ = (sel) => grafanaViewer.querySelector(sel);
  grafanaViewer.querySelectorAll('[data-level]').forEach(cb => {
    cb.onchange = () => { L.levels = GRAFANA_LEVELS.filter(l => grafanaViewer.querySelector(`[data-level="${l}"]`).checked); loadGrafanaLogs(); };
  });
  if ($('#gfv-log-app')) $('#gfv-log-app').onchange = (e) => { L.app = e.target.value; loadGrafanaLogs(); };
  if ($('#gfv-log-contains')) {
    $('#gfv-log-contains').oninput = (e) => { L.contains = e.target.value; };
    $('#gfv-log-contains').onkeydown = (e) => { if (e.key === 'Enter') loadGrafanaLogs(); };
  }
  if ($('#gfv-log-raw')) {
    $('#gfv-log-raw').oninput = (e) => { L.raw = e.target.value; };
    $('#gfv-log-raw').onkeydown = (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); loadGrafanaLogs(); } };
  }
  $('#gfv-log-range').onchange = (e) => { L.range = Number(e.target.value); loadGrafanaLogs(); };
  $('#gfv-log-live').onchange = (e) => { L.live = e.target.checked; renderGrafanaMain(); scheduleGrafanaLive(); };
  $('#gfv-log-mode').onclick = () => { L.useRaw = !L.useRaw; if (L.useRaw && !L.raw) L.raw = L.query; renderGrafanaMain(); };
  $('#gfv-log-search').onclick = () => loadGrafanaLogs();
  $('#gfv-log-question').oninput = (e) => { L.question = e.target.value; };
  $('#gfv-log-question').onkeydown = (e) => { if (e.key === 'Enter') askClaudeAboutGrafanaLogs(); };
  $('#gfv-log-claude').onclick = () => askClaudeAboutGrafanaLogs();
  grafanaViewer.querySelectorAll('.gfv-log-check').forEach(cb => {
    cb.onclick = (e) => e.stopPropagation();
    cb.onchange = () => { const i = Number(cb.dataset.i); if (cb.checked) L.checked.add(i); else L.checked.delete(i); renderGrafanaMain(); };
  });
  grafanaViewer.querySelectorAll('.gfv-log-h').forEach(h => {
    h.onclick = () => {
      const line = L.lines[Number(h.parentElement.dataset.i)];
      L.open = L.open === line.ts ? null : line.ts;
      renderGrafanaMain();
    };
  });
  grafanaViewer.querySelectorAll('[data-context]').forEach(b => {
    b.onclick = async (e) => {
      e.stopPropagation();
      const line = L.lines[Number(b.closest('.gfv-log').dataset.i)];
      const result = await window.api.getGrafanaLogContext({ labels: line.labels, ts: line.ts });
      L.context.set(line.ts, result?.lines || []);
      renderGrafanaMain();
    };
  });
}

// --- Asking Claude ---

/** The local checkout of a platform repo (MoveLab-Studio/<name>), or null. */
async function grafanaRepoPath(name) {
  return typeof findLocalClone === 'function' ? findLocalClone({}, `MoveLab-Studio/${name}`) : null;
}

/**
 * A session in the platform's repo (or the chat folder) beside the page: read
 * only, to investigate. `apps` picks the NOHRD repo(s) when lines are given.
 */
async function startGrafanaSession(key, { platform, apps = [], prompt, label }) {
  const repos = platform ? grafanaReposFor(platform, apps) : [];
  const paths = (await Promise.all(repos.map(grafanaRepoPath))).filter(Boolean);
  let projectPath = paths[0];
  if (!projectPath) {
    const folder = await window.api.getChatFolder();
    if (!folder || folder.error) { alert(`Could not create the chat folder: ${folder?.error || 'unknown error'}`); return; }
    projectPath = folder;
  }
  const target = { folder: encodeProjectPath(projectPath), projectPath, sessions: [] };
  const options = await resolveDefaultSessionOptions(target);
  options.runtime = 'claude';
  options.initialPrompt = prompt;
  delete options.worktree;
  delete options.worktreeName;
  if (paths.length > 1) options.addDirs = [options.addDirs, ...paths.slice(1)].filter(Boolean).join(', ');
  // Started from the Grafana tab it opens beside the page (session-context.js).
  const origin = sessionPlaceHere();
  const sessionId = await launchNewSession(target, options, { focus: true });
  if (!sessionId) return;
  grafanaViewState.sessions.set(key, sessionId);
  // Kept for good: the alert or the platform's logs, and the way back.
  const [kind, ref] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)];
  linkSession(sessionId, kind, ref, kind === 'alert' ? label.replace(/^Alert: /, '') : label);
  rememberSessionOrigin(sessionId, origin);
  refreshSessionContextViews(sessionId);
  prSessionLabels.set(sessionId, label);
}

/** The repo folder names for a platform: per Loki app for NOHRD, else its one repo (grafana.js PLATFORMS). */
function grafanaReposFor(platform, apps) {
  const p = grafanaPlatform(platform);
  const repos = p?.repos || {};
  const used = (apps.length ? apps : p?.apps || []).filter(a => repos[a]);
  return [...new Set(used.map(a => repos[a]))];
}

async function askClaudeAboutGrafanaLogs() {
  const s = grafanaViewState;
  const L = s.logs;
  const p = grafanaPlatform();
  const picked = L.checked.size ? [...L.checked].sort((a, b) => a - b).map(i => L.lines[i]).filter(Boolean) : L.lines.slice(0, 50);
  const apps = [...new Set(picked.map(l => l.labels.app).filter(Boolean))];
  const range = GRAFANA_RANGES.find(([, sec]) => sec === L.range)?.[0] || `${L.range}s`;
  const note = await window.api.getGrafanaSessionNote();
  const question = L.question.trim() || 'What is going on here? Find the cause, in the logs and in this repository\'s code.';
  const prompt = [
    `Production logs of ${p?.label} (Loki, env="prod"), the last ${range}. Query: \`${L.query}\``,
    '',
    `My question: ${question}`,
    '',
    `${L.checked.size ? 'The lines I picked' : `The newest ${picked.length} lines`}, oldest first:`,
    '```',
    ...picked.slice().reverse().map(l => `${new Date(l.time).toISOString()} [${l.labels.app || ''}] ${l.line.length > 4000 ? `${l.line.slice(0, 4000)}…` : l.line}`),
    '```',
    '',
    'Investigate only: do not change code, deploy or write anywhere unless I ask for it here.',
    '',
    note,
  ].join('\n');
  L.question = '';
  await startGrafanaSession(`logs:${s.platform}`, { platform: s.platform, apps, prompt, label: `Logs on ${p?.label}` });
}

async function askClaudeAboutGrafanaAlert(a) {
  const note = await window.api.getGrafanaSessionNote();
  const p = grafanaPlatform(a.platform);
  const prompt = [
    `Grafana alert "${a.title}" is ${a.state}${a.activeAt ? ` since ${a.activeAt}` : ''}${p ? `, on ${p.label}` : ''} (production).`,
    a.annotations?.summary ? `Summary: ${a.annotations.summary}` : '',
    a.annotations?.description ? `Description: ${a.annotations.description}` : '',
    `Rule group: ${a.group}. Its query:`,
    '```',
    a.query,
    '```',
    a.instances.length ? `Active instances: ${a.instances.map(i => JSON.stringify(i.labels)).join('; ')}` : '',
    '',
    'Find out why it fires and what to do about it: query the metrics and the logs around that time, and look in this repository\'s code where it helps. Investigate only: do not change code, deploy or write anywhere unless I ask for it here.',
    '',
    note,
  ].filter(line => line !== '').join('\n');
  await startGrafanaSession(`alert:${a.uid}`, { platform: a.platform, apps: a.apps || [], prompt, label: `Alert: ${a.title}` });
}

// --- The session beside the page ---
// In this tab a shown session sits on the right instead of covering the page
// (session-context.js); the header's Hide puts the page back alone.

registerSessionSplit('grafana', {
  viewer: () => grafanaViewer,
  className: 'gfv-split',
  onShown: (sessionId) => { grafanaViewState.splitSession = sessionId; },
  onLeave: () => { grafanaViewState.splitSession = null; },
  hide: () => leaveSessionSplit(),
});

function leaveGrafanaSplit() {
  leaveSessionSplit();
  grafanaViewState.splitSession = null;
}

/** The selected alert's (or the platform's logs') running session beside it, or the page alone. */
function showGrafanaItemSession() {
  const s = grafanaViewState;
  const key = s.selected.kind === 'alert' ? `alert:${s.selected.id}` : s.selected.kind === 'logs' ? `logs:${s.platform}` : null;
  const id = key && s.sessions.get(key);
  if (id && openSessions.has(id) && !openSessions.get(id).closed) showSession(id);
  else leaveGrafanaSplit();
}

/** Called when the Grafana tab is opened (app.js). */
async function showGrafanaView() {
  hideAllViewers();
  // hideAllViewers puts the terminal area back; this tab covers it instead.
  placeholder.style.display = 'none';
  terminalArea.style.display = 'none';
  grafanaViewer.style.display = 'flex';
  renderGrafanaView();
  startObservabilityPolling();
  await loadGrafanaView();
  showGrafanaItemSession();
}

function hideGrafanaView() {
  if (grafanaViewer) grafanaViewer.style.display = 'none';
  // showSession passes through here too; onSessionSplitShown puts the split back.
  mainEl.classList.remove('gfv-split');
}

// The badge and notifications run from the start, not only once the tab is opened.
loadGrafanaConfig().then(config => {
  if (!config?.hasToken) return;
  loadGrafanaAlerts().then(() => { if (typeof renderSidebarRail === 'function') renderSidebarRail(); });
  startGrafanaPolling();
});
