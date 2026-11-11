'use strict';

/**
 * Monitor.js
 *
 * Polls the cloneDetector MongoDB database at regular intervals, collecting:
 *   - Counts of files, chunks, candidates, clones
 *   - New statusUpdates since the last poll
 *
 * Calculates per-interval deltas and derived statistics:
 *   - Processing rate (units/sec) for each collection
 *   - Time per unit (µs per new item) for each collection
 *   - Cumulative elapsed time
 *
 * Stores all samples in a MongoDB collection (monitorSamples) to avoid
 * OOM crashes during long-running monitoring sessions.
 *
 * On connect, archives any existing monitorSamples + statusUpdates to
 * /data/previous-session.json, then drops monitorSamples so the new
 * session starts clean (no data mixing between runs).
 */

const { MongoClient } = require('mongodb');
const fs = require('fs');

const DB_NAME = 'cloneDetector';
const COLLECTIONS = ['files', 'chunks', 'candidates', 'clones'];
const STATUS_COLLECTION = 'statusUpdates';
const SAMPLES_COLLECTION = 'monitorSamples';
const ARCHIVE_PATH = process.env.ARCHIVE_PATH || '/data/previous-session.json';

class Monitor {
    constructor(dbHost, pollIntervalMs) {
        this.dbHost = dbHost || 'localhost';
        this.pollIntervalMs = pollIntervalMs || 5000;
        this.client = null;
        this.db = null;

        // Track the start time of monitoring
        this.startTime = null;

        // Track last seen counts for delta calculation
        this.lastCounts = { files: 0, chunks: 0, candidates: 0, clones: 0 };

        // Track last seen status update _id for fetching only new ones
        this.lastStatusId = null;

        this.timer = null;
        this.running = false;
    }

    async connect() {
        const url = `mongodb://${this.dbHost}:27017`;
        this.client = new MongoClient(url, { serverSelectionTimeoutMS: 5000 });
        await this.client.connect();
        this.db = this.client.db(DB_NAME);

        // Archive existing session data before starting a new one
        await this._archivePreviousSession();

        // Ensure indexes for efficient querying
        await this.db.collection(SAMPLES_COLLECTION).createIndex({ elapsedMs: 1 });
        await this.db.collection(STATUS_COLLECTION).createIndex({ _id: 1 });
        console.log(`[Monitor] Connected to MongoDB at ${url}/${DB_NAME}`);
    }

