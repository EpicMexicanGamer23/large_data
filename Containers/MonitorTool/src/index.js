'use strict';

/**
 * index.js — MonitorTool web server
 *
 * Connects to MongoDB, starts the Monitor polling loop,
 * and serves a web UI with live statistics and SVG charts.
 *
 * Two modes:
 *   1. Live mode (default): Connects to MongoDB, polls every 5s, serves live data.
 *   2. Archive mode (ARCHIVE_FILE env var set): Loads data from a JSON file
 *      instead of MongoDB. Serves the same dashboard with static data.
 *      No MongoDB connection, no polling.
 *
 * Dashboard layout:
 *   - Summary box at top (current counts, elapsed time, averages)
 *   - 2x2 grid of charts (files, chunks, candidates, clones)
 *     x-axis = objects stored, y-axis = µs/object
 *   - Status updates below
 *
 * Routes:
 *   GET /            — Dashboard (summary + 4 charts + status updates)
 *   GET /export/json — All collected data as JSON
 *   GET /export/csv  — All samples as CSV
 */

const express = require('express');
const fs = require('fs');
const Monitor = require('./Monitor');
const Charts = require('./Charts');

const PORT = process.env.PORT || 3000;
const DBHOST = process.env.DBHOST || 'localhost';
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL || '5000', 10);
const ARCHIVE_FILE = process.env.ARCHIVE_FILE || null;

const app = express();

// --- Data source abstraction ---

/**
 * LiveDataSource wraps the Monitor class for live MongoDB polling.
 */
class LiveDataSource {
    constructor() {
        this.monitor = new Monitor(DBHOST, POLL_INTERVAL);
        this.isArchive = false;
    }

    async connect() {
        let connected = false;
        for (let attempt = 1; attempt <= 12 && !connected; attempt++) {
            try {
                await this.monitor.connect();
                connected = true;
            } catch (e) {
                console.log(`[MonitorTool] MongoDB connection attempt ${attempt} failed: ${e.message}. Retrying in 5s...`);
                await new Promise(r => setTimeout(r, 5000));
            }
        }
        if (!connected) {
            console.error('[MonitorTool] Could not connect to MongoDB after 60s. Starting web server anyway (will show empty data).');
        } else {
            await this.monitor.start();
        }
    }

    async getSummary() { return await this.monitor.getSummary(); }
    async getSamples() { return await this.monitor.getSamples(); }
    async getStatusUpdates(limit) { return await this.monitor.getStatusUpdates(limit); }
    async exportAll() { return await this.monitor.exportAll(); }
    async exportCSV() { return await this.monitor.exportCSV(); }
}

/**
 * ArchiveDataSource loads from a JSON file — no MongoDB, no polling.
 */
class ArchiveDataSource {
    constructor(filePath) {
        this.filePath = filePath;
        this.data = null;
        this.isArchive = true;
    }

    async connect() {
        console.log(`[MonitorTool] Archive mode: loading data from ${this.filePath}`);
        const raw = fs.readFileSync(this.filePath, 'utf-8');
        this.data = JSON.parse(raw);
        console.log(`[MonitorTool] Loaded ${this.data.samples?.length || 0} samples, ${this.data.statusUpdates?.length || 0} status updates from archive.`);
    }

