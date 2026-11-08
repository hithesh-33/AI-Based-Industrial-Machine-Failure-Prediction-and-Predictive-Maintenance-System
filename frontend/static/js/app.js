const pageContent = document.getElementById('pageContent');
const pageNames = {
  overview: 'Overview', 'machine-fleet': 'Machine Fleet', 'ai-predictions': 'AI Predictions',
  'maintenance-alerts': 'Maintenance Alerts', 'failure-analytics': 'Failure Analytics',
  'root-cause-analysis': 'Root Cause Analysis',
  'production-impact': 'Production Impact Analyzer', 'work-order-automation': 'Work Order Automation',
  'ai-assistant': 'AI Assistant', 'maintenance-schedule': 'Maintenance Schedule',
  reports: 'Reports', 'user-management': 'User Management', settings: 'Settings'
};
const sensors = [
  ['Temperature', 'Temperature', '°C', 0, 200],
  ['Vibration', 'Vibration', 'mm/s', 0, 30],
  ['Rotational speed', 'RotationalSpeed', 'rpm', 0, 10000],
  ['Pressure', 'Pressure', 'bar', 0, 30],
  ['Machine load', 'MachineLoad', '%', 0, 150]
];
let machines = [];
let summary = { total: 0, healthy: 0, warning: 0, critical: 0, maintenance: 0 };
let fleetChart = null;
let detailChart = null;
let analyticsChart = null;
let analyticsFleetChart = null;
let renderedPage = null;
let dashboardError = '';
let clockFormatter = null;
let clockTimezone = null;
let knownActiveAlertIds = null;
const csrfToken = document.querySelector('meta[name="csrf-token"]')?.content || '';
const userRole = document.querySelector('meta[name="user-role"]')?.content || 'viewer';
const permissions = {
  manageAlerts: ['admin', 'operator'].includes(userRole),
  manageWorkOrders: ['admin', 'operator'].includes(userRole),
  manageUsers: userRole === 'admin'
};
const storage = {
  read(key, fallback) {
    try { return JSON.parse(localStorage.getItem(`forgesight.${key}`)) ?? fallback; }
    catch (error) { console.warn(`Could not read saved ${key} preferences.`, error); return fallback; }
  },
  write(key, value) {
    try { localStorage.setItem(`forgesight.${key}`, JSON.stringify(value)); }
    catch (error) { console.error(`Could not save ${key}.`, error); }
  }
};

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[char]);
}
function fmt(value) { return Number(value).toFixed(1); }
function updateClock() {
  const preferences = storage.read('settings', { timezone: 'Asia/Kolkata' });
  const timezone = preferences.timezone || 'Asia/Kolkata';
  if (timezone !== clockTimezone) {
    try {
      clockFormatter = new Intl.DateTimeFormat('en-IN', {
        weekday: 'short',
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        second: '2-digit',
        hour12: true,
        timeZone: timezone
      });
      clockTimezone = timezone;
    } catch (error) {
      console.error(`Invalid workspace timezone "${timezone}". Falling back to the browser timezone.`, error);
      clockFormatter = new Intl.DateTimeFormat('en-IN', {
        weekday: 'short',
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        second: '2-digit',
        hour12: true
      });
      clockTimezone = null;
    }
  }
  const now = new Date();
  const clock = document.getElementById('today');
  clock.textContent = clockFormatter.format(now);
  clock.dateTime = now.toISOString();
  clock.title = `Current time in ${clockFormatter.resolvedOptions().timeZone}`;
}
function formatDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}
function statusClass(risk) { return ['Healthy', 'Warning', 'Critical'].includes(risk) ? risk : 'Warning'; }
function statusBadge(risk) { return `<span class="status ${statusClass(risk)}">${esc(risk)}</span>`; }
function stat(label, value, note, icon) {
  return `<div class="stat-card"><div class="stat-top">${esc(label)}</div><div class="stat-value">${esc(value)}</div><div class="stat-note">${esc(note)}</div><div class="stat-icon">${icon}</div></div>`;
}
function pageHeader(title, description, actions = '') {
  return `<div class="page-heading"><div><div class="eyebrow">PLANT INTELLIGENCE</div><h1>${esc(title)}</h1><p>${esc(description)}</p></div><div class="heading-actions">${actions}</div></div>`;
}
function machineCard(machine) {
  const color = machine.risk === 'Critical' ? '#dc716a' : machine.risk === 'Warning' ? '#e7ad55' : '#45b88d';
  return `<article class="machine-card" data-open-machine="${esc(machine.id)}" tabindex="0" role="button" aria-label="View ${esc(machine.name)}">
    <div class="machine-top"><div><div class="machine-name">${esc(machine.name)}</div><div class="machine-id">${esc(machine.id)} · ${esc(machine.line)}</div></div>${statusBadge(machine.risk)}</div>
    <div class="health-row"><span>Machine health</span><b>${esc(machine.health)}/100</b></div>
    <div class="progress"><div class="progress-bar" style="width:${Math.max(0, Math.min(100, Number(machine.health)))}%;background:${color}"></div></div>
    <div class="sensor-mini"><div><span>Temperature</span><b>${esc(machine.sensors.Temperature)}°C</b></div><div><span>Vibration</span><b>${esc(machine.sensors.Vibration)} mm/s</b></div><div><span>Speed</span><b>${esc(machine.sensors.RotationalSpeed)} rpm</b></div></div>
    <div class="risk-line">Estimated failure risk <b>${esc(machine.probability)}%</b></div>
  </article>`;
}
function pageTable(headers, rows, empty = 'No records to display.') {
  if (!rows.length) return `<div class="table-panel"><div class="empty-state">${esc(empty)}</div></div>`;
  return `<div class="table-panel"><table class="data-table"><thead><tr>${headers.map(header => `<th>${esc(header)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
}
function machineSelect(id = 'predictionMachine', selected = '', name = '') {
  return `<select class="filter-select" id="${id}" ${name ? `name="${name}"` : ''} aria-label="Select machine">${machines.map(machine => `<option value="${esc(machine.id)}" ${machine.id === selected ? 'selected' : ''}>${esc(machine.id)} · ${esc(machine.name)}</option>`).join('')}</select>`;
}
function pageActions() {
  const actions = document.querySelectorAll('.nav-item');
  actions.forEach(link => {
    const active = link.dataset.page === pageKey();
    link.classList.toggle('active', active);
    if (active) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
  document.getElementById('pageCrumb').textContent = pageNames[pageKey()] || 'Overview';
}
function pageKey() {
  const requested = location.hash.replace(/^#/, '');
  return Object.prototype.hasOwnProperty.call(pageNames, requested) ? requested : 'overview';
}
function drawFleetChart(canvasId = 'fleetChart', data = summary) {
  const canvas = document.getElementById(canvasId);
  if (!canvas || typeof Chart === 'undefined') return;
  if (canvasId === 'fleetChart' && fleetChart) fleetChart.destroy();
  if (canvasId === 'analyticsFleetChart' && analyticsFleetChart) analyticsFleetChart.destroy();
  const chart = new Chart(canvas, {
    type: 'doughnut',
    data: { labels: ['Healthy', 'Warning', 'Critical'], datasets: [{ data: [data.healthy, data.warning, data.critical], backgroundColor: ['#45b88d', '#e7ad55', '#dc716a'], borderWidth: 0, hoverOffset: 5 }] },
    options: { maintainAspectRatio: false, cutout: '72%', plugins: { legend: { display: false } } }
  });
  if (canvasId === 'fleetChart') fleetChart = chart;
  if (canvasId === 'analyticsFleetChart') analyticsFleetChart = chart;
}
function renderOverview() {
  const alerts = machines.filter(machine => machine.risk !== 'Healthy');
  const alertRows = alerts.length ? alerts.slice(0, 4).map(machine => `
    <div class="alert-row"><div class="alert-symbol">!</div><div class="alert-text"><b>${esc(machine.id)} · ${esc(machine.name)}</b><small>${machine.risk === 'Critical' ? 'Review immediately and inspect the machine.' : 'Plan an inspection and verify sensor readings.'}</small></div>${statusBadge(machine.risk)}</div>`).join('') : '<div class="empty-state">No active maintenance alerts.</div>';
  pageContent.innerHTML = `${pageHeader('Plant overview', 'A real-time view of equipment health and maintenance priorities.', '<span class="live-pill"><b></b> DEMO TELEMETRY</span>')}
    <div id="assignedWorkOrders" class="assigned-work-orders" hidden aria-live="polite"></div>
    ${dashboardError ? `<div class="callout mb-3"><b>Telemetry unavailable.</b> ${esc(dashboardError)} <button class="action-link" data-action="retry">Try again</button></div>` : ''}
    <section class="stat-grid">${stat('Total machines', summary.total, 'Across production lines', '▤')}${stat('Healthy machines', summary.healthy, 'Operating within normal range', '✓')}${stat('Needs attention', summary.warning, 'Warning condition', '!')}${stat('Critical alerts', summary.critical, 'Requires immediate review', '⌁')}</section>
    <section class="section-head"><div><h2>Machine fleet</h2><p>Live condition overview across your production lines</p></div><a class="btn-quiet" href="#machine-fleet">View all machines →</a></section>
    <div class="machine-grid">${machines.map(machineCard).join('')}</div>
    <section class="lower-grid"><div class="panel"><div class="panel-head"><div><h2>Maintenance alerts</h2><p>Machines requiring attention</p></div><a class="btn-quiet" href="#maintenance-alerts">Open alerts</a></div>${alertRows}</div>
    <div class="panel"><div class="panel-head"><div><h2>Fleet health</h2><p>Current condition distribution</p></div></div><div class="chart-box"><canvas id="fleetChart"></canvas></div><div class="legend"><span><i class="healthy"></i>Healthy</span><span><i class="warning"></i>Warning</span><span><i class="critical"></i>Critical</span></div></div></section>`;
  drawFleetChart();
  if (userRole === 'operator') refreshAssignedWorkOrders();
}
function renderFleet() {
  pageContent.innerHTML = `${pageHeader('Machine fleet', `${machines.length} assets monitored across your production lines.`, `<input class="search-input" id="fleetSearch" placeholder="Search machines…" aria-label="Search machines"><select class="filter-select" id="fleetRisk"><option value="">All conditions</option><option>Healthy</option><option>Warning</option><option>Critical</option></select>`)}
    ${dashboardError ? `<div class="callout mb-3">${esc(dashboardError)}</div>` : ''}
    <section class="stat-grid">${stat('Total assets', summary.total, 'Machines reporting telemetry', '▤')}${stat('Healthy', summary.healthy, 'Normal operating range', '✓')}${stat('Warning', summary.warning, 'Inspection recommended', '!')}${stat('Critical', summary.critical, 'Immediate review recommended', '⌁')}</section>
    <div class="machine-grid" id="fleetMachines">${machines.map(machineCard).join('')}</div>`;
}
function renderPrediction() {
  const machine = machines[0];
  if (!machine) {
    pageContent.innerHTML = `${pageHeader('AI predictions', 'Run a machine-learning assessment on current sensor readings.')}${dashboardError ? `<div class="callout">${esc(dashboardError)}</div>` : '<div class="empty-state">No machine telemetry is available.</div>'}`;
    return;
  }
  if (!permissions.manageWorkOrders) {
    pageContent.innerHTML = `${pageHeader('AI predictions', 'Prediction history is read-only for your account.') }
      <div class="callout">Your current role can review saved readings and risk estimates but cannot submit predictions.</div>
      <div class="machine-grid">${machines.map(machineCard).join('')}</div>`;
    return;
  }
  pageContent.innerHTML = `${pageHeader('AI predictions', 'Adjust sensor readings and run the trained model to assess machine risk.')}
    <div class="settings-grid"><div class="panel"><div class="panel-head"><div><h2>Prediction inputs</h2><p>Select an asset and enter the latest readings</p></div><span class="tag">RANDOM FOREST</span></div>
      <form id="predictionForm"><label class="form-label small text-muted">Machine</label>${machineSelect('predictionMachine', machine.id)}<div class="sensor-form prediction-sensors mt-3">${sensors.map(([label, key, unit, min, max]) => `<label>${esc(label)} (${unit})<input type="number" step="0.1" min="${min}" max="${max}" name="${key}" value="${esc(machine.sensors[key])}" required></label>`).join('')}</div><button class="btn-primary btn-run" type="submit">Run prediction <span>→</span></button></form>
      <div id="predictionOutput" class="prediction-result" hidden aria-live="polite"></div></div>
      <div class="panel"><div class="panel-head"><div><h2>How to read this estimate</h2><p>Decision support for maintenance planning</p></div><span class="tag">MODEL GUIDE</span></div><div class="insight-list"><div class="insight"><b>Healthy · under 35%</b>Continue normal operation and follow the planned preventive maintenance schedule.</div><div class="insight"><b>Warning · 35–69.9%</b>Schedule an inspection within 24–48 hours and verify sensor readings.</div><div class="insight"><b>Critical · 70% or above</b>Stop and inspect the machine; verify the physical condition before action.</div></div><div class="callout mt-3">Predictions are estimates from the included demonstration model, not a guaranteed diagnosis. Validate readings and follow site safety procedures.</div></div></div>`;
  document.getElementById('predictionMachine').addEventListener('change', updatePredictionInputs);
}
function updatePredictionInputs(event) {
  const machine = machines.find(item => item.id === event.target.value);
  if (!machine) return;
  sensors.forEach(([, key]) => {
    const input = document.querySelector(`#predictionForm [name="${key}"]`);
    if (input) input.value = machine.sensors[key];
  });
}
async function renderAlerts() {
  pageContent.innerHTML = `${pageHeader('Maintenance alerts', 'Review live alerts and the permanent record of actions.') }<div class="loading">Loading alert history…</div>`;
  try {
    const data = await getJSON('/api/alerts');
    const activeAlerts = data.alerts.filter(alert => alert.status !== 'resolved');
    const rows = data.alerts.map(alert => `<tr><td><b>${esc(alert.machine_id)} · ${esc(alert.machine_name)}</b><div class="muted">${esc(alert.line)}</div></td><td>${statusBadge(alert.severity)}</td><td><span class="tag">${esc(alert.status.toUpperCase())}</span></td><td>${esc(alert.title)}<div class="muted">${esc(alert.details)}</div></td><td>${esc(formatDate(alert.created_at))}</td><td class="table-actions">${alert.status !== 'resolved' && permissions.manageAlerts ? `${alert.status === 'open' ? `<button class="btn-outline" data-action="alert-acknowledge" data-id="${alert.id}">Acknowledge</button>` : ''}<button class="btn-quiet" data-action="alert-resolve" data-id="${alert.id}">Resolve</button>` : ''}</td></tr>`);
    const eventRows = data.events.map(event => `<tr><td>${esc(formatDate(event.created_at))}</td><td><b>${esc(event.machine_id)} · ${esc(event.machine_name)}</b></td><td><span class="tag">${esc(event.action.replaceAll('_', ' ').toUpperCase())}</span></td><td>${esc(event.details)}</td><td>${esc(event.actor_name || 'ForgeSight')}</td></tr>`);
    document.getElementById('alertCount').textContent = activeAlerts.length;
    pageContent.innerHTML = `${pageHeader('Maintenance alerts', `${activeAlerts.length} active · ${data.alerts.length} tracked`, '<span class="tag">AUDIT HISTORY ENABLED</span>')}
      <div class="callout mb-3"><b>Alert lifecycle is recorded.</b> New risk alerts, acknowledgements, resolutions, and automated condition changes are saved with timestamps and the responsible user.</div>
      <section class="stat-grid">${stat('Active alerts', activeAlerts.length, 'Open or acknowledged', '!')}${stat('Open', activeAlerts.filter(alert => alert.status === 'open').length, 'Awaiting acknowledgement', '◉')}${stat('Acknowledged', activeAlerts.filter(alert => alert.status === 'acknowledged').length, 'Being reviewed', '✓')}${stat('Resolved', data.alerts.filter(alert => alert.status === 'resolved').length, 'Retained in the audit history', '▤')}</section>
      <section class="section-head"><div><h2>Alert register</h2><p>Current and resolved alert records</p></div><select id="alertFilter" class="filter-select"><option value="">All statuses</option><option value="open">Open</option><option value="acknowledged">Acknowledged</option><option value="resolved">Resolved</option></select></section>
      <div id="alertRegister">${pageTable(['MACHINE', 'SEVERITY', 'STATUS', 'DETAILS', 'RAISED', ''], rows, 'No alert records yet.')}</div>
      <section class="section-head"><div><h2>Alert activity history</h2><p>Chronological audit trail · latest 200 events</p></div></section>
      ${pageTable(['TIME', 'MACHINE', 'EVENT', 'DETAILS', 'ACTOR'], eventRows, 'Alert actions will appear here.')}`;
    document.getElementById('alertFilter').addEventListener('change', event => {
      const visible = data.alerts.filter(alert => !event.target.value || alert.status === event.target.value);
      const filtered = visible.map(alert => rows[data.alerts.indexOf(alert)]);
      document.getElementById('alertRegister').innerHTML = pageTable(['MACHINE', 'SEVERITY', 'STATUS', 'DETAILS', 'RAISED', ''], filtered, 'No alerts match this status.');
    });
  } catch (error) {
    pageContent.innerHTML = `${pageHeader('Maintenance alerts', 'Review live alerts and the permanent record of actions.') }<div class="callout">${esc(error.message)}</div>`;
  }
}
function renderAnalytics() {
  if (analyticsChart) analyticsChart.destroy();
  const critical = [...machines].sort((a, b) => b.probability - a.probability);
  const rows = critical.map((machine, index) => `<tr><td>${index + 1}</td><td><b>${esc(machine.name)}</b><div class="muted">${esc(machine.id)} · ${esc(machine.line)}</div></td><td>${statusBadge(machine.risk)}</td><td><b>${esc(machine.probability)}%</b></td><td>${esc(machine.health)}/100</td></tr>`);
  pageContent.innerHTML = `${pageHeader('Failure analytics', 'Explore current model risk and machine condition across the fleet.')}
    <div class="callout mb-3"><b>Snapshot, not historical failure analytics.</b> This prototype has no stored failure-event history. Charts below summarize the current model assessments only.</div>
    <section class="stat-grid">${stat('Critical risk', summary.critical, 'Current assessments', '!')}${stat('Warning risk', summary.warning, 'Current assessments', '⌁')}${stat('Fleet average risk', machines.length ? `${fmt(machines.reduce((total, item) => total + item.probability, 0) / machines.length)}%` : '—', 'Mean estimated probability', '◷')}${stat('Average health', machines.length ? `${Math.round(machines.reduce((total, item) => total + item.health, 0) / machines.length)}/100` : '—', 'Across monitored machines', '✓')}</section>
    <section class="lower-grid"><div class="panel"><div class="panel-head"><div><h2>Estimated failure risk by machine</h2><p>Probability from latest sensor snapshot</p></div></div><div class="chart-panel"><canvas id="analyticsChart"></canvas></div></div><div class="panel"><div class="panel-head"><div><h2>Fleet condition mix</h2><p>Model-classified risk categories</p></div></div><div class="chart-box"><canvas id="analyticsFleetChart"></canvas></div><div class="legend"><span><i class="healthy"></i>Healthy</span><span><i class="warning"></i>Warning</span><span><i class="critical"></i>Critical</span></div></div></section>
    <section class="section-head"><div><h2>Machine risk ranking</h2><p>Highest estimated probability first</p></div></section>${pageTable(['RANK', 'MACHINE', 'CONDITION', 'FAILURE PROBABILITY', 'HEALTH'], rows)}`;
  if (typeof Chart !== 'undefined') {
    analyticsChart = new Chart(document.getElementById('analyticsChart'), { type: 'bar', data: { labels: critical.map(item => item.id), datasets: [{ label: 'Failure probability (%)', data: critical.map(item => item.probability), backgroundColor: critical.map(item => item.risk === 'Critical' ? '#dc716a' : item.risk === 'Warning' ? '#e7ad55' : '#45b88d'), borderRadius: 5, maxBarThickness: 36 }] }, options: { maintainAspectRatio: false, scales: { y: { beginAtZero: true, max: 100, ticks: { callback: value => `${value}%` } } }, plugins: { legend: { display: false } } } });
  }
  drawFleetChart('analyticsFleetChart');
}
const intelligencePages = {
  'root-cause-analysis': {
    title: 'AI root cause analysis',
    description: 'Evidence-ranked sensor signals and recommended checks for each machine.',
    kind: 'causes'
  },
  'production-impact': {
    title: 'Production impact analyzer',
    description: 'Understand line-level asset exposure and severity-based downtime scenarios.',
    kind: 'impact'
  },
  'work-order-automation': {
    title: 'AI maintenance work order automation',
    description: 'Generate tracked inspection work orders from active maintenance alerts.',
    kind: 'automation'
  }
};
async function renderIntelligencePage(page, notice = '') {
  const config = intelligencePages[page];
  pageContent.innerHTML = `${pageHeader(config.title, config.description)}<div class="loading">Analyzing current sensor history…</div>`;
  try {
    const data = await getJSON('/api/intelligence');
    let activeAlerts = [];
    if (config.kind === 'automation') {
      const alertData = await getJSON('/api/alerts');
      activeAlerts = alertData.alerts.filter(alert => alert.status !== 'resolved');
    }
    const fleet = data.machines;
    const atRisk = fleet.filter(machine => machine.risk !== 'Healthy');
    let content = '';
    if (config.kind === 'causes') {
      const cards = fleet.map(machine => `<article class="panel intelligence-card">
        <div class="panel-head"><div><h2>${esc(machine.name)}</h2><p>${esc(machine.id)} · ${esc(machine.line)}</p></div>${statusBadge(machine.risk)}</div>
        <div class="insight-list">${machine.root_cause.causes.map(cause => `<div class="insight"><b>${esc(cause.title)}${cause.score ? ` · ${esc(cause.score)}% evidence score` : ''}</b>${esc(cause.observation)}<small>${esc(cause.recommendation)}</small></div>`).join('')}</div>
        <div class="muted mt-2">${esc(machine.root_cause.basis)}</div>
      </article>`).join('');
      content = `<section class="stat-grid">${stat('Machines assessed', fleet.length, 'Latest saved telemetry', '⌕')}${stat('Assets with risk signals', atRisk.length, 'Model warning or critical', '!')}${stat('Root-cause method', 'Rules + trend', 'Transparent sensor thresholds', '✳')}${stat('Confirmed diagnoses', '0', 'Requires physical inspection', '✓')}</section><div class="intelligence-grid">${cards}</div><div class="callout mt-3">Cause ranking is based on configured sensor thresholds and recent readings. It is an inspection aid, not a confirmed failure diagnosis.</div>`;
    } else if (config.kind === 'impact') {
      const lines = [...new Set(fleet.map(machine => machine.line))];
      const linesExposed = lines.filter(line => fleet.some(machine => machine.line === line && machine.risk !== 'Healthy')).length;
      const rows = [...fleet].sort((a, b) => ({ Critical: 0, Warning: 1, Healthy: 2 }[a.risk] - { Critical: 0, Warning: 1, Healthy: 2 }[b.risk])).map(machine => `<tr><td><b>${esc(machine.id)} · ${esc(machine.name)}</b></td><td>${esc(machine.production_impact.line)}</td><td>${statusBadge(machine.risk)}</td><td>${esc(machine.production_impact.line_assets_at_risk)} / ${esc(machine.production_impact.line_assets)} assets</td><td>${esc(machine.production_impact.estimated_downtime_hours)} hours</td></tr>`);
      content = `<section class="stat-grid">${stat('Assets at risk', atRisk.length, 'Current model warnings and criticals', '!')}${stat('Lines with exposure', linesExposed, 'Production lines with at-risk assets', '▥')}${stat('Critical scenario', '4–8 hrs', 'Per critical machine; planning only', '◷')}${stat('Warning scenario', '1–3 hrs', 'Per warning machine; planning only', '⌁')}</section>${pageTable(['MACHINE', 'PRODUCTION LINE', 'CONDITION', 'LINE ASSETS AT RISK', 'DOWNTIME SCENARIO'], rows)}<div class="callout mt-3">These are severity-based planning scenarios, not a production forecast. The app has no configured throughput, redundancy, shift, or cost data, so no units or financial loss are inferred.</div>`;
    } else {
      const alertRows = activeAlerts.map(alert => `<tr><td><b>${esc(alert.machine_id)} · ${esc(alert.machine_name)}</b><div class="muted">${esc(alert.line)}</div></td><td>${statusBadge(alert.severity)}</td><td>${esc(alert.details)}</td><td><span class="tag">${esc(alert.status.toUpperCase())}</span></td></tr>`);
      content = `<section class="stat-grid">${stat('Active alerts', activeAlerts.length, 'Eligible for work-order generation', '!')}${stat('Critical', activeAlerts.filter(alert => alert.severity === 'Critical').length, 'Generated as urgent, due today', '⌁')}${stat('Warnings', activeAlerts.filter(alert => alert.severity === 'Warning').length, 'Generated as high, due tomorrow', '◷')}${stat('Automation mode', 'Reviewable', 'Orders remain editable', '⚙')}</section>
        ${notice ? `<div class="callout mb-3">${esc(notice)}</div>` : ''}
        <div class="panel automation-panel"><div class="panel-head"><div><h2>Generate maintenance orders</h2><p>One open order per active alert; repeated runs skip existing orders.</p></div>${permissions.manageWorkOrders ? `<button class="btn-primary" data-action="automate-work-orders" ${activeAlerts.length ? '' : 'disabled'}>Generate work orders</button>` : '<span class="tag">READ ONLY</span>'}</div>
          ${activeAlerts.length ? pageTable(['MACHINE', 'SEVERITY', 'ALERT CONTEXT', 'STATUS'], alertRows) : '<div class="empty-state">No active alerts need a work order.</div>'}
          ${!permissions.manageWorkOrders ? '<div class="callout mt-3">Operator or administrator access is required to create work orders.</div>' : ''}
          <div class="callout mt-3">Generated orders are not assigned automatically. Review the recommended inspection and assign a qualified operator in Maintenance Schedule.</div>
        </div>`;
    }
    pageContent.innerHTML = `${pageHeader(config.title, config.description)}${content}`;
  } catch (error) {
    pageContent.innerHTML = `${pageHeader(config.title, config.description)}<div class="callout callout-error">${esc(error.message)}</div>`;
  }
}
function renderAssistant() {
  pageContent.innerHTML = `${pageHeader('AI assistant', 'Ask about machine health, risk levels, or practical maintenance priorities.')}
    <div class="assistant-layout"><div class="callout mb-3"><b>Gemini assistant.</b> Answers use the current fleet snapshot and are decision support only. Configure <code>GEMINI_API_KEY</code> on the server; never enter or store the key in this browser.</div>
      <div class="chat-window" id="chatWindow" aria-live="polite"><div class="chat-message assistant">Hello! I can summarize this fleet's current health, identify the highest-risk machine, or explain the risk categories. What would you like to know?</div></div>
      <div class="chat-suggestions"><button type="button" data-question="Which machine needs attention first?">Which machine needs attention first?</button><button type="button" data-question="Summarize fleet health">Summarize fleet health</button><button type="button" data-question="What should I do about a critical risk?">What should I do about a critical risk?</button></div>
      <form class="chat-form" id="chatForm"><input name="question" placeholder="Ask a question about your fleet…" autocomplete="off" required><button class="btn-primary" type="submit">Send</button></form></div>`;
}
async function renderSchedule() {
  pageContent.innerHTML = `${pageHeader('Maintenance schedule', 'Plan, assign, and track maintenance work.') }<div class="loading">Loading work orders…</div>`;
  try {
    const [data, maintenance] = await Promise.all([
      getJSON('/api/work-orders'),
      getJSON('/api/maintenance')
    ]);
    const assigneeOptions = data.assignees.map(user => `<option value="${user.id}">${esc(user.name)} · ${esc(user.role)}</option>`).join('');
    const rows = data.work_orders.map(order => `<tr><td><b>${esc(order.id)}</b><div class="muted">${esc(order.machine_id)} · ${esc(order.machine_name)}</div></td><td><b>${esc(order.title)}</b><div class="muted">${esc(order.description || 'No description')}</div>${order.completion_notes ? `<div class="muted"><b>Completion:</b> ${esc(order.completion_notes)}</div>` : ''}</td><td><span class="tag">${esc(order.priority.toUpperCase())}</span></td><td>${esc(order.assignee_name || 'Unassigned')}${data.can_manage ? `<select class="filter-select order-assignee" data-order-field="assigned_to" data-id="${esc(order.id)}"><option value="">Unassigned</option>${data.assignees.map(user => `<option value="${user.id}" ${String(order.assigned_to) === String(user.id) ? 'selected' : ''}>${esc(user.name)}</option>`).join('')}</select>` : ''}</td><td>${esc(order.due_date)}</td><td>${data.can_manage ? `<select class="filter-select order-status" data-order-field="status" data-id="${esc(order.id)}">${['Open','In progress','Completed','Cancelled'].map(status => `<option ${status === order.status ? 'selected' : ''}>${status}</option>`).join('')}</select>` : `<span class="tag">${esc(order.status.toUpperCase())}</span>`}</td><td>${data.can_manage ? `<button class="btn-outline" data-action="order-notes" data-id="${esc(order.id)}" data-notes="${esc(order.completion_notes || '')}">Notes</button>` : ''}</td></tr>`);
    const maintenanceRows = [...maintenance.schedules].sort((a, b) => a.next_due.localeCompare(b.next_due)).map(schedule => `<tr>
      <td><b>${esc(schedule.machine_id)} · ${esc(schedule.machine_name)}</b><div class="muted">${esc(schedule.line)}</div></td>
      <td>${esc(schedule.next_due)}</td>
      <td><span class="tag">${esc(schedule.due_status.toUpperCase())}</span></td>
      <td>${esc(schedule.last_completed)}</td>
      <td>${schedule.is_due && maintenance.can_manage ? `<button class="btn-outline" data-action="complete-maintenance" data-id="${esc(schedule.machine_id)}">Mark complete</button>` : ''}</td>
    </tr>`);
    const createForm = data.can_manage ? `<div class="panel"><div class="panel-head"><div><h2>Create a work order</h2><p>Assign a maintenance task with a priority and due date</p></div><span class="tag">TRACKED</span></div>
      <form id="workOrderForm" class="form-grid work-order-form"><label>Machine${machineSelect('workOrderMachine', machines[0]?.id || '', 'machine')}</label><label>Title<input name="title" minlength="3" maxlength="120" required placeholder="e.g. Inspect drive bearings"></label><label>Priority<select name="priority"><option>Medium</option><option>Low</option><option>High</option><option>Urgent</option></select></label><label>Assign to machine operator<select name="assigned_to"><option value="">Unassigned</option>${assigneeOptions}</select></label><label>Due date<input name="due_date" type="date" min="${new Date().toISOString().slice(0,10)}" value="${new Date(Date.now()+3*86400000).toISOString().slice(0,10)}" required></label><label>Description<input name="description" maxlength="2000" placeholder="Work details and safety notes"></label><div><button class="btn-primary" type="submit">Create work order</button></div></form></div>` : '<div class="callout mb-3">Your viewer role has read-only access to maintenance work orders.</div>';
    pageContent.innerHTML = `${pageHeader('Maintenance schedule', `${data.work_orders.length} tracked work order${data.work_orders.length === 1 ? '' : 's'}`, '<span class="tag">SERVER-SAVED</span>')}
      ${createForm}<section class="section-head"><div><h2>Work orders</h2><p>Assigned tasks, due dates, priorities, and completion notes</p></div></section>
      ${pageTable(['WORK ORDER', 'TASK', 'PRIORITY', 'ASSIGNEE', 'DUE DATE', 'STATUS', ''], rows, 'No work orders yet. Create one to assign the first maintenance task.')}
      <section class="section-head"><div><h2>Preventive maintenance</h2><p>${maintenance.due_count} machine${maintenance.due_count === 1 ? '' : 's'} due or overdue · completion advances the next date by 7 days</p></div></section>
      ${pageTable(['MACHINE', 'NEXT DUE', 'STATUS', 'LAST COMPLETED', ''], maintenanceRows, 'No maintenance schedules are configured.')}`;
  } catch (error) {
    pageContent.innerHTML = `${pageHeader('Maintenance schedule', 'Plan, assign, and track maintenance work.') }<div class="callout">${esc(error.message)}</div>`;
  }
}
function renderReports() {
  const rows = machines.map(machine => `<tr><td><b>${esc(machine.id)}</b></td><td>${esc(machine.name)}</td><td>${esc(machine.line)}</td><td>${statusBadge(machine.risk)}</td><td>${esc(machine.probability)}%</td><td>${esc(machine.health)}/100</td><td>${esc(machine.sensors.Temperature)} °C</td><td>${esc(machine.sensors.Vibration)} mm/s</td></tr>`);
  pageContent.innerHTML = `${pageHeader('Reports', 'Review the current fleet snapshot or export machine data for follow-up.', '<button class="btn-primary" data-action="export-report">↓ Export CSV</button>')}
    <div class="callout mb-3"><b>Report scope:</b> This export contains the latest demo telemetry and model estimates loaded in this browser session. It is not a historical or compliance report.</div>
    <section class="report-cards"><div class="panel report-card"><h3>Fleet condition snapshot</h3><p>Risk, health, and latest sensor readings for each asset.</p><button class="btn-outline" data-action="export-report">Download CSV →</button></div><div class="panel report-card"><h3>Maintenance priorities</h3><p>${summary.warning + summary.critical} assets currently classified as warning or critical.</p><a class="btn-outline" href="#maintenance-alerts">Review alerts →</a></div><div class="panel report-card"><h3>Prediction results</h3><p>Review model assessments and current machine condition before planning maintenance.</p><a class="btn-outline" href="#ai-predictions">Run a prediction →</a></div></section>
    <section class="section-head"><div><h2>Current fleet snapshot</h2><p>Latest readings and condition assessment</p></div></section>${pageTable(['MACHINE ID', 'ASSET', 'LINE', 'CONDITION', 'RISK', 'HEALTH', 'TEMP.', 'VIBRATION'], rows)}`;
}
async function renderUsers() {
  if (!permissions.manageUsers) {
    pageContent.innerHTML = `${pageHeader('User management', 'Administrator access is required.') }<div class="callout">Your current role is read-only for user and access management.</div>`;
    return;
  }
  pageContent.innerHTML = `${pageHeader('User management', 'Manage real accounts, roles, and workspace access.') }<div class="loading">Loading accounts…</div>`;
  try {
    const data = await getJSON('/api/users');
    const rows = data.users.map(user => `<tr><td><b>${esc(user.name)}</b>${user.id === data.current_user_id ? '<div class="muted">You</div>' : ''}</td><td>${esc(user.email)}</td><td><select class="filter-select user-role" data-id="${user.id}" ${user.id === data.current_user_id ? 'disabled' : ''}>${[['admin','Administrator'],['operator','Maintenance operator'],['viewer','Read only']].map(([value,label])=>`<option value="${value}" ${user.role===value?'selected':''}>${label}</option>`).join('')}</select></td><td><span class="tag">${user.active ? 'ACTIVE' : 'DISABLED'}</span></td><td>${user.id === data.current_user_id ? '<span class="muted">Current account</span>' : `<button class="btn-outline" data-action="reset-user-password" data-id="${user.id}">Reset password</button><button class="btn-outline" data-action="toggle-user" data-id="${user.id}" data-active="${user.active}">${user.active ? 'Disable' : 'Enable'}</button>`}</td></tr>`);
    pageContent.innerHTML = `${pageHeader('User management', `${data.users.length} accounts · access controlled by role`)}
      <div class="callout mb-3"><b>Role permissions:</b> Administrators manage accounts and maintenance. Operators manage work orders and alerts. Viewers can inspect data without changing it. Disabled accounts cannot sign in.</div>
      <div class="settings-grid"><div class="panel"><div class="panel-head"><div><h2>Add a user</h2><p>Set an initial password and share it securely</p></div></div><form id="userForm" class="form-grid"><label>Full name<input name="name" minlength="2" maxlength="80" required></label><label>Email address<input name="email" type="email" maxlength="254" required></label><label>Initial password<input name="password" type="password" minlength="12" autocomplete="new-password" required><small>At least 12 characters</small></label><label>Role<select name="role"><option value="operator">Maintenance operator</option><option value="viewer">Read only</option><option value="admin">Administrator</option></select></label><div><button class="btn-primary" type="submit">Create account</button></div></form></div>
      <div class="panel"><div class="panel-head"><div><h2>Access controls</h2><p>Accounts and permissions are enforced by the server</p></div></div><div class="insight-list"><div class="insight"><b>Protected sign-in</b>Passwords are stored as salted, one-way hashes.</div><div class="insight"><b>Least privilege</b>Viewers are read-only; maintenance actions require operator or administrator access.</div><div class="insight"><b>Account recovery</b>Use Reset password to set a temporary password, then share it securely.</div></div></div></div>
      <section class="section-head"><div><h2>Workspace accounts</h2><p>Role changes and deactivation take effect immediately</p></div></section>${pageTable(['NAME', 'EMAIL', 'ROLE', 'STATUS', ''], rows, 'No user accounts found.')}`;
  } catch (error) {
    pageContent.innerHTML = `${pageHeader('User management', 'Manage real accounts, roles, and workspace access.') }<div class="callout">${esc(error.message)}</div>`;
  }
}
function renderSettings() {
  const settings = storage.read('settings', { alerts: true, compact: false, plant: 'ForgeSight Demo Plant', timezone: 'Asia/Kolkata' });
  settings.dark = false;
  pageContent.innerHTML = `${pageHeader('Settings', 'Personalize this browser’s ForgeSight demo workspace.')}
    <div class="callout mb-3"><b>Workspace preferences</b> are stored locally in this browser and do not change plant telemetry or server configuration.</div>
    <div class="settings-grid"><div class="panel"><div class="panel-head"><div><h2>Appearance & notifications</h2><p>Choose how this workspace looks and behaves</p></div></div>
      <label class="setting-row"><span><b>Maintenance alert badges</b><small>Show the active alert count in navigation</small></span><input class="switch" type="checkbox" data-setting="alerts" ${settings.alerts ? 'checked' : ''}></label>
      <label class="setting-row"><span><b>Compact density</b><small>Reduce card spacing across the workspace</small></span><input class="switch" type="checkbox" data-setting="compact" ${settings.compact ? 'checked' : ''}></label>
    </div><div class="panel"><div class="panel-head"><div><h2>Plant workspace</h2><p>Display and regional preferences</p></div></div>
      <form id="settingsForm" class="form-grid"><label>Workspace name<input name="plant" maxlength="60" value="${esc(settings.plant)}" required></label><label>Timezone<select name="timezone"><option value="Asia/Kolkata" ${settings.timezone === 'Asia/Kolkata' ? 'selected' : ''}>Asia/Kolkata</option><option value="UTC" ${settings.timezone === 'UTC' ? 'selected' : ''}>UTC</option><option value="America/Chicago" ${settings.timezone === 'America/Chicago' ? 'selected' : ''}>America/Chicago</option><option value="Europe/London" ${settings.timezone === 'Europe/London' ? 'selected' : ''}>Europe/London</option></select></label><div><button class="btn-primary" type="submit">Save preferences</button></div></form>
    </div><div class="panel"><div class="panel-head"><div><h2>Change your password</h2><p>Choose a new password with at least 12 characters</p></div></div><form id="passwordForm" class="form-grid"><label>Current password<input name="current_password" type="password" autocomplete="current-password" required></label><label>New password<input name="new_password" type="password" minlength="12" autocomplete="new-password" required></label><div><button class="btn-primary" type="submit">Update password</button></div></form></div>
    <div class="panel"><div class="panel-head"><div><h2>About this prototype</h2><p>Current environment</p></div></div><div class="setting-row"><span><b>Mode</b><small>Local demonstration</small></span><span class="tag">DEMO</span></div><div class="setting-row"><span><b>Machine-learning model</b><small>Random Forest classifier</small></span><span class="tag">ACTIVE</span></div><div class="setting-row"><span><b>Saved preferences</b><small>Browser local storage</small></span></div></div></div>
    <div id="settingsNotice" aria-live="polite"></div>`;
}
const renderers = {
  overview: renderOverview, 'machine-fleet': renderFleet, 'ai-predictions': renderPrediction,
  'maintenance-alerts': renderAlerts, 'failure-analytics': renderAnalytics,
  'root-cause-analysis': () => renderIntelligencePage('root-cause-analysis'),
  'production-impact': () => renderIntelligencePage('production-impact'),
  'work-order-automation': () => renderIntelligencePage('work-order-automation'),
  'ai-assistant': renderAssistant,
  'maintenance-schedule': renderSchedule,
  reports: renderReports, 'user-management': renderUsers, settings: renderSettings
};
function renderPage() {
  const requestedPage = pageKey();
  if (renderedPage && renderedPage !== requestedPage) {
    const modal = bootstrap.Modal.getInstance(document.getElementById('machineModal'));
    if (modal) modal.hide();
    if (detailChart) {
      detailChart.destroy();
      detailChart = null;
    }
    if (analyticsChart) {
      analyticsChart.destroy();
      analyticsChart = null;
    }
    if (analyticsFleetChart) {
      analyticsFleetChart.destroy();
      analyticsFleetChart = null;
    }
  }
  renderedPage = requestedPage;
  pageActions();
  const preferences = storage.read('settings', { dark: false, alerts: true, compact: false, plant: 'ForgeSight Demo Plant', timezone: 'Asia/Kolkata' });
  document.body.classList.remove('dark-mode');
  document.body.classList.toggle('compact-mode', preferences.compact === true);
  document.querySelector('.breadcrumb > span').textContent = preferences.plant.toUpperCase();
  updateClock();
  const alertsEnabled = preferences.alerts !== false;
  const alertCount = document.getElementById('alertCount');
  alertCount.hidden = !alertsEnabled;
  alertCount.textContent = machines.filter(machine => machine.risk !== 'Healthy').length;
  (renderers[requestedPage] || renderOverview)();
  refreshAlertCount();
  refreshMaintenanceNotifications();
  closeSidebar();
}
function closeSidebar() {
  if (window.matchMedia('(max-width: 760px)').matches) {
    document.getElementById('sidebar').classList.remove('open');
    document.getElementById('sidebarScrim').classList.remove('open');
    document.getElementById('mobileMenu').setAttribute('aria-expanded', 'false');
  } else {
    document.getElementById('mobileMenu').setAttribute(
      'aria-expanded',
      String(!document.getElementById('sidebar').classList.contains('sidebar-collapsed'))
    );
  }
}
function syncSidebarForViewport() {
  const sidebar = document.getElementById('sidebar');
  const scrim = document.getElementById('sidebarScrim');
  const main = document.querySelector('.main');
  const toggle = document.getElementById('mobileMenu');
  if (window.matchMedia('(max-width: 760px)').matches) {
    sidebar.classList.remove('sidebar-collapsed');
    main.classList.remove('sidebar-expanded');
    scrim.classList.toggle('open', sidebar.classList.contains('open'));
    toggle.setAttribute('aria-expanded', String(sidebar.classList.contains('open')));
  } else {
    sidebar.classList.remove('open');
    scrim.classList.remove('open');
    main.classList.toggle('sidebar-expanded', sidebar.classList.contains('sidebar-collapsed'));
    toggle.setAttribute('aria-expanded', String(!sidebar.classList.contains('sidebar-collapsed')));
  }
}
async function getJSON(url) {
  const response = await fetch(url, { credentials: 'same-origin' });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401) {
    location.assign('/login');
    throw new Error(data.error || 'Please sign in again.');
  }
  if (!response.ok) throw new Error(data.error || 'Request failed');
  return data;
}
async function refreshAlertCount() {
  try {
    const data = await getJSON('/api/alerts');
    const activeAlerts = data.alerts.filter(alert => alert.status !== 'resolved');
    const alertCount = document.getElementById('alertCount');
    alertCount.textContent = activeAlerts.length;
    alertCount.hidden = storage.read('settings', { alerts: true }).alerts === false;
    const activeIds = new Set(activeAlerts.map(alert => alert.id));
    const newAlerts = knownActiveAlertIds
      ? activeAlerts.filter(alert => !knownActiveAlertIds.has(alert.id))
      : activeAlerts;
    if (newAlerts.length && ['admin', 'operator'].includes(userRole) &&
        storage.read('settings', { alerts: true }).alerts !== false) {
      showAlertNotification(newAlerts);
    }
    knownActiveAlertIds = activeIds;
  } catch (error) {
    console.warn('Could not refresh the active alert count.', error);
  }
}
function showAlertNotification(alerts) {
  let notification = document.getElementById('alertNotification');
  if (!notification) {
    notification = document.createElement('div');
    notification.id = 'alertNotification';
    notification.className = 'alert-notification';
    notification.setAttribute('role', 'status');
    notification.setAttribute('aria-live', 'polite');
    document.querySelector('.main').appendChild(notification);
  }
  const criticalCount = alerts.filter(alert => alert.severity === 'Critical').length;
  notification.textContent = `${alerts.length} active alert${alerts.length === 1 ? '' : 's'}${criticalCount ? ` · ${criticalCount} critical` : ''}. `;
  const link = document.createElement('a');
  link.href = '#maintenance-alerts';
  link.textContent = 'Review alerts';
  notification.appendChild(link);
  addNotificationDismissButton(notification);
  notification.hidden = false;
  clearTimeout(notification.dismissTimer);
  notification.dismissTimer = setTimeout(() => { notification.hidden = true; }, 12000);
}
function addNotificationDismissButton(notification, onDismiss = () => {}) {
  const dismissButton = document.createElement('button');
  dismissButton.type = 'button';
  dismissButton.className = 'notification-dismiss';
  dismissButton.setAttribute('aria-label', 'Dismiss notification');
  dismissButton.textContent = '×';
  dismissButton.addEventListener('click', () => {
    onDismiss();
    notification.hidden = true;
  });
  notification.appendChild(dismissButton);
}
async function refreshMaintenanceNotifications() {
  try {
    const data = await getJSON('/api/maintenance');
    const dueSchedules = data.schedules.filter(schedule => schedule.is_due);
    let notification = document.getElementById('maintenanceNotification');
    if (!dueSchedules.length) {
      if (notification) {
        notification.hidden = true;
        notification.dataset.dismissedSignature = '';
      }
      return;
    }
    const signature = dueSchedules
      .map(schedule => `${schedule.machine_id}:${schedule.due_status}`)
      .sort()
      .join('|');
    if (notification?.dataset.dismissedSignature === signature) {
      notification.hidden = true;
      return;
    }
    if (!notification) {
      notification = document.createElement('div');
      notification.id = 'maintenanceNotification';
      notification.className = 'alert-notification maintenance-notification';
      notification.setAttribute('role', 'status');
      notification.setAttribute('aria-live', 'polite');
      document.querySelector('.main').appendChild(notification);
    }
    const dueToday = dueSchedules.filter(schedule => schedule.due_status === 'Due today');
    const overdue = dueSchedules.filter(schedule => schedule.due_status === 'Overdue');
    const sections = [];
    if (dueToday.length) sections.push(`Due today: ${dueToday.map(schedule => `${schedule.machine_name} (${schedule.machine_id})`).join(', ')}`);
    if (overdue.length) sections.push(`Overdue: ${overdue.map(schedule => `${schedule.machine_name} (${schedule.machine_id})`).join(', ')}`);
    notification.textContent = `Maintenance reminder — ${sections.join(' · ')}. `;
    const link = document.createElement('a');
    link.href = '#maintenance-schedule';
    link.textContent = data.can_manage ? 'Review / complete' : 'View schedule';
    notification.appendChild(link);
    addNotificationDismissButton(notification, () => {
      notification.dataset.dismissedSignature = signature;
    });
    notification.hidden = false;
  } catch (error) {
    console.warn('Could not refresh the maintenance schedule notification.', error);
  }
}
async function refreshAssignedWorkOrders() {
  const container = document.getElementById('assignedWorkOrders');
  if (!container || userRole !== 'operator') return;
  try {
    const data = await getJSON('/api/my-work-orders');
    if (!container.isConnected || pageKey() !== 'overview') return;
    container.classList.remove('assigned-work-error');
    if (!data.work_orders.length) {
      container.hidden = true;
      container.replaceChildren();
      return;
    }
    const assignments = data.work_orders.map(order => {
      const assignedByRole = order.assigned_by_role === 'admin'
        ? 'Administrator'
        : order.assigned_by_role === 'operator' ? 'Operator' : 'Plant team';
      return `<article class="assigned-work-item">
        <div><b>${esc(order.machine_name)} · ${esc(order.machine_id)}</b><span class="tag">${esc(order.status.toUpperCase())}</span></div>
        <p>Hi ${esc(data.user_name)}, work assigned on ${esc(order.machine_name)}: <b>${esc(order.title)}</b>${order.description ? ` — ${esc(order.description)}` : ''}. Assigned by ${esc(order.assigned_by || 'Plant team')}${order.assigned_by ? ` (${assignedByRole})` : ''}.</p>
        <small>${esc(order.line)} · Due ${esc(order.due_date)} · ${esc(order.priority)} priority</small>
      </article>`;
    }).join('');
    container.innerHTML = `<div class="assigned-work-heading"><b>Work assigned to you</b><a href="#maintenance-schedule">Open work orders →</a></div>${assignments}`;
    container.hidden = false;
  } catch (error) {
    if (!container.isConnected) return;
    container.classList.add('assigned-work-error');
    container.innerHTML = `<b>Could not load your assigned work.</b> ${esc(error.message)}`;
    container.hidden = false;
  }
}
async function postJSON(url, method, body) {
  const response = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
    body: JSON.stringify(body)
  });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401) {
    location.assign('/login');
    throw new Error(data.error || 'Please sign in again.');
  }
  if (!response.ok) throw new Error(data.error || 'Request failed');
  return data;
}
async function loadDashboard() {
  try {
    const data = await getJSON('/api/machines');
    machines = data.machines;
    summary = data.summary;
    dashboardError = '';
  } catch (error) {
    dashboardError = error.message || 'Could not load machine telemetry.';
  }
  renderPage();
}
async function openMachine(id) {
  try {
    const machine = await getJSON(`/api/machine/${encodeURIComponent(id)}`);
    document.getElementById('modalTitle').textContent = `${machine.name} · ${machine.id}`;
    const sensor = machine.sensors;
    const predictionPanel = permissions.manageWorkOrders ? `<div class="detail-section detail-box"><h5>Run a new prediction</h5><p>Adjust the latest sensor readings, then run the trained Random Forest model. Test readings are saved separately from live telemetry.</p><form id="machinePredictForm"><div class="sensor-form">${sensors.map(([label, key, unit, min, max]) => `<label>${esc(label)} (${unit})<input type="number" step="0.1" min="${min}" max="${max}" name="${key}" value="${esc(sensor[key])}" required></label>`).join('')}</div><button class="btn-run" type="submit">Run prediction →</button></form><div class="prediction-result" id="machinePredictionOutput" hidden aria-live="polite"></div></div>` : '';
    const maintenancePanel = `<div class="detail-section detail-box"><h5>Preventive maintenance</h5><p>Last completed: <b>${esc(machine.maintenance.last_completed)}</b><br>Next due: <b>${esc(machine.maintenance.next_due)} · ${esc(machine.maintenance.due_status)}</b></p>${machine.maintenance.is_due && permissions.manageWorkOrders ? `<button class="btn-outline" data-action="complete-maintenance" data-id="${esc(machine.id)}">Mark maintenance complete</button>` : ''}</div>`;
    document.getElementById('machineBody').innerHTML = `
      <div class="d-flex justify-content-between align-items-center mb-3 flex-wrap gap-2"><div>${statusBadge(machine.risk)}<span class="ms-2 text-muted small">${esc(machine.line)} · ${esc(machine.runtime)} runtime</span></div><div class="small text-muted">Failure probability <b>${esc(machine.probability)}%</b></div></div>
      <div class="detail-grid">${[['Temperature', `${sensor.Temperature} °C`], ['Vibration', `${sensor.Vibration} mm/s`], ['Rotational speed', `${sensor.RotationalSpeed} rpm`], ['Pressure', `${sensor.Pressure} bar`], ['Machine load', `${sensor.MachineLoad} %`]].map(item => `<div class="detail-stat"><small>${esc(item[0])}</small><b>${esc(item[1])}</b></div>`).join('')}</div>
      <div class="detail-section"><h5>Saved sensor history</h5><p class="small text-muted">Persisted readings · ${machine.history.length} samples · latest ${esc(formatDate(machine.last_sampled))}</p><div class="detail-box detail-chart"><canvas id="detailChart"></canvas></div></div>
      <div class="detail-columns detail-section"><div class="detail-box"><h5>AI condition assessment</h5><p><b>Health score: ${esc(machine.health)}/100</b><br>${esc(machine.explanation)}</p><p><b>Recommended action</b><br>${esc(machine.action)}</p></div><div class="detail-box"><h5>Weekly maintenance plan</h5>${machine.weekly_plan.map(item => `<div class="plan-row"><b>${esc(item.day)}</b><span>${esc(item.task)}</span></div>`).join('')}</div></div>
      ${maintenancePanel}
      <div class="detail-section detail-box"><h5>Maintenance history</h5>${machine.maintenance_log.map(item => `<div class="log-row"><b>${esc(item.date)}</b><span>${esc(item.task)}</span><span>${esc(item.technician)} · ${esc(item.result)}</span></div>`).join('')}</div>
      ${predictionPanel}`;
    if (detailChart) detailChart.destroy();
    if (typeof Chart !== 'undefined') {
      detailChart = new Chart(document.getElementById('detailChart'), { type: 'line', data: { labels: machine.history.map(item => item.label), datasets: [{ label: 'Temperature °C', data: machine.history.map(item => item.temperature), borderColor: '#4b89dc', yAxisID: 'y', tension: .35 }, { label: 'Vibration mm/s', data: machine.history.map(item => item.vibration), borderColor: '#e3a34d', yAxisID: 'y1', tension: .35 }] }, options: { maintainAspectRatio: false, interaction: { mode: 'index', intersect: false }, scales: { y: { title: { display: true, text: 'Temperature °C' } }, y1: { position: 'right', grid: { drawOnChartArea: false }, title: { display: true, text: 'Vibration mm/s' } } } } });
    }
    document.getElementById('machinePredictForm')?.addEventListener('submit', event => submitPrediction(event, 'machinePredictionOutput', machine.id, event.currentTarget));
    bootstrap.Modal.getOrCreateInstance(document.getElementById('machineModal')).show();
  } catch (error) {
    window.alert(`Could not load machine details: ${error.message}`);
  }
}
async function submitPrediction(event, outputId, machineId, formElement = event.currentTarget) {
  event.preventDefault();
  const output = document.getElementById(outputId);
  const form = new FormData(formElement);
  const values = {};
  for (const [key, value] of form.entries()) values[key] = Number(value);
  output.hidden = false;
  output.textContent = 'Running prediction…';
  try {
    const data = await postJSON('/api/predict', 'POST', { machine_id: machineId, sensors: values });
    output.innerHTML = `<b>${esc(data.risk)} · ${esc(data.probability)}% failure probability · Health ${esc(data.health)}/100</b><br>${esc(data.explanation)}<br><br><b>Recommended:</b> ${esc(data.action)}<br><small>${esc(data.timestamp)}</small>`;
  } catch (error) {
    output.textContent = error.message;
  }
}
function exportReport() {
  const columns = ['Machine ID', 'Machine', 'Production line', 'Condition', 'Failure probability (%)', 'Health score', ...sensors.map(item => `${item[0]} (${item[2]})`)];
  const quote = value => `"${String(value ?? '').replace(/"/g, '""')}"`;
  const rows = machines.map(machine => [machine.id, machine.name, machine.line, machine.risk, machine.probability, machine.health, ...sensors.map(item => machine.sensors[item[1]])]);
  const csv = [columns, ...rows].map(row => row.map(quote).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `forgesight-fleet-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}
function addChatMessage(text, role, windowId = 'chatWindow') {
  const windowEl = document.getElementById(windowId);
  if (!windowEl) return null;
  const message = document.createElement('div');
  message.className = `chat-message ${role}`;
  message.textContent = text;
  windowEl.appendChild(message);
  windowEl.scrollTop = windowEl.scrollHeight;
  return message;
}
async function runAssistant(question, windowId = 'chatWindow', formId = 'chatForm') {
  const chatWindow = document.getElementById(windowId);
  if (!chatWindow) return;
  addChatMessage(question, 'user', windowId);
  const responseMessage = addChatMessage('Thinking…', 'assistant', windowId);
  const sendButton = document.querySelector(`#${formId} button[type="submit"]`);
  if (sendButton) sendButton.disabled = true;
  try {
    const data = await postJSON('/api/assistant', 'POST', { question });
    if (responseMessage?.isConnected) responseMessage.textContent = data.answer;
  } catch (error) {
    if (responseMessage?.isConnected) responseMessage.textContent = error.message;
  } finally {
    if (sendButton?.isConnected) sendButton.disabled = false;
    chatWindow.scrollTop = chatWindow.scrollHeight;
  }
}

document.addEventListener('click', event => {
  const assistantToggle = event.target.closest('#assistantWidgetToggle');
  if (assistantToggle) {
    const panel = document.getElementById('assistantWidgetPanel');
    panel.hidden = !panel.hidden;
    assistantToggle.setAttribute('aria-expanded', String(!panel.hidden));
    if (!panel.hidden) panel.querySelector('input[name="question"]').focus();
    return;
  }
  if (event.target.closest('#assistantWidgetClose')) {
    document.getElementById('assistantWidgetPanel').hidden = true;
    document.getElementById('assistantWidgetToggle').setAttribute('aria-expanded', 'false');
    document.getElementById('assistantWidgetToggle').focus();
    return;
  }
  const nav = event.target.closest('.nav-item, .brand');
  if (nav && nav.getAttribute('href')?.startsWith('#')) {
    if (location.hash === nav.getAttribute('href')) renderPage();
    return;
  }
  const menuButton = event.target.closest('#mobileMenu');
  if (menuButton) {
    const sidebar = document.getElementById('sidebar');
    if (window.matchMedia('(max-width: 760px)').matches) {
      sidebar.classList.toggle('open');
      document.getElementById('sidebarScrim').classList.toggle('open', sidebar.classList.contains('open'));
      menuButton.setAttribute('aria-expanded', String(sidebar.classList.contains('open')));
    } else {
      sidebar.classList.toggle('sidebar-collapsed');
      document.querySelector('.main').classList.toggle('sidebar-expanded', sidebar.classList.contains('sidebar-collapsed'));
      menuButton.setAttribute('aria-expanded', String(!sidebar.classList.contains('sidebar-collapsed')));
    }
    return;
  }
  if (event.target.closest('#sidebarScrim')) { closeSidebar(); return; }
  const suggestion = event.target.closest('[data-question]');
  if (suggestion) { runAssistant(suggestion.dataset.question); return; }
  const machineCardEl = event.target.closest('[data-open-machine]');
  if (machineCardEl) { openMachine(machineCardEl.dataset.openMachine); return; }
  const action = event.target.closest('[data-action]');
  if (!action) return;
  const id = action.dataset.id;
  if (action.dataset.action === 'open-machine') openMachine(id);
  if (action.dataset.action === 'retry') loadDashboard();
  if (action.dataset.action === 'export-report') exportReport();
  if (action.dataset.action === 'automate-work-orders') {
    action.disabled = true;
    postJSON('/api/work-orders/automate', 'POST', {}).then(result => {
      const notice = `Generated ${result.created_count} work order${result.created_count === 1 ? '' : 's'}; skipped ${result.skipped_count} active alert${result.skipped_count === 1 ? '' : 's'} with an existing open order.`;
      renderIntelligencePage('work-order-automation', notice);
    }).catch(error => {
      action.disabled = false;
      showError(error);
    });
  }
  if (action.dataset.action === 'alert-acknowledge' || action.dataset.action === 'alert-resolve') {
    const operation = action.dataset.action === 'alert-acknowledge' ? 'acknowledge' : 'resolve';
    postJSON(`/api/alerts/${id}/action`, 'POST', { action: operation }).then(renderAlerts).catch(showError);
  }
  if (action.dataset.action === 'complete-maintenance') {
    action.disabled = true;
    postJSON(`/api/machine/${encodeURIComponent(id)}/maintenance/complete`, 'POST', {
      task: 'Preventive maintenance and visual inspection'
    }).then(async result => {
      await refreshMaintenanceNotifications();
      if (pageKey() === 'maintenance-schedule') {
        await renderSchedule();
        showNotice(`${id} maintenance recorded for ${result.schedule.last_completed}. Next maintenance is due ${result.schedule.next_due}.`);
      } else {
        await openMachine(id);
      }
    }).catch(error => {
      action.disabled = false;
      showError(error);
    });
  }
  if (action.dataset.action === 'toggle-user') {
    postJSON(`/api/users/${id}`, 'PATCH', { active: action.dataset.active !== 'true' }).then(renderUsers).catch(showError);
  }
  if (action.dataset.action === 'reset-user-password') {
    const password = prompt('Enter a temporary password with at least 12 characters:');
    if (password !== null) postJSON(`/api/users/${id}`, 'PATCH', { password }).then(() => showNotice('Temporary password updated. Share it securely with the user.')).catch(showError);
  }
  if (action.dataset.action === 'order-notes') {
    const notes = prompt('Add completion notes:', action.dataset.notes || '');
    if (notes !== null) postJSON(`/api/work-orders/${id}`, 'PATCH', { completion_notes: notes }).then(renderSchedule).catch(showError);
  }
});
function showError(error) {
  showNotice(error.message || 'The requested action could not be completed.', true);
}
function showNotice(message, isError = false) {
  let notice = document.getElementById('actionNotice');
  if (!notice) {
    notice = document.createElement('div');
    notice.id = 'actionNotice';
    pageContent.querySelector('.page-heading')?.after(notice);
  }
  notice.className = `callout mb-3${isError ? ' callout-error' : ''}`;
  notice.textContent = message;
  notice.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}
document.addEventListener('keydown', event => {
  const machineCardEl = event.target.closest('[data-open-machine]');
  if (machineCardEl && (event.key === 'Enter' || event.key === ' ')) {
    event.preventDefault();
    openMachine(machineCardEl.dataset.openMachine);
  }
  if (event.key === 'Escape' && !document.getElementById('assistantWidgetPanel').hidden) {
    document.getElementById('assistantWidgetPanel').hidden = true;
    document.getElementById('assistantWidgetToggle').setAttribute('aria-expanded', 'false');
  }
  if (event.key === 'Escape') closeSidebar();
});
document.addEventListener('change', event => {
  if (event.target.id === 'fleetSearch' || event.target.id === 'fleetRisk') {
    const query = (document.getElementById('fleetSearch')?.value || '').toLowerCase();
    const risk = document.getElementById('fleetRisk')?.value || '';
    const filtered = machines.filter(machine => `${machine.name} ${machine.id} ${machine.line}`.toLowerCase().includes(query) && (!risk || machine.risk === risk));
    document.getElementById('fleetMachines').innerHTML = filtered.length ? filtered.map(machineCard).join('') : '<div class="empty-state">No machines match these filters.</div>';
  }
  if (event.target.matches('[data-setting]')) {
    const settings = storage.read('settings', { dark: false, alerts: true, compact: false, plant: 'ForgeSight Demo Plant', timezone: 'Asia/Kolkata' });
    settings[event.target.dataset.setting] = event.target.checked;
    storage.write('settings', settings);
    if (event.target.dataset.setting === 'compact') document.body.classList.toggle('compact-mode', event.target.checked);
    if (event.target.dataset.setting === 'alerts') document.getElementById('alertCount').hidden = !event.target.checked;
  }
  if (event.target.matches('[data-order-field]')) {
    const field = event.target.dataset.orderField;
    const value = field === 'assigned_to' && !event.target.value ? null : event.target.value;
    postJSON(`/api/work-orders/${event.target.dataset.id}`, 'PATCH', { [field]: value }).then(() => showNotice('Work order updated and recorded in the audit history.')).catch(showError);
  }
  if (event.target.matches('.user-role')) {
    postJSON(`/api/users/${event.target.dataset.id}`, 'PATCH', { role: event.target.value }).then(renderUsers).catch(showError);
  }
});
document.addEventListener('submit', event => {
  if (event.target.id === 'predictionForm') {
    const machineId = document.getElementById('predictionMachine').value;
    submitPrediction(event, 'predictionOutput', machineId, event.target);
  }
  if (event.target.id === 'chatForm' || event.target.id === 'assistantWidgetForm') {
    event.preventDefault();
    const input = event.target.elements.question;
    const question = input.value.trim();
    if (question) {
      const widget = event.target.id === 'assistantWidgetForm';
      runAssistant(
        question,
        widget ? 'assistantWidgetMessages' : 'chatWindow',
        event.target.id
      );
    }
    input.value = '';
  }
  if (event.target.id === 'workOrderForm') {
    event.preventDefault();
    const formData = new FormData(event.target);
    const order = Object.fromEntries(formData.entries());
    order.machine_id = order.machine;
    delete order.machine;
    postJSON('/api/work-orders', 'POST', order).then(result => {
      showNotice(`Work order ${result.id} created.`);
      renderSchedule();
    }).catch(showError);
  }
  if (event.target.id === 'userForm') {
    event.preventDefault();
    const formData = new FormData(event.target);
    const user = Object.fromEntries(formData.entries());
    postJSON('/api/users', 'POST', user).then(() => {
      renderUsers();
      showNotice('Account created. Share the temporary password securely.');
    }).catch(showError);
  }
  if (event.target.id === 'passwordForm') {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.target).entries());
    postJSON('/api/me/password', 'POST', values).then(() => {
      event.target.reset();
      showNotice('Your password has been updated.');
    }).catch(showError);
  }
  if (event.target.id === 'settingsForm') {
    event.preventDefault();
    const formData = new FormData(event.target);
    const settings = storage.read('settings', { dark: false, alerts: true, compact: false });
    settings.plant = formData.get('plant').trim();
    settings.timezone = formData.get('timezone');
    storage.write('settings', settings);
    renderPage();
    const notice = document.createElement('div');
    notice.className = 'callout mb-3';
    notice.textContent = 'Preferences saved in this browser.';
    pageContent.querySelector('.page-heading').after(notice);
  }
});
window.addEventListener('hashchange', renderPage);
window.addEventListener('resize', syncSidebarForViewport);
document.getElementById('sidebarScrim').addEventListener('click', closeSidebar);
syncSidebarForViewport();
updateClock();
setInterval(updateClock, 1000);
setInterval(refreshAlertCount, 30000);
setInterval(refreshMaintenanceNotifications, 60000);
setInterval(() => {
  if (userRole === 'operator' && pageKey() === 'overview') refreshAssignedWorkOrders();
}, 60000);
loadDashboard();