    /**
     * Archive existing monitorSamples + statusUpdates to /data/previous-session.json,
     * then drop monitorSamples so the new session starts clean.
     * Skips if there's nothing to archive (first run).
     */
    async _archivePreviousSession() {
        try {
            const sampleCount = await this.db.collection(SAMPLES_COLLECTION).countDocuments();
            const statusCount = await this.db.collection(STATUS_COLLECTION).countDocuments();

            if (sampleCount === 0 && statusCount === 0) {
                console.log('[Monitor] No existing session data to archive.');
                return;
            }

            console.log(`[Monitor] Archiving previous session: ${sampleCount} samples, ${statusCount} status updates → ${ARCHIVE_PATH}`);

            const samples = await this.db.collection(SAMPLES_COLLECTION)
                .find({})
                .sort({ elapsedMs: 1 })
                .toArray();
            const statusUpdates = await this.db.collection(STATUS_COLLECTION)
                .find({})
                .sort({ _id: 1 })
                .toArray();

            const archive = {
                archivedAt: new Date().toISOString(),
                samples,
                statusUpdates,
            };

            // Ensure /data directory exists
            const dir = require('path').dirname(ARCHIVE_PATH);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }

            fs.writeFileSync(ARCHIVE_PATH, JSON.stringify(archive, null, 2));
            console.log(`[Monitor] Archive written to ${ARCHIVE_PATH}`);

            // Drop monitorSamples so new session data doesn't mix with old
            await this.db.collection(SAMPLES_COLLECTION).drop().catch(() => {});
            console.log('[Monitor] Dropped monitorSamples collection for clean session.');
        } catch (e) {
            console.error('[Monitor] Error archiving previous session:', e.message);
            // Non-fatal — continue starting up even if archiving fails
        }
    }

    async start() {
        this.startTime = Date.now();
        this.running = true;
        console.log(`[Monitor] Starting monitoring (poll interval: ${this.pollIntervalMs}ms)`);
        // Do an immediate first poll
        await this.poll();
        // Schedule subsequent polls
        this.timer = setInterval(() => this.poll().catch(console.error), this.pollIntervalMs);
    }

    stop() {
        this.running = false;
        if (this.timer) clearInterval(this.timer);
        if (this.client) this.client.close();
    }

    async poll() {
        const now = Date.now();
        const elapsedMs = now - this.startTime;

        // Count each collection
        const counts = {};
        for (const coll of COLLECTIONS) {
            try {
                counts[coll] = await this.db.collection(coll).countDocuments();
            } catch (e) {
                counts[coll] = -1; // Error sentinel
            }
        }

        // Calculate deltas from last poll
        const deltas = {};
        for (const coll of COLLECTIONS) {
            deltas[coll] = counts[coll] - this.lastCounts[coll];
        }

        // Calculate processing rate (units/sec) and time per unit (µs/unit) for this interval
        const intervalSeconds = this.pollIntervalMs / 1000;
        const rates = {};
        const timePerUnit = {};
        for (const coll of COLLECTIONS) {
            if (deltas[coll] > 0) {
                rates[coll] = deltas[coll] / intervalSeconds;
                // Convert ms/unit to µs/unit for finer granularity
                timePerUnit[coll] = (this.pollIntervalMs / deltas[coll]) * 1000;
            } else {
                rates[coll] = 0;
                timePerUnit[coll] = 0;
            }
        }

        // Fetch new status update count
        const newStatusCount = await this._fetchNewStatusCount();

        // Build the sample document
        const sample = {
            timestamp: new Date(now).toISOString(),
            elapsedMs: elapsedMs,
            counts: { ...counts },
            deltas: { ...deltas },
            rates: { ...rates },
            timePerUnit: { ...timePerUnit },
            newStatusCount: newStatusCount,
        };

        // Persist sample to MongoDB instead of in-memory array
        try {
            await this.db.collection(SAMPLES_COLLECTION).insertOne(sample);
        } catch (e) {
            console.error('[Monitor] Error persisting sample:', e.message);
        }

        this.lastCounts = { ...counts };

        // Log to console for text-only monitoring
        const countStr = COLLECTIONS.map(c => `${c}=${counts[c]}`).join(' ');
        const deltaStr = COLLECTIONS.map(c => `d${c}=${deltas[c] >= 0 ? '+' : ''}${deltas[c]}`).join(' ');
        console.log(`[Monitor] t=${(elapsedMs / 1000).toFixed(1)}s | ${countStr} | ${deltaStr}` +
            (newStatusCount > 0 ? ` | ${newStatusCount} new status updates` : ''));

        return sample;
    }

    async _fetchNewStatusCount() {
        try {
            // Count status updates newer than the last one we saw
            const query = this.lastStatusId ? { _id: { $gt: this.lastStatusId } } : {};
            const count = await this.db.collection(STATUS_COLLECTION).countDocuments(query);

            // Update lastStatusId to the most recent one
            const latest = await this.db.collection(STATUS_COLLECTION)
                .find({})
                .sort({ _id: -1 })
                .limit(1)
                .toArray();
            if (latest.length > 0) {
                this.lastStatusId = latest[0]._id;
            }
            return count;
        } catch (e) {
            console.error('[Monitor] Error fetching status update count:', e.message);
            return 0;
        }
    }

    // --- Methods for the web UI (all async, fetch from DB) ---

    async getSummary() {
        const sampleCount = await this.db.collection(SAMPLES_COLLECTION).countDocuments();

        // Get the most recent sample
        const lastSamples = await this.db.collection(SAMPLES_COLLECTION)
            .find({})
            .sort({ elapsedMs: -1 })
            .limit(1)
            .toArray();
        const lastSample = lastSamples[0] || null;
        const elapsedSec = lastSample ? (lastSample.elapsedMs / 1000) : 0;

        // Get total status update count
        const statusUpdateCount = await this.db.collection(STATUS_COLLECTION).countDocuments();

        // Calculate average rates from all samples with non-zero deltas
        const allSamples = await this.db.collection(SAMPLES_COLLECTION)
            .find({})
            .sort({ elapsedMs: 1 })
            .toArray();

        const avgRates = {};
        const avgTimePerUnit = {};
        let totalDeltas = { files: 0, chunks: 0, candidates: 0, clones: 0 };
        let activeSamples = { files: 0, chunks: 0, candidates: 0, clones: 0 };

        for (const s of allSamples) {
            for (const coll of COLLECTIONS) {
                totalDeltas[coll] += s.deltas[coll] || 0;
                if (s.deltas[coll] > 0) activeSamples[coll]++;
            }
        }

        for (const coll of COLLECTIONS) {
            avgRates[coll] = activeSamples[coll] > 0
                ? (totalDeltas[coll] / (activeSamples[coll] * this.pollIntervalMs / 1000))
                : 0;
            // avg time per unit in µs
            avgTimePerUnit[coll] = activeSamples[coll] > 0
                ? (activeSamples[coll] * this.pollIntervalMs * 1000 / totalDeltas[coll])
                : 0;
        }

        return {
            sampleCount,
            elapsedSec: elapsedSec.toFixed(1),
            lastCounts: lastSample ? lastSample.counts : { files: 0, chunks: 0, candidates: 0, clones: 0 },
            avgRates,
            avgTimePerUnit,
            statusUpdateCount,
        };
    }

    async getSamples() {
        return await this.db.collection(SAMPLES_COLLECTION)
            .find({})
            .sort({ elapsedMs: 1 })
            .toArray();
    }

    async getRecentSamples(count) {
        return await this.db.collection(SAMPLES_COLLECTION)
            .find({})
            .sort({ elapsedMs: -1 })
            .limit(count)
            .toArray();
    }

    async getStatusUpdates(limit = 0) {
        const query = {};
        const options = { sort: { _id: -1 } };
        if (limit > 0) options.limit = limit;
        return await this.db.collection(STATUS_COLLECTION)
            .find(query, options)
            .toArray();
    }

    async getRecentStatusUpdates(count) {
        return await this.db.collection(STATUS_COLLECTION)
            .find({})
            .sort({ _id: -1 })
            .limit(count)
            .toArray();
    }

    // Export all collected data as a JSON string (for raw data export)
    async exportAll() {
        const samples = await this.getSamples();
        const statusUpdates = await this.getStatusUpdates();
        return JSON.stringify({
            startTime: this.startTime ? new Date(this.startTime).toISOString() : null,
            pollIntervalMs: this.pollIntervalMs,
            samples,
            statusUpdates,
        }, null, 2);
    }

    // Export samples as CSV (for raw data appendix in the report)
    async exportCSV() {
        const samples = await this.getSamples();
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

module.exports = Monitor;
