# Codebase Understanding & Assignment Plan

## Project Overview

This is the **Big Data Analytics** part of the "Applied Cloud Computing and Big Data" course (Blekinge Institute of Technology). The project performs clone detection on the **Qualitas Corpus** — a large collection of Java source code. There are two execution modes:

1. **Stream-of-Code** (`stream-of-code.yaml`): A Node.js/Express consumer receives files one-by-one from a bash generator, processes them in-memory, and detects clones. (`Containers/CodeStreamConsumer/`, `Containers/CodeStreamGenerator/`)
2. **All-at-Once** (`all-at-once.yaml`): A Clojure app (`cljDetector`) reads all `.java` files from the QualitasCorpus volume, chunks them, stores in MongoDB, identifies candidates via aggregation, then expands clones via iterative DB queries. (`Containers/cljdetector/`)

The assignment focuses on the **All-at-Once** path (cljDetector + MongoDB). Ignore Containers CodeStreamConsumer and CodeStreamGenerator, as development on these are not part of this assignment.

---

## Relevant Files

### cljDetector (Clojure) — `Containers/cljdetector/`

| File | Purpose |
|---|---|
| `src/cljdetector/core.clj` | Entry point (`-main`). Orchestrates: clear DB → read files → chunkify → store files → store chunks → identify candidates → expand clones → print statistics. Contains `ts-println` (the method we must modify). |
| `src/cljdetector/storage/storage.clj` | MongoDB layer using `monger`. Collections: `files`, `chunks`, `candidates`, `clones`. Key functions: `store-files!`, `store-chunks!`, `identify-candidates!` (Mongo aggregation pipeline), `get-one-candidate`, `get-overlapping-candidates`, `remove-overlapping-candidates!`, `store-clone!`, `clear-db!`, `count-items`, `print-statistics`. **We must add `addUpdate!` here.** |
| `src/cljdetector/process/source_processor.clj` | Reads files from disk, filters lines (comments/whitespace), creates sliding-window chunks of N lines, MD5-hashes each chunk. Key functions: `traverse-directory`, `chunkify`, `chunkify-file`, `process-lines`. |
| `src/cljdetector/process/expander.clj` | Clone expansion logic. Two implementations: `expand-clones-elegantly` (FP/in-memory) and `expand-clones` (DB-based "BoBoTW" approach). The DB approach loops: fetch one candidate → find overlapping candidates via aggregation → merge → remove processed → store clone → repeat. |
| `project.clj` | Leiningen project. Deps: Clojure 1.11.1, clj-commons/digest, monger (MongoDB client), slf4j-nop. |
| `Dockerfile` | `FROM clojure`, runs `lein run`. |

### Infrastructure / Deployment

| File | Purpose |
|---|---|
| `all-at-once.yaml` | Docker Compose: `clone-detector` (cljdetector) + `monitorTool` (MonitorTool) + `dbstorage` (MongoDB). Env: `DBHOST=dbstorage`, `SOURCEDIR=/QualitasCorpus`, `CHUNKSIZE=20`. MonitorTool depends on `dbstorage`, exposes port 8081, and receives `DBHOST=dbstorage`. |
| `stream-of-code.yaml` | Docker Compose for the stream-of-code variant (not relevant to this assignment). |
| `makefile` | Top-level targets: `cljDetector` (compose up), `mongodb`, `mongosh`, `corpusGet`, `corpusVolume`, etc. |
| `Containers/makefile` | Builds Docker images: `corpusGetter`, `codeStreamGenerator`, `codeStreamConsumer`, `cljDetector`, `monitorTool`. The `all` target builds all images. |
| `Containers/CorpusGetter/` | Bash script + Dockerfile to install/extract the Qualitas Corpus into a Docker volume. |
| `Data/` | Contains the two `.tar` files of the Qualitas Corpus (~3.5 GB total). |

---

## Architecture: All-at-Once cljDetector Pipeline

```
1. Clear DB (if "CLEAR" arg)
2. Read & Process Files:
   a. traverse-directory → finds all *.java files
   b. chunkify(chunkSize, files) → sliding window of N lines per file, MD5 hash each chunk
   c. store-files! → batch insert file contents into "files" collection
   d. store-chunks! → batch insert chunks into "chunks" collection
3. Identify Clone Candidates:
   a. identify-candidates! → Mongo aggregation: group by chunkHash, keep groups with >1 instance, $out to "candidates"
4. Expand Clones:
   a. expand-clones → loop: get-one-candidate → get-overlapping-candidates (aggregation) → merge → remove → store-clone → repeat
5. Print Statistics (counts of files, chunks, candidates, clones)
```

### Key Algorithmic Details (for report analysis)

- **Chunk generation** (`chunkify-file`): Sliding window. For a file with `L` content lines and chunk size `N`, it produces `L - N + 1` chunks (or 0 if `L < N`). Each chunk is hashed with MD5. This is O(L) per file, O(total_lines) overall. Time per chunk is **constant** (independent of how many chunks already exist) because it's pure computation per file with no DB interaction during chunkification.

- **Candidate identification** (`identify-candidates!`): Single MongoDB aggregation pipeline — `$group` by `chunkHash`, `$match` count > 1, `$out`. This is a one-shot batch operation; time depends on total chunks in DB but is done once.

