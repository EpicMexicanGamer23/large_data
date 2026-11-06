(ns cljdetector.storage.storage
  (:require [monger.core :as mg]
            [monger.collection :as mc]
            [monger.operators :refer :all]
            [monger.conversion :refer [from-db-object]]))

(def DEFAULT-DBHOST "localhost")
(def dbname "cloneDetector")
(def partition-size 100)
(def hostname (or (System/getenv "DBHOST") DEFAULT-DBHOST))
;; [MONITORING] Added "statusUpdates" to the list of collections
(def collnames ["files"  "chunks" "candidates" "clones" "statusUpdates"])

;; [PERF] Shared connection — created once via delay, reused everywhere.
;; The original monitoring code opened a new mg/connect per call (addUpdate!,
;; count-items, every store function) and never closed them, leaking thousands
;; of TCP connections to MongoDB and causing progressive slowdown from 2000/s to 3.3/s.
(def ^:private shared-conn (delay (mg/connect {:host hostname})))
(defn get-shared-conn [] @shared-conn)
(defn get-db [] (mg/get-db (get-shared-conn) dbname))

;; [MONITORING] addUpdate! — stores a timestamped status message in the statusUpdates collection.
;; Called by core/ts-println so all status updates are persisted to the database
;; and can be monitored from a separate process.
;; [PERF] Uses shared connection instead of opening a new one per call.
(defn addUpdate! [timestamp message]
  (try
    (mc/insert (get-db) "statusUpdates" {:timestamp timestamp :message message})
    (catch Exception e
      ;; Silently ignore DB errors so status logging never breaks processing
      nil)))

(defn print-statistics []
  (let [db (get-db)]
    (doseq [coll collnames]
      (println "db contains" (mc/count db coll) coll))))

(defn clear-db! []
  (let [db (get-db)]
    (doseq [coll collnames]
      (mc/drop db coll))))

;; [PERF] Uses shared connection. Original opened a new connection per call and never closed it.
(defn count-items [collname]
  (mc/count (get-db) collname))

(defn store-files! [files]
  (let [db (get-db)
        collname "files"
        file-parted (partition-all partition-size files)]
    ;; [MONITORING] Log total file count before storing
    (addUpdate! (.toString (java.time.LocalDateTime/now))
                (str "store-files: starting with " (count files) " files in "
                     (count file-parted) " batches"))
    ;; [PERF] Track count with a local counter instead of calling mc/count after
    ;; each batch. mc/count does a full collection scan (O(n) per call), making
    ;; the total O(n²) — this was the primary cause of slowdown from 2000/s to 3.3/s.
    (loop [batches file-parted
           stored 0]
      (when (seq batches)
        (let [batch (first batches)
              batch-size (count batch)
              success? (try (mc/insert-batch db collname (map (fn [f] {:fileName (.getPath f) :contents (slurp f)}) batch))
                            true
                            (catch Exception e false))]
          (if success?
            (do
              ;; [MONITORING] Log progress after each batch insert
              (let [total (+ stored batch-size)]
                (addUpdate! (.toString (java.time.LocalDateTime/now))
                            (str "store-files: stored batch, total files in DB: " total)))
              (recur (next batches) (+ stored batch-size)))
            ;; Re-run this batch if insert failed
            (recur batches stored)))))))

(defn store-chunks! [chunks]
  (let [db (get-db)
        collname "chunks"
        all-chunks (flatten chunks)
        chunk-parted (partition-all partition-size all-chunks)]
    ;; [MONITORING] Log total chunk count before storing
    (addUpdate! (.toString (java.time.LocalDateTime/now))
                (str "store-chunks: starting with " (count all-chunks) " chunks in "
                     (count chunk-parted) " batches"))
    ;; [PERF] Same O(n²) fix as store-files! — use a local counter instead of mc/count.
    (loop [batches chunk-parted
           stored 0]
      (when (seq batches)
        (let [batch (first batches)
              batch-size (count batch)]
          (mc/insert-batch db collname (map identity batch))
          ;; [MONITORING] Log progress after each batch insert
          (let [total (+ stored batch-size)]
            (addUpdate! (.toString (java.time.LocalDateTime/now))
                        (str "store-chunks: stored batch, total chunks in DB: " total)))
          (recur (next batches) (+ stored batch-size)))))))

(defn store-clones! [clones]
  (let [db (get-db)
        collname "clones"
        clones-parted (partition-all partition-size clones)]
    (doseq [clone-group clones-parted]
      (mc/insert-batch db collname (map identity clone-group)))))