    async getSummary() {
        const samples = this.data.samples || [];
        const statusUpdates = this.data.statusUpdates || [];
        const lastSample = samples.length > 0 ? samples[samples.length - 1] : null;
        const elapsedSec = lastSample ? (lastSample.elapsedMs / 1000) : 0;

        const avgRates = {};
        const avgTimePerUnit = {};
        let totalDeltas = { files: 0, chunks: 0, candidates: 0, clones: 0 };
        let activeSamples = { files: 0, chunks: 0, candidates: 0, clones: 0 };

        for (const s of samples) {
            for (const coll of ['files', 'chunks', 'candidates', 'clones']) {
                totalDeltas[coll] += s.deltas[coll] || 0;
                if (s.deltas[coll] > 0) activeSamples[coll]++;
            }
        }

        const pollIntervalMs = this.data.pollIntervalMs || POLL_INTERVAL;

        for (const coll of ['files', 'chunks', 'candidates', 'clones']) {
            avgRates[coll] = activeSamples[coll] > 0
                ? (totalDeltas[coll] / (activeSamples[coll] * pollIntervalMs / 1000))
                : 0;
            avgTimePerUnit[coll] = activeSamples[coll] > 0
                ? (activeSamples[coll] * pollIntervalMs * 1000 / totalDeltas[coll])
                : 0;
        }

        return {
            sampleCount: samples.length,
            elapsedSec: elapsedSec.toFixed(1),
            lastCounts: lastSample ? lastSample.counts : { files: 0, chunks: 0, candidates: 0, clones: 0 },
            avgRates,
            avgTimePerUnit,
            statusUpdateCount: statusUpdates.length,
        };
    }

    async getSamples() { return this.data.samples || []; }
    async getStatusUpdates(limit) {
        const updates = this.data.statusUpdates || [];
        if (limit > 0) return updates.slice(0, limit);
        return updates;
    }

    async exportAll() {
        return JSON.stringify(this.data, null, 2);
    }

    async exportCSV() {
        const samples = this.data.samples || [];
        const header = 'sample,timestamp,elapsedMs,files,chunks,candidates,clones,' +
            'd_files,d_chunks,d_candidates,d_clones,' +
            'rate_files,rate_chunks,rate_candidates,rate_clones,' +
            'tpu_files,tpu_chunks,tpu_candidates,tpu_clones\n';
        const rows = samples.map((s, i) => {
            return [
                i + 1,
                s.timestamp,
                s.elapsedMs,
                s.counts.files, s.counts.chunks, s.counts.candidates, s.counts.clones,
                s.deltas.files, s.deltas.chunks, s.deltas.candidates, s.deltas.clones,
                s.rates.files.toFixed(4), s.rates.chunks.toFixed(4),
                s.rates.candidates.toFixed(4), s.rates.clones.toFixed(4),
                s.timePerUnit.files.toFixed(4), s.timePerUnit.chunks.toFixed(4),
                s.timePerUnit.candidates.toFixed(4), s.timePerUnit.clones.toFixed(4),
            ].join(',');
        });
        return header + rows.join('\n');
    }
}

// --- Pick data source based on env var ---

const source = ARCHIVE_FILE
    ? new ArchiveDataSource(ARCHIVE_FILE)
    : new LiveDataSource();

// --- HTML helpers ---

