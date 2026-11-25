(function () {
  const SVG_NS = "http://www.w3.org/2000/svg";

  function svgElement(name, attributes = {}) {
    const element = document.createElementNS(SVG_NS, name);
    for (const [key, value] of Object.entries(attributes)) {
      element.setAttribute(key, value);
    }
    return element;
  }

  function renderTrendChart(container, samples, collection, trend) {
    const points = samples.flatMap((sample) => {
      const interval = sample.intervals && sample.intervals[collection];
      if (!interval || interval.delta <= 0 || interval.secondsPerUnit == null) {
        return [];
      }
      return [{ x: interval.countBefore, y: interval.secondsPerUnit * 1e6 }];
    });

    if (points.length === 0) {
      container.textContent = "Waiting for new units in this collection.";
      return;
    }

    const width = 560;
    const height = 300;
    const margin = { top: 20, right: 24, bottom: 52, left: 76 };
    const plotWidth = width - margin.left - margin.right;
    const plotHeight = height - margin.top - margin.bottom;
    let minX = Math.min(...points.map((point) => point.x));
    let maxX = Math.max(...points.map((point) => point.x));
    if (minX === maxX) {
      minX = Math.max(0, minX - 1);
      maxX += 1;
    }
    const linearValues = trend && trend.linear
      ? [minX, maxX].map((value) => trend.linear.intercept + (trend.linear.slope * value))
      : [];
    const exponentialValues = trend && trend.exponential
      ? Array.from({ length: 31 }, (_, index) => {
        const value = minX + ((maxX - minX) * index) / 30;
        return Math.exp(Math.max(-700, Math.min(700,
          trend.exponential.intercept + (trend.exponential.slope * value))));
      })
      : [];
    const maxY = Math.max(
      ...points.map((point) => point.y),
      ...linearValues.filter((value) => value > 0),
      ...exponentialValues,
      1,
    );
    const x = (value) => margin.left + ((value - minX) / (maxX - minX)) * plotWidth;
    const y = (value) => margin.top + plotHeight - (value / maxY) * plotHeight;
    const svg = svgElement("svg", {
      viewBox: `0 0 ${width} ${height}`,
      role: "img",
      "aria-label": `${collection} processing time per unit versus prior count`,
    });

    svg.append(
      svgElement("line", {
        x1: margin.left,
        y1: margin.top,
        x2: margin.left,
        y2: margin.top + plotHeight,
        class: "axis",
      }),
      svgElement("line", {
        x1: margin.left,
        y1: margin.top + plotHeight,
        x2: margin.left + plotWidth,
        y2: margin.top + plotHeight,
        class: "axis",
      }),
    );

    if (trend && trend.linear) {
      const linearPoints = [minX, maxX]
        .map((value) => ({ x: value, y: Math.max(0, trend.linear.intercept + (trend.linear.slope * value)) }));
      svg.appendChild(svgElement("path", {
        d: linearPoints.map((point, index) => `${index === 0 ? "M" : "L"}${x(point.x)},${y(point.y)}`).join(" "),
        class: "linear-fit",
      }));
    }
    if (trend && trend.exponential) {
      const exponentialPoints = Array.from({ length: 31 }, (_, index) => {
        const value = minX + ((maxX - minX) * index) / 30;
        return {
          x: value,
          y: Math.exp(Math.max(-700, Math.min(700,
            trend.exponential.intercept + (trend.exponential.slope * value)))),
        };
      });
      svg.appendChild(svgElement("path", {
        d: exponentialPoints.map((point, index) => `${index === 0 ? "M" : "L"}${x(point.x)},${y(point.y)}`).join(" "),
        class: "exponential-fit",
      }));
    }
    for (const point of points) {
      svg.appendChild(svgElement("circle", {
        cx: x(point.x),
        cy: y(point.y),
        r: 4,
        class: "data-point",
      }));
    }

    const legend = document.createElement("p");
    legend.className = "chart-legend";
    legend.textContent = "● samples  ━ linear fit  ┄ exponential fit";
    container.replaceChildren(legend, svg);

    for (const [text, xPos, yPos, className, transform] of [
      ["Time per new unit (µs)", 18, margin.top + plotHeight / 2, "axis-label", `rotate(-90 18 ${margin.top + plotHeight / 2})`],
      ["Units already present when interval began", margin.left + plotWidth / 2, height - 8, "axis-label", ""],
      [String(Math.round(minX)), margin.left, margin.top + plotHeight + 20, "tick-label", ""],
      [String(Math.round(maxX)), margin.left + plotWidth, margin.top + plotHeight + 20, "tick-label", ""],
      [maxY.toFixed(2), margin.left - 10, margin.top + 5, "tick-label", ""],
      ["0", margin.left - 10, margin.top + plotHeight, "tick-label", ""],
    ]) {
      const label = svgElement("text", {
        x: xPos,
        y: yPos,
        class: className,
        "text-anchor": className === "axis-label" && text.startsWith("Units") ? "middle" : "end",
      });
      if (transform) {
        label.setAttribute("transform", transform);
      }
      label.textContent = text;
      svg.appendChild(label);
    }

  }

  window.MonitorCharts = { renderTrendChart };
}());