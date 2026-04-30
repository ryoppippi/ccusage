/**
 * Self-contained HTML dashboard for the ccusage web command.
 * Embedded as a template string to avoid serving static files.
 */
export const dashboardHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>ccusage Dashboard</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script>
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{--bg:#0d1117;--card:#161b22;--border:#30363d;--text:#c9d1d9;--text-dim:#8b949e;--blue:#58a6ff;--green:#3fb950;--yellow:#d29922;--red:#f85149;--purple:#bc8cff}
body{font-family:system-ui,-apple-system,'Segoe UI',sans-serif;background:var(--bg);color:var(--text);min-height:100vh}
a{color:var(--blue);text-decoration:none}
.header{display:flex;justify-content:space-between;align-items:center;padding:16px 24px;border-bottom:1px solid var(--border)}
.header h1{font-size:20px;font-weight:600}
.header h1 span{color:var(--blue)}
.filters{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.filters input[type="date"]{background:var(--card);border:1px solid var(--border);color:var(--text);padding:6px 10px;border-radius:6px;font-size:13px}
.filters button{background:var(--card);border:1px solid var(--border);color:var(--text);padding:6px 12px;border-radius:6px;cursor:pointer;font-size:13px;transition:border-color .2s}
.filters button:hover{border-color:var(--blue)}
.filters button.active{border-color:var(--blue);color:var(--blue)}
.container{max-width:1400px;margin:0 auto;padding:20px 24px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:16px;margin-bottom:24px}
.card{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:20px}
.card .label{font-size:12px;color:var(--text-dim);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px}
.card .value{font-size:28px;font-weight:700}
.card .sub{font-size:12px;color:var(--text-dim);margin-top:4px}
.card.green .value{color:var(--green)}
.card.yellow .value{color:var(--yellow)}
.card.red .value{color:var(--red)}
.card.blue .value{color:var(--blue)}
.chart-row{display:grid;grid-template-columns:1fr;gap:16px;margin-bottom:24px}
.chart-row.split{grid-template-columns:1fr 1fr}
.chart-box{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:20px}
.chart-box h3{font-size:14px;color:var(--text-dim);margin-bottom:12px}
.chart-box canvas{width:100%!important}
.sessions{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:20px;margin-bottom:24px}
.sessions h3{font-size:14px;color:var(--text-dim);margin-bottom:12px}
table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;padding:8px 12px;border-bottom:1px solid var(--border);color:var(--text-dim);font-weight:500;font-size:12px;text-transform:uppercase;letter-spacing:.5px}
th.r{text-align:right}
td{padding:8px 12px;border-bottom:1px solid var(--border)}
td.r{text-align:right;font-variant-numeric:tabular-nums}
tr.clickable{cursor:pointer;transition:background .15s}
tr.clickable:hover{background:rgba(88,166,255,.08)}
.modal-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:100;justify-content:center;align-items:center}
.modal-overlay.show{display:flex}
.modal{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:24px;max-width:900px;width:90%;max-height:80vh;overflow-y:auto}
.modal h2{font-size:16px;margin-bottom:16px;display:flex;justify-content:space-between;align-items:center}
.modal .close{background:none;border:none;color:var(--text-dim);font-size:20px;cursor:pointer}
.loading{display:flex;justify-content:center;align-items:center;padding:60px;color:var(--text-dim)}
.loading.hide{display:none}
.tag{display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px;background:rgba(88,166,255,.15);color:var(--blue)}
@media(max-width:768px){.chart-row.split{grid-template-columns:1fr}.cards{grid-template-columns:repeat(2,1fr)}}
</style>
</head>
<body>
<div class="header">
  <h1><span>ccusage</span> Dashboard</h1>
  <div class="filters">
    <button onclick="setRange(7)" id="btn7d">7D</button>
    <button onclick="setRange(30)" id="btn30d">30D</button>
    <button onclick="setRange('month')" id="btnMonth">Month</button>
    <button onclick="setRange(null)" id="btnAll" class="active">All</button>
    <input type="date" id="sinceInput" onchange="applyCustomRange()">
    <input type="date" id="untilInput" onchange="applyCustomRange()">
  </div>