function htmlPage(title, body) {
    const isArchive = source.isArchive;
    const refreshTag = isArchive ? '' : '<meta http-equiv="refresh" content="10">';
    const modeLabel = isArchive
        ? '<span style="color: #dc2626; font-weight: bold;">📋 ARCHIVE MODE — viewing previous session (static data)</span>'
        : '<span style="color: #0e9489; font-weight: bold;">● LIVE — monitoring in progress</span>';

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${Charts.escapeXml(title)}</title>
<style>
  body { font-family: sans-serif; margin: 2rem; background: #f8f9fa; }
  h1 { color: #1a1a2e; }
  h2 { color: #16213e; margin-top: 1.5rem; }
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
  .chart-section { background: white; border: 1px solid #ddd; border-radius: 8px; padding: 1rem; margin: 0.5rem 0; }
  .chart-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; margin: 1rem 0; }
  .chart-cell h3 { margin: 0 0 0.5rem 0; font-size: 1rem; color: #16213e; }
  .status-entry { background: white; border-left: 3px solid #2563eb; padding: 0.4rem 0.8rem; margin: 0.3rem 0; font-family: monospace; font-size: 0.85rem; }
  .status-time { color: #666; }
  .mode-badge { display: inline-block; padding: 0.3rem 0.8rem; border-radius: 4px; background: #f0f0f0; }
</style>
${refreshTag}
</head>
<body>
<nav class="nav">
  <a href="/">Dashboard</a>
  <a href="/export/csv">Export CSV</a>
  <a href="/export/json">Export JSON</a>
</nav>
<p class="mode-badge">${modeLabel}</p>
${body}
</body>
</html>`;
}

async function summaryBox(source) {
    const s = await source.getSummary();
    const cards = Object.entries(s.lastCounts).map(([coll, count]) => {
        const rate = s.avgRates[coll] || 0;
        const tpu = s.avgTimePerUnit[coll] || 0;
        return `<div class="stat-card">
  <h3>${Charts.escapeXml(coll)}</h3>
  <div class="value">${count}</div>
  <div class="sub">avg rate: ${rate.toFixed(2)} /s · avg time/unit: ${tpu.toFixed(2)} µs</div>
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

async function statusUpdatesHTML(source, count = 200) {
    const updates = await source.getStatusUpdates(count);
    if (updates.length === 0) {
        return '<p>No status updates yet.</p>';
    }
    const rows = updates.reverse().map(u =>
        `<div class="status-entry"><span class="status-time">[${Charts.escapeXml(u.timestamp || '')}]</span> ${Charts.escapeXml(u.message || '')}</div>`
    ).join('\n');
    return `<h2>Status Updates (${updates.length} most recent)</h2>\n${rows}`;
}

/**
 * Build a single-series chart for one collection.
 * x-axis: objects stored (counts[coll])
 * y-axis: µs/object (timePerUnit[coll])
 */
async function buildChart(source, coll) {
    const samples = await source.getSamples();
    const points = samples.map(s => ({
        x: s.counts[coll] >= 0 ? s.counts[coll] : 0,
        y: s.timePerUnit[coll] || 0,
    }));

    return Charts.createSingleSeriesChart({
        name: coll,
        color: Charts.COLORS[coll],
        points,
        title: `${coll} — µs per object vs objects stored`,
        xLabel: 'Objects stored',
        yLabel: 'µs / object',
    });
}

// --- Routes ---

app.get('/', async (req, res) => {
    try {
        const body = `
<h1>MonitorTool — cljDetector Dashboard</h1>
${await summaryBox(source)}
<div class="chart-grid">
  <div class="chart-cell"><h3>Files</h3>${await buildChart(source, 'files')}</div>
  <div class="chart-cell"><h3>Chunks</h3>${await buildChart(source, 'chunks')}</div>
  <div class="chart-cell"><h3>Candidates</h3>${await buildChart(source, 'candidates')}</div>
  <div class="chart-cell"><h3>Clones</h3>${await buildChart(source, 'clones')}</div>
</div>
<h2>Status Updates</h2>
${await statusUpdatesHTML(source)}
`;
        res.send(htmlPage('MonitorTool Dashboard', body));
    } catch (e) {
        console.error('Route / error:', e.message);
        res.status(500).send('Error fetching data: ' + Charts.escapeXml(e.message));
    }
});

app.get('/export/json', async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', 'attachment; filename="monitor-statistics.json"');
    res.send(await source.exportAll());
});

app.get('/export/csv', async (req, res) => {
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="monitor-statistics.csv"');
    res.send(await source.exportCSV());
});

// --- Start ---

async function main() {
    console.log(`[MonitorTool] Starting... ${ARCHIVE_FILE ? 'ARCHIVE MODE' : 'LIVE MODE'}`);
    if (!ARCHIVE_FILE) {
        console.log(`[MonitorTool] DBHOST=${DBHOST}, POLL_INTERVAL=${POLL_INTERVAL}ms, PORT=${PORT}`);
    }
    console.log(`[MonitorTool] PORT=${PORT}`);

    await source.connect();

    app.listen(PORT, () => {
        console.log(`[MonitorTool] Web UI available at http://localhost:${PORT}`);
    });
}

main().catch(console.error);
