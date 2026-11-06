'use strict';

/**
 * Charts.js
 *
 * SVG chart generation for the MonitorTool web UI.
 * Generates inline SVG graphs — no external dependencies needed.
 *
 * Inspired by the CodeStreamConsumer's createXYGraphSVG approach.
 */

const CHART_WIDTH = 960;
const CHART_HEIGHT = 460;

const COLORS = {
    files: '#2563eb',      // blue
    chunks: '#0e9489',     // teal
    candidates: '#7c3aed', // purple
    clones: '#dc2626',    // red
};

function escapeXml(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

/**
 * Create a multi-series XY line chart as an SVG string.
 * @param {Object} data - { series: [{ name, color, points: [{x, y, label}] }], title, xLabel, yLabel }
 * @returns {string} SVG string
 */
function createMultiSeriesChart(data) {
    const { series, title, xLabel, yLabel } = data;

    // Collect all points across all series to determine min/max
    let allPoints = series.flatMap(s => s.points);
    if (allPoints.length === 0) {
        return `<p>${escapeXml('No data available yet.')}</p>`;
    }

    const margin = { top: 30, right: 120, bottom: 75, left: 90 };
    const plotWidth = CHART_WIDTH - margin.left - margin.right;
    const plotHeight = CHART_HEIGHT - margin.top - margin.bottom;

    let minX = Infinity, maxX = -Infinity;
    let minY = 0, maxY = -Infinity;
    for (const p of allPoints) {
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.y > maxY) maxY = p.y;
    }
    if (minX === maxX) { minX -= 1; maxX += 1; }
    if (minY === maxY) { maxY = minY + 1; }

    const xAt = v => margin.left + ((v - minX) / (maxX - minX)) * plotWidth;
    const yAt = v => margin.top + plotHeight - ((v - minY) / (maxY - minY)) * plotHeight;

    let svg = `<svg viewBox="0 0 ${CHART_WIDTH} ${CHART_HEIGHT}" role="img" aria-label="${escapeXml(title)}">`;
    svg += `<title>${escapeXml(title)}</title>`;

    // Grid lines and labels for y-axis
    for (let i = 0; i <= 5; i++) {
        const y = margin.top + (plotHeight * i / 5);
        const value = maxY - ((maxY - minY) * i / 5);
        svg += `<line class="grid" x1="${margin.left}" y1="${y}" x2="${CHART_WIDTH - margin.right}" y2="${y}" stroke="#ddd"/>`;
        svg += `<text x="${margin.left - 10}" y="${y + 4}" text-anchor="end" font-size="12">${escapeXml(value.toFixed(1))}</text>`;
    }
    // Grid lines and labels for x-axis
    for (let i = 0; i <= 5; i++) {
        const x = margin.left + (plotWidth * i / 5);
        const value = minX + ((maxX - minX) * i / 5);
        svg += `<line class="grid" x1="${x}" y1="${margin.top}" x2="${x}" y2="${margin.top + plotHeight}" stroke="#ddd"/>`;
        svg += `<text x="${x}" y="${margin.top + plotHeight + 22}" text-anchor="middle" font-size="12">${escapeXml(Math.round(value).toString())}</text>`;
    }
    // Axes
    svg += `<line class="axis" x1="${margin.left}" y1="${margin.top}" x2="${margin.left}" y2="${margin.top + plotHeight}" stroke="#333"/>`;
    svg += `<line class="axis" x1="${margin.left}" y1="${margin.top + plotHeight}" x2="${CHART_WIDTH - margin.right}" y2="${margin.top + plotHeight}" stroke="#333"/>`;

    // Draw each series
    for (const s of series) {
        if (s.points.length === 0) continue;
        // Line path
        const path = s.points.map((p, i) =>
            (i === 0 ? 'M' : 'L') + xAt(p.x).toFixed(2) + ',' + yAt(p.y).toFixed(2)
        ).join(' ');
        svg += `<path d="${path}" fill="none" stroke="${s.color}" stroke-width="2"/>`;
        // Points
        for (const p of s.points) {
            svg += `<circle cx="${xAt(p.x).toFixed(2)}" cy="${yAt(p.y).toFixed(2)}" r="2" fill="${s.color}">`;
            svg += `<title>${escapeXml(s.name)}: ${escapeXml(p.y.toFixed(2))} at t=${escapeXml(p.x.toFixed(1))}s</title></circle>`;
        }
    }

    // Legend
    let legendY = margin.top;
    for (const s of series) {
        svg += `<line x1="${CHART_WIDTH - margin.right + 10}" y1="${legendY}" x2="${CHART_WIDTH - margin.right + 30}" y2="${legendY}" stroke="${s.color}" stroke-width="2"/>`;
        svg += `<text x="${CHART_WIDTH - margin.right + 35}" y="${legendY + 4}" font-size="12">${escapeXml(s.name)}</text>`;
        legendY += 20;
    }

    // Axis labels
    svg += `<text x="${margin.left + plotWidth / 2}" y="${CHART_HEIGHT - 15}" text-anchor="middle" font-size="14">${escapeXml(xLabel)}</text>`;
    svg += `<text transform="translate(22 ${margin.top + plotHeight / 2}) rotate(-90)" text-anchor="middle" font-size="14">${escapeXml(yLabel)}</text>`;
    svg += '</svg>';
    return svg;
}

module.exports = { createMultiSeriesChart, escapeXml, COLORS, CHART_WIDTH, CHART_HEIGHT };
