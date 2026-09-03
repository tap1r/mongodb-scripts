/*
 *  Name: "onlineDefrag.js"
 *  Version: "0.1.18"
 *  Description: "online compaction"
 *  Disclaimer: "https://raw.githubusercontent.com/tap1r/mongodb-scripts/master/DISCLAIMER.md"
 *  Authors: ["tap1r <luke.prochazka@gmail.com>"]
 *
 *  Legacy archive line: v0.1.4 is the snapshot for this script. mongosh-only
 *  (async IIFE, process/fs; incompatible with legacy mongo).
 *  Still the demarked version for the whole-tree freeze. Further feature
 *  work targets mongosh; see ROADMAP.md → Legacy mongo shell retirement.
 *
 *  Notes:
 *  - mongosh only. Do not top-level-await this IIFE (rewriter SyntaxError).
 *  - --eval must use var (not let/const). Do not declare dbName/collName/defragOptions
 *    in this file — IIFE const would shadow the overlay.
 *  - storage snapshots use mdblib $collStats (MDBLIB, ~/.mongodb, or cwd).
 *  - defragOptions.sampler: 'random' | 'adjacent' | 'bucketed' (default) | 'doubleParked'.
 *  - bucketed sampler streams _id-range batches (no $sort / $bucketAuto).
 *  - one pass: waves = docs / (batch × concurrency). Batch = max(actual fill, 90% target).
 *  - concurrency = min(reusable pages, dirty fill headroom). Dirty fill ~10% of
 *    cache so eviction can write ahead of checkpoint (do not change mongod
 *    eviction knobs; stay below ~20% trigger). M0: dirtyBudgetRatio × reusable.
 *  - do not start writes during a WT checkpoint; wait only while one is running.
 *  - after the last wave, wait for a checkpoint cycle before settled stats.
 *  - throttle when repl lag exceeds maxLagSeconds (rs.status, else lastWrite vs majority).
 *
 *  TODOs:
 *  - autotune pageFill (pageFillRatio / pageFillTarget) from settled collStats
 *    instead of a fixed 0.9 — next discussion
 *  - inter-wave pause on WT dirty / updates bytes instead of checkpoint status
 *  - AIMD dirtyBudgetRatio from settled density/reusable (stop ~10–20% reuse)
 *  - sampler 'doubleParked': first rewrite (may append), settle one checkpoint,
 *    rewrite the same _ids so they can consume the free list (prototype)
 *  - augmented pipeline: raise page occupancy here, then compact (or EOF
 *    rewrite) to relocate the geometric tail — compact cannot change density
 */

// Usage: mongosh [connection options] [--quiet] [-f|--file] </path/to/>onlineDefrag.js

/*
 *  Example:
 *    mongosh [connection options] --quiet --eval "var dbName = 'database', collName = 'collection';" [-f|--file] </path/to/>onlineDefrag.js
 *    mongosh [connection options] --quiet --eval "var dbName = 'database', collName = 'collection', defragOptions = { sampler: 'adjacent' };" [-f|--file] </path/to/>onlineDefrag.js
 *    mongosh [connection options] --quiet --eval "var dbName = 'database', collName = 'collection', defragOptions = { sampler: 'doubleParked' };" [-f|--file] </path/to/>onlineDefrag.js
 *
 *  We use 'var' to interoperate with mongosh's sloppy mode
 */

/*
 *  Load helper mdblib.js (https://github.com/tap1r/mongodb-scripts/blob/master/src/mdblib.js)
 *  Save libs to the $MDBLIB or other valid search path
 */

