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
 *   - Time per unit (ms per new item) for each collection
 *   - Cumulative elapsed time
 *
 * Stores all samples in-memory and provides methods for the web UI to query.
 */

const { MongoClient } = require('mongodb');

const DB_NAME = 'cloneDetector';
const COLLECTIONS = ['files', 'chunks', 'candidates', 'clones'];
const STATUS_COLLECTION = 'statusUpdates';

class Monitor {
    constructor(dbHost, pollIntervalMs) {
        this.dbHost = dbHost || 'localhost';
        this.pollIntervalMs = pollIntervalMs || 5000;
        this.client = null;
        this.db = null;

        // All collected samples — each sample is a snapshot at a point in time
        this.samples = [];

        // All status updates collected so far (deduplicated by _id)
        this.statusUpdates = [];
        this.seenStatusIds = new Set();

        // Track the start time of monitoring
        this.startTime = null;

        // Track last seen counts for delta calculation
        this.lastCounts = { files: 0, chunks: 0, candidates: 0, clones: 0 };

        this.timer = null;
        this.running = false;
    }

    async connect() {
        const url = `mongodb://${this.dbHost}:27017`;
        this.client = new MongoClient(url, { serverSelectionTimeoutMS: 5000 });
        await this.client.connect();
        this.db = this.client.db(DB_NAME);
        console.log(`[Monitor] Connected to MongoDB at ${url}/${DB_NAME}`);
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

        // Calculate processing rate (units/sec) and time per unit (ms/unit) for this interval
        const intervalSeconds = this.pollIntervalMs / 1000;
        const rates = {};
        const timePerUnit = {};
        for (const coll of COLLECTIONS) {
            if (deltas[coll] > 0) {
                rates[coll] = deltas[coll] / intervalSeconds;
                timePerUnit[coll] = this.pollIntervalMs / deltas[coll];
            } else {
                rates[coll] = 0;
                timePerUnit[coll] = 0;
            }
        }

        // Fetch new status updates
        const newUpdates = await this._fetchNewStatusUpdates();

        // Build the sample object
        const sample = {
            timestamp: new Date(now).toISOString(),
            elapsedMs: elapsedMs,
            counts: { ...counts },
            deltas: { ...deltas },
            rates: { ...rates },
            timePerUnit: { ...timePerUnit },
            newStatusCount: newUpdates.length,
        };
        this.samples.push(sample);
        this.lastCounts = { ...counts };

        // Log to console for text-only monitoring
        const countStr = COLLECTIONS.map(c => `${c}=${counts[c]}`).join(' ');
        const deltaStr = COLLECTIONS.map(c => `d${c}=${deltas[c] >= 0 ? '+' : ''}${deltas[c]}`).join(' ');
        console.log(`[Monitor] t=${(elapsedMs / 1000).toFixed(1)}s | ${countStr} | ${deltaStr}` +
            (newUpdates.length > 0 ? ` | ${newUpdates.length} new status updates` : ''));

        return sample;
    }

    async _fetchNewStatusUpdates() {
        try {
            // Fetch status updates sorted by _id (ObjectId embeds timestamp, so roughly chronological)
            const cursor = this.db.collection(STATUS_COLLECTION)
                .find({})
                .sort({ _id: 1 })
                .limit(1000);

            const allUpdates = await cursor.toArray();
            const newOnes = [];

            for (const update of allUpdates) {
                const idStr = update._id.toString();
                if (!this.seenStatusIds.has(idStr)) {
                    this.seenStatusIds.add(idStr);
                    // Store the new status update
                    newOnes.push({
                        _id: idStr,
                        timestamp: update.timestamp,
                        message: update.message,
                    });
                    // Also add to the main statusUpdates array for UI access
                    this.statusUpdates.push({
                        _id: idStr,
                        timestamp: update.timestamp,
                        message: update.message,
                    });
                }
            }
            return newOnes;
        } catch (e) {
            console.error('[Monitor] Error fetching status updates:', e.message);
            return [];
        }
    }

    // --- Methods for the web UI ---

    getSummary() {
        const sampleCount = this.samples.length;
        const lastSample = this.samples[sampleCount - 1] || null;
        const elapsedSec = lastSample ? (lastSample.elapsedMs / 1000) : 0;

        // Calculate average rates (only from samples that have non-zero deltas)
        const avgRates = {};
        const avgTimePerUnit = {};
        let totalDeltas = { files: 0, chunks: 0, candidates: 0, clones: 0 };
        let activeSamples = { files: 0, chunks: 0, candidates: 0, clones: 0 };

        for (const s of this.samples) {
            for (const coll of COLLECTIONS) {
                totalDeltas[coll] += s.deltas[coll] || 0;
                if (s.deltas[coll] > 0) activeSamples[coll]++;
            }
        }

        for (const coll of COLLECTIONS) {
            avgRates[coll] = activeSamples[coll] > 0
                ? (totalDeltas[coll] / (activeSamples[coll] * this.pollIntervalMs / 1000))
                : 0;
            avgTimePerUnit[coll] = activeSamples[coll] > 0
                ? (activeSamples[coll] * this.pollIntervalMs / totalDeltas[coll])
                : 0;
        }

        return {
            sampleCount,
            elapsedSec: elapsedSec.toFixed(1),
            lastCounts: lastSample ? lastSample.counts : { files: 0, chunks: 0, candidates: 0, clones: 0 },
            avgRates,
            avgTimePerUnit,
            statusUpdateCount: this.statusUpdates.length,
        };
    }

    getSamples() {
        return this.samples;
    }

    getRecentSamples(count) {
        return this.samples.slice(-count);
    }

    getStatusUpdates() {
        return this.statusUpdates;
    }

    getRecentStatusUpdates(count) {
        return this.statusUpdates.slice(-count);
    }

    // Export all collected data as a JSON string (for raw data export)
    exportAll() {
        return JSON.stringify({
            startTime: this.startTime ? new Date(this.startTime).toISOString() : null,
            pollIntervalMs: this.pollIntervalMs,
            samples: this.samples,
            statusUpdates: this.statusUpdates,
        }, null, 2);
    }

    // Export samples as CSV (for raw data appendix in the report)
    exportCSV() {
        const header = 'sample,timestamp,elapsedMs,files,chunks,candidates,clones,' +
            'd_files,d_chunks,d_candidates,d_clones,' +
            'rate_files,rate_chunks,rate_candidates,rate_clones,' +
            'tpu_files,tpu_chunks,tpu_candidates,tpu_clones\n';
        const rows = this.samples.map((s, i) => {
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