- **Clone expansion** (`expand-clones`): Iterative DB-based approach. Each iteration: fetch one candidate → run aggregation to find overlapping candidates → merge → delete processed candidates → store clone → repeat. Each iteration involves a DB aggregation query over the `candidates` collection, which **shrinks** over time as candidates are removed. So per-iteration time may **decrease** as candidates are consumed, but the aggregation query scans fewer documents each time.

---

## TODO List

### Phase 1: Modify cljDetector (Clojure) — COMPLETED

- [x] **1.1** Implement `storage/addUpdate!` in `storage.clj` — inserts `{timestamp, message}` into the `statusUpdates` collection. Done: added `addUpdate!` function with try/catch so DB errors never break processing.
- [x] **1.2** Modify `core/ts-println` to call `storage/addUpdate!` with the timestamp and message (in addition to the existing `println`). Done: `ts-println` now generates a timestamp string, joins args into a message string, prints to terminal, and calls `storage/addUpdate!`.
- [x] **1.3** Add `"statusUpdates"` to the `collnames` vector in `storage.clj` so it's included in `clear-db!` and `print-statistics`. Done.
- [x] **1.4** Added fine-grained progress markers within processing steps:
  - `store-files!`: logs before starting (total files/batches) and after each batch insert (current count in DB).
  - `store-chunks!`: logs before starting (total chunks/batches) and after each batch insert (current count in DB).
  - `identify-candidates!`: logs before aggregation (chunk count) and after completion (candidate count).
  - `maybe-expand` (in `expander.clj`): logs after each clone is stored (clone # and remaining candidates).
- [x] **1.5** Rebuilt the cljdetector Docker image — build succeeded, all code compiles.

**Files modified (all marked with `;; [MONITORING]` comments):**
- `src/cljdetector/core.clj` — `ts-println` now writes to DB via `storage/addUpdate!`
- `src/cljdetector/storage/storage.clj` — added `addUpdate!`, added `statusUpdates` to `collnames`, added progress logging to `store-files!`, `store-chunks!`, `identify-candidates!`
- `src/cljdetector/process/expander.clj` — added progress logging to `maybe-expand`

### Phase 2: Implement MonitorTool (Docker Container)

- [x] **2.1** Choose programming language (recommend Node.js — matches existing CodeStreamConsumer patterns, has mongoose, easy web server + charts).
- [x] **2.2** Create `Containers/MonitorTool/` directory with: `Dockerfile`, `package.json`, `src/` (monitor script + web server).
- [x] **2.3** Implement DB polling: connect to MongoDB (`DBHOST` env), query counts of `files`, `chunks`, `candidates`, `clones` at regular intervals (e.g., every 5-10 seconds).
- [x] **2.4** Implement `statusUpdates` monitoring: fetch new statusUpdates since last check, display them.
- [x] **2.5** Calculate statistics: per-interval delta in counts → derive processing rate (units/sec) for each collection. Track cumulative time. Determine if rate is linear, exponential, etc.
- [x] **2.6** Implement visualization: web app with graphs (counts over time, processing rate over time, per-unit time trends). Can use SVG generation like CodeStreamConsumer or a charting library.
- [x] **2.7** Store collected statistics to a file or DB collection for later report extraction.
- [x] **2.8** Create Dockerfile for MonitorTool.

### Phase 3: Update Deployment

- [x] **3.1** Add `monitortool` build target to `Containers/makefile`.
- [x] **3.2** Add `monitortool` service to `all-at-once.yaml` — depends on `dbstorage`, sets `DBHOST=dbstorage`, exposes a port (e.g., 8081) for the web UI.
- [x] **3.3** Add `monitortool` to the `all` target in `Containers/makefile`.

### Phase 4: Run & Collect Statistics

- [ ] **4.1** Ensure Qualitas Corpus is loaded into the Docker volume (run `make corpusGet` if needed).
- [ ] **4.2** Run `make cljDetector` (or `docker compose -f all-at-once.yaml up`) on the full corpus.
- [ ] **4.3** Monitor via MonitorTool web UI — collect statistics throughout the run.
- [ ] **4.4** Export raw statistics data (first ~100 lines minimum).

### Phase 5: Analysis & Report

- [ ] **5.1** Determine: Can the entire Qualitas Corpus be processed? If not, identify failure points (data volume, storage limits, processing bottlenecks).
- [ ] **5.2** Analyze chunk generation time: constant or varying? Explain via algorithm (sliding window, per-file, no DB dependency → expect constant per chunk).
- [ ] **5.3** Analyze candidate identification time: constant or varying? Explain via aggregation algorithm (one-shot batch → depends on total chunks, done once).
- [ ] **5.4** Analyze clone expansion time: constant or varying? Explain via iterative DB approach (candidates shrink, aggregation over decreasing set → expect decreasing per-iteration time).
- [ ] **5.5** Calculate average clone size → use to predict expansion phase progress.
- [ ] **5.6** Calculate average chunks per file → use to predict read/chunkify/candidate stages progress.
- [ ] **5.7** Discuss whether trends are linear or exponential and why.
- [ ] **5.8** (Optional) Summarize the three performance antipatterns papers (Smith & Williams) — 1/2 page each.
- [ ] **5.9** Write the final report with all analysis, graphs, and raw data sample.

### Phase 6: Submission Preparation

- [ ] **6.1** Zip the entire `Containers/` folder (including modified cljdetector + MonitorTool).
- [ ] **6.2** Include the modified `all-at-once.yaml` in the submission.
- [ ] **6.3** Highlight all modifications made to cljDetector (use comments like `;; [MONITORING]` or a changelog/diff).
- [ ] **6.4** Include the report (PDF or document) with:
  - Summary of collected statistics
  - Answers to all analysis questions (with discussion)
  - Raw data sample (~100 lines) as appendix or linked
  - (Optional) Article summaries
- [ ] **6.5** Be prepared for a meeting to demo and explain:
  - Modifications to cljDetector
  - MonitorTool implementation
  - Collected statistics and implications
  - Possible future improvements

---

## Key Design Decisions (All Made)

1. **MonitorTool language**: Node.js chosen (matches CodeStreamConsumer patterns, `mongodb` driver available, easy SVG charts with no external frontend deps).

2. **Monitoring approach**: Poll MongoDB at fixed 5-second intervals. Calculate deltas between samples to derive per-unit processing times. Samples stored in-memory with JSON/CSV export endpoints.

3. **Statistics collection granularity**: Both approaches implemented:
   - (a) MonitorTool polls every 5s and infers timing from count deltas.
   - (b) cljDetector writes fine-grained progress markers to `statusUpdates` after each batch insert/clone expansion.

4. **Visualization**: Web app with inline SVG graphs (no external charting library). Routes: `/` (dashboard with counts + status), `/rates` (processing rates), `/timeperunit` (trend analysis), `/status` (all status updates), `/export/json`, `/export/csv`. Port 8081 to avoid conflict with cljDetector's 8080.

---

## cljDetector Modification Summary (for highlighting in submission)

All modifications are marked with `;; [MONITORING]` comments in the source code.

Files modified:
- `src/cljdetector/core.clj`:
  - `ts-println` — now generates a timestamp string, joins args into a message string, prints to terminal, and calls `storage/addUpdate!` to persist to the `statusUpdates` DB collection.
- `src/cljdetector/storage/storage.clj`:
  - `collnames` — added `"statusUpdates"` so it's included in `clear-db!` and `print-statistics`.
  - `addUpdate!` — new function: connects to MongoDB, inserts `{timestamp, message}` into `statusUpdates` collection. Wrapped in try/catch so DB errors never break processing.
  - `store-files!` — added progress logging: logs before starting (total files/batches) and after each batch insert (current count in DB).
  - `store-chunks!` — added progress logging: logs before starting (total chunks/batches) and after each batch insert (current count in DB).
  - `identify-candidates!` — added progress logging: logs before aggregation (chunk count) and after completion (candidate count).
- `src/cljdetector/process/expander.clj`:
  - `maybe-expand` — added progress logging: after each clone is stored, logs clone # and remaining candidate count.

Build verification: Docker image built successfully (`docker build -t cljdetector .`), `lein compile` exits with status 0 (no errors). All Clojure code compiles, dependencies resolve.

---

## Fixes Applied During Setup (Session 2026-11-05)

### 1. Containers/makefile — monitorTool directory case
- **Problem**: `monitorTool` target used `cd monitorTool` but the actual directory is `MonitorTool` (Linux is case-sensitive).
- **Fix**: Changed to `cd MonitorTool && docker build -t monitor-tool .`

### 2. MonitorTool Dockerfile — WORKDIR mismatch
- **Problem**: Dockerfile had `WORKDIR /app` but `all-at-once.yaml` mounts the source to `/usr/src/app`. The volume mount was ineffective — code changes wouldn't reflect in the container.
- **Fix**: Changed `WORKDIR /app` to `WORKDIR /usr/src/app`. Also removed unnecessary `RUN npm install -g nodemon` (not needed for production).

### 3. all-at-once.yaml — monitorTool service cleanup
- **Problem**: monitorTool had `command: clear` (this is a Node.js app, not the Clojure detector — `clear` is not a valid command), unused env vars (`SOURCEDIRtest`, `SOURCEDIReclipse`, `SOURCEDIR` — MonitorTool only needs `DBHOST`), an unnecessary `qc-volume` mount (MonitorTool doesn't read source files), and no `depends_on` for MongoDB.
- **Fix**: Removed `command: clear`, removed unused env vars, removed `qc-volume` volume mount, added `depends_on: [dbstorage]`.

### 4. cljdetector storage.clj — syntax error (missing closing paren)
- **Problem**: `mc/insert-batch` in `store-files!` was missing a closing paren — the monitoring `addUpdate!` call was inserted between `mc/insert-batch` and its closing `)`, causing "EOF while reading" at compile time.
- **Fix**: Added the missing `)` to close `mc/insert-batch` before the `addUpdate!` progress log.

### 5. cljdetector storage.clj — addUpdate! defined after first use
- **Problem**: `addUpdate!` was defined at the bottom of the file (line ~177) but called by `store-files!` at line ~37. Clojure compiles top-to-bottom, so the symbol was unresolvable ("Unable to resolve symbol: addUpdate!").
- **Fix**: Moved `addUpdate!` definition to right after `collnames` (before all functions that use it).

### 6. all-at-once.yaml — MonitorTool cannot find express module
- **Problem**: The bind mount `./Containers/MonitorTool:/usr/src/app` overwrites the container's `/usr/src/app` directory, including the `node_modules` installed during `docker build`. Since the host directory has no `node_modules`, Express (and all other npm dependencies) were missing at runtime, causing `Error: Cannot find module 'express'`.
- **Fix**: Added an anonymous volume `- /usr/src/app/node_modules` to the monitorTool service in `all-at-once.yaml`. This tells Docker to use the container's `node_modules` from the build layer instead of the bind-mounted host directory.

---

## Performance Fixes (Session 2026-11-06)

### Problem
File loading slowed from ~2,000 files/sec to 3.3 files/sec after ~20K files. A 163K file corpus that should load in ~5 minutes was taking 1.5+ hours and not completing.

### Root Causes (3 issues, all in monitoring code added in Phase 1)

#### 1. Connection leak in `addUpdate!` — thousands of leaked MongoDB connections
- **What**: `addUpdate!` called `(mg/connect {:host hostname})` every invocation, creating a new TCP connection to MongoDB that was never closed. Called after every batch insert (1,636 times for 163K files) plus from `ts-println` for every status message.
- **Impact**: MongoDB connection pool exhausted. Each leaked connection holds resources on both client and server. After 1,636+ leaked connections, MongoDB slows to a crawl responding to new connection requests.
- **Fix**: Replaced per-call `mg/connect` with a shared connection via Clojure `delay`: `(def ^:private shared-conn (delay (mg/connect {:host hostname})))`. All functions now use `(get-db)` which dereferences the delay once and reuses the connection.

#### 2. O(n²) `mc/count` calls in `store-files!` and `store-chunks!` — primary slowdown cause
- **What**: After each batch insert of 100 files, the code called `(mc/count db collname)` to log "total files in DB: N". In monger, `mc/count` calls MongoDB's `countDocuments()`, which does a **full collection scan** — it counts every document in the collection by scanning them all.
- **Impact**: After batch K (100K files stored), the count scans 100K documents. Total work: 100 + 200 + 300 + ... + 163,000 = **O(n²)**. After 42K files, each count scan takes long enough to dominate the batch insert time, dropping throughput from 2,000/s to 3.3/s.
- **Fix**: Replaced `(mc/count db collname)` with a **local counter** tracked via `loop/recur`: `(loop [batches file-parted stored 0] ... (recur (next batches) (+ stored batch-size)))`. The total is now computed in O(1) from the batch size, no DB query needed.

#### 3. Connection leak in `count-items` — same pattern
- **What**: `count-items` also opened a new `mg/connect` per call and never closed it. Called from `maybe-expand` in the expander (twice per clone iteration — once for "clones" count, once for "candidates" count).
- **Fix**: `count-items` now uses `(get-db)` (shared connection). `get-dbconnection` (used by expander) also returns the shared connection.

### What changed in `storage.clj`

| Before | After |
|---|---|
| Every function: `(let [conn (mg/connect ...) db (mg/get-db conn ...)] ...)` | All functions: `(let [db (get-db)] ...)` — shared connection via `delay` |
| `addUpdate!`: new `mg/connect` per call, never closed | `addUpdate!`: uses `(get-db)`, shared connection |
| `store-files!`: `(mc/count db collname)` after each batch (O(n²)) | `store-files!`: `doseq` + `atom` counter (O(1) per batch), skips failing batches |
| `store-chunks!`: `(mc/count db collname)` after each batch (O(n²)) + `(count all-chunks)` forced full lazy seq | `store-chunks!`: `doseq` + `atom` counter (O(1) per batch), no `count` on lazy seq |
| `count-items`: new `mg/connect` per call, never closed | `count-items`: uses `(get-db)`, shared connection |
| `get-dbconnection`: new `mg/connect` per call | `get-dbconnection`: returns shared connection |
| `print-statistics`, `clear-db!`, `store-clones!`, `identify-candidates!`, `consolidate-clones-and-source`: each opened own connection | All use `(get-db)`, shared connection |

### Verification
- `lein compile` exits 0 (no errors)
- Docker compose test: ~170 seconds, ~117K new files stored at consistent ~900 files/sec (4,000-5,900 files per 5s poll). No slowdown from t=37s through t=162s. Compare to before: slowed from 2,000/s to 3.3/s after 20K files.

### Fix 4: Infinite loop on failing batch in `store-files!`
- **Problem**: The initial fix used `loop/recur` with retry-on-failure: if `mc/insert-batch` threw an exception, it would `(recur batches stored)` — retrying the same batch forever. Some files exceed MongoDB's 16MB document limit (large generated Java files), causing the batch to always fail and the process to hang at exactly 117,700 files with 0 progress.
- **Fix**: Replaced `loop/recur` with `doseq` + `atom` counter. `doseq` always advances to the next batch regardless of exceptions (matching the original code's behavior of silently skipping failed batches). The atom tracks the running total for monitoring logs without any DB queries.

### Fix 5: Chunk storing hangs on `(count all-chunks)`
- **Problem**: The monitoring log in `store-chunks!` called `(count all-chunks)` and `(count chunk-parted)` before starting any inserts. `all-chunks` is a lazy seq produced by chunkifying 162K files with chunk size 20 — potentially millions of chunks. Calling `count` forces the entire lazy seq to be computed in memory before any storing begins, causing an apparent hang at 0 chunks after files complete.
- **Fix**: Removed the `(count all-chunks)` and `(count chunk-parted)` calls from the monitoring log. The log now just says "starting batch inserts" without a total count. Also switched `store-chunks!` from `loop/recur` to `doseq` + `atom` for consistency with `store-files!`.

### Updated Verification (Session 2026-11-06, Fix 4+5)
- `lein compile` exits 0 (no errors)
- Docker compose test: 162,896 files stored in ~175 seconds (~930 files/sec consistent, no slowdown). Files phase completed successfully. Chunks phase began immediately after files completed.
- Note: A small number of files that exceed MongoDB's 16MB document limit are silently skipped (same behavior as the original code).

---

## Assignment Compliance Audit

All modifications were checked against the assignment task list. Every changed file maps to a required task:

| Assignment Task | Files Modified | Status |
|---|---|---|
| Modify `core/ts-println` to call `storage/addUpdate!` | `src/cljdetector/core.clj` | ✅ Within scope |
| Implement `addUpdate!` in `storage.clj` + `statusUpdates` collection | `src/cljdetector/storage/storage.clj` | ✅ Within scope |
| Implement MonitorTool Docker container | `Containers/MonitorTool/` (Dockerfile, package.json, src/) | ✅ Within scope |
| Monitor DB: sample [files, chunks, candidates, clones] + statusUpdates | `Containers/MonitorTool/src/Monitor.js` | ✅ Within scope |
| Calculate statistics: processing time per unit, trends | `Containers/MonitorTool/src/Monitor.js` (rates, timePerUnit) | ✅ Within scope |
| Visualise statistics (web app with graphs) | `Containers/MonitorTool/src/index.js`, `Charts.js` | ✅ Within scope |
| Modify `all-at-once.yaml` so MonitorTool starts alongside cljDetector | `all-at-once.yaml` | ✅ Within scope |

**Files changed outside the task list (performance fixes in `storage.clj`):**

The `storage.clj` file was modified beyond the literal task requirements to fix three performance bugs that prevented the assignment from running at all. These fixes are:
1. Shared MongoDB connection (fixing connection leaks from `addUpdate!` and `count-items`)
2. Local counter replacing O(n²) `mc/count` calls in `store-files!` and `store-chunks!`
3. `doseq` + `atom` replacing `loop/recur` (fixing infinite loop on failing batches) and removing `(count all-chunks)` (fixing chunk storing hang)

These changes are all in `storage.clj`, the same file the assignment explicitly requires modifying for `addUpdate!`. They do not change any algorithms — only the implementation details of existing `store-files!`/`store-chunks!` functions (which are called by the pipeline but not listed as modification targets). The progress logging calls to `addUpdate!` added to these functions ARE part of the assignment task ("monitor the database and regularly update").

**No other files were modified outside the task list.**

---

## MongoDB OOM Crash Analysis (clojure-error.edn)

### What Happened
After ~2 hours, the cljDetector stored all 162,896 files and was storing chunks. It reached ~14,000,000 chunks when MongoDB was killed by the Linux OOM killer (exit code 137 = SIGKILL).

### Evidence
From `clojure-error.edn`:
- Error: `java.net.SocketException: Connection reset` during `mc/insert-batch` in `store_chunks_BANG_` (storage.clj:89)
- MongoDB connection was severed mid-write because mongod was killed

From kernel logs (`journalctl -k`):
```
Out of memory: Killed process 947512 (mongod) total-vm:9257280kB, anon-rss:5822904kB
```
- mongod was using 5.8GB of anonymous RSS memory when killed
- System has 15GB RAM total, swap was exhausted (510MB used out of 511MB)

### Root Cause
This is **not caused by any code modification** — it is an inherent limitation of the original architecture:

1. **Chunk volume**: 162,896 Java files with chunk size 20 produces ~14M+ chunks. Each chunk document contains `{fileName, startLine, endLine, chunkHash}` — small per document, but 14M documents is a large working set.

2. **MongoDB WiredTiger cache**: MongoDB's WiredTiger storage engine caches data in memory. With 14M chunk documents being inserted in rapid succession, the cache grows until mongod consumes all available RAM. No memory limit was set in `all-at-once.yaml` for the `dbstorage` service.

3. **No resource constraints**: The `dbstorage` service in `all-at-once.yaml` has no `mem_limit` or `deploy.resources` configuration. MongoDB defaults to using up to 50% of available RAM for its cache, but with 14M documents and concurrent insert/load operations, it exceeded this and the OS killed it.

4. **The original code has the same issue**: The original `store-chunks!` used `doseq` with `mc/insert-batch` — identical insertion pattern. The monitoring changes (addUpdate! calls, local counters) do not affect memory usage of MongoDB. The connection leak fixes actually *reduce* resource usage (fewer TCP connections).

### What Would Help (not implemented — outside assignment scope)
- Set `mem_limit` on the `dbstorage` service in `all-at-once.yaml` (Docker Compose resource constraint)
- Configure MongoDB `--wiredTigerCacheSizeGB` to a lower value (e.g., 2GB)
- Run on a machine with more RAM (16GB is borderline for 14M documents)
- Use a smaller `CHUNKSIZE` (fewer chunks but coarser clone detection)

### Conclusion
The MongoDB OOM crash is a resource limitation of the deployment environment, not a code bug from the assignment modifications. The original code would hit the same wall. The error is not something that can be fixed within the scope of the assignment tasks without modifying code outside the permitted areas (the chunk storage mechanism is part of the original pipeline, not a monitoring addition).

---

## Full OOM Analysis & Memory Limit Fix (Session 2026-11-06)

### Two OOM Events on Nov 06

Kernel logs (`journalctl -k --since "24 hours ago"`) show **two separate OOM kills**:

**Event 1 — Nov 06 14:52 — mongod killed (primary OOM)**
```
oom-kill:constraint=CONSTRAINT_NONE,global_oom,task=mongod,pid=947512
Out of memory: Killed process 947512 (mongod) total-vm:9257280kB, anon-rss:5822904kB
```
- mongod was using **5.8 GB RSS** when killed
- This is the same event documented above in the MongoDB OOM Crash Analysis section

**Event 2 — Nov 06 19:02 — VS Code killed (collateral damage)**
```
oom-kill:constraint=CONSTRAINT_NONE,global_oom,task=code,pid=100628
Out of memory: Killed process 100628 (code) total-vm:1522381176kB, anon-rss:562816kB, oom_score_adj:300
```
- VS Code was using only **550 MB RSS**, but had **1.45 TB virtual memory** allocated
- `oom_score_adj:300` — the kernel's OOM scorer gave VS Code the highest kill priority on the system
- The OOM was triggered by `watch_displays` (a KDE/Wayland display component), not by any container
- This was **collateral damage** from the same memory pressure that caused Event 1

### Root Cause

The system has **15 GB RAM + 511 MB swap**. MongoDB's WiredTiger storage engine defaults its cache to **~50% of available RAM = 7.25 GB** (confirmed: `db.serverStatus().wiredTiger.cache['maximum bytes configured']` = 7,786,725,376 bytes = 7.25 GB).

With no memory limits set in `all-at-once.yaml`, the containers compete freely for all 15 GB:

| Component | Memory Use | Source |
|---|---|---|
| MongoDB (WiredTiger cache + overhead) | up to 7.25 GB | Default cache = 50% of RAM |
| cljDetector (JVM heap + Clojure runtime) | ~1 GB | `docker stats` shows 1.07 GB |
| MonitorTool (Node.js) | ~50 MB | `docker stats` shows 53 MB |
| VS Code (editor + extensions) | ~550 MB RSS | OOM log |
| Linux OS + KDE/Wayland | ~2-3 GB | Typical desktop overhead |
| **Total demand** | **~11-12 GB minimum, up to 15+ GB** | Exceeds RAM + swap |

When the chunk count reached ~14M documents, MongoDB's cache filled toward its 7.25 GB limit. The combined memory demand exceeded 15 GB RAM + 511 MB swap, triggering the OOM killer. The first victim was mongod (5.8 GB, largest single process). Four hours later, after containers restarted (`restart: always` on dbstorage) and system memory pressure persisted, the OOM killer selected VS Code as the next victim due to its high `oom_score_adj:300`.

### Question: Did `make cljDetector` vs `docker compose -f all-at-once.yaml up` Cause the OOM?

**No. There is zero difference between the two commands.**

Verified with `make -n cljDetector`:
```
docker volume create qc-volume
docker compose -f all-at-once.yaml up
```

The makefile target `cljDetector` is a thin wrapper that runs `docker volume create qc-volume` followed by `docker compose -f all-at-once.yaml up`. Both commands launch the same containers with the same configuration from the same `all-at-once.yaml` file. The OOM would have occurred regardless of which command was used.

### Question: Should I Disable the OOM Killer or Use Memory Limits?

**Use memory limits. Disabling the OOM killer is the wrong approach.**

| Aspect | Disable OOM Killer | Memory Limits (Docker cgroups) |
|---|---|---|
| Does it fix the root cause? | No — MongoDB still consumes all RAM | Yes — each container is capped |
| What happens when RAM is exhausted? | System hard-freezes or kernel panics | Only the exceeding container is killed |
| Blast radius | Entire host (all processes) | Only the container that exceeded its limit |
| Portability | Not portable — requires host-level sysctl | Declarative — defined in docker-compose.yaml |
| Reversibility | Requires host reboot if system freezes | Container restarts, host stays up |
| Good engineering practice | No — masks the problem | Yes — proper resource sizing |

Disabling the OOM killer (`echo 1 > /proc/sys/vm/oom_kill_disable` or setting `vm.panic_on_oom`) would prevent the kernel from killing processes, but the underlying problem remains: total memory demand exceeds physical RAM. Instead of killing a process, the system would freeze entirely — far worse than losing one container.

### Implemented Fix: Memory Limits in all-at-once.yaml

Three changes were made to `all-at-once.yaml`:

**1. MongoDB: `mem_limit: 3g` + `--wiredTigerCacheSizeGB 2`**

The `--wiredTigerCacheSizeGB 2` flag tells MongoDB to cap its WiredTiger cache at 2 GB instead of the default 7.25 GB. The `mem_limit: 3g` Docker cgroup limit provides a hard ceiling — if MongoDB exceeds 3 GB (cache + connection overhead + WiredTiger internal structures), the OOM killer kills only the `dbstorage` container, not VS Code or the desktop.

**2. cljDetector: `mem_limit: 2g`**

The JVM typically uses ~1 GB. A 2 GB limit gives headroom while preventing the Clojure process from growing unbounded (e.g., if lazy sequences are realized in memory).

**3. MonitorTool: `mem_limit: 256m`**

MonitorTool is a lightweight Node.js app (~50 MB RSS). 256 MB is generous and prevents any heap growth from affecting the system.

**Total container memory budget: 2 + 0.25 + 3 = 5.25 GB**, leaving ~10 GB for the OS, desktop environment, VS Code, and other applications. This is well within the 15 GB RAM + 511 MB swap available.

### Updated all-at-once.yaml (key changes)

```yaml
services:
  clone-detector:
    # ... existing config ...
    mem_limit: 2g

  monitorTool:
    # ... existing config ...
    mem_limit: 256m

  dbstorage:
    image: mongo
    command: --quiet --syslog --wiredTigerCacheSizeGB 2
    # ... existing config ...
    mem_limit: 3g
```

Also removed the deprecated `version: "3.8"` field (Docker Compose v2+ ignores it and warns on stderr).

### Verification

- `docker compose -f all-at-once.yaml config --quiet` — exits 0, no errors or warnings
- `docker run --rm mongo --wiredTigerCacheSizeGB 2 --version` — MongoDB accepts the flag (v9.0.4)
- Memory budget: 5.25 GB containers + ~2 GB OS/desktop + ~1 GB VS Code = ~8.25 GB, well under 15 GB RAM

### What Happens If MongoDB Exceeds 3 GB?

With `--wiredTigerCacheSizeGB 2`, MongoDB should stay under 3 GB (2 GB cache + ~1 GB overhead). If it does exceed 3 GB due to connection overhead or unexpected WiredTiger growth, the Docker cgroup OOM killer kills only the `dbstorage` container. The `restart: always` policy restarts MongoDB, and cljDetector will get a connection error (the same `SocketException: Connection reset` seen in `clojure-error.edn`). VS Code and the desktop are not affected.

This is the correct trade-off: a single container may fail, but the host system and all other processes remain stable. Compare to the previous behavior where the kernel's global OOM killer could kill any process on the system — including VS Code or the display server.

---

## MonitorTool DB Persistence (Session 2026-11-06)

### Problem
MonitorTool stored all collected samples and status updates in-memory (JavaScript heap). During long-running monitoring sessions (hours), this accumulated thousands of sample objects and status updates in the Node.js heap, contributing to memory pressure on the system. Combined with MongoDB's memory usage, this could trigger OOM kills.

### Fix
Moved all sample and status update storage from in-memory heap to MongoDB collections:

**Monitor.js changes:**
- Samples are now persisted to a `monitorSamples` MongoDB collection via `insertOne()` on each poll, instead of pushed to an in-memory `this.samples` array
- Removed `this.samples = []`, `this.statusUpdates = []`, and `this.seenStatusIds = new Set()` — no in-memory accumulation
- `_fetchNewStatusUpdates()` replaced with `_fetchNewStatusCount()` — only counts new updates by querying DB with `_id: { $gt: lastStatusId }`, no in-memory dedup set
- `getSummary()`, `getSamples()`, `getStatusUpdates()`, `exportAll()`, `exportCSV()` are all now `async` and query the DB instead of reading from heap
- Added index on `monitorSamples.elapsedMs` for efficient sorting

**index.js changes:**
- All routes (`/`, `/rates`, `/timeperunit`, `/status`, `/export/json`, `/export/csv`) are now `async`
- All helper functions (`summaryBox`, `statusUpdatesHTML`, `buildCountsChart`, `buildRatesChart`, `buildTimePerUnitChart`) are now `async` and `await` the Monitor methods
- Added try/catch error handling on each route
- Status updates are fetched from the `statusUpdates` collection directly (sorted by `_id` descending, reversed for display)

**Memory impact:**
- Before: MonitorTool heap grew linearly with runtime (samples array + status updates array + dedup set)
- After: MonitorTool heap is constant regardless of runtime — all data lives in MongoDB

---

## Current Ready-to-Run State

### Docker Images
- `cljdetector:latest` — built and verified. `lein compile` exits 0.
- `monitor-tool:latest` — built and verified. Web server starts on port 3000 (container) / 8081 (host).

### Docker Volumes
- `qc-volume` — exists (external). Contains Qualitas Corpus if `make corpusGet` has been run.

### How to Run
```bash
# 1. Build images (if not already built)
cd Containers && make all

# 2. Ensure Qualitas Corpus is loaded (only needed once)
make corpusGet

# 3. Run the full pipeline (cljDetector + MonitorTool + MongoDB)
make cljDetector
# or: docker compose -f all-at-once.yaml up

# 4. Open MonitorTool web UI in browser
#    http://localhost:8081

# 5. Export collected statistics
#    http://localhost:8081/export/csv  (for CSV)
#    http://localhost:8081/export/json (for JSON)
```

### What Each Service Does
| Service | Image | Port | Memory Limit | Purpose |
|---|---|---|---|---|
| `dbstorage` | mongo | 27017 | 3g (WiredTiger cache: 2g) | MongoDB. Stores all collections: `files`, `chunks`, `candidates`, `clones`, `statusUpdates`. |

---

## Dashboard Redesign & Session Isolation (Session 2026-11-10)

### Problem
1. **Dashboard too tall**: The old dashboard had separate pages for counts, rates, and time-per-unit charts. You had to scroll and navigate between pages to see everything. The charts used time on the x-axis, not object count.
2. **Session data mixing**: MonitorTool's `monitorSamples` collection persisted across runs. When `make cljDetector` started a new run, old sample data remained in MongoDB. The dashboard mixed old and new session data, producing incorrect charts and statistics.
3. **No way to view previous session**: Once a new run started, the previous session's data was overwritten/lost. There was no mechanism to go back and view results from a prior run.

### Changes Made

#### 1. Dashboard Redesign — Single Page with 2x2 Chart Grid

**index.js** — Complete rewrite of the dashboard:
- All information on one page: summary box at top, 4 charts in a 2x2 grid, status updates below.
- Removed separate `/rates`, `/timeperunit`, and `/status` routes — everything is on `/`.
- Each chart shows one collection (files, chunks, candidates, clones):
  - **x-axis**: Objects stored (cumulative count of files/chunks/candidates/clones)
  - **y-axis**: Microseconds per object (µs/object) — time per unit converted from ms to µs for finer granularity
- Charts use `createSingleSeriesChart()` (460×340 SVG, no legend needed for single series).
- Mode badge at top shows whether viewing live data or archive data.
- Auto-refresh (10s) only in live mode; disabled in archive mode (static data).

**Charts.js** — Added configurable dimensions and single-series support:
- `createMultiSeriesChart()` now accepts `width`, `height`, and `legendPosition` params (`'right'`, `'bottom'`, or `'none'`).
- New `createSingleSeriesChart()` helper — wraps `createMultiSeriesChart` with a single series and `legendPosition: 'none'`. Defaults to 460×340 for the 2x2 grid.

**Monitor.js** — timePerUnit now stored in µs (was ms):
- `timePerUnit[coll] = (pollIntervalMs / deltas[coll]) * 1000` — converts ms/unit to µs/unit.
- `getSummary()` returns `avgTimePerUnit` in µs.

#### 2. Session Isolation — Archive Before Clear

**Monitor.js** — `_archivePreviousSession()` method:
- Called on `connect()`, before starting the polling loop.
- If `monitorSamples` or `statusUpdates` have existing data:
  1. Fetches all samples and status updates from MongoDB.
  2. Writes them to `/data/previous-session.json` (a JSON file on the `session-archive` volume).
  3. Drops the `monitorSamples` collection so the new session starts clean.
- If no existing data (first run), skips archiving silently.
- Errors during archiving are non-fatal — the monitor continues starting up.

**all-at-once.yaml** — Updated service ordering:
- `monitorTool` starts before `clone-detector` (clone-detector `depends_on: monitorTool`).
- This ensures MonitorTool connects to MongoDB and archives the previous session's data before cljDetector runs `clear` (which drops all collections).
- Added `session-archive` named volume, mounted at `/data` in the `monitorTool` service.
- Added `ARCHIVE_PATH=/data/previous-session.json` env var to monitorTool.

**Startup sequence:**
```
dbstorage starts → monitorTool starts (archives old data, drops monitorSamples) → clone-detector starts (clears all DB collections, begins processing)
```

Note: cljDetector's `clear` command drops `files`, `chunks`, `candidates`, `clones`, and `statusUpdates` — but NOT `monitorSamples` (that collection is only known to MonitorTool). MonitorTool handles dropping `monitorSamples` itself during archiving. This prevents any race between cljDetector's `clear` and MonitorTool's archive.

#### 3. Previous Session Viewer — `make viewPrevious`

**makefile** — New `viewPrevious` target:
```bash
make viewPrevious
```
Runs MonitorTool in archive mode:
```bash
docker run --rm -p 8082:3000 \
    -e ARCHIVE_FILE=/data/previous-session.json \
    -v session-archive:/data:ro \
    monitor-tool
```
- Reads the archived `previous-session.json` from the `session-archive` volume (read-only).
- Serves the same dashboard UI on port 8082 with static data from the archive.
- No MongoDB connection needed — `ArchiveDataSource` class loads from the JSON file.
- Mode badge shows "📋 ARCHIVE MODE — viewing previous session (static data)".
- Export endpoints (`/export/csv`, `/export/json`) work with the archived data.

**Files modified:**
- `Containers/MonitorTool/src/Charts.js` — configurable dimensions, `createSingleSeriesChart()`.
- `Containers/MonitorTool/src/Monitor.js` — `_archivePreviousSession()`, timePerUnit in µs.
- `Containers/MonitorTool/src/index.js` — complete rewrite: single-page dashboard, `ArchiveDataSource`, `LiveDataSource` abstraction, mode badge.
- `all-at-once.yaml` — `session-archive` volume, `ARCHIVE_PATH` env, service ordering (monitorTool before clone-detector).
- `makefile` — `viewPrevious` target.

### Verification
- `node -c` syntax check passes for all three JS files (via Docker node:18-alpine).
- `docker compose -f all-at-once.yaml config --quiet` exits 0 (valid compose file).
- `docker build -t monitor-tool .` succeeds.
- Archive mode tested end-to-end: created mock archive data, started container in archive mode, verified dashboard renders correctly (summary, 4 SVG charts, status updates), verified CSV/JSON exports work.
- `make -n viewPrevious` shows the correct docker run command.
| `clone-detector` | cljdetector | 8080 | 2g | Runs the Clojure clone detection pipeline. Writes progress to `statusUpdates` collection. |
| `monitorTool` | monitor-tool | 8081 | 256m | Polls MongoDB every 5s, shows live charts and status updates. Exports CSV/JSON. |
| `dbstorage` | mongo | 27017 | 3g (WiredTiger cache: 2g) | MongoDB. Stores all collections: `files`, `chunks`, `candidates`, `clones`, `statusUpdates`. |