(() => {
   const __script = { "name": "onlineDefrag.js", "version": "0.1.18" };
   if (typeof __lib === 'undefined') {
      /*
       *  Load helper library mdblib.js
       */
      let __lib = { "name": "mdblib.js", "paths": null, "path": null };
      __lib.paths = [process.env.MDBLIB, `${process.env.HOME}/.mongodb`, '.'];
      __lib.path = `${__lib.paths.find(path => fs.existsSync(`${path}/${__lib.name}`))}/${__lib.name}`;
      load(__lib.path);
   }
   let __comment = `#### Running script ${__script.name} v${__script.version}`;
   __comment += ` with ${__lib.name} v${__lib.version}`;
   __comment += ` on shell v${version()}`;
   console.log(`\n\n[yellow]${__comment}[/]`);
})();

(async() => {
   const nsDb = typeof dbName === 'undefined' ? 'database' : dbName;
   const nsColl = typeof collName === 'undefined' ? 'collection' : collName;
   const namespace = db.getSiblingDB(nsDb).getCollection(nsColl);

   // Caller: var defragOptions = { ... } (--eval or REPL). Do not declare or assign it in this file.
   const userOptions = typeof defragOptions === 'undefined' ? {} : defragOptions;
   const {
      "sampler": sampler = 'bucketed', // 'random' | 'adjacent' | 'bucketed' | 'doubleParked'
      "pageFillRatio": pageFillRatio = 0.9, // dest leaf fill (WT spill threshold)
      "dirtyFillTarget": dirtyFillTarget = 0.10, // script cap (~10% cache); lets eviction flush, below ~20% trigger
      "dirtyBudgetRatio": dirtyBudgetRatio = 0.5, // fallback: fraction of reusable pages when cache stats are missing
      "maxConcurrent": maxConcurrent,
      "maxLagSeconds": maxLagSeconds = 10, // pause new batches when lag exceeds this
      "checkpointTimeoutMs": checkpointTimeoutMs
   } = userOptions;

   function collSnapshot() {
      const { indexes, ...stats } = $collStats(nsDb, nsColl) || {};
      return stats;
   }

   function sampleDims(sampleSize = 1, concurrentUpdates = 1) {
      const nBuckets = Math.max(1, Math.ceil(+concurrentUpdates) || 1);
      const pageSize = Math.max(1, Math.ceil(+sampleSize) || 1);
      return { "nBuckets": nBuckets, "pageSize": pageSize };
   }

   function aggOpts(comment, extra = {}) {
      return {
         "allowDiskUse": true,
         "readConcern": { "level": "local" },
         "comment": comment,
         ...extra
      };
   }

   function pageStats(stats = {}) {
      const {
         dataSize,
         storageSize,
         freeStorageSize,
         objects: documentCount,
         avgObjSize,
         dataPageSize: leafPageSize
      } = stats;
      const live = Math.max(0, (storageSize || 0) - (freeStorageSize || 0));
      const compression = live > 0 ? dataSize / live : 1;
      const dataPageSize = Number(leafPageSize) > 0 ? leafPageSize : 32 * 1024;
      const avg = +avgObjSize > 0 ? +avgObjSize : 1;
      const nPages = Math.max(1, Math.ceil(live / dataPageSize));
      const pageFillActual = Math.max(1, Math.ceil((documentCount || 0) / nPages));
      const pageFillTarget = Math.max(1, Math.ceil((pageFillRatio * dataPageSize * compression) / avg));
      const batchSize = Math.max(pageFillTarget, pageFillActual);

      return {
         "pageFillTarget": pageFillTarget,
         "pageFillActual": pageFillActual,
         "batchSize": batchSize,
         "documentCount": documentCount,
         "nPages": nPages,
         "dataPageSize": dataPageSize
      };
   }

   function dirtyFillPages(leaf) {
      const cache = serverStatus({ "wiredTiger": true }).wiredTiger?.cache;
      if (!cache) return null;
      const max = +cache['maximum bytes configured'];
      const dirty = +cache['tracked dirty bytes in the cache'];
      if (!(max > 0)) return null;
      // Do not change mongod eviction_dirty_*; only how much dirty we create.
      const frac = Math.min(+dirtyFillTarget || 0.10, 0.15);
      const headroom = max * frac - (Number.isFinite(dirty) ? dirty : 0);
      return Math.max(0, Math.floor(headroom / leaf));
   }

   function waveBatches(stats, dataPageSize) {
      // Reusable pages = hard cap (no file extend). Dirty fill = softer cap
      // so eviction can write during the wave; checkpoint still required to settle.
      const leaf = Number(dataPageSize) > 0 ? dataPageSize : 32 * 1024;
      const reusable = +stats.freeStorageSize;
      const reusablePages = Number.isFinite(reusable) && reusable > 0
                          ? Math.floor(reusable / leaf)
                          : null;
      const dirtyPages = dirtyFillPages(leaf);
      const dirtyCap = dirtyPages != null
                     ? dirtyPages
                     : (reusablePages == null ? null : Math.floor(reusablePages * dirtyBudgetRatio));
      let n;
      if (reusablePages == null && dirtyCap == null) n = 1;
      else if (reusablePages == null) n = dirtyCap;
      else if (dirtyCap == null) n = reusablePages;
      else n = Math.min(reusablePages, dirtyCap);
      if (Number(maxConcurrent) > 0) n = Math.min(n, Math.ceil(maxConcurrent));
      return Math.max(0, n);
   }

   async function* batchesFromCursor(cursor, batchSize = 1) {
      // Do not yield* the cursor: that emits one document per yield.
      // Do not yield the cursor object: batchSize is only a getMore hint.
      const size = Math.max(1, Math.ceil(+batchSize) || 1);
      let batch = [];
      try {
         for await (const doc of cursor) {
            batch.push(doc);
            if (batch.length >= size) {
               yield batch;
               batch = [];
            }
         }
         if (batch.length) yield batch;
      } finally {
         try { cursor.close(); } catch(_) { /* exhausted or already closed */ }
      }
   }

   async function* rndSample(sampleSize = 1, concurrentUpdates = 1) {
      const { nBuckets, pageSize } = sampleDims(sampleSize, concurrentUpdates);
      const pipeline = [
         { "$sample": { "size": nBuckets * pageSize } },
         { "$project": { "_id": 1 } }
      ];
      // $sample is blocking; after it completes, batch the cursor (do not toArray / await it).
      yield* batchesFromCursor(
         namespace.aggregate(pipeline, aggOpts("$sample technique", { "cursor": { "batchSize": pageSize } })),
         pageSize
      );
   }

   async function* adjacentSample(sampleSize = 1, concurrentUpdates = 1, sampleRate = 1) {
      const { nBuckets, pageSize } = sampleDims(sampleSize, concurrentUpdates);
      const seedCursor = namespace.aggregate([
         { "$sample": { "size": 1 } },
         { "$project": { "_id": 1 } }
      ], aggOpts("fetching seed _id via $sample", { "cursor": { "batchSize": 1 } }));
      let seed;
      try {
         for await (const doc of seedCursor) {
            seed = doc._id;
            break;
         }
      } finally {
         try { seedCursor.close(); } catch(_) { /* exhausted or already closed */ }
      }
      if (seed === undefined) return;
      const seeding = [
         { "$gte": seed },
         { "$lte": seed }
      ][Math.floor(Math.random() * 2)];
      const pipeline = [
         { "$match": { "_id": seeding } },
         { "$match": { "$sampleRate": sampleRate } },
         { "$limit": nBuckets * pageSize },
         { "$project": { "_id": 1 } }
      ];
      yield* batchesFromCursor(
         namespace.aggregate(pipeline, aggOpts("get neighbouring documents by _id/recordId", {
            "hint": { "$natural": -1 },
            "cursor": { "batchSize": pageSize }
         })),
         pageSize
      );
   }

   async function* bucketedIds(sampleSize = 1, concurrentUpdates = 1, sampleRate = 1) {
      // Stream page-sized batches from an _id range. No $sort / $bucketAuto /
      // $setWindowFields — those block (or semi-block) before the first yield.
      const { nBuckets, pageSize } = sampleDims(sampleSize, concurrentUpdates);
      const seedCursor = namespace.aggregate([
         { "$sample": { "size": 1 } },
         { "$project": { "_id": 1 } }
      ], aggOpts("bucketedIds seed _id", { "cursor": { "batchSize": 1 } }));
      let seed;
      try {
         for await (const doc of seedCursor) {
            seed = doc._id;
            break;
         }
      } finally {
         try { seedCursor.close(); } catch(_) { /* exhausted or already closed */ }
      }
      if (seed === undefined) return;
      const bound = Math.random() < 0.5 ? { "$gte": seed } : { "$lte": seed };
      const pipeline = [
         { "$match": { "_id": bound } },
         ...(sampleRate < 1 ? [{ "$match": { "$sampleRate": sampleRate } }] : []),
         { "$limit": nBuckets * pageSize },
         { "$project": { "_id": 1 } }
      ];
      yield* batchesFromCursor(
         namespace.aggregate(pipeline, aggOpts("bucketed _id batches", { "cursor": { "batchSize": pageSize } })),
         pageSize
      );
   }

   async function* getIds(sampleSize, concurrentUpdates, sampleRate) {
      switch (sampler) {
         case 'random':
            yield* rndSample(sampleSize, concurrentUpdates);
            break;
         case 'adjacent':
            yield* adjacentSample(sampleSize, concurrentUpdates, sampleRate);
            break;
         case 'bucketed':
         case 'doubleParked':
            yield* bucketedIds(sampleSize, concurrentUpdates, sampleRate);
            break;
         default:
            throw new Error(`unknown defragOptions.sampler "${sampler}" (use random|adjacent|bucketed|doubleParked)`);
      }
   }

   const bulkOpts = {
      "ordered": false // writeConcern belongs on the txn, not bulkWrite
   };
   const updatePipeline = [{ "$unset": "_id" }]; // leverages SERVER-36405
   const updateManyOpts = {
      "upsert": false, // must only update existing documents
      "hint": { "_id": 1 } // must force hint to avoid $expr collscan
   };

   async function rewriteIds(ids) {
      const session = db.getMongo().startSession({
         "readPreference": { "mode": "primary" },
         "causalConsistency": true
      });
      const coll = session.getDatabase(nsDb).getCollection(nsColl);
      try {
         await session.withTransaction(async() => {
            const { modifiedCount } = await coll.bulkWrite([{
               "updateMany": {
                  "filter": { "_id": { "$in": ids } },
                  "update": updatePipeline,
                  ...updateManyOpts
               }
            }], bulkOpts);
            console.log(`\tmodifiedCount: ${modifiedCount}`);
         }, {
            "readConcern": { "level": "local" },
            "writeConcern": { "w": 1, "j": false }, // ack in memory; rewrite is a no-op on data
            "comment": "online compacting updates"
         });
      } catch(error) {
         // console.log(`txn error:`, error);
         console.log(`\ttxn conflict detected, aborting op`);
      } finally {
         await session.endSession();
      }
   }

   function wtCheckpoint() {
      // WT-11171: v8+ wiredTiger.checkpoint; v7 wiredTiger.transaction.
      // mongos / Atlas M0/Flex / non-WT: no wiredTiger section.
      const { wiredTiger } = serverStatus({ "wiredTiger": true });
      if (wiredTiger == null) {
         return { "available": false, "running": false, "minTimeMS": null, "recentTimeMS": null };
      }
      const v8 = wiredTiger.checkpoint;
      const v7 = wiredTiger.transaction;
      return {
         "available": true,
         "running": (v8?.['progress state'] > 0) || (v7?.['transaction checkpoint currently running'] === 1),
         "minTimeMS": v8?.['min time (msecs)'] ?? v7?.['transaction checkpoint min time (msecs)'] ?? null,
         "recentTimeMS": v8?.['most recent time (msecs)'] ?? v7?.['transaction checkpoint most recent time (msecs)'] ?? null
      };
   }

   async function delay(ms) {
      await new Promise(resolve => setTimeout(resolve, ms));
   }

   function replLag() {
      // Prefer member optime spread; M0/Flex: replSetGetStatus is unsupported.
      try {
         const { members = [] } = db.adminCommand({ "replSetGetStatus": 1 });
         const dates = members.filter(({ health, stateStr }) =>
            health && (stateStr === 'PRIMARY' || stateStr === 'SECONDARY')
         ).map(({ optimeDate }) => optimeDate).filter(d => d != null);
         if (dates.length >= 2) {
            return {
               "available": true,
               "lagSeconds": Math.max(0, (Math.max(...dates) - Math.min(...dates)) / 1000),
               "source": "replSetGetStatus"
            };
         }
      } catch(_) { /* M0/Flex / unauthorized */ }
      const { lastWrite } = serverStatus({ "repl": true }).repl || {};
      const last = lastWrite?.lastWriteDate;
      const maj = lastWrite?.majorityWriteDate;
      if (last == null || maj == null) {
         return { "available": false, "lagSeconds": 0, "source": null };
      }
      return {
         "available": true,
         "lagSeconds": Math.max(0, (new Date(last) - new Date(maj)) / 1000),
         "source": "lastWrite"
      };
   }

   let lagSkipLogged = false;
   async function waitForReplLag() {
      const cap = Number(maxLagSeconds) > 0 ? +maxLagSeconds : 10;
      let { available, lagSeconds, source } = replLag();
      if (!available) {
         if (!lagSkipLogged) {
            console.log('repl lag metrics unavailable, skipping lag throttle');
            lagSkipLogged = true;
         }
         return;
      }
      if (lagSeconds <= cap) return;
      const timeoutMs = Number(checkpointTimeoutMs) > 0 ? +checkpointTimeoutMs : 120000;
      const deadline = Date.now() + timeoutMs;
      console.log(`repl lag ${lagSeconds.toFixed(1)}s via ${source} > ${cap}s, throttling...`);
      do {
         await delay(Math.min(1000, Math.max(1, deadline - Date.now())));
         ({ available, lagSeconds, source } = replLag());
         if (!available) return;
      } while (lagSeconds > cap && Date.now() < deadline);
      if (lagSeconds > cap) {
         console.log(`repl lag still ${lagSeconds.toFixed(1)}s after throttle timeout, continuing`);
      } else {
         console.log(`repl lag ${lagSeconds.toFixed(1)}s via ${source}, resuming`);
      }
   }

   let ckptSkipLogged = false;
   async function waitForCheckpoint({ settle = false } = {}) {
      // settle=false: wait only while a checkpoint is already running.
      // settle=true: wait for a falling edge (start+complete if idle) so
      // block-manager reusable bytes are visible in collStats.
      let { available, running, minTimeMS, recentTimeMS } = wtCheckpoint();
      if (!available) {
         if (!ckptSkipLogged) {
            console.log('checkpoint metrics unavailable (no wiredTiger in serverStatus), skipping wait');
            ckptSkipLogged = true;
         }
         return;
      }
      if (!settle && !running) return;
      const pollMs = Math.max(1, Math.ceil(0.9 * (minTimeMS || 1000)));
      const timeoutMs = Number(checkpointTimeoutMs) > 0
                      ? +checkpointTimeoutMs
                      : Math.max(120000, 2 * (recentTimeMS || minTimeMS || 0));
      const deadline = Date.now() + timeoutMs;
      if (running) {
         console.log(`checkpoint running, waiting to complete (timeout ${timeoutMs}ms)...`);
      } else {
         console.log(`waiting for checkpoint to start and complete (settled stats, timeout ${timeoutMs}ms)...`);
      }
      let completed = false;
      do {
         const wasRunning = running;
         await delay(Math.min(pollMs, Math.max(1, deadline - Date.now())));
         ({ running } = wtCheckpoint());
         if (wasRunning && !running) completed = true;
      } while ((running || (settle && !completed)) && Date.now() < deadline);
      console.log(completed ? 'checkpoint completed' : 'checkpoint wait timed out, continuing');
   }

   async function main() {
      let snap = collSnapshot();
      const fill0 = pageStats(snap);
      const nBatches0 = waveBatches(snap, fill0.dataPageSize);
      const batch0 = fill0.batchSize || 1;
      const docsPerWave = Math.max(1, batch0 * Math.max(1, nBatches0));
      const maxWaves = Math.max(1, Math.ceil((fill0.documentCount || 0) / docsPerWave));

      console.log(`sampler: ${sampler}`);
      console.log(`pages: ${fill0.nPages} actualFill ${fill0.pageFillActual} targetFill ${fill0.pageFillTarget} batch ${batch0}`);
      console.log(`waves: ${maxWaves} (docs ${fill0.documentCount} / (batch ${batch0} * concurrency ${Math.max(1, nBatches0)}))`);
      console.log(EJSON.stringify({ "state": "initial storage", ...snap }));
      let didWork = false;
      for (let wave = 1; wave <= maxWaves; ++wave) {
         const fill = pageStats(snap);
         const sampleSize = fill.batchSize;
         const sampleRate = 1 / fill.pageFillActual;
         const nBatches = waveBatches(snap, fill.dataPageSize);
         if (nBatches < 1) {
            console.log('no reusable/dirty budget without extending the file, stopping');
            break;
         }
         console.log(`wave ${wave}/${maxWaves} batches ${nBatches} batchSize ${sampleSize} actualFill ${fill.pageFillActual} targetFill ${fill.pageFillTarget} reusable ${snap.freeStorageSize}`);
         await waitForCheckpoint();
         let tasks = [];
         let update = 0;
         const parked = [];
         for await (const ids of getIds(sampleSize, nBatches, sampleRate)) {
            const updateOneIds = ids.map(id => id._id);
            if (!updateOneIds.length) continue;
            parked.push(updateOneIds);
            await waitForCheckpoint();
            await waitForReplLag();
            ++update;
            console.log(`\tforking concurrent update ${update} with ${updateOneIds.length} IDs`);
            tasks.push(rewriteIds(updateOneIds));
         }
         await Promise.allSettled(tasks);
         if (update > 0) didWork = true;
         console.log(EJSON.stringify({ "state": "volatile storage", ...collSnapshot() }));
         if (sampler === 'doubleParked' && parked.length) {
            console.log(`doubleParked settle then replay ${parked.length} batches`);
            await waitForCheckpoint({ "settle": true });
            await waitForReplLag();
            const replayTasks = [];
            let replay = 0;
            for (const ids of parked) {
               await waitForCheckpoint();
               await waitForReplLag();
               ++replay;
               console.log(`\tforking doubleParked replay ${replay} with ${ids.length} IDs`);
               replayTasks.push(rewriteIds(ids));
            }
            await Promise.allSettled(replayTasks);
            console.log(EJSON.stringify({ "state": "volatile storage (replay)", ...collSnapshot() }));
         }
         await waitForCheckpoint();
         await waitForReplLag();
         snap = collSnapshot();
      }
      if (didWork) {
         await waitForCheckpoint({ "settle": true });
         await waitForReplLag();
         console.log(EJSON.stringify({ "state": "settled storage", ...collSnapshot() }));
      }
   }

   try {
      await main();
   } catch(e) {
      console.log('[red][ERROR][/]', e.errmsg || e.message || String(e));
      throw e;
   }
})();

// EOF
