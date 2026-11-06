'use strict';

/**
 * index.js — MonitorTool web server
 *
 * Connects to MongoDB, starts the Monitor polling loop,
 * and serves a web UI with live statistics and SVG charts.
 *
 * Routes:
 *   GET /          — Dashboard with summary, counts-over-time chart, and recent status updates
 *   GET /rates     — Processing rate over time chart
 *   GET /timeperunit — Time-per-unit over time chart (key for trend analysis)
 *   GET /status    — All status updates from cljDetector
 *   GET /export/json — All collected data as JSON
 *   GET /export/csv  — All samples as CSV (for raw data appendix)
 */

const express = require('express');
const Monitor = require('./Monitor');
const Charts = require('./Charts');

const PORT = process.env.PORT || 3000;
const DBHOST = process.env.DBHOST || 'localhost';
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL || '5000', 10);

const app = express();
const monitor = new Monitor(DBHOST, POLL_INTERVAL);

// --- HTML helpers ---

function htmlPage(title, body) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${Charts.escapeXml(title)}</title>
<style>
  body { font-family: sans-serif; margin: 2rem; background: #f8f9fa; }
  h1 { color: #1a1a2e; }
  h2 { color: #16213e; margin-top: 2rem; }
  .nav a { margin-right: 1rem; color: #2563eb; text-decoration: none; }
  .nav a:hover { text-decoration: underline; }
  table { border-collapse: collapse; width: 100%; margin: 1rem 0; }
  th, td { border: 1px solid #ddd; padding: 0.4rem 0.6rem; text-align: left; font-size: 0.85rem; }
  th { background: #16213e; color: white; }
  tr:nth-child(even) { background: #f2f2f2; }
  .summary-box { background: white; border: 1px solid #ddd; border-radius: 8px; padding: 1rem 1.5rem; margin: 1rem 0; }
  .summary-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 1rem; }
  .stat-card { background: white; border: 1px solid #ddd; border-radius: 8px; padding: 0.8rem 1rem; }
  .stat-card h3 { margin: 0 0 0.3rem 0; font-size: 0.8rem; color: #666; text-transform: uppercase; }
  .stat-card .value { font-size: 1.5rem; font-weight: bold; color: #16213e; }
  .stat-card .sub { font-size: 0.8rem; color: #666; }
  svg { max-width: 100%; height: auto; }
  .chart-section { background: white; border: 1px solid #ddd; border-radius: 8px; padding: 1rem; margin: 1rem 0; }
  .status-entry { background: white; border-left: 3px solid #2563eb; padding: 0.4rem 0.8rem; margin: 0.3rem 0; font-family: monospace; font-size: 0.85rem; }
  .status-time { color: #666; }
</style>
<meta http-equiv="refresh" content="10">
</head>
<body>
<nav class="nav">
  <a href="/">Dashboard</a>
  <a href="/rates">Processing Rates</a>
  <a href="/timeperunit">Time Per Unit</a>
  <a href="/status">Status Updates</a>
  <a href="/export/csv">Export CSV</a>
  <a href="/export/json">Export JSON</a>
</nav>
${body}
</body>
</html>`;
}

function summaryBox(monitor) {
    const s = monitor.getSummary();
    const cards = Object.entries(s.lastCounts).map(([coll, count]) => {
        const rate = s.avgRates[coll] || 0;
        const tpu = s.avgTimePerUnit[coll] || 0;
        return `<div class="stat-card">
  <h3>${Charts.escapeXml(coll)}</h3>
  <div class="value">${count}</div>
  <div class="sub">avg rate: ${rate.toFixed(2)} /s · avg time/unit: ${tpu.toFixed(2)} ms</div>
</div>`;
    }).join('\n');

    return `<div class="summary-box">
  <h2>Summary</h2>
  <p>Monitoring for ${Charts.escapeXml(s.elapsedSec)}s · ${s.sampleCount} samples · ${s.statusUpdateCount} status updates</p>
  <div class="summary-grid">
  ${cards}
  </div>
</div>`;
}

function statusUpdatesHTML(monitor) {
    const updates = monitor.getRecentStatusUpdates(200);
    if (updates.length === 0) {
        return '<p>No status updates yet.</p>';
    }
    const rows = updates.map(u =>
        `<div class="status-entry"><span class="status-time">[${Charts.escapeXml(u.timestamp || '')}]</span> ${Charts.escapeXml(u.message || '')}</div>`
    ).join('\n');
    return `<h2>Status Updates (${updates.length} most recent)</h2>\n${rows}`;
}

function buildCountsChart(monitor) {
    const samples = monitor.getSamples();
    const series = ['files', 'chunks', 'candidates', 'clones'].map(coll => ({
        name: coll,
        color: Charts.COLORS[coll],
        points: samples.map(s => ({
            x: s.elapsedMs / 1000,
            y: s.counts[coll] >= 0 ? s.counts[coll] : 0,
        })),
    }));
    return Charts.createMultiSeriesChart({
        series,
        title: 'Collection Counts Over Time',
        xLabel: 'Elapsed Time (seconds)',
        yLabel: 'Count',
    });
}

function buildRatesChart(monitor) {
    const samples = monitor.getSamples();
    const series = ['files', 'chunks', 'candidates', 'clones'].map(coll => ({
        name: coll,
        color: Charts.COLORS[coll],
        points: samples.map(s => ({
            x: s.elapsedMs / 1000,
            y: s.rates[coll] || 0,
        })),
    }));
    return Charts.createMultiSeriesChart({
        series,
        title: 'Processing Rate Over Time (units/sec)',
        xLabel: 'Elapsed Time (seconds)',
        yLabel: 'Units / second',
    });
}

function buildTimePerUnitChart(monitor) {
    const samples = monitor.getSamples();
    const series = ['files', 'chunks', 'candidates', 'clones'].map(coll => ({
        name: coll,
        color: Charts.COLORS[coll],
        points: samples.map(s => ({
            x: s.elapsedMs / 1000,
            y: s.timePerUnit[coll] || 0,
        })),
    }));
    return Charts.createMultiSeriesChart({
        series,
        title: 'Time Per Unit Over Time (ms/unit) — Trend Analysis',
        xLabel: 'Elapsed Time (seconds)',
        yLabel: 'Milliseconds per new unit',
    });
}

// --- Routes ---

app.get('/', (req, res) => {
    const body = `
<h1>MonitorTool — cljDetector Dashboard</h1>
${summaryBox(monitor)}
<div class="chart-section">
<h2>Collection Counts Over Time</h2>
${buildCountsChart(monitor)}
</div>
<div class="chart-section">
<h2>Recent Status Updates</h2>
${statusUpdatesHTML(monitor)}
</div>
`;
    res.send(htmlPage('MonitorTool Dashboard', body));
});

app.get('/rates', (req, res) => {
    const body = `
<h1>MonitorTool — Processing Rates</h1>
${summaryBox(monitor)}
<div class="chart-section">
${buildRatesChart(monitor)}
</div>
`;
    res.send(htmlPage('Processing Rates', body));
});

app.get('/timeperunit', (req, res) => {
    const body = `
<h1>MonitorTool — Time Per Unit (Trend Analysis)</h1>
${summaryBox(monitor)}
<div class="chart-section">
${buildTimePerUnitChart(monitor)}
</div>
<p>This chart shows how long it takes to create each new unit (file/chunk/candidate/clone)
at each sampling interval. An upward trend indicates processing is slowing down
(potentially linear or exponential degradation); a flat line indicates constant
processing time per unit.</p>
`;
    res.send(htmlPage('Time Per Unit', body));
});

app.get('/status', (req, res) => {
    const body = `
<h1>MonitorTool — Status Updates</h1>
${summaryBox(monitor)}
${statusUpdatesHTML(monitor)}
`;
    res.send(htmlPage('Status Updates', body));
});

app.get('/export/json', (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', 'attachment; filename="monitor-statistics.json"');
    res.send(monitor.exportAll());
});

app.get('/export/csv', (req, res) => {
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="monitor-statistics.csv"');
    res.send(monitor.exportCSV());
});

// --- Start ---

async function main() {
    console.log(`[MonitorTool] Starting... DBHOST=${DBHOST}, POLL_INTERVAL=${POLL_INTERVAL}ms, PORT=${PORT}`);

    // Try to connect to MongoDB, retry for up to 60 seconds
    let connected = false;
    for (let attempt = 1; attempt <= 12 && !connected; attempt++) {
        try {
            await monitor.connect();
            connected = true;
        } catch (e) {
            console.log(`[MonitorTool] MongoDB connection attempt ${attempt} failed: ${e.message}. Retrying in 5s...`);
            await new Promise(r => setTimeout(r, 5000));
        }
    }

    if (!connected) {
        console.error('[MonitorTool] Could not connect to MongoDB after 60s. Starting web server anyway (will show empty data).');
    } else {
        await monitor.start();
    }

    app.listen(PORT, () => {
        console.log(`[MonitorTool] Web UI available at http://localhost:${PORT}`);
    });
}

main().catch(console.error);