</div>
<div class="container">
  <div class="loading" id="loading">Loading data...</div>
  <div id="content" style="display:none">
    <div class="cards" id="cards"></div>
    <div class="chart-row">
      <div class="chart-box"><h3>Daily Token Usage</h3><canvas id="dailyChart"></canvas></div>
    </div>
    <div class="chart-row split">
      <div class="chart-box"><h3>Cost Trend</h3><canvas id="costChart"></canvas></div>
      <div class="chart-box"><h3>Model Distribution</h3><canvas id="modelChart"></canvas></div>
    </div>
    <div class="sessions">
      <h3>Sessions</h3>
      <table>
        <thead><tr>
          <th>Session</th><th>Last Active</th><th>Models</th>
          <th class="r">Input</th><th class="r">Output</th>
          <th class="r">Cache Read</th><th class="r">Hit Rate</th><th class="r">Cost</th>
        </tr></thead>
        <tbody id="sessionBody"></tbody>
      </table>
    </div>
  </div>
</div>
<div class="modal-overlay" id="modal">
  <div class="modal">
    <h2><span id="modalTitle">Session Detail</span><button class="close" onclick="closeModal()">&times;</button></h2>
    <div id="modalContent"></div>
  </div>
</div>
<script>
const $ = s => document.querySelector(s);
const state = { since: null, until: null };
let charts = {};

function fmt(n) { return n == null ? '0' : n.toLocaleString(); }
function fmtCost(n) { return '$' + (n || 0).toFixed(2); }
function fmtPct(n) { return (n * 100).toFixed(1) + '%'; }
function hitRateColor(r) { return r >= .7 ? 'green' : r >= .4 ? 'yellow' : 'red'; }
function dateToYMD(d) { return d.replace(/-/g, ''); }

async function api(endpoint, params = {}) {
  const u = new URL('/api/' + endpoint, location.origin);
  if (params.since) u.searchParams.set('since', params.since);
  if (params.until) u.searchParams.set('until', params.until);
  const r = await fetch(u);
  return r.json();
}

function setRange(v) {
  document.querySelectorAll('.filters button').forEach(b => b.classList.remove('active'));
  if (v === null) {
    state.since = null; state.until = null;
    $('#btnAll').classList.add('active');
    $('#sinceInput').value = ''; $('#untilInput').value = '';
  } else if (v === 'month') {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    state.since = dateToYMD(start.toISOString().slice(0,10));
    state.until = null;
    $('#btnMonth').classList.add('active');
  } else {
    const now = new Date();
    const start = new Date(now);
    start.setDate(now.getDate() - v);
    state.since = dateToYMD(start.toISOString().slice(0,10));
    state.until = null;
    $('#btn' + v + 'd').classList.add('active');
  }
  load();
}

function applyCustomRange() {
  const s = $('#sinceInput').value;
  const u = $('#untilInput').value;
  document.querySelectorAll('.filters button').forEach(b => b.classList.remove('active'));
  state.since = s ? dateToYMD(s) : null;
  state.until = u ? dateToYMD(u) : null;
  load();
}

async function load() {
  $('#loading').classList.remove('hide');
  $('#content').style.display = 'none';
  const p = { since: state.since, until: state.until };
  try {
    const [daily, sessions, monthly] = await Promise.all([
      api('daily', p), api('session', p), api('monthly', p)
    ]);
    render(daily, sessions, monthly);
  } catch(e) {
    $('#loading').textContent = 'Error loading data: ' + e.message;
    return;
  }
  $('#loading').classList.add('hide');
  $('#content').style.display = '';
}

function render(daily, sessions, monthly) {
  renderCards(daily, sessions);
  renderDailyChart(daily);
  renderCostChart(daily);
  renderModelChart(daily);
  renderSessions(sessions);
}

