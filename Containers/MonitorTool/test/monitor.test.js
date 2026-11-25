const test = require("node:test");
const assert = require("node:assert/strict");
const { analyzeTrends, createSample, Monitor, toCsv } = require("../src/monitor");

const counts = (value) => ({
  files: value,
  chunks: value,
  candidates: value,
  clones: value,
});

test("samples calculate per-interval count deltas and processing time", () => {
  const first = createSample({
    runId: "test",
    sampledAt: "2026-01-01T00:00:00.000Z",
    counts: counts(10),
  });
  const second = createSample({
    runId: "test",
    sampledAt: "2026-01-01T00:00:05.000Z",
    counts: counts(20),
    previousSample: first,
  });

  assert.equal(first.intervals, null);
  assert.equal(second.intervals.files.delta, 10);
  assert.equal(second.intervals.files.unitsPerSecond, 2);
  assert.equal(second.intervals.files.secondsPerUnit, 0.5);
  assert.equal(second.intervals.files.countBefore, 10);
});

test("non-increasing collection counts do not claim a positive processing rate", () => {
  const previous = createSample({
    runId: "test",
    sampledAt: "2026-01-01T00:00:00.000Z",
    counts: counts(20),
  });
  const next = createSample({
    runId: "test",
    sampledAt: "2026-01-01T00:00:05.000Z",
    counts: counts(12),
    previousSample: previous,
  });

  assert.equal(next.intervals.files.delta, -8);
  assert.equal(next.intervals.files.unitsPerSecond, null);
  assert.equal(next.intervals.files.secondsPerUnit, null);
});

test("trend analysis compares linear and exponential time-per-unit fits", () => {
  const samples = [1, 2, 4, 8].map((time, index) => ({
    intervals: {
      files: {
        countBefore: index + 1,
        delta: 1,
        secondsPerUnit: time,
      },
    },
  }));
  const trend = analyzeTrends(samples).files;

  assert.equal(trend.points, 4);
  assert.equal(trend.classification, "exponential");
  assert.ok(trend.exponential.rSquared > trend.linear.rSquared);
  assert.ok(trend.exponential.growthFactorPer1000Units > 1e300);
});

test("trend analysis reports insufficient observations", () => {
  const trend = analyzeTrends([]).files;
  assert.equal(trend.classification, "insufficient data");
  assert.equal(trend.linear, null);
});

test("trend analysis handles repeated starting counts without throwing", () => {
  const samples = [1, 2, 3].map((time) => ({
    intervals: {
      files: { countBefore: 5, delta: 1, secondsPerUnit: time },
    },
  }));
  const trend = analyzeTrends(samples).files;

  assert.equal(trend.classification, "insufficient count variation");
  assert.equal(trend.linear, null);
});

test("CSV export includes collection counts and interval metrics", () => {
  const sample = createSample({
    runId: "test",
    sampledAt: "2026-01-01T00:00:00.000Z",
    counts: counts(10),
  });
  const csv = toCsv([sample]);
  assert.match(csv, /filesCount/);
  assert.match(csv, /chunksSecondsPerUnit/);
  assert.match(csv, /2026-01-01T00:00:00.000Z/);
});

test("monitor persists regular samples and receives new status updates", async () => {
  const collections = {
    files: [{}],
    chunks: [{}, {}],
    candidates: [],
    clones: [],
    statusUpdates: [{ _id: 1, timestamp: "first", message: "started" }],
    monitorSamples: [],
  };
  const database = {
    collection(name) {
      return {
        estimatedDocumentCount: async () => collections[name].length,
        createIndex: async () => "runId_1_sampledAt_1",
        find(filter = {}) {
          let documents = collections[name].filter((document) => {
            if (filter.runId && document.runId !== filter.runId) {
              return false;
            }
            return !filter._id || !filter._id.$gt || document._id > filter._id.$gt;
          });
          let sortField;
          let sortDirection;
          let limit = Infinity;
          return {
            sort(order) {
              [sortField] = Object.keys(order);
              sortDirection = order[sortField];
              return this;
            },
            limit(value) {
              limit = value;
              return this;
            },
            async toArray() {
              documents = documents.slice().sort((left, right) => (
                (left[sortField] < right[sortField] ? -1 : 1) * sortDirection
              ));
              return documents.slice(0, limit);
            },
          };
        },
        insertOne: async (document) => collections[name].push(document),
      };
    },
  };
  let now = Date.parse("2026-01-01T00:00:00.000Z");
  const monitor = new Monitor({
    dbProvider: async () => database,
    pollIntervalMs: 5000,
    clock: () => now,
    logger: { error() {} },
  });

  await monitor.pollOnce();
  collections.files.push({});
  collections.statusUpdates.push({ _id: 2, timestamp: "second", message: "stored files" });
  now += 5000;
  await monitor.pollOnce();
  const snapshot = await monitor.getSnapshot();

  assert.equal(collections.monitorSamples.length, 2);
  assert.equal(snapshot.currentCounts.files, 2);
  assert.equal(snapshot.samples[1].intervals.files.delta, 1);
  assert.deepEqual(snapshot.statusUpdates.map((update) => update.message), ["started", "stored files"]);
});
