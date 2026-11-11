'use strict';

/**
 * Charts.js
 *
 * SVG chart generation for the MonitorTool web UI.
 * Generates inline SVG graphs — no external dependencies needed.
 *
 * Supports configurable dimensions for 2x2 grid layout and
 * single-series charts (no legend) via createSingleSeriesChart.
 */

const CHART_WIDTH = 960;
const CHART_HEIGHT = 460;

const COLORS = {
    files: '#2563eb',      // blue
    chunks: '#0e9489',     // teal
    candidates: '#7c3aed', // purple
    clones: '#dc2626',     // red
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
 * @param {Object} data - { series, title, xLabel, yLabel, width?, height?, legendPosition? }
 *   - legendPosition: 'right' (default), 'bottom', or 'none'
 * @returns {string} SVG string
 */
function createMultiSeriesChart(data) {
    const {
        series, title, xLabel, yLabel,
        width = CHART_WIDTH, height = CHART_HEIGHT,
        legendPosition = 'right',
    } = data;

    // Collect all points across all series to determine min/max
    let allPoints = series.flatMap(s => s.points);
    if (allPoints.length === 0) {
        return `<p>${escapeXml('No data available yet.')}</p>`;
    }

    // Margins adjust based on legend position
    const margin = { top: 30, bottom: 75, left: 90 };
    margin.right = legendPosition === 'right' ? 120 : 20;
    if (legendPosition === 'bottom') margin.bottom = 105;

    const plotWidth = width - margin.left - margin.right;
    const plotHeight = height - margin.top - margin.bottom;

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

    let svg = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeXml(title)}">`;
    svg += `<title>${escapeXml(title)}</title>`;

    // Grid lines and labels for y-axis
    for (let i = 0; i <= 5; i++) {
        const y = margin.top + (plotHeight * i / 5);
        const value = maxY - ((maxY - minY) * i / 5);
        svg += `<line class="grid" x1="${margin.left}" y1="${y}" x2="${width - margin.right}" y2="${y}" stroke="#ddd"/>`;
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
    svg += `<line class="axis" x1="${margin.left}" y1="${margin.top + plotHeight}" x2="${width - margin.right}" y2="${margin.top + plotHeight}" stroke="#333"/>`;

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
            svg += `<title>${escapeXml(s.name)}: ${escapeXml(p.y.toFixed(2))} at x=${escapeXml(p.x.toFixed(1))}</title></circle>`;
        }
    }

    // Legend — conditional on position
    if (legendPosition === 'right') {
        let legendY = margin.top;
        for (const s of series) {
            svg += `<line x1="${width - margin.right + 10}" y1="${legendY}" x2="${width - margin.right + 30}" y2="${legendY}" stroke="${s.color}" stroke-width="2"/>`;
            svg += `<text x="${width - margin.right + 35}" y="${legendY + 4}" font-size="12">${escapeXml(s.name)}</text>`;
            legendY += 20;
        }
    } else if (legendPosition === 'bottom') {
        let legendX = margin.left;
        const legendY = height - 20;
        for (const s of series) {
            svg += `<line x1="${legendX}" y1="${legendY}" x2="${legendX + 20}" y2="${legendY}" stroke="${s.color}" stroke-width="2"/>`;
            svg += `<text x="${legendX + 25}" y="${legendY + 4}" font-size="12">${escapeXml(s.name)}</text>`;
            legendX += 100;
        }
    }
    // legendPosition === 'none' → no legend

    // Axis labels
    svg += `<text x="${margin.left + plotWidth / 2}" y="${height - 15}" text-anchor="middle" font-size="14">${escapeXml(xLabel)}</text>`;
    // y-label: adjust vertical position for shorter charts
    const yLabelX = 22;
    const yLabelY = margin.top + plotHeight / 2;
    svg += `<text transform="translate(${yLabelX} ${yLabelY}) rotate(-90)" text-anchor="middle" font-size="14">${escapeXml(yLabel)}</text>`;
    svg += '</svg>';
    return svg;
}

/**
 * Create a single-series XY line chart — no legend, compact dimensions.
 * Defaults to 460x340, suitable for a 2x2 grid layout.
 * @param {Object} data - { name, color, points, title, xLabel, yLabel, width?, height? }
 * @returns {string} SVG string
 */
function createSingleSeriesChart(data) {
    const {
        name, color, points, title, xLabel, yLabel,
        width = 460, height = 340,
    } = data;
    return createMultiSeriesChart({
        series: [{ name, color, points }],
        title, xLabel, yLabel, width, height,
        legendPosition: 'none',
    });
}

module.exports = { createMultiSeriesChart, createSingleSeriesChart, escapeXml, COLORS, CHART_WIDTH, CHART_HEIGHT };