function renderCards(daily, sessions) {
  const t = daily.totals || {};
  const totalInput = (t.inputTokens||0) + (t.cacheCreationTokens||0) + (t.cacheReadTokens||0);
  const hitRate = totalInput > 0 ? (t.cacheReadTokens||0) / totalInput : 0;
  const hrClass = hitRateColor(hitRate);
  $('#cards').innerHTML =
    '<div class="card blue"><div class="label">Total Cost</div><div class="value">' + fmtCost(t.totalCost) + '</div></div>' +
    '<div class="card"><div class="label">Total Tokens</div><div class="value">' + fmt(t.totalTokens) + '</div></div>' +
    '<div class="card ' + hrClass + '"><div class="label">Cache Hit Rate</div><div class="value">' + fmtPct(hitRate) + '</div><div class="sub">' + fmt(t.cacheReadTokens) + ' read / ' + fmt(totalInput) + ' total input</div></div>' +
    '<div class="card"><div class="label">Sessions</div><div class="value">' + ((sessions.sessions||[]).length) + '</div></div>';
}

function renderDailyChart(daily) {
  const d = daily.daily || [];
  const labels = d.map(x => x.date);
  if (charts.daily) charts.daily.destroy();
  charts.daily = new Chart($('#dailyChart'), {
    type: 'bar',
    data: {
      labels,
      datasets: [
        { label: 'Input', data: d.map(x => x.inputTokens), backgroundColor: '#58a6ff' },
        { label: 'Output', data: d.map(x => x.outputTokens), backgroundColor: '#bc8cff' },
        { label: 'Cache Create', data: d.map(x => x.cacheCreationTokens), backgroundColor: '#d29922' },
        { label: 'Cache Read', data: d.map(x => x.cacheReadTokens), backgroundColor: '#3fb950' },
      ]
    },
    options: {
      responsive: true,
      scales: {
        x: { stacked: true, ticks: { color: '#8b949e' }, grid: { color: '#21262d' } },
        y: { stacked: true, ticks: { color: '#8b949e', callback: v => v >= 1e6 ? (v/1e6).toFixed(1)+'M' : v >= 1e3 ? (v/1e3).toFixed(0)+'K' : v }, grid: { color: '#21262d' } }
      },
      plugins: { legend: { labels: { color: '#c9d1d9' } } }
    }
  });
}

function renderCostChart(daily) {
  const d = daily.daily || [];
  const labels = d.map(x => x.date);
  let cum = 0;
  const cumData = d.map(x => { cum += x.totalCost; return +cum.toFixed(2); });
  if (charts.cost) charts.cost.destroy();
  charts.cost = new Chart($('#costChart'), {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: 'Daily Cost', data: d.map(x => x.totalCost), borderColor: '#58a6ff', backgroundColor: 'rgba(88,166,255,.1)', fill: true, tension: .3 },
        { label: 'Cumulative', data: cumData, borderColor: '#d29922', borderDash: [5,5], tension: .3, yAxisID: 'y1' }
      ]
    },
    options: {
      responsive: true,
      scales: {
        x: { ticks: { color: '#8b949e' }, grid: { color: '#21262d' } },
        y: { position: 'left', ticks: { color: '#58a6ff', callback: v => '$'+v.toFixed(2) }, grid: { color: '#21262d' } },
        y1: { position: 'right', ticks: { color: '#d29922', callback: v => '$'+v.toFixed(0) }, grid: { drawOnChartArea: false } }
      },
      plugins: { legend: { labels: { color: '#c9d1d9' } } }
    }
  });
}

