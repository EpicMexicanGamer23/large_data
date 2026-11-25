const path = require("node:path");
const express = require("express");
const { MongoClient } = require("mongodb");
const { Monitor, toCsv } = require("./monitor");

const port = Number(process.env.PORT || 3000);
const pollIntervalMs = Number(process.env.POLL_INTERVAL || 5000);
const databaseName = process.env.DBNAME || "cloneDetector";
const mongoUri = process.env.MONGODB_URI
  || `mongodb://${process.env.DBHOST || "localhost"}:${Number(process.env.DBPORT || 27017)}`;

if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
  throw new RangeError("PORT must be an integer between 1 and 65535");
}

const client = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 5000 });
let clientConnected = false;
let connectionPromise = null;
const monitor = new Monitor({
  dbProvider: async () => {
    if (!clientConnected) {
      if (!connectionPromise) {
        connectionPromise = client.connect()
          .then(() => {
            clientConnected = true;
          })
          .catch((error) => {
            connectionPromise = null;
            throw error;
          });
      }
      await connectionPromise;
    }
    return client.db(databaseName);
  },
  pollIntervalMs,
});
const app = express();

function asyncRoute(handler) {
  return (request, response, next) => {
    Promise.resolve(handler(request, response, next)).catch(next);
  };
}

app.get("/api/health", (_request, response) => {
  response.status(monitor.connected ? 200 : 503).json({
    ok: monitor.connected,
    runId: monitor.runId,
    lastError: monitor.lastError,
  });
});

app.get("/api/snapshot", asyncRoute(async (_request, response) => {
  const snapshot = await monitor.getSnapshot();
  response.status(snapshot.connected ? 200 : 503).json(snapshot);
}));

app.get("/export/json", asyncRoute(async (_request, response) => {
  response.set("Content-Disposition", 'attachment; filename="monitor-statistics.json"');
  response.json(await monitor.getExportData());
}));

app.get("/export/csv", asyncRoute(async (_request, response) => {
  const data = await monitor.getExportData();
  response.type("text/csv");
  response.set("Content-Disposition", 'attachment; filename="monitor-samples.csv"');
  response.send(toCsv(data.samples));
}));

app.get("/charts.js", (_request, response) => {
  response.sendFile(path.join(__dirname, "charts.js"));
});

app.use(express.static(path.join(__dirname, "..", "public")));

app.use((error, _request, response, _next) => {
  console.error(`Monitor request failed: ${error.message}`);
  response.status(500).json({ error: "Monitor request failed" });
});

const server = app.listen(port, () => {
  console.log(`MonitorTool listening on port ${port}; polling every ${pollIntervalMs} ms`);
});
monitor.start();

async function shutdown() {
  monitor.stop();
  server.close(async () => {
    await client.close();
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);