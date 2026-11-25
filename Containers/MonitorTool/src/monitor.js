const { randomUUID } = require("node:crypto");

const COLLECTIONS = ["files", "chunks", "candidates", "clones"];
const SAMPLE_COLLECTION = "monitorSamples";
const MAX_SAMPLES_IN_API = 1000;
const MAX_STATUS_UPDATES = 200;

function createSample({ runId, sampledAt, counts, previousSample }) {
  const timestamp = new Date(sampledAt);
  if (Number.isNaN(timestamp.getTime())) {
    throw new TypeError("sampledAt must be a valid date");
  }

  const elapsedMs = previousSample
    ? timestamp.getTime() - new Date(previousSample.sampledAt).getTime()
    : null;
  const intervals = previousSample
    ? Object.fromEntries(COLLECTIONS.map((collection) => {
      const countBefore = Number(previousSample.counts[collection]);
      const countAfter = Number(counts[collection]);
      const delta = countAfter - countBefore;
      const validDuration = Number.isFinite(elapsedMs) && elapsedMs > 0;
      const increasing = validDuration && delta > 0;

      return [collection, {
        countBefore,
        countAfter,
        delta,
        elapsedMs,
        unitsPerSecond: increasing ? (delta * 1000) / elapsedMs : null,
        secondsPerUnit: increasing ? elapsedMs / (delta * 1000) : null,
      }];
    }))
    : null;

  return {
    runId,
    sampledAt: timestamp.toISOString(),
    elapsedMs,
    counts: Object.fromEntries(
      COLLECTIONS.map((collection) => [collection, Number(counts[collection])]),
    ),
    intervals,
  };
}

function rSquared(observations, predictions) {
  const mean = observations.reduce((sum, value) => sum + value, 0) / observations.length;
  const total = observations.reduce((sum, value) => sum + ((value - mean) ** 2), 0);
  const residual = observations.reduce(
    (sum, value, index) => sum + ((value - predictions[index]) ** 2),
    0,
  );
  if (total === 0) {
    return residual < 1e-12 ? 1 : 0;
  }
  return Math.max(0, 1 - (residual / total));
}

function linearFit(points) {
  const meanX = points.reduce((sum, point) => sum + point.x, 0) / points.length;
  const meanY = points.reduce((sum, point) => sum + point.y, 0) / points.length;
  const varianceX = points.reduce((sum, point) => sum + ((point.x - meanX) ** 2), 0);
  if (varianceX === 0) {
    return null;
  }

  const covariance = points.reduce(
    (sum, point) => sum + ((point.x - meanX) * (point.y - meanY)),
    0,
  );
  const slope = covariance / varianceX;
  const intercept = meanY - (slope * meanX);
  const predictions = points.map((point) => intercept + (slope * point.x));

  return {
    slope,
    intercept,
    rSquared: rSquared(points.map((point) => point.y), predictions),
  };
}

function exponentialFit(points) {
  const logged = points.map((point) => ({ x: point.x, y: Math.log(point.y) }));
  const fit = linearFit(logged);
  if (!fit) {
    return null;
  }

  const predictions = points.map((point) => (
    Math.exp(Math.max(-700, Math.min(700, fit.intercept + (fit.slope * point.x))))
  ));
  return {
    initialSecondsPerUnit: Math.exp(Math.max(-700, Math.min(700, fit.intercept))),
    growthFactorPer1000Units: Math.exp(Math.max(-700, Math.min(700, fit.slope * 1000))),
    slope: fit.slope,
    intercept: fit.intercept,
    rSquared: rSquared(points.map((point) => point.y), predictions),
  };
}

function analyzeTrends(samples) {
  return Object.fromEntries(COLLECTIONS.map((collection) => {
    const points = samples.flatMap((sample) => {
      const interval = sample.intervals && sample.intervals[collection];
      if (!interval || interval.delta <= 0 || interval.secondsPerUnit == null) {
        return [];
      }
      return [{ x: interval.countBefore, y: interval.secondsPerUnit }];
    });

    if (points.length < 3) {
      return [collection, {
        points: points.length,
        classification: "insufficient data",
        linear: null,
        exponential: null,
      }];
    }

    const linear = linearFit(points);
    const exponential = exponentialFit(points);
    if (!linear || !exponential) {
      return [collection, {
        points: points.length,
        classification: "insufficient count variation",
        linear,
        exponential,
      }];
    }
    const difference = Math.abs(linear.rSquared - exponential.rSquared);
    const classification = difference < 0.05
      ? "similar fit"
      : (linear.rSquared > exponential.rSquared ? "linear" : "exponential");

    return [collection, {
      points: points.length,
      classification,
      linear,
      exponential,
    }];
  }));
}

class Monitor {
  constructor({ dbProvider, pollIntervalMs, logger = console, clock = Date.now }) {
    if (typeof dbProvider !== "function") {
      throw new TypeError("dbProvider must be a function");
    }
    if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs <= 0) {
      throw new RangeError("pollIntervalMs must be a positive integer");
    }