function renderModelChart(daily) {
  const d = daily.daily || [];
  const models = {};
  for (const day of d) {
    for (const b of (day.modelBreakdowns || [])) {
      const n = b.modelName.replace(/^claude-/, '').replace(/-2025\\d+$/, '');
      models[n] = (models[n] || 0) + b.cost;
    }
  }
  const sorted = Object.entries(models).sort((a,b) => b[1] - a[1]);
  const colors = ['#58a6ff','#3fb950','#d29922','#f85149','#bc8cff','#79c0ff','#56d364','#e3b341','#ffa198','#d2a8ff'];
  if (charts.model) charts.model.destroy();
  charts.model = new Chart($('#modelChart'), {
    type: 'doughnut',
    data: {
      labels: sorted.map(x => x[0]),
      datasets: [{ data: sorted.map(x => +x[1].toFixed(4)), backgroundColor: colors.slice(0, sorted.length) }]
    },
    options: {
      responsive: true,
      plugins: {
        legend: { position: 'right', labels: { color: '#c9d1d9', font: { size: 11 } } },
        tooltip: { callbacks: { label: ctx => ctx.label + ': $' + ctx.parsed.toFixed(2) } }
      }
    }
  });
}

function renderSessions(sessions) {
  const s = (sessions.sessions || []).slice(0, 50);
  const body = $('#sessionBody');
  body.innerHTML = s.map(x => {
    const sid = x.sessionId.split('-').slice(-2).join('-');
    const totalIn = (x.inputTokens||0) + (x.cacheCreationTokens||0) + (x.cacheReadTokens||0);
    const hr = totalIn > 0 ? (x.cacheReadTokens||0) / totalIn : 0;
    const models = (x.modelsUsed||[]).map(m => m.replace(/^claude-/, '').replace(/-2025\\d+$/, '')).join(', ');
    return '<tr class="clickable" onclick="openSession(\\'' + x.sessionId + '\\')">' +
      '<td>' + sid + '</td>' +
      '<td>' + (x.lastActivity||'') + '</td>' +
      '<td><span class="tag">' + models + '</span></td>' +
      '<td class="r">' + fmt(x.inputTokens) + '</td>' +
      '<td class="r">' + fmt(x.outputTokens) + '</td>' +
      '<td class="r">' + fmt(x.cacheReadTokens) + '</td>' +
      '<td class="r" style="color:var(--' + hitRateColor(hr) + ')">' + fmtPct(hr) + '</td>' +
      '<td class="r">' + fmtCost(x.totalCost) + '</td></tr>';
  }).join('');
}

async function openSession(id) {
  const m = $('#modal');
  m.classList.add('show');
  $('#modalTitle').textContent = 'Session: ' + id.split('-').slice(-2).join('-');
  $('#modalContent').innerHTML = '<div class="loading">Loading...</div>';
  try {
    const data = await api('session/' + id);
    if (!data || data.error) { $('#modalContent').innerHTML = '<p>Session not found</p>'; return; }
    let html = '<p style="margin-bottom:12px">Total Cost: <b>' + fmtCost(data.totalCost) + '</b> &middot; Tokens: <b>' + fmt(data.totalTokens) + '</b> &middot; Entries: <b>' + data.entries.length + '</b></p>';
    html += '<table><thead><tr><th>Time</th><th>Model</th><th class="r">Input</th><th class="r">Output</th><th class="r">Cache Create</th><th class="r">Cache Read</th><th class="r">Cost</th></tr></thead><tbody>';
    for (const e of data.entries) {
      const t = new Date(e.timestamp).toLocaleString();
      const model = (e.model||'unknown').replace(/^claude-/, '').replace(/-2025\\d+$/, '');
      html += '<tr><td>' + t + '</td><td><span class="tag">' + model + '</span></td>' +
        '<td class="r">' + fmt(e.inputTokens) + '</td><td class="r">' + fmt(e.outputTokens) + '</td>' +
        '<td class="r">' + fmt(e.cacheCreationTokens) + '</td><td class="r">' + fmt(e.cacheReadTokens) + '</td>' +
        '<td class="r">' + fmtCost(e.costUSD) + '</td></tr>';
    }
    html += '</tbody></table>';
    $('#modalContent').innerHTML = html;
  } catch(e) {
    $('#modalContent').innerHTML = '<p>Error: ' + e.message + '</p>';
  }
}

function closeModal() { $('#modal').classList.remove('show'); }
$('#modal').addEventListener('click', e => { if (e.target === $('#modal')) closeModal(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

load();
</script>
</body>
</html>`;
