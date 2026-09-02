/*
 *  Name: "onlineDefrag.js"
 *  Version: "0.1.13"
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
 *  - defragOptions.sampler: 'random' | 'adjacent' | 'bucketed' (default).
 *  - bucketed sampler streams _id-range batches (no $sort / $bucketAuto).
 *  - each wave dirties at most dirtyBudgetRatio of current reusable bytes, then checkpoints.
 *  - throttle when repl lag exceeds maxLagSeconds (rs.status, else lastWrite vs majority).
 */

// Usage: mongosh [connection options] [--quiet] [-f|--file] </path/to/>onlineDefrag.js

/*
 *  Example:
 *    mongosh [connection options] --quiet --eval "var dbName = 'database', collName = 'collection';" [-f|--file] </path/to/>onlineDefrag.js
 *    mongosh [connection options] --quiet --eval "var dbName = 'database', collName = 'collection', defragOptions = { sampler: 'adjacent' };" [-f|--file] </path/to/>onlineDefrag.js
 *
 *  We use 'var' to interoperate with mongosh's sloppy mode
 */

/*
 *  Load helper mdblib.js (https://github.com/tap1r/mongodb-scripts/blob/master/src/mdblib.js)
 *  Save libs to the $MDBLIB or other valid search path
 */

(() => {
   const __script = { "name": "onlineDefrag.js", "version": "0.1.13" };
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
      "sampler": sampler = 'bucketed', // 'random' | 'adjacent' | 'bucketed'
      "pageFillRatio": pageFillRatio = 0.9,
      "concurrentUpdatesRatio": concurrentUpdatesRatio = 0.005,
      "totalUpdatesRatio": totalUpdatesRatio = 2,
      "dirtyBudgetRatio": dirtyBudgetRatio = 0.5, // max fraction of reusable bytes dirtied per wave
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
      return { "nBuckets": nBuckets, "pageSize": pageSize, "sampleN": Math.max(nBuckets * pageSize, nBuckets) };
   }

   function aggOpts(comment, extra = {}) {
      return {
         "allowDiskUse": true,
         "readConcern": { "level": "local" },
         "comment": comment,
         ...extra
      };
   }

   function pageStats(
         stats = {},
         pageFillRatio = 0.9, // 0.9 (default page fill ratio)
         concurrentUpdatesRatio = 0.01, // needs to be limited to a portion of reusableBytes target ~1%
         totalUpdatesRatio = 0.2 // 20% pass
      ) {
      const {
         dataSize,
         storageSize,
         freeStorageSize,
         objects: documentCount,
         avgObjSize,
         dataPageSize: leafPageSize
      } = stats;
      const compression = dataSize / (storageSize - freeStorageSize);
      const dataPageSize = Number(leafPageSize) > 0 ? leafPageSize : 32 * 1024;
      const pageFillTarget = Math.ceil((pageFillRatio * dataPageSize * compression) / avgObjSize);
      const pageFillActual = Math.ceil((0.9 * dataPageSize * compression) / avgObjSize);
      const estimatedDataPageCount = Math.ceil(documentCount / pageFillActual);
      const concurrentUpdates = Math.ceil(estimatedDataPageCount * concurrentUpdatesRatio);
      const iterations = Math.ceil(totalUpdatesRatio / concurrentUpdatesRatio);

      return {
         "pageFillTarget": pageFillTarget,
         "documentCount": documentCount,
         "concurrentUpdates": concurrentUpdates,
         "iterations": iterations,
         "pageFillActual": pageFillActual,
         "estimatedDataPageCount": estimatedDataPageCount,
         "dataPageSize": dataPageSize
      };
   }

   function waveBatches(stats, dataPageSize, concurrencyCap) {
      // Stay inside existing reusable bytes so WT does not extend the file.
      const reusable = +stats.freeStorageSize;
      const leaf = Number(dataPageSize) > 0 ? dataPageSize : 32 * 1024;
      const cap = Math.max(1, Math.ceil(+concurrencyCap) || 1);
      if (!Number.isFinite(reusable)) return cap; // reuse hidden (e.g. some Atlas tiers)
      if (reusable <= 0) return 0;
      const n = Math.floor((reusable * dirtyBudgetRatio) / leaf);
      return Math.max(0, Math.min(n, cap));
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
            yield* bucketedIds(sampleSize, concurrentUpdates, sampleRate);
            break;
         default:
            throw new Error(`unknown defragOptions.sampler "${sampler}" (use random|adjacent|bucketed)`);
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

   function waitForCheckpoint() {
      let { available, running, minTimeMS, recentTimeMS } = wtCheckpoint();
      if (!available) {
         console.log('checkpoint metrics unavailable (no wiredTiger in serverStatus), skipping wait');
         return;
      }
      const pollMs = Math.max(1, Math.ceil(0.9 * (minTimeMS || 1000)));
      const timeoutMs = Number(checkpointTimeoutMs) > 0
                      ? +checkpointTimeoutMs
                      : Math.max(120000, 2 * (recentTimeMS || minTimeMS || 0));
      const deadline = Date.now() + timeoutMs;
      if (running) {
         console.log(`checkpoint running, waiting to complete (timeout ${timeoutMs}ms)...`);
      } else {
         console.log(`waiting for checkpoint to start and complete (timeout ${timeoutMs}ms)...`);
      }
      let completed = false;
      do {
         const wasRunning = running;
         sleep(Math.min(pollMs, Math.max(1, deadline - Date.now())));
         ({ running } = wtCheckpoint());
         if (wasRunning && !running) completed = true;
      } while ((running || !completed) && Date.now() < deadline);
      console.log(completed ? 'checkpoint completed' : 'checkpoint wait timed out, continuing');
   }

   async function main() {
      let snap = collSnapshot();
      const {
         iterations = 1,
         concurrentUpdates: concurrencyCap = 1,
         estimatedDataPageCount = 0
      } = pageStats(snap, pageFillRatio, concurrentUpdatesRatio, totalUpdatesRatio);
      const targetPages = Math.max(1, Math.ceil((estimatedDataPageCount || 1) * totalUpdatesRatio));
      const maxWaves = Math.max(1, iterations);

      console.log(`sampler: ${sampler}`);
      console.log(EJSON.stringify({ "state": "initial storage", ...snap }));
      let pagesDone = 0;
      for (let wave = 1; wave <= maxWaves && pagesDone < targetPages; ++wave) {
         const fill = pageStats(snap, pageFillRatio, concurrentUpdatesRatio, totalUpdatesRatio);
         const sampleSize = fill.pageFillTarget;
         const sampleRate = 1 / fill.pageFillActual;
         const nBatches = waveBatches(snap, fill.dataPageSize, Number(maxConcurrent) > 0 ? maxConcurrent : concurrencyCap);
         if (nBatches < 1) {
            console.log('reusable-byte budget is empty; further rewrites would extend the file, stopping');
            break;
         }
         console.log(`wave ${wave} batches ${nBatches} pageFillTarget ${sampleSize} sampleRate 1/${fill.pageFillActual} reusable ${snap.freeStorageSize} dirtyBudgetRatio ${dirtyBudgetRatio}`);
         let tasks = [];
         let update = 0;
         for await (const ids of getIds(sampleSize, nBatches, sampleRate)) {
            const updateOneIds = ids.map(id => id._id);
            if (!updateOneIds.length) continue;
            await waitForReplLag();
            ++update;
            console.log(`\tforking concurrent update ${update} with ${updateOneIds.length} IDs`);
            tasks.push(rewriteIds(updateOneIds));
         }
         await Promise.allSettled(tasks);
         pagesDone += update;
         console.log(EJSON.stringify({ "state": "volatile storage", ...collSnapshot() }));
         waitForCheckpoint();
         await waitForReplLag();
         snap = collSnapshot();
         console.log(EJSON.stringify({ "state": "settled storage", ...snap }));
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