    this.dbProvider = dbProvider;
    this.pollIntervalMs = pollIntervalMs;
    this.logger = logger;
    this.clock = clock;
    this.runId = randomUUID();
    this.previousSample = null;
    this.latestSample = null;
    this.lastStatusId = null;
    this.statusUpdates = [];
    this.sampleIndexCreated = false;
    this.connected = false;
    this.lastError = null;
    this.running = false;
    this.timer = null;
  }

  async _readNewStatusUpdates(db) {
    const collection = db.collection("statusUpdates");
    if (this.lastStatusId == null) {
      const updates = await collection.find({})
        .sort({ _id: -1 })
        .limit(MAX_STATUS_UPDATES)
        .toArray();
      updates.reverse();
      return { updates, lastId: updates.length ? updates[updates.length - 1]._id : null };
    }

    const updates = await collection.find({ _id: { $gt: this.lastStatusId } })
      .sort({ _id: 1 })
      .limit(1000)
      .toArray();
    return {
      updates,
      lastId: updates.length ? updates[updates.length - 1]._id : this.lastStatusId,
    };
  }

  async pollOnce() {
    const db = await this.dbProvider();
    const sampleCollection = db.collection(SAMPLE_COLLECTION);
    if (!this.sampleIndexCreated) {
      await sampleCollection.createIndex({ runId: 1, sampledAt: 1 });
      this.sampleIndexCreated = true;
    }
    const counts = Object.fromEntries(await Promise.all(COLLECTIONS.map(async (collection) => (
      [collection, await db.collection(collection).estimatedDocumentCount()]
    ))));
    const statusResult = await this._readNewStatusUpdates(db);
    const sample = createSample({
      runId: this.runId,
      sampledAt: this.clock(),
      counts,
      previousSample: this.previousSample,
    });

    await sampleCollection.insertOne(sample);
    this.previousSample = sample;
    this.latestSample = sample;
    this.lastStatusId = statusResult.lastId;
    this.statusUpdates = [...this.statusUpdates, ...statusResult.updates].slice(-MAX_STATUS_UPDATES);
    this.connected = true;
    this.lastError = null;
    return sample;
  }

  start() {
    if (this.running) {
      return;
    }
    this.running = true;
    this._schedulePoll(0);
  }

  stop() {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  _schedulePoll(delayMs) {
    this.timer = setTimeout(async () => {
      try {
        await this.pollOnce();
      } catch (error) {
        this.connected = false;
        this.lastError = error.message;
        this.logger.error(`Monitor poll failed: ${error.message}`);
      } finally {
        if (this.running) {
          this._schedulePoll(this.pollIntervalMs);
        }
      }
    }, delayMs);
  }

  async getSnapshot() {
    const db = await this.dbProvider();
    const samples = await db.collection(SAMPLE_COLLECTION)
      .find({ runId: this.runId })
      .sort({ sampledAt: -1 })
      .limit(MAX_SAMPLES_IN_API)
      .toArray();
    samples.reverse();
    return {
      runId: this.runId,
      pollIntervalMs: this.pollIntervalMs,
      connected: this.connected,
      lastError: this.lastError,
      currentCounts: this.latestSample ? this.latestSample.counts : null,
      sampledAt: this.latestSample ? this.latestSample.sampledAt : null,
      samples,
      trends: analyzeTrends(samples),
      statusUpdates: this.statusUpdates,
    };
  }

  async getExportData() {
    const db = await this.dbProvider();
    const [samples, statusUpdates] = await Promise.all([
      db.collection(SAMPLE_COLLECTION)
        .find({ runId: this.runId })
        .sort({ sampledAt: 1 })
        .toArray(),
      db.collection("statusUpdates").find({}).sort({ _id: 1 }).toArray(),
    ]);
    return {
      runId: this.runId,
      pollIntervalMs: this.pollIntervalMs,
      samples,
      trends: analyzeTrends(samples),
      statusUpdates,
    };
  }
}

function toCsv(samples) {
  const fields = ["sampledAt", "elapsedMs"];
  for (const collection of COLLECTIONS) {
    fields.push(
      `${collection}Count`,
      `${collection}Delta`,
      `${collection}UnitsPerSecond`,
      `${collection}SecondsPerUnit`,
    );
  }
  const quote = (value) => {
    const text = value == null ? "" : String(value);
    return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  const rows = samples.map((sample) => {
    const values = [sample.sampledAt, sample.elapsedMs];
    for (const collection of COLLECTIONS) {
      const interval = sample.intervals && sample.intervals[collection];
      values.push(
        sample.counts[collection],
        interval ? interval.delta : "",
        interval ? interval.unitsPerSecond : "",
        interval ? interval.secondsPerUnit : "",
      );
    }
    return values.map(quote).join(",");
  });
  return [fields.join(","), ...rows].join("\n");
}

module.exports = {
  COLLECTIONS,
  Monitor,
  analyzeTrends,
  createSample,
  toCsv,
};