(defn identify-candidates! []
  (let [db (get-db)
        collname "chunks"]
    ;; [MONITORING] Log before candidate identification
    (addUpdate! (.toString (java.time.LocalDateTime/now))
                (str "identify-candidates: starting aggregation over "
                     (mc/count db collname) " chunks"))
    (mc/aggregate db collname
                   [{$group {:_id {:chunkHash "$chunkHash"}
                             :numberOfInstances {$count {}}
                             :instances {$push {:fileName "$fileName"
                                                :startLine "$startLine"
                                                :endLine "$endLine"}}}}
                    {$match {:numberOfInstances {$gt 1}}}
                    {"$out" "candidates"} ])
    ;; [MONITORING] Log after candidate identification
    (addUpdate! (.toString (java.time.LocalDateTime/now))
                (str "identify-candidates: done, found "
                     (mc/count db "candidates") " candidates"))))


(defn consolidate-clones-and-source []
  (let [db (get-db)
        collname "clones"]
    (mc/aggregate db collname
                  [{$project {:_id 0 :instances "$instances" :sourcePosition {$first "$instances"}}}
                   {"$addFields" {:cloneLength {"$subtract" ["$sourcePosition.endLine" "$sourcePosition.startLine"]}}}
                   {$lookup
                    {:from "files"
                     :let {:sourceName "$sourcePosition.fileName"
                           :sourceStart {"$subtract" ["$sourcePosition.startLine" 1]}
                           :sourceLength "$cloneLength"}
                     :pipeline
                     [{$match {$expr {$eq ["$fileName" "$$sourceName"]}}}
                      {$project {:contents {"$split" ["$contents" "\n"]}}}
                      {$project {:contents {"$slice" ["$contents" "$$sourceStart" "$$sourceLength"]}}}
                      {$project
                       {:_id 0
                        :contents 
                        {"$reduce"
                         {:input "$contents"
                          :initialValue ""
                          :in {"$concat"
                               ["$$value"
                                {"$cond" [{"$eq" ["$$value", ""]}, "", "\n"]}
                                "$$this"]
                               }}}}}]
                     :as "sourceContents"}}
                   {$project {:_id 0 :instances 1 :contents "$sourceContents.contents"}}])))


;; [PERF] get-dbconnection now returns the shared connection.
;; The expander code uses this for its iterative loop — previously each call
;; to maybe-expand also called count-items which opened its own connection.
(defn get-dbconnection []
  (get-shared-conn))

(defn get-one-candidate [conn]
  (let [db (mg/get-db conn dbname)
        collname "candidates"]
    (from-db-object (mc/find-one db collname {}) true)))

(defn get-overlapping-candidates [conn candidate]
  (let [db (mg/get-db conn dbname)
        collname "candidates"
        clj-cand (from-db-object candidate true)]
    (mc/aggregate db collname
                  [{$match {"instances.fileName" {$all (map #(:fileName %) (:instances clj-cand))}}}
                   {$addFields {:candidate candidate}}
                   {$unwind "$instances"}
                   {$project 
                    {:matches
                     {$filter
                      {:input "$candidate.instances"
                       :cond {$and [{$eq ["$$this.fileName" "$instances.fileName"]}
                                    {$or [{$and [{$gt  ["$$this.startLine" "$instances.startLine"]}
                                                 {$lte ["$$this.startLine" "$instances.endLine"]}]}
                                          {$and [{$gt  ["$instances.startLine" "$$this.startLine"]}
                                                 {$lte ["$instances.startLine" "$$this.endLine"]}]}]}]}}}
                     :instances 1
                     :numberOfInstances 1
                     :candidate 1
                     }}
                   {$match {$expr {$gt [{$size "$matches"} 0]}}}
                   {$group {:_id "$_id"
                            :candidate {$first "$candidate"}
                            :numberOfInstances {$max "$numberOfInstances"}
                            :instances {$push "$instances"}}}
                   {$match {$expr {$eq [{$size "$candidate.instances"} "$numberOfInstances"]}}}
                   {$project {:_id 1 :numberOfInstances 1 :instances 1}}])))

(defn remove-overlapping-candidates! [conn candidates]
  (let [db (mg/get-db conn dbname)
        collname "candidates"]
      (mc/remove db collname {:_id {$in (map #(:_id %) candidates)}})))

(defn store-clone! [conn clone]
  (let [db (mg/get-db conn dbname)
        collname "clones"
        anonymous-clone (select-keys clone [:numberOfInstances :instances])]
    (mc/insert db collname anonymous-clone)))
