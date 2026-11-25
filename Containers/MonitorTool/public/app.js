(function () {
  const collections = ["files", "chunks", "candidates", "clones"];
  const countsElement = document.getElementById("counts");
  const intervalElement = document.getElementById("intervals");
  const chartElement = document.getElementById("charts");
  const updatesElement = document.getElementById("updates");
  const errorElement = document.getElementById("error");
  const numberFormat = new Intl.NumberFormat();
  let refreshTimer;
  let refreshIntervalMs;

  function scheduleRefresh(intervalMs) {
    const delay = Math.max(1000, intervalMs);
    if (refreshTimer && refreshIntervalMs === delay) {
      return;
    }
    if (refreshTimer) {
      window.clearInterval(refreshTimer);
    }
    refreshIntervalMs = delay;
    refreshTimer = window.setInterval(refresh, delay);
  }

  function addCell(row, value) {
    const cell = document.createElement("td");
    cell.textContent = value;
    row.appendChild(cell);
  }

  function format(value, digits = 3) {
    return value == null || !Number.isFinite(value)
      ? "—"
      : new Intl.NumberFormat(undefined, { maximumFractionDigits: digits }).format(value);
  }

  function renderCounts(counts) {
    countsElement.replaceChildren();
    for (const collection of collections) {
      const card = document.createElement("article");
      card.className = "count-card";
      const label = document.createElement("h3");
      label.textContent = collection;
      const value = document.createElement("p");
      value.textContent = numberFormat.format(counts[collection]);
      card.append(label, value);
      countsElement.appendChild(card);
    }
  }

  function renderIntervals(snapshot) {
    intervalElement.replaceChildren();
    const latest = snapshot.samples[snapshot.samples.length - 1];
    for (const collection of collections) {
      const row = document.createElement("tr");
      const interval = latest && latest.intervals && latest.intervals[collection];
      const trend = snapshot.trends[collection];
      addCell(row, collection);
      addCell(row, interval ? format(interval.delta, 0) : "—");
      addCell(row, interval ? format(interval.unitsPerSecond) : "—");
      addCell(row, interval ? format(interval.secondsPerUnit, 6) : "—");
      addCell(row, trend ? `${trend.classification} (${trend.points} intervals)` : "—");
      intervalElement.appendChild(row);
    }
    if (latest) {
      const elapsedMs = latest.elapsedMs;
      document.getElementById("sample-time").textContent =
        `Last sample ${new Date(latest.sampledAt).toLocaleString()}`
        + (elapsedMs == null ? "" : ` · interval ${format(elapsedMs / 1000, 1)} s`);
    }
  }

  function renderUpdates(updates) {
    updatesElement.replaceChildren();
    if (updates.length === 0) {
      const item = document.createElement("li");
      item.textContent = "No detector status updates yet.";
      updatesElement.appendChild(item);
      return;
    }
    for (const update of updates.slice().reverse()) {
      const item = document.createElement("li");
      const time = document.createElement("time");
      time.textContent = update.timestamp || "";
      const message = document.createElement("span");
      message.textContent = update.message || "";
      item.append(time, message);
      updatesElement.appendChild(item);
    }
  }

  function renderCharts(samples, trends) {
    chartElement.replaceChildren();
    for (const collection of collections) {
      const panel = document.createElement("article");
      panel.className = "chart-panel";
      const heading = document.createElement("h3");
      heading.textContent = collection;
      const chart = document.createElement("div");
      chart.className = "chart";
      panel.append(heading, chart);
      chartElement.appendChild(panel);
      if (window.MonitorCharts && typeof window.MonitorCharts.renderTrendChart === "function") {
        window.MonitorCharts.renderTrendChart(chart, samples, collection, trends[collection]);
      } else {
        chart.textContent = "Chart renderer could not be loaded.";
      }
    }
  }

  async function refresh() {
    try {
      const response = await fetch("/api/snapshot", { cache: "no-store" });
      const snapshot = await response.json();
      if (!response.ok) {
        throw new Error(snapshot.lastError || "Waiting for the first successful database sample");
      }

      errorElement.textContent = "";
      document.getElementById("connection").textContent = `Connected · run ${snapshot.runId}`;
      document.getElementById("connection").className = "connection connected";
      if (snapshot.currentCounts) {
        renderCounts(snapshot.currentCounts);
      }
      renderIntervals(snapshot);
      renderCharts(snapshot.samples, snapshot.trends);
      renderUpdates(snapshot.statusUpdates);
      scheduleRefresh(snapshot.pollIntervalMs);
    } catch (error) {
      document.getElementById("connection").textContent = "Database unavailable";
      document.getElementById("connection").className = "connection disconnected";
      errorElement.textContent = error.message;
      scheduleRefresh(5000);
    }
  }

  refresh();
}());
