(ns cljdetector.core-test
  (:require [clojure.test :refer :all]
            [cljdetector.core :refer :all]
            [cljdetector.storage.storage :as storage]))

(deftest a-test
  (testing "FIXME, I fail."
    (is (= 0 1))))

(deftest ts-println-persists-timestamp-and-message
  (let [update (atom nil)]
    (with-redefs [storage/addUpdate! #(reset! update %)]
      (with-out-str (ts-println "Found" 3 "candidates")))
    (is (re-matches #"\d{4}-\d{2}-\d{2}T.*" (:timestamp @update)))
    (is (= "Found 3 candidates" (:message @update)))))
