/*
 *  Name: "onlineDefrag.js"
 *  Version: "0.5.5"
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
 *  - defragOptions.sampler: 'random' | 'adjacent' | 'bucketed' (default) | 'doubleParked'
 *  - defragOptions.strategy: 'waves' (default) | 'meetInMiddle' | 'lowStressMode' |
 *    'updateOne' | 'slidingShuffle' | 'slidingWindow' | 'quantile' | 'rndQuantile' |
 *    'shapeQuantile' | 'doubleParked' | 'naturalWindow' | 'naturalReply'
 *    (alias: naturalReplay → naturalReply)
 *  - defragOptions.writeConcurrency: in-flight rewrite txns (default 8).
 *    concurrentUpdates is an alias when writeConcurrency is omitted.
 *  - defragOptions.ignoreCheckpoint: skip checkpoint waits; $collStats is
 *    fetched without blocking and applied on the next write round. Calibrate
 *    still settles. Reusable/R caps and doubleParked replay use stale stats.
 *  - Settle waits try {fsync:1, lock:false} so we do not sit out a 60s
 *    checkpoint interval. Atlas M0/Flex deny fsync and omit WT checkpoint
 *    metrics: poll $collStats instead of sleeping 60s. parkedWindowReplay
 *    skip-replay (no extend, R>0) does not wait for a checkpoint.
 *  - defragOptions.naturalDir: naturalWindow / naturalReply scan, 1 (default,
 *    oldest RecordId first) or -1 (newest first). doubleParked stays -1.
 *  - defragOptions.passes: collection cover count (default 1). naturalReply
 *    / naturalReplay rescans $natural each pass (RecordIds changed).
 *  - Atlas M0/Flex ignore allowDiskUse and cap in-memory sorts at 32MiB.
 *    $sample of >=5% of n (or n<=100) COLLSCAN+sorts the whole collection;
 *    calibrate/$sample stay on the random-cursor path (chunks <5% of n).
 *
 *  TODOs:
 *  - autotune pageFill (pageFillRatio / pageFillTarget) from settled collStats
 *    instead of a fixed 0.9 — next discussion
 *  - inter-wave pause on WT dirty / updates bytes instead of checkpoint status
 *  - AIMD dirtyBudgetRatio from settled density/reusable (stop ~10–20% reuse)
 *  - compact after a density pass to relocate the geometric tail
 */

// Usage: mongosh [connection options] [--quiet] [-f|--file] </path/to/>onlineDefrag.js

/*
 *  Example:
 *    mongosh [connection options] --quiet --eval "var dbName = 'database', collName = 'collection';" [-f|--file] </path/to/>onlineDefrag.js
 *    mongosh [connection options] --quiet --eval "var dbName = 'database', collName = 'collection', defragOptions = { sampler: 'adjacent' };" [-f|--file] </path/to/>onlineDefrag.js
 *    mongosh [connection options] --quiet --eval "var dbName = 'database', collName = 'collection', defragOptions = { strategy: 'doubleParked' };" [-f|--file] </path/to/>onlineDefrag.js
 *    mongosh [connection options] --quiet --eval "var dbName = 'database', collName = 'collection', defragOptions = { strategy: 'meetInMiddle', curator: 'ids' };" [-f|--file] </path/to/>onlineDefrag.js
 *    mongosh [connection options] --quiet --eval "var dbName = 'database', collName = 'collection', defragOptions = { strategy: 'lowStressMode', curator: 'ranges' };" [-f|--file] </path/to/>onlineDefrag.js
 *    mongosh [connection options] --quiet --eval "var dbName = 'database', collName = 'collection', defragOptions = { strategy: 'updateOne' };" [-f|--file] </path/to/>onlineDefrag.js
 *    mongosh [connection options] --quiet --eval "var dbName = 'database', collName = 'collection', defragOptions = { strategy: 'slidingShuffle' };" [-f|--file] </path/to/>onlineDefrag.js
 *    mongosh [connection options] --quiet --eval "var dbName = 'database', collName = 'collection', defragOptions = { strategy: 'slidingWindow' };" [-f|--file] </path/to/>onlineDefrag.js
 *    mongosh [connection options] --quiet --eval "var dbName = 'database', collName = 'collection', defragOptions = { strategy: 'quantile' };" [-f|--file] </path/to/>onlineDefrag.js
 *    mongosh [connection options] --quiet --eval "var dbName = 'database', collName = 'collection', defragOptions = { strategy: 'rndQuantile' };" [-f|--file] </path/to/>onlineDefrag.js
 *    mongosh [connection options] --quiet --eval "var dbName = 'database', collName = 'collection', defragOptions = { strategy: 'shapeQuantile' };" [-f|--file] </path/to/>onlineDefrag.js
 *    mongosh [connection options] --quiet --eval "var dbName = 'database', collName = 'collection', defragOptions = { strategy: 'naturalWindow' };" [-f|--file] </path/to/>onlineDefrag.js
 *    mongosh [connection options] --quiet --eval "var dbName = 'database', collName = 'collection', defragOptions = { strategy: 'naturalReply', updateDelayMs: 0 };" [-f|--file] </path/to/>onlineDefrag.js
 *    mongosh [connection options] --eval "var dbName = 'database', collName = 'collection', defragOptions = { strategy: 'naturalReplay', concurrentUpdates: 32, updateDelayMs: 0 };" [-f|--file] </path/to/>onlineDefrag.js
 *
 *  We use 'var' to interoperate with mongosh's sloppy mode
 */

/*
 *  Load helper mdblib.js (https://github.com/tap1r/mongodb-scripts/blob/master/src/mdblib.js)
 *  Save libs to the $MDBLIB or other valid search path
 */

(() => {
   const __script = { "name": "onlineDefrag.js", "version": "0.5.5" };
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
   console.log(`\n\n[yellow]${__comment}[/]\n`);
})();

(async() => {
   const nsDb = typeof dbName === 'undefined' ? 'database' : dbName;
   const nsColl = typeof collName === 'undefined' ? 'collection' : collName;
   const namespace = db.getSiblingDB(nsDb).getCollection(nsColl);

   // Caller: var defragOptions = { ... } (--eval or REPL). Do not declare or assign it in this file.
   const userOptions = typeof defragOptions === 'undefined' ? {} : defragOptions;
   const {
      "sampler": samplerIn = 'bucketed', // 'random' | 'adjacent' | 'bucketed' | 'doubleParked'
      "strategy": strategyIn = 'waves', // 'waves' | 'meetInMiddle' | 'lowStressMode' | 'updateOne' | 'slidingShuffle' | 'slidingWindow' | 'quantile' | 'rndQuantile' | 'doubleParked' | 'shapeQuantile' | 'naturalWindow' | 'naturalReply'
      "shuffleSampleSize": shuffleSampleSize, // $sample size for TFR calibration; default 10000
      "curator": curator = 'ids', // meetInMiddle: 'ids' | 'ranges'
      "pageFillRatio": pageFillRatio = 0.9, // WT dest-leaf spill target (fixed)
      "dirtyFillTarget": dirtyFillTarget = 0.08, // wave fill cap vs updates allocated % of cache
      "dirtyTrigger": dirtyTrigger = 0.20, // meetInMiddle: stressed if dirty util >= this
      "updatesTrigger": updatesTrigger = 0.10, // eviction_updates_trigger; stressed if updates util >= this
      "lowStressDirtyMax": lowStressDirtyMax = 0.07, // updates allocated soft pause
      "lowStressDirtyHard": lowStressDirtyHard = 0.08, // updates allocated hard; overshoot lowers soft
      "dirtyBudgetRatio": dirtyBudgetRatio = 0.2, // fraction of compressed freeStorageSize to dest-allocate per checkpoint. Not a target reusable%. Debit is nPages×leaf/C (same units as R).
      "maxConcurrent": maxConcurrent,
      "writeConcurrency": writeConcurrencyIn, // meetInMiddle / lowStressMode / slidingShuffle / slidingWindow / quantile / rndQuantile write forks
      "concurrentUpdates": concurrentUpdates, // alias of writeConcurrency when that key is omitted
      "curatorBatchSize": curatorBatchSize, // if set, overrides pageFillTarget for $in / $bucketAuto
      "maxLagSeconds": maxLagSeconds = 10, // pause new batches when lag exceeds this
      "passes": passes, // collection cover count; default 1
      "checkpointTimeoutMs": checkpointTimeoutMs,
      "ignoreCheckpoint": ignoreCheckpoint = false, // skip ckpt waits; async $collStats next round
      "naturalDir": naturalDir = 1, // naturalWindow/naturalReply: 1 = oldest RecordId first, -1 = newest first
      "updateDelayMs": updateDelayMs = 0 // pause before every rewrite
   } = userOptions;
   const strategy = strategyIn === 'naturalReplay' ? 'naturalReply' : strategyIn;
   const sampler = samplerIn === 'naturalReplay' ? 'naturalReply' : samplerIn;
   const writeConcurrency = Number(writeConcurrencyIn) > 0
      ? Math.ceil(writeConcurrencyIn)
      : (Number(concurrentUpdates) > 0 ? Math.ceil(concurrentUpdates) : 8);

   // mdblib $collStats for the target namespace (indexes stripped).
   function collSnapshot() {
      const { indexes, ...stats } = $collStats(nsDb, nsColl) || {};
      return stats;
   }

   // ignoreCheckpoint: kick $collStats without waiting for a checkpoint; consume
   // on the next round (non-blocking). In-flight kick is not duplicated.
   let asyncSnap = null, asyncSnapBusy = false;
   function kickCollStats() {
      if (!ignoreCheckpoint || asyncSnapBusy) return;
      asyncSnapBusy = true;
      Promise.resolve().then(() => collSnapshot()).then(s => {
         asyncSnap = s;
         asyncSnapBusy = false;
      }).catch(() => { asyncSnapBusy = false; });
   }
   function consumeAsyncSnap() {
      if (!asyncSnap) return null;
      const s = asyncSnap;
      asyncSnap = null;
      return s;
   }

   const ckptPollMs = 250;
   const statsPollMs = 1000;
   const statsSettleTimeoutMs = 15000;
   const dirtyPollMs = 250;
   const lagPollMs = 250;
   const idlePollMs = 250;

   function sampleDims(sampleSize = 1, concurrentUpdates = 1) {
      const nBuckets = Math.max(1, Math.ceil(+concurrentUpdates) || 1);
      const pageSize = Math.max(1, Math.ceil(+sampleSize) || 1);
      return { "nBuckets": nBuckets, "pageSize": pageSize };
   }

   // $sample random-cursor path: n>100 and size <5% of n. Otherwise COLLSCAN,
   // attach a random key, sort. Atlas M0/Flex ignore allowDiskUse (32MiB).
   function randomCursorSampleCap(nObjs) {
      const n = Math.max(0, Math.floor(Number(nObjs) || 0));
      if (n <= 100) return n;
      return Math.max(1, Math.floor(n * 0.049));
   }

   function aggOpts(comment, extra = {}) {
      return {
         "allowDiskUse": true,
         "readConcern": { "level": "local" },
         "comment": comment,
         ...extra
      };
   }

   // Wave batch = max(actual fill, pageFillRatio × dest leaf). nPages from live/32KiB.
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
      const leafFill = Math.max(1, Math.ceil((pageFillRatio * dataPageSize * compression) / avg));
      const pageFillTarget = Math.max(1, Math.ceil(leafFill));
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

   // Soft cap: ~dirtyFillTarget of cache as updates-allocated headroom (stay below ~20% dirty trigger).
   function dirtyFillPages(leaf) {
      const c = wtCache();
      if (!c) return null;
      const frac = Math.min(+dirtyFillTarget || 0.08, 0.10);
      const headroom = c.max * frac - c.updates;
      return Math.max(0, Math.floor(headroom / leaf));
   }

   function waveBudget(stats, dataPageSize) {
      // Wave concurrency = min(reusable pages, dirty fill headroom).
      // Reusable pages = hard cap (no file extend). Dirty fill = softer cap
      // so eviction can write during the wave; checkpoint still required to settle.
      // M0 (no cache stats): dirtyBudgetRatio × reusable pages.
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
      return {
         "nBatches": Math.max(0, n),
         "reusablePages": reusablePages,
         "dirtyPages": dirtyCap
      };
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

   // sampler 'random': $sample of nBuckets × pageSize, then stream page-sized _id batches.
   // Cap at <5% of n so M0 does not COLLSCAN+sort the collection in 32MiB.
   async function* rndSample(sampleSize = 1, concurrentUpdates = 1) {
      const { nBuckets, pageSize } = sampleDims(sampleSize, concurrentUpdates);
      const want = nBuckets * pageSize;
      const nObjs = namespace.estimatedDocumentCount();
      const cap = randomCursorSampleCap(nObjs);
      const size = (nObjs > 100 && want > cap) ? cap : want;
      if (size < want) {
         console.log(`random sampler: $sample ${want} -> ${size} (<5% of ${nObjs}; M0 32MiB sort)`);
      }
      const pipeline = [
         { "$sample": { "size": size } },
         { "$project": { "_id": 1 } }
      ];
      yield* batchesFromCursor(
         namespace.aggregate(pipeline, aggOpts("$sample technique", { "cursor": { "batchSize": pageSize } })),
         pageSize
      );
   }

   // sampler 'adjacent': random seed _id, walk $gte or $lte with $sampleRate (≈1/actualFill), $natural:-1.
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

   async function* bucketedIds(sampleSize = 1, concurrentUpdates = 1, sampleRate = 1, afterId) {
      // sampler 'bucketed' (default): stream page-sized _id-range batches.
      // No $sort / $bucketAuto / $setWindowFields — those block before the first yield.
      const { nBuckets, pageSize } = sampleDims(sampleSize, concurrentUpdates);
      const pipeline = [];
      if (afterId !== undefined) {
         pipeline.push({ "$match": { "_id": { "$gt": afterId } } });
      } else {
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
         pipeline.push({ "$match": { "_id": bound } });
      }
      pipeline.push(
         { "$limit": nBuckets * pageSize },
         { "$project": { "_id": 1 } }
      );
      yield* batchesFromCursor(
         namespace.aggregate(pipeline, aggOpts("bucketed _id batches", {
            "cursor": { "batchSize": pageSize },
            "hint": { "_id": 1 }
         })),
         pageSize
      );
   }

   // Waves sampler switch. sampler 'doubleParked' is dispatched to doubleParkedMain.
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

   // Txn updateMany (or updateOne) + $unset _id. updateDelayMs before each rewrite.
   async function rewriteFilter(filter, { one = false, expect } = {}) {
      if (Number(updateDelayMs) > 0) await delay(updateDelayMs);
      const session = db.getMongo().startSession({
         "readPreference": { "mode": "primary" },
         "causalConsistency": true
      });
      const coll = session.getDatabase(nsDb).getCollection(nsColl);
      try {
         await session.withTransaction(async() => {
            const spec = one
                       ? { "updateOne": { "filter": filter, "update": updatePipeline, ...updateManyOpts } }
                       : { "updateMany": { "filter": filter, "update": updatePipeline, ...updateManyOpts } };
            const { modifiedCount } = await coll.bulkWrite([spec], bulkOpts);
            if (!((expect != null && modifiedCount === expect) || (one && modifiedCount === 1))) {
               console.log(`\tmodifiedCount: ${modifiedCount}`);
            }
         }, {
            "readConcern": { "level": "local" },
            "writeConcern": { "w": "majority", "j": true },
            "comment": "online compacting updates"
         });
      } catch(error) {
         console.log(`\ttxn conflict detected, aborting op`);
      } finally {
         await session.endSession();
      }
   }

   function rewriteIds(ids, opts) {
      // Halloween: $unset _id assigns a new RecordId; a $natural/collscan can
      // see the doc again. Identify by frozen _id list + hint _id:1 (id does
      // not change). Never rescan $natural for a replay.
      return rewriteFilter({ "_id": { "$in": ids } }, opts);
   }

   function rewriteOne(id) {
      return rewriteFilter({ "_id": id }, { "one": true });
   }

   function makeWritePool({ onEnqueue } = {}) {
      let inflight = [];
      return {
         async drain() {
            if (!inflight.length) return;
            await Promise.allSettled(inflight);
            inflight = [];
         },
         async enqueue(p, cap) {
            if (typeof onEnqueue === 'function') onEnqueue();
            inflight.push(p);
            while (inflight.length >= cap) await inflight.shift();
         }
      };
   }

   function jobIds(job) {
      if (job.ids) return job.ids;
      if (!job.range) return [];
      return namespace.find({ "_id": job.range }, { "_id": 1 }).hint({ "_id": 1 }).toArray().map(d => d._id);
   }

   function jobFilter(job) {
      return job.ids ? { "_id": { "$in": job.ids } } : { "_id": job.range };
   }

   function wtCache() {
      const cache = serverStatus({ "wiredTiger": true }).wiredTiger?.cache;
      if (!cache) return null;
      const max = +cache['maximum bytes configured'];
      if (!(max > 0)) return null;
      return {
         "max": max,
         "dirty": +cache['tracked dirty bytes in the cache'] || 0,
         "updates": +cache['bytes allocated for updates'] || 0,
         "used": +cache['bytes currently in the cache'] || 0
      };
   }

   function cacheUpdatesUtil() {
      const c = wtCache();
      return c ? c.updates / c.max : null;
   }

   function cacheStressed() {
      const c = wtCache();
      if (!c) return false;
      const dirtyUtil = c.dirty / c.max;
      const updatesUtil = c.updates / c.max;
      const usedUtil = c.used / c.max;
      return dirtyUtil >= dirtyTrigger || updatesUtil >= updatesTrigger || usedUtil >= 0.95;
   }

   function applyDirtyOvershoot(u, tune) {
      if (u == null) return;
      const over = Math.max(0, u - tune.hard);
      const prev = tune.soft;
      tune.soft = Math.max(0, tune.base - over);
      if (tune.soft !== prev) {
         console.log(`updates ${(u * 100).toFixed(2)}% hard ${(tune.hard * 100).toFixed(2)}%; soft ${(prev * 100).toFixed(2)}% -> ${(tune.soft * 100).toFixed(2)}%`);
      }
   }

   // Pause while updates-allocated % ≥ soft; hard overshoot lowers the soft floor.
   async function waitForDirtyUnder(tune) {
      let u = cacheUpdatesUtil();
      if (u == null) return;
      applyDirtyOvershoot(u, tune);
      if (u < tune.soft) return;
      console.log(`updates ${(u * 100).toFixed(2)}% >= soft ${(tune.soft * 100).toFixed(2)}%, pausing`);
      while ((u = cacheUpdatesUtil()) != null) {
         applyDirtyOvershoot(u, tune);
         if (u < tune.soft) break;
         await delay(dirtyPollMs);
      }
      console.log(`updates ${((u || 0) * 100).toFixed(2)}% (soft ${(tune.soft * 100).toFixed(2)}%), resuming`);
   }

   function estimateRewriteBytes(nDocs, packed) {
      // On-disk bytes after block compression, from the packed sample:
      // n * avgObjSize (BSON) / (dataSize / live). Do not debit uncompressed
      // 32KiB leaves — freeStorageSize is compressed block-manager units.
      const avg = +packed?.avgObjSize > 0 ? +packed.avgObjSize : 256;
      const compression = Number(packed?.compression) > 0 ? +packed.compression : 1;
      return nDocs * avg / Math.max(compression, 0.01);
   }

   function refreshReusableCap(window, reason = 'checkpoint', snap) {
      // Caller has just observed a checkpoint falling edge (or M0 proxy wait),
      // or ignoreCheckpoint delivered an async $collStats for the next round.
      window.snap = snap || collSnapshot();
      window.bytes = 0;
      const R = +window.snap.freeStorageSize;
      const frac = Number(dirtyBudgetRatio) > 0 ? dirtyBudgetRatio : 0.05;
      const cap = Number.isFinite(R) && R > 0 ? frac * R : 0;
      const live = Math.max(0, (window.snap.storageSize || 0) - (Number.isFinite(R) ? R : 0));
      console.log(`${reason}: settled stats reusable=${Number.isFinite(R) ? R : 0} cap=${Math.round(cap)} live=${live} storageSize=${window.snap.storageSize || 0}`);
      return cap;
   }

   async function ensureReusableRoom(window, nextBytes, { refreshSnap = true, beforeWait } = {}) {
      // Cap cumulative estimated rewrite bytes at dirtyBudgetRatio * R per
      // checkpoint. R comes from window.snap (refreshed on falling edge).
      const R = +window.snap.freeStorageSize;
      if (!Number.isFinite(R) || R <= 0) return;
      const frac = Number(dirtyBudgetRatio) > 0 ? dirtyBudgetRatio : 0.05;
      const cap = frac * R;
      if (window.bytes + nextBytes <= cap) return;
      if (typeof beforeWait === 'function') await beforeWait();
      if (ignoreCheckpoint) {
         window.bytes = 0;
         const s = consumeAsyncSnap();
         if (s) refreshReusableCap(window, 'async stats', s);
         kickCollStats();
         return;
      }
      console.log(`reusable budget ${Math.round(window.bytes)}+${Math.round(nextBytes)} > ${Math.round(cap)} (${frac}*freeStorageSize ${R}); waiting for checkpoint`);
      const waited = await waitForCheckpoint({ "settle": true });
      if (!waited.available && !waited.completed) {
         await delay(statsPollMs);
      }
      window.bytes = 0;
      if (refreshSnap && (waited.completed || !waited.available)) refreshReusableCap(window, 'reusable budget');
   }

   async function* curateIdBatches(direction, state) {
      while (state.taken < state.maxDocs) {
         const r = {};
         if (direction === 1) {
            if (state.afterId !== undefined) r.$gt = state.afterId;
            if (state.meetHigh !== undefined) r.$lt = state.meetHigh;
         } else {
            if (state.beforeId !== undefined) r.$lt = state.beforeId;
            if (state.meetLow !== undefined) r.$gt = state.meetLow;
         }
         const q = Object.keys(r).length ? { "_id": r } : {};
         const n = Math.min(state.batchSize, state.maxDocs - state.taken);
         const docs = namespace.find(q, { "_id": 1 }).sort({ "_id": direction })
            .hint({ "_id": 1 }).limit(n).toArray();
         if (!docs.length) return;
         const ids = docs.map(d => d._id);
         if (direction === 1) state.afterId = ids[ids.length - 1];
         else state.beforeId = ids[ids.length - 1];
         state.taken += ids.length;
         yield { "ids": ids, "n": ids.length };
      }
   }

   async function* curateRangeBatches(direction, state) {
      const nBuckets = Math.max(1, Math.ceil(state.maxDocs / state.batchSize));
      const pipeline = [
         { "$sort": { "_id": direction } },
         { "$limit": state.maxDocs },
         { "$project": { "_id": 1 } },
         { "$bucketAuto": {
            "groupBy": "$_id",
            "buckets": nBuckets,
            "output": { "min": { "$min": "$_id" }, "max": { "$max": "$_id" }, "n": { "$sum": 1 } }
         } }
      ];
      const rows = namespace.aggregate(pipeline, aggOpts("meetInMiddle $bucketAuto ranges", {
         "hint": { "_id": 1 },
         "allowDiskUse": true
      })).toArray();
      // $bucketAuto bounds are half-open: adjacent max === next min. Inclusive on
      // both ends would rewrite the boundary _id twice. Last bucket in _id order
      // is closed so the highest _id is not dropped.
      const last = rows[rows.length - 1];
      const ordered = direction === 1 ? rows : rows.slice().reverse();
      for (const row of ordered) {
         if (state.taken >= state.maxDocs) return;
         state.taken += row.n || 0;
         const range = (last && row === last)
                     ? { "$gte": row.min, "$lte": row.max }
                     : { "$gte": row.min, "$lt": row.max };
         yield { "range": range, "n": row.n || 0 };
      }
   }

   function scaledBatch(n) {
      if (Number(curatorBatchSize) > 0) return Math.max(1, Math.ceil(+curatorBatchSize));
      return Math.max(1, Math.ceil(n || 1));
   }

   function startCurator(direction, batchSize, maxDocs, kind = curator) {
      const state = { "batchSize": scaledBatch(batchSize), "maxDocs": maxDocs, "taken": 0 };
      const gen = kind === 'ranges'
                ? curateRangeBatches(direction, state)
                : curateIdBatches(direction, state);
      return { state, gen };
   }

   function packedPageBudget(cal) {
      // First-fit fill: Σ ($bsonSize / C_mode) ≤ floor(pageFillRatio × leaf).
      // C_mode from calibrate size-band temps, else global dataSize/live.
      const leaf = cal?.ps?.dataPageSize || 32 * 1024;
      const fillRatio = Number(pageFillRatio) > 0 ? +pageFillRatio : 0.9;
      const compression = Number(cal?.compression) > 0 ? +cal.compression : 1;
      const packedBudget = Math.max(1, Math.floor(fillRatio * leaf));
      const bsonCap = packedBudget * Math.max(compression, 0.01);
      return { "leaf": leaf, "fillRatio": fillRatio, "compression": compression, "packedBudget": packedBudget, "bsonCap": bsonCap };
   }

   function batchAllocBytes(b, leaf, fillRatio, compression) {
      // Dest on-disk vs freeStorageSize (compressed block-manager bytes).
      // WT splits on uncompressed fillRatio×leaf images; those pages then
      // compress by C. Debiting nPages×leaf (uncompressed) against R made
      // the dirty window ~C/pageFill too small, so collStats reusable %
      // sat ~that much above dirtyBudgetRatio.
      const leafB = Number(leaf) > 0 ? +leaf : 32 * 1024;
      const fill = Math.max(1, (Number(fillRatio) > 0 ? +fillRatio : 0.9) * leafB);
      const C = Math.max(Number(compression) > 0 ? +compression : 1, 0.01);
      const bson = Number(b?.bson) > 0 ? +b.bson
                 : (Number(b?.packed) > 0 ? +b.packed * C : fill);
      const nPages = Math.max(1, Math.ceil(bson / fill));
      return nPages * leafB / C;
   }

   function modeIndex(bson, cal) {
      // Classify by packed bytes (bson / global C). Packed > spill cap is jumbo (TFR=1).
      const modes = cal?.modes;
      if (!Array.isArray(modes) || modes.length < 2) return -1;
      const C0 = Number(cal?.compression) > 0 ? +cal.compression : 1;
      const packed = bson / Math.max(C0, 0.01);
      const cap = packedPageBudget(cal).packedBudget;
      if (packed > cap) return -1;
      for (let k = 0; k < modes.length; k++) {
         const m = modes[k];
         if (k === modes.length - 1) {
            if (packed >= m.min) return k;
         } else if (packed >= m.min && packed < m.max) return k;
      }
      return -1;
   }

   function modeCompression(bson, cal) {
      const fallback = Number(cal?.compression) > 0 ? +cal.compression : 1;
      const k = modeIndex(bson, cal);
      if (k < 0) return fallback;
      const C = Number(cal.modes[k].compression);
      return C > 0 ? C : fallback;
   }

   function packedOf(bson, cal) {
      return bson / Math.max(modeCompression(bson, cal), 0.01);
   }

   function shapeKeysExpr() {
      return {
         "$sortArray": {
            "input": {
               "$filter": {
                  "input": {
                     "$map": {
                        "input": { "$objectToArray": "$$ROOT" },
                        "as": "f",
                        "in": "$$f.k"
                     }
                  },
                  "as": "k",
                  "cond": { "$ne": ["$$k", "_id"] }
               }
            },
            "sortBy": 1
         }
      };
   }

   function shapeHashExpr() {
      return { "$toHashedIndexKey": shapeKeysExpr() };
   }

   function shapeProjectStage() {
      return {
         "$project": {
            "bson": { "$ifNull": [{ "$bsonSize": "$$ROOT" }, 0] },
            "shape": shapeHashExpr()
         }
      };
   }

   function keysSig(v) {
      if (v == null) return '';
      if (typeof v === 'object' && typeof v.toString === 'function') return String(v);
      return String(v);
   }

   function shapeCompression(sig, cal) {
      const fallback = Number(cal?.compression) > 0 ? +cal.compression : 1;
      const shapes = cal?.shapes;
      if (!Array.isArray(shapes) || !shapes.length) return fallback;
      for (let i = 0; i < shapes.length; i++) {
         if (shapes[i].sig === sig && Number(shapes[i].compression) > 0) return +shapes[i].compression;
      }
      return fallback;
   }

   async function naturalPackedBatches(cal, maxDocs, naturalDir = -1) {
      // Record-store cover in $natural order; $bsonSize on the server.
      // $limit maxDocs (pre-update count) excludes inserts appended during the
      // scan (Halloween). First-fit packed $in leaves. Client sees {_id, bson}.
      const { packedBudget } = packedPageBudget(cal);
      const dir = Number(naturalDir) >= 0 ? 1 : -1;
      const pipeline = [
         { "$project": { "bson": { "$ifNull": [{ "$bsonSize": "$$ROOT" }, 0] } } },
         { "$limit": Math.max(1, maxDocs) }
      ];
      const cursor = namespace.aggregate(pipeline, aggOpts(`natural ${dir} $bsonSize`, {
         "hint": { "$natural": dir },
         "allowDiskUse": true,
         "cursor": { "batchSize": 256 }
      }));
      const batches = [];
      let cur = null;
      const consider = (doc) => {
         const bson = +doc.bson || 0;
         if (bson < 1) return;
         const packed = packedOf(bson, cal);
         if (cur && cur.n > 0 && cur.packed + packed > packedBudget) {
            batches.push(cur);
            cur = null;
         }
         if (!cur) cur = { "ids": [], "n": 0, "bson": 0, "packed": 0 };
         cur.ids.push(doc._id);
         cur.n++;
         cur.bson += bson;
         cur.packed += packed;
      };
      if (typeof cursor[Symbol.asyncIterator] === 'function') {
         for await (const doc of cursor) consider(doc);
      } else if (typeof cursor.forEach === 'function') {
         cursor.forEach(consider);
      } else {
         let rows = typeof cursor.toArray === 'function' ? cursor.toArray() : [...cursor];
         if (rows && typeof rows.then === 'function') rows = await rows;
         for (const doc of rows || []) consider(doc);
      }
      if (cur && cur.n) batches.push(cur);
      return batches;
   }

   async function startNaturalWindowCurator(cal, maxDocs) {
      // strategy 'naturalWindow': freeze a $natural + $bsonSize cover ($limit
      // nDocs) then first-fit like quantile. naturalDir 1 = oldest RecordId
      // first; -1 = newest first. Writes are $in in that order. $limit nDocs
      // with dir=1 excludes concurrent tail inserts; dir=-1 is newest n (a
      // concurrent insert can displace the oldest).
      const { packedBudget, bsonCap, leaf, fillRatio, compression } = packedPageBudget(cal);
      const dir = Number(naturalDir) >= 0 ? 1 : -1;
      console.log(`naturalWindow curator: $natural:${dir} scan nDocs=${maxDocs} packedBudget=${packedBudget} leaf=${leaf} pageFillRatio=${fillRatio} compression=${compression.toFixed(3)}`);
      const batches = await naturalPackedBatches(cal, maxDocs, dir);
      const state = { "batchSize": packedBudget, "maxDocs": maxDocs, "taken": 0 };
      async function* gen() {
         for (const b of batches) {
            state.taken += b.n || 0;
            yield { "ids": b.ids, "n": b.n, "packed": b.packed, "bson": b.bson };
         }
      }
      return {
         "state": state,
         "gen": gen(),
         "totalBatches": batches.length,
         "packedBudget": packedBudget,
         "bsonCap": bsonCap
      };
   }

   function startQuantileCurator(cal, maxDocs) {
      // strategy 'quantile': first-fit _id ranges while Σ ($bsonSize / C_mode)
      // ≤ packedBudget. Calibrate may split the sample into size modes and
      // measure per-mode C. Mixed modes along _id stay in one leaf until the
      // packed cap. Jumbo docs get their own. $bucket (docSizes.js) histograms
      // size classes — wrong axis for rewrite ranges.
      const { compression, packedBudget, bsonCap, leaf, fillRatio } = packedPageBudget(cal);
      const pipeline = [
         { "$sort": { "_id": 1 } },
         { "$limit": Math.max(1, maxDocs) },
         { "$project": { "bson": { "$ifNull": [{ "$bsonSize": "$$ROOT" }, 0] } } }
      ];
      const nModes = Array.isArray(cal?.modes) ? cal.modes.length : 0;
      console.log(`quantile curator: first-fit packedBudget=${packedBudget} bsonCap≈${Math.round(bsonCap)} leaf=${leaf} pageFillRatio=${fillRatio} compression=${compression.toFixed(3)} modes=${nModes >= 2 ? nModes : 'unimodal'}`);
      const cursor = namespace.aggregate(pipeline, aggOpts("quantile first-fit packed ranges", {
         "hint": { "_id": 1 },
         "allowDiskUse": true
      }));
      const rows = [];
      let cur = null;
      const consume = (doc) => {
         const bson = +doc.bson || 0;
         const packed = packedOf(bson, cal);
         if (cur && cur.n > 0 && cur.packed + packed > packedBudget) {
            rows.push(cur);
            cur = null;
         }
         if (!cur) cur = { "min": doc._id, "max": doc._id, "n": 0, "bson": 0, "packed": 0 };
         else cur.max = doc._id;
         cur.n++;
         cur.bson += bson;
         cur.packed += packed;
      };
      if (typeof cursor.forEach === 'function') cursor.forEach(consume);
      else for (const doc of cursor) consume(doc);
      if (cur && cur.n) rows.push(cur);
      const state = { "batchSize": packedBudget, "maxDocs": maxDocs, "taken": 0 };
      async function* gen() {
         for (const row of rows) {
            if (state.taken >= state.maxDocs) return;
            state.taken += row.n || 0;
            yield {
               "range": { "$gte": row.min, "$lte": row.max },
               "n": row.n || 0,
               "packed": row.packed || 0,
               "bson": row.bson || 0
            };
         }
      }
      return { "state": state, "gen": gen(), "totalBatches": rows.length, "packedBudget": packedBudget, "bsonCap": bsonCap };
   }

   function startRndQuantileCurator(cal, maxDocs) {
      // strategy 'rndQuantile': same first-fit / C_mode as quantile, but the
      // stream is repeated $sample of ~TFR until N draws. Small $sample uses a
      // random cursor (non-blocking). $sample of N would collscan+sort and
      // block. Random ids are rewritten with $in.
      const { compression, packedBudget, bsonCap, leaf, fillRatio } = packedPageBudget(cal);
      const pft = Math.max(1, Number(cal.tfr) > 0 ? Math.ceil(cal.tfr) : 1);
      const state = { "batchSize": packedBudget, "maxDocs": maxDocs, "taken": 0 };
      const nModes = Array.isArray(cal?.modes) ? cal.modes.length : 0;
      console.log(`rndQuantile curator: first-fit packedBudget=${packedBudget} bsonCap≈${Math.round(bsonCap)} $sample=${pft} (PFT/TFR) draws=${maxDocs} leaf=${leaf} pageFillRatio=${fillRatio} compression=${compression.toFixed(3)} modes=${nModes >= 2 ? nModes : 'unimodal'}`);
      async function* gen() {
         let drawn = 0;
         let cur = null;
         while (drawn < maxDocs) {
            const size = Math.min(pft, maxDocs - drawn);
            const cursor = namespace.aggregate([
               { "$sample": { "size": size } },
               { "$project": { "bson": { "$ifNull": [{ "$bsonSize": "$$ROOT" }, 0] } } }
            ], aggOpts(`${strategy} $sample ${size}`, { "cursor": { "batchSize": size } }));
            const docs = typeof cursor.toArray === 'function' ? cursor.toArray() : [...cursor];
            if (!docs.length) break;
            for (const doc of docs) {
               if (drawn >= maxDocs) break;
               drawn++;
               const bson = +doc.bson || 0;
               const packed = packedOf(bson, cal);
               if (cur && cur.n > 0 && cur.packed + packed > packedBudget) {
                  state.taken += cur.n;
                  yield { "ids": cur.ids, "n": cur.n, "packed": cur.packed, "bson": cur.bson };
                  cur = null;
               }
               if (!cur) cur = { "ids": [], "n": 0, "bson": 0, "packed": 0 };
               cur.ids.push(doc._id);
               cur.n++;
               cur.bson += bson;
               cur.packed += packed;
            }
         }
         if (cur && cur.n) {
            state.taken += cur.n;
            yield { "ids": cur.ids, "n": cur.n, "packed": cur.packed, "bson": cur.bson };
         }
      }
      return {
         "state": state,
         "gen": gen(),
         "totalBatches": 0,
         "streaming": true,
         "packedBudget": packedBudget,
         "bsonCap": bsonCap
      };
   }

   // strategy 'shapeQuantile': first-fit packed $in per server-side hash of
   // sorted top-level keys ($toHashedIndexKey). Client sees {_id, bson, shape}.
   function startShapeQuantileCurator(cal, maxDocs) {
      const { packedBudget, bsonCap, leaf, fillRatio, compression } = packedPageBudget(cal);
      const nShapes = Array.isArray(cal?.shapes) ? cal.shapes.length : 0;
      console.log(`shapeQuantile curator: first-fit packedBudget=${packedBudget} bsonCap≈${Math.round(bsonCap)} leaf=${leaf} pageFillRatio=${fillRatio} compression=${compression.toFixed(3)} shapes=${nShapes || 'unmeasured'}`);
      const state = { "batchSize": packedBudget, "maxDocs": maxDocs, "taken": 0 };
      async function* gen() {
         const cursor = namespace.aggregate([
            shapeProjectStage()
         ], aggOpts("shapeQuantile $bsonSize $toHashedIndexKey", {
            "hint": { "_id": 1 },
            "allowDiskUse": true,
            "cursor": { "batchSize": 256 }
         }));
         const open = new Map();
         const pending = [];
         const consider = (doc) => {
            const sig = keysSig(doc.shape);
            const bson = +doc.bson || 0;
            const packed = bson / Math.max(shapeCompression(sig, cal), 0.01);
            let cur = open.get(sig);
            if (cur && cur.n > 0 && cur.packed + packed > packedBudget) {
               pending.push(cur);
               open.delete(sig);
               cur = null;
            }
            if (!cur) {
               cur = { "ids": [], "n": 0, "bson": 0, "packed": 0, "sig": sig };
               open.set(sig, cur);
            }
            cur.ids.push(doc._id);
            cur.n++;
            cur.bson += bson;
            cur.packed += packed;
         };
         const pull = async function*() {
            if (typeof cursor[Symbol.asyncIterator] === 'function') {
               for await (const doc of cursor) {
                  consider(doc);
                  while (pending.length) {
                     const b = pending.shift();
                     state.taken += b.n;
                     yield { "ids": b.ids, "n": b.n, "packed": b.packed, "bson": b.bson, "shape": b.sig };
                  }
               }
            } else {
               while (true) {
                  let has = typeof cursor.hasNext === 'function' ? cursor.hasNext() : false;
                  if (has && typeof has.then === 'function') has = await has;
                  if (!has) break;
                  let doc = cursor.next();
                  if (doc && typeof doc.then === 'function') doc = await doc;
                  if (doc == null) break;
                  consider(doc);
                  while (pending.length) {
                     const b = pending.shift();
                     state.taken += b.n;
                     yield { "ids": b.ids, "n": b.n, "packed": b.packed, "bson": b.bson, "shape": b.sig };
                  }
               }
            }
         };
         yield* pull();
         for (const cur of open.values()) {
            if (!cur.n) continue;
            state.taken += cur.n;
            yield { "ids": cur.ids, "n": cur.n, "packed": cur.packed, "bson": cur.bson, "shape": cur.sig };
         }
      }
      return {
         "state": state,
         "gen": gen(),
         "totalBatches": 0,
         "streaming": true,
         "packedBudget": packedBudget,
         "bsonCap": bsonCap
      };
   }

   // strategy 'meetInMiddle': low-pass (_id: 1) while checkpoint idle, high-pass
   // (_id: -1) while it runs. After the first high pass completes, a reverse
   // high pass rewrites those buckets from the last (middle) boundary back
   // toward max _id. Writes are txn updateMany + $unset _id.
   async function meetInMiddleMain() {
      let snap = collSnapshot();
      let fill = pageStats(snap);
      const half = Math.max(1, Math.ceil((fill.documentCount || 1) / 2));
      const conc = Math.max(1, Number(writeConcurrency) > 0 ? Math.ceil(writeConcurrency) : 1);
      console.log(`strategy: meetInMiddle curator: ${curator} writeConcurrency: ${conc}`);
      console.log(`half: ${half} batch: ${fill.batchSize} actualFill: ${fill.pageFillActual} targetFill: ${fill.pageFillTarget}`);
      console.log(EJSON.stringify({ "state": "initial storage", ...snap }));

      const low = startCurator(1, fill.pageFillTarget, half);
      const high = startCurator(-1, fill.pageFillTarget, half);
      const highClaimed = [];
      let revJobs = null, revIdx = 0, met = false;
      let prevRunning = false;
      let didWork = false;
      let idleLogged = false;
      const { drain: drainWrites, enqueue: enqueueWrite } = makeWritePool({
         "onEnqueue": () => { didWork = true; }
      });

      while (true) {
         const lowDone = low.state.taken >= half;
         const firstHighDone = high.state.taken >= half || met;
         if (firstHighDone && revJobs == null) {
            await drainWrites();
            revJobs = highClaimed.slice().reverse();
            revIdx = 0;
            console.log(`high-reverse: ${revJobs.length} buckets from last high-pass boundary (middle) toward max _id`);
         }
         const reverseDone = firstHighDone && revJobs != null && revIdx >= revJobs.length;
         if (lowDone && firstHighDone && reverseDone) break;

         if (cacheStressed()) {
            console.log('cache stressed, pausing meetInMiddle writes');
            await drainWrites();
            await delay(idlePollMs);
            continue;
         }
         const ckpt = wtCheckpoint();
         if (prevRunning && ckpt.available && !ckpt.running) {
            await drainWrites();
            console.log('checkpoint finished, refreshing settled collStats...');
            snap = collSnapshot();
            fill = pageStats(snap);
            console.log(`settled targetFill ${fill.pageFillTarget} actualFill ${fill.pageFillActual} reusable ${snap.freeStorageSize}`);
            console.log(EJSON.stringify({ "state": "settled storage", ...snap }));
            low.state.batchSize = scaledBatch(fill.pageFillTarget);
            high.state.batchSize = scaledBatch(fill.pageFillTarget);
         }
         prevRunning = !!(ckpt.available && ckpt.running);

         let ckptRunning = !!(ckpt.available && ckpt.running);
         let wantLow = !ckptRunning && !lowDone;
         let wantFirstHigh = ckptRunning && !firstHighDone;

         // Lag throttle only when we are about to write on the idle path.
         // Do not lag-wait while parked for the first high pass — that delayed
         // noticing a checkpoint that started during the cool-off.
         if (wantLow) await waitForReplLag({ "abortIfCheckpoint": true });
         else if (firstHighDone && !reverseDone && !ckptRunning) {
            await waitForReplLag({ "abortIfCheckpoint": true });
         }
         {
            const again = wtCheckpoint();
            ckptRunning = !!(again.available && again.running);
            wantLow = !ckptRunning && !lowDone;
            wantFirstHigh = ckptRunning && !firstHighDone;
         }

         if (wantLow || wantFirstHigh) {
            idleLogged = false;
            const pass = wantLow ? low : high;
            const passName = wantLow ? 'low' : 'high';
            if (wantFirstHigh) low.state.meetHigh = high.state.beforeId;
            else high.state.meetLow = low.state.afterId;
            const jobs = [];
            for (let i = 0; i < conc && pass.state.taken < half; i++) {
               const { value, done } = await pass.gen.next();
               if (done || value == null) break;
               jobs.push(value);
            }
            if (!jobs.length) {
               pass.state.taken = half;
               continue;
            }
            for (const job of jobs) {
               if (wantFirstHigh) highClaimed.push(job);
               console.log(`\t${passName} n=${job.n} filter=${job.ids ? ('$in ' + job.ids.length) : 'range'} beforeId=${high.state.beforeId}`);
               await enqueueWrite(rewriteFilter(jobFilter(job)), conc);
            }
            if (!met && low.state.afterId !== undefined && high.state.beforeId !== undefined) {
               const gap = namespace.find({
                  "_id": { "$gt": low.state.afterId, "$lt": high.state.beforeId }
               }).hint({ "_id": 1 }).limit(1).toArray();
               if (!gap.length) {
                  console.log('meetInMiddle: low and high passes met');
                  met = true;
               }
            }
         } else if (firstHighDone && !reverseDone) {
            idleLogged = false;
            const job = revJobs[revIdx++];
            console.log(`\thigh-reverse ${revIdx}/${revJobs.length} n=${job.n}`);
            await enqueueWrite(rewriteFilter(jobFilter(job)), conc);
         } else {
            if (!idleLogged) {
               if (ckptRunning) {
                  console.log('high pass complete, waiting for checkpoint to finish for low pass');
               } else if (high.state.taken > 0 || highClaimed.length) {
                  console.log('waiting for checkpoint to continue high pass');
               } else {
                  console.log('waiting for checkpoint to start high pass');
               }
               idleLogged = true;
            }
            await delay(idlePollMs);
         }
      }

      await drainWrites();
      if (didWork) {
         await waitForCheckpoint();
         snap = collSnapshot();
         fill = pageStats(snap);
         console.log(`final targetFill ${fill.pageFillTarget} actualFill ${fill.pageFillActual}`);
         console.log(EJSON.stringify({ "state": "settled storage", ...snap }));
      }
   }

   // strategy 'lowStressMode': single _id ascending pass (ids/ranges curator).
   // Writes when checkpoint idle; throttle by repl lag and updates allocated
   // (soft 7% / hard 8%, overshoot lowers soft). Pause if dirty trigger or
   // eviction_updates_trigger (10%) hits first.
   async function lowStressModeMain() {
      let snap = collSnapshot();
      let fill = pageStats(snap);
      const concExplicit = Object.prototype.hasOwnProperty.call(userOptions, 'writeConcurrency');
      const concNow = () => (concExplicit && Number(writeConcurrency) > 0)
                          ? Math.ceil(writeConcurrency)
                          : 1;
      let conc = concNow();
      const dirtyTune = {
         "base": Number(lowStressDirtyMax) > 0 ? +lowStressDirtyMax : 0.07,
         "soft": Number(lowStressDirtyMax) > 0 ? +lowStressDirtyMax : 0.07,
         "hard": Number(lowStressDirtyHard) > 0 ? +lowStressDirtyHard : 0.08
      };
      const coverPasses = Object.prototype.hasOwnProperty.call(userOptions, 'passes') && Number(passes) > 0
                        ? Math.ceil(passes)
                        : 3;
      console.log(`strategy: lowStressMode curator: ${curator} writeConcurrency: ${conc} updates soft ${(dirtyTune.soft * 100).toFixed(2)}% hard ${(dirtyTune.hard * 100).toFixed(2)}%`);
      console.log(`docs: ${fill.documentCount} batch: ${fill.batchSize} curatorBatch: ${scaledBatch(fill.pageFillTarget)} targetFill: ${fill.pageFillTarget} actualFill: ${fill.pageFillActual}`);
      console.log(EJSON.stringify({ "state": "initial storage", ...snap }));

      let prevRunning = false;
      let didWork = false;
      const { drain: drainWrites, enqueue: enqueueWrite } = makeWritePool({
         "onEnqueue": () => { didWork = true; }
      });

      for (let pass = 1; pass <= coverPasses; pass++) {
         fill = pageStats(snap);
         const direction = (pass % 2 === 1) ? 1 : -1;
         const walk = startCurator(direction, fill.pageFillTarget, fill.documentCount || 1);
         console.log(`lowStressMode pass ${pass}/${coverPasses} maxDocs ${walk.state.maxDocs} sort _id:${direction}`);
         while (walk.state.taken < walk.state.maxDocs) {
            await waitForDirtyUnder(dirtyTune);
            await waitForReplLag({ "abortIfCheckpoint": true });
            const beforeCkpt = wtCheckpoint();
            await waitForCheckpoint();
            const ckpt = wtCheckpoint();
            if (ckpt.available && ckpt.running) continue;
            if (ckpt.available && !ckpt.running && (prevRunning || beforeCkpt.running)) {
               await drainWrites();
               snap = collSnapshot();
               fill = pageStats(snap);
               conc = concNow();
               walk.state.batchSize = scaledBatch(fill.pageFillTarget);
               console.log(`settled targetFill ${fill.pageFillTarget} actualFill ${fill.pageFillActual} reusable ${snap.freeStorageSize}`);
               console.log(EJSON.stringify({ "state": "settled storage", ...snap }));
            }
            prevRunning = !!(ckpt.available && ckpt.running);

            const jobs = [];
            for (let i = 0; i < conc && walk.state.taken < walk.state.maxDocs; i++) {
               const { value, done } = await walk.gen.next();
               if (done || value == null) break;
               jobs.push(value);
            }
            if (!jobs.length) break;
            for (const job of jobs) {
               console.log(`\tlowStress n=${job.n} filter=${job.ids ? ('$in ' + job.ids.length) : 'range'}`);
               await enqueueWrite(rewriteFilter(jobFilter(job)), conc);
            }
         }
         if (pass < coverPasses) {
            await drainWrites();
            console.log(`pass ${pass} complete; waiting for next checkpoint to start and finish before pass ${pass + 1}`);
            await waitForCheckpoint({ "settle": true });
            snap = collSnapshot();
            fill = pageStats(snap);
            conc = concNow();
            console.log(`between-pass settled targetFill ${fill.pageFillTarget} actualFill ${fill.pageFillActual} reusable ${snap.freeStorageSize}`);
            console.log(EJSON.stringify({ "state": "settled storage", ...snap }));
         }
      }

      await drainWrites();
      if (didWork) {
         snap = collSnapshot();
         fill = pageStats(snap);
         console.log(`final targetFill ${fill.pageFillTarget} actualFill ${fill.pageFillActual}`);
         console.log(EJSON.stringify({ "state": "settled storage", ...snap }));
      }
   }

   // strategy 'updateOne': same walk/throttles as lowStressMode, but each txn
   // is updateOne on a single _id (curator batch size 1).
   async function updateOneModeMain() {
      let snap = collSnapshot();
      let fill = pageStats(snap);
      const concExplicit = Object.prototype.hasOwnProperty.call(userOptions, 'writeConcurrency');
      const concNow = () => (concExplicit && Number(writeConcurrency) > 0)
                          ? Math.ceil(writeConcurrency)
                          : Math.max(1, fill.pageFillTarget || 1);
      let conc = concNow();
      const dirtyTune = {
         "base": Number(lowStressDirtyMax) > 0 ? +lowStressDirtyMax : 0.07,
         "soft": Number(lowStressDirtyMax) > 0 ? +lowStressDirtyMax : 0.07,
         "hard": Number(lowStressDirtyHard) > 0 ? +lowStressDirtyHard : 0.08
      };
      const coverPasses = Number(passes) > 0 ? Math.ceil(passes) : 1;
      console.log(`strategy: updateOne writeConcurrency: ${conc} (pageFillTarget) updates soft ${(dirtyTune.soft * 100).toFixed(2)}% hard ${(dirtyTune.hard * 100).toFixed(2)}%`);
      console.log(`docs: ${fill.documentCount} (1 doc per updateOne) actualFill: ${fill.pageFillActual} targetFill: ${fill.pageFillTarget}`);
      console.log(EJSON.stringify({ "state": "initial storage", ...snap }));

      let prevRunning = false;
      let didWork = false;
      let written = 0;
      const { drain: drainWrites, enqueue: enqueueWrite } = makeWritePool({
         "onEnqueue": () => { didWork = true; }
      });

      for (let pass = 1; pass <= coverPasses; pass++) {
         fill = pageStats(snap);
         const walk = startCurator(1, 1, fill.documentCount || 1, 'ids');
         walk.state.batchSize = 1;
         console.log(`updateOne pass ${pass}/${coverPasses} maxDocs ${walk.state.maxDocs}`);
         while (walk.state.taken < walk.state.maxDocs) {
            await waitForDirtyUnder(dirtyTune);
            await waitForReplLag({ "abortIfCheckpoint": true });
            const beforeCkpt = wtCheckpoint();
            await waitForCheckpoint();
            const ckpt = wtCheckpoint();
            if (ckpt.available && ckpt.running) continue;
            if (ckpt.available && !ckpt.running && (prevRunning || beforeCkpt.running)) {
               await drainWrites();
               snap = collSnapshot();
               fill = pageStats(snap);
               conc = concNow();
               walk.state.batchSize = 1;
               console.log(`settled targetFill ${fill.pageFillTarget} actualFill ${fill.pageFillActual} reusable ${snap.freeStorageSize} writeConcurrency ${conc}`);
               console.log(EJSON.stringify({ "state": "settled storage", ...snap }));
            }
            prevRunning = !!(ckpt.available && ckpt.running);

            const jobs = [];
            for (let i = 0; i < conc && walk.state.taken < walk.state.maxDocs; i++) {
               const { value, done } = await walk.gen.next();
               if (done || value == null) break;
               jobs.push(value);
            }
            if (!jobs.length) break;
            for (const job of jobs) {
               for (const id of jobIds(job)) {
                  written++;
                  if (written % 100 === 0) console.log(`\tupdateOne written ${written}`);
                  await enqueueWrite(rewriteOne(id), conc);
               }
            }
         }
      }

      await drainWrites();
      if (didWork) {
         snap = collSnapshot();
         fill = pageStats(snap);
         console.log(`final targetFill ${fill.pageFillTarget} actualFill ${fill.pageFillActual} written ${written}`);
         console.log(EJSON.stringify({ "state": "settled storage", ...snap }));
      }
   }

   // Packed-sample temps live in __tmpdb_for_collection_stats so we do not
   // create collections in the source db (may lack createCollection). Names
   // are <sourceDb>.<sourceColl>_<oid> (dots allowed; no $). Needs readWrite
   // on that tmp db.
   const tmpStatsDbName = '__tmpdb_for_collection_stats';
   function tmpStatsDb() {
      return db.getSiblingDB(tmpStatsDbName);
   }

   function tmpSamplePrefix() {
      return `${nsDb}.${nsColl}`;
   }

   function isTmpSampleName(name) {
      const prefix = tmpSamplePrefix();
      return typeof name === 'string' && (name === prefix || name.startsWith(prefix + '_'));
   }

   function tmpSampleName() {
      const oid = new ObjectId();
      const hex = typeof oid.toHexString === 'function'
                ? oid.toHexString()
                : String(oid).replace(/[^a-f0-9]/gi, '').slice(-24);
      return `${tmpSamplePrefix()}_${hex}`;
   }

   function dropTmpSample(tmpDb, name, reason = 'drop') {
      try {
         tmpDb.getCollection(name).drop();
         console.log(`${reason}: dropped ${tmpStatsDbName}.${name}`);
         return true;
      } catch(_) {
         return false;
      }
   }

   // Drop leftover temps for this source ns in __tmpdb_for_collection_stats.
   function preflightDropTmpSamples() {
      const tmpDb = tmpStatsDb();
      let names = [];
      try {
         names = tmpDb.getCollectionNames().filter(isTmpSampleName);
      } catch(e) {
         console.log(`preflight: list collections failed, ${e.message || e}`);
         return;
      }
      let n = 0;
      for (const name of names) {
         if (dropTmpSample(tmpDb, name, 'preflight')) n++;
      }
      if (n) console.log(`preflight: removed ${n} leftover sample collection(s) matching ${tmpSamplePrefix()}`);
      else console.log(`preflight: no leftover sample collections matching ${tmpSamplePrefix()}`);
   }

   function packedCalibBins() {
      return 24;
   }

   function detectSizeModes(tmpDb, tmpName, compression, packedBudget) {
      // Packed (bson/C) equal-width bins on [0, pageFillRatio×32KiB]. Larger docs
      // spill to their own leaf (TFR=1) and are excluded from C-band hunt.
      const C = Math.max(Number(compression) > 0 ? +compression : 1, 0.01);
      const cap = Math.max(1, Math.floor(Number(packedBudget) > 0 ? +packedBudget : 0.9 * 32768));
      const nBins = packedCalibBins();
      const step = cap / nBins;
      const boundaries = [];
      for (let i = 0; i <= nBins; i++) {
         const v = Math.round(i * step);
         if (!boundaries.length || v > boundaries[boundaries.length - 1]) boundaries.push(v);
      }
      if (boundaries[boundaries.length - 1] <= cap) boundaries.push(cap + 1);
      if (boundaries.length < 2) return [];
      let facet = [];
      try {
         facet = tmpDb.getCollection(tmpName).aggregate([
            { "$project": {
               "packed": {
                  "$divide": [
                     { "$ifNull": [{ "$bsonSize": "$$ROOT" }, 0] },
                     C
                  ]
               }
            } },
            { "$facet": {
               "inLeaf": [
                  { "$match": { "packed": { "$lte": cap } } },
                  { "$bucket": {
                     "groupBy": "$packed",
                     "boundaries": boundaries,
                     "default": "overflow",
                     "output": { "n": { "$sum": 1 }, "avg": { "$avg": "$packed" } }
                  } }
               ],
               "jumbo": [
                  { "$match": { "packed": { "$gt": cap } } },
                  { "$count": "n" }
               ]
            } }
         ], aggOpts("calibrate packed-size histogram")).toArray();
      } catch(e) {
         console.log(`calibrate modes: histogram failed, ${e.message || e}`);
         return [];
      }
      const jumboN = facet[0]?.jumbo?.[0]?.n || 0;
      if (jumboN) console.log(`calibrate modes: jumbos n=${jumboN} packed>${cap} TFR=1 (own leaf, skip C bands)`);
      const bins = (facet[0]?.inLeaf || []).filter(b => b._id !== 'overflow');
      if (bins.length < 3) {
         console.log(`calibrate modes: unimodal (${bins.length} in-leaf bins, cap=${cap})`);
         return [];
      }
      const d = bins.map(b => (b.n || 0) / Math.max(step, 1));
      const peaks = [];
      for (let i = 0; i < bins.length; i++) {
         const prev = i > 0 ? d[i - 1] : 0;
         const next = i < bins.length - 1 ? d[i + 1] : 0;
         if ((bins[i].n || 0) >= 20 && d[i] >= prev && d[i] >= next) peaks.push(i);
      }
      const groups = [];
      for (const i of peaks) {
         if (groups.length && i <= groups[groups.length - 1].hi + 1) groups[groups.length - 1].hi = i;
         else groups.push({ "lo": i, "hi": i });
      }
      const densNote = bins.map((b, i) => `${Math.round(Number(b._id))}:${d[i].toFixed(2)}`).join(',');
      if (groups.length < 2) {
         console.log(`calibrate modes: unimodal (${bins.length} packed bins 0–${cap}, density-peaks=${groups.length}) ${densNote}`);
         return [];
      }
      const binHi = (i) => {
         const lo = Number(bins[i]._id);
         const nxt = i + 1 < bins.length ? Number(bins[i + 1]._id) : cap;
         return Number.isFinite(nxt) ? nxt : cap;
      };
      const modes = [];
      for (let g = 0; g < groups.length; g++) {
         const { lo, hi } = groups[g];
         let peakD = 0;
         for (let i = lo; i <= hi; i++) peakD = Math.max(peakD, d[i]);
         const prevHi = g > 0 ? groups[g - 1].hi : -1;
         const nextLo = g + 1 < groups.length ? groups[g + 1].lo : bins.length;
         let a = lo, b = hi;
         while (a - 1 > prevHi && d[a - 1] >= peakD * 0.25) a--;
         while (b + 1 < nextLo && d[b + 1] >= peakD * 0.25) b++;
         let n = 0, avgSum = 0;
         for (let i = a; i <= b; i++) {
            n += bins[i].n || 0;
            avgSum += (bins[i].avg || 0) * (bins[i].n || 0);
         }
         modes.push({
            "min": Number(bins[a]._id),
            "max": binHi(b),
            "n": n,
            "avg": n > 0 ? avgSum / n : 0
         });
      }
      const merged = [];
      for (const m of modes) {
         const p = merged[merged.length - 1];
         if (p && m.min < p.max) {
            const n2 = p.n + m.n;
            p.avg = n2 > 0 ? (p.avg * p.n + m.avg * m.n) / n2 : p.avg;
            p.n = n2;
            if (m.max > p.max) p.max = m.max;
            if (m.min < p.min) p.min = m.min;
         } else merged.push({ "min": m.min, "max": m.max, "n": m.n, "avg": m.avg });
      }
      if (merged.length < 2) {
         console.log(`calibrate modes: unimodal after merge (${modes.length} overlapping packed peaks)`);
         return [];
      }
      console.log(`calibrate modes: ${merged.length} packed bands (0–${cap}) ` + merged.map((m, k) => {
         const close = k === merged.length - 1 ? ']' : ')';
         return `[${Math.round(m.min)}, ${Math.round(m.max)}${close} n=${m.n} avg=${Math.round(m.avg)}`;
      }).join('; '));
      return merged;
   }

   async function measureModeCompression(tmpDb, srcName, modes, compressor, fallbackC) {
      const created = [];
      try {
         for (let k = 0; k < modes.length; k++) {
            const m = modes[k];
            const oid = new ObjectId();
            const hex = typeof oid.toHexString === 'function'
                      ? oid.toHexString()
                      : String(oid).replace(/[^a-f0-9]/gi, '').slice(-24);
            const name = `${tmpSamplePrefix()}_m${k}_${hex}`;
            try {
               tmpDb.createCollection(name, {
                  "storageEngine": { "wiredTiger": { "configString": `block_compressor=${compressor}` } }
               });
            } catch(_) {
               tmpDb.createCollection(name);
            }
            created.push(name);
            const C0 = Math.max(Number(fallbackC) > 0 ? +fallbackC : 1, 0.01);
            const packedExpr = { "$divide": [{ "$ifNull": [{ "$bsonSize": "$$ROOT" }, 0] }, C0] };
            const bound = k === modes.length - 1
                        ? { "$lte": [packedExpr, m.max] }
                        : { "$lt": [packedExpr, m.max] };
            tmpDb.getCollection(srcName).aggregate([
               { "$match": { "$expr": { "$and": [
                  { "$gte": [packedExpr, m.min] },
                  bound
               ] } } },
               { "$merge": {
                  "into": { "db": tmpStatsDbName, "coll": name },
                  "whenMatched": "replace",
                  "whenNotMatched": "insert"
               } }
            ], aggOpts(`${strategy} calibrate mode ${k} $merge`)).toArray();
         }
         console.log('calibrate modes: waiting for checkpoint before per-mode $collStats');
         await waitForCheckpoint({ "settle": true, "force": true });
         if (!wtCheckpoint().available && created[0]) {
            console.log('M0: polling mode temps for packed $collStats');
            await waitForPackedStats(tmpStatsDbName, created[0]);
         }
         for (let k = 0; k < modes.length; k++) {
            const packed = $collStats(tmpStatsDbName, created[k]) || {};
            const { indexes, ...stats } = packed;
            const ps = pageStats(stats);
            const live = Math.max(0, (stats.storageSize || 0) - (stats.freeStorageSize || 0));
            const C = live > 0 && (stats.dataSize || 0) > 0 ? stats.dataSize / live : fallbackC;
            modes[k].compression = Number(C) > 0 ? C : fallbackC;
            modes[k].tfr = ps.pageFillActual;
            modes[k].avgObjSize = stats.avgObjSize;
            modes[k].objects = ps.documentCount;
            const close = k === modes.length - 1 ? ']' : ')';
            console.log(`calibrate mode ${k} packed=[${Math.round(modes[k].min)}, ${Math.round(modes[k].max)}${close} n=${modes[k].objects} C=${modes[k].compression.toFixed(3)} tfr=${modes[k].tfr} avgObjSize=${modes[k].avgObjSize}`);
         }
         return modes;
      } finally {
         for (const name of created) dropTmpSample(tmpDb, name, 'calibrate mode');
      }
   }

   function detectShapes(tmpDb, tmpName) {
      let rows = [];
      try {
         rows = tmpDb.getCollection(tmpName).aggregate([
            shapeProjectStage(),
            { "$group": { "_id": "$shape", "n": { "$sum": 1 }, "avg": { "$avg": "$bson" } } },
            { "$sort": { "n": -1 } }
         ], aggOpts("calibrate shape histogram")).toArray();
      } catch(e) {
         console.log(`calibrate shapes: histogram failed, ${e.message || e}`);
         return [];
      }
      const shapes = (rows || []).map(r => ({
         "hash": r._id,
         "sig": keysSig(r._id),
         "n": r.n || 0,
         "avg": r.avg || 0
      }));
      if (!shapes.length) {
         console.log('calibrate shapes: none');
         return [];
      }
      const shown = shapes.slice(0, 8).map(s => `h=${s.sig} n=${s.n} avg=${Math.round(s.avg)}`);
      console.log(`calibrate shapes: ${shapes.length}` + (shapes.length > 8 ? ` (top 8)` : '') + ' ' + shown.join('; '));
      return shapes;
   }

   async function measureShapeCompression(tmpDb, srcName, shapes, compressor, fallbackC) {
      const maxMeasure = 12;
      const todo = shapes.slice(0, maxMeasure);
      const created = [];
      try {
         for (let k = 0; k < todo.length; k++) {
            const s = todo[k];
            const oid = new ObjectId();
            const hex = typeof oid.toHexString === 'function'
                      ? oid.toHexString()
                      : String(oid).replace(/[^a-f0-9]/gi, '').slice(-24);
            const name = `${tmpSamplePrefix()}_s${k}_${hex}`;
            try {
               tmpDb.createCollection(name, {
                  "storageEngine": { "wiredTiger": { "configString": `block_compressor=${compressor}` } }
               });
            } catch(_) {
               tmpDb.createCollection(name);
            }
            created.push(name);
            tmpDb.getCollection(srcName).aggregate([
               { "$set": { "shape": shapeHashExpr() } },
               { "$match": { "shape": s.hash } },
               { "$unset": "shape" },
               { "$merge": {
                  "into": { "db": tmpStatsDbName, "coll": name },
                  "whenMatched": "replace",
                  "whenNotMatched": "insert"
               } }
            ], aggOpts(`${strategy} calibrate shape ${k} $merge`)).toArray();
         }
         console.log('calibrate shapes: waiting for checkpoint before per-shape $collStats');
         await waitForCheckpoint({ "settle": true, "force": true });
         if (!wtCheckpoint().available && created[0]) {
            console.log('M0: polling shape temps for packed $collStats');
            await waitForPackedStats(tmpStatsDbName, created[0]);
         }
         for (let k = 0; k < todo.length; k++) {
            const packed = $collStats(tmpStatsDbName, created[k]) || {};
            const { indexes, ...stats } = packed;
            const ps = pageStats(stats);
            const live = Math.max(0, (stats.storageSize || 0) - (stats.freeStorageSize || 0));
            const C = live > 0 && (stats.dataSize || 0) > 0 ? stats.dataSize / live : fallbackC;
            todo[k].compression = Number(C) > 0 ? C : fallbackC;
            todo[k].tfr = ps.pageFillActual;
            todo[k].avgObjSize = stats.avgObjSize;
            todo[k].objects = ps.documentCount;
            console.log(`calibrate shape ${k} h=${todo[k].sig} n=${todo[k].objects} C=${todo[k].compression.toFixed(3)} tfr=${todo[k].tfr} avgObjSize=${todo[k].avgObjSize}`);
         }
         return shapes;
      } finally {
         for (const name of created) dropTmpSample(tmpDb, name, 'calibrate shape');
      }
   }

   // $sample+$merge into __tmpdb_for_collection_stats.<db>.<coll>_<oid>
   // (same compressor). TFR = packed pageFillActual. Optional size-mode or
   // shape-hash C from extra temps in the same tmp db.
   async function calibrateTFR() {
      const src = collSnapshot();
      const fill = pageStats(src);
      const compressor = (src.compressor && src.compressor !== 'mixed') ? src.compressor : 'snappy';
      const avg = +src.avgObjSize > 0 ? +src.avgObjSize : 256;
      const leaf = fill.dataPageSize || 32 * 1024;
      if (avg >= leaf) {
         const live = Math.max(0, (src.storageSize || 0) - (src.freeStorageSize || 0));
         const compression = live > 0 && (src.dataSize || 0) > 0 ? src.dataSize / live : 1;
         console.log(`calibrate: avgObjSize=${avg} >= leaf=${leaf}; TFR=1 skip sample and bin analysis`);
         return { "tfr": 1, "compression": compression, "avgObjSize": avg, "ps": fill, "modes": [], "shapes": [] };
      }
      const nBins = packedCalibBins();
      const packedCap = Math.max(1, Math.floor((Number(pageFillRatio) > 0 ? +pageFillRatio : 0.9) * leaf));
      const assumeC = 3;
      const minBson = 256;
      const packedMin = minBson / assumeC;
      const perLowBin = Math.max(20, Math.ceil(2 * packedCap / packedMin));
      const sampleNeed = nBins * perLowBin;
      const nObjs = src.objects || 0;
      const sampleN = Math.min(nObjs, Number(shuffleSampleSize) > 0
         ? Math.ceil(+shuffleSampleSize)
         : sampleNeed);
      if (sampleN < 1) throw new Error(`${strategy}: empty namespace, cannot calibrate TFR`);
      const tmpName = tmpSampleName();
      const tmpDb = tmpStatsDb();
      const sampleCap = randomCursorSampleCap(nObjs);
      const sampleDraws = (nObjs > 100 && sampleN > sampleCap)
         ? Math.ceil(sampleN / sampleCap)
         : 1;
      console.log(`${strategy} calibrate: $sample ${sampleN} (${nBins} packed bins × ${perLowBin} docs; 2 leaves at bson>=${minBson} C=${assumeC}) compressor=${compressor} -> ${tmpStatsDbName}.${tmpName}`);
      try {
         try {
            tmpDb.createCollection(tmpName, {
               "storageEngine": { "wiredTiger": { "configString": `block_compressor=${compressor}` } }
            });
         } catch(_) {
            tmpDb.createCollection(tmpName);
         }
         console.log(`calibrate collection created: ${tmpStatsDbName}.${tmpName}`);
         // One $sample >=5% of n COLLSCAN+sorts every document. M0 ignores
         // allowDiskUse (32MiB), which is how 16k of ~204k threw here.
         if (sampleDraws > 1) {
            console.log(`calibrate: $sample ${sampleN} is >=5% of ${nObjs}; ${sampleDraws} random-cursor draws of <=${sampleCap}`);
         }
         let remaining = sampleN;
         while (remaining > 0) {
            const size = (nObjs > 100) ? Math.min(remaining, Math.max(1, sampleCap)) : remaining;
            namespace.aggregate([
               { "$sample": { "size": size } },
               { "$merge": {
                  "into": { "db": tmpStatsDbName, "coll": tmpName },
                  "whenMatched": "keepExisting",
                  "whenNotMatched": "insert"
               } }
            ], aggOpts(`${strategy} calibrate $merge`)).toArray();
            remaining -= size;
            if (nObjs <= 100) break;
         }
         console.log('calibrate: waiting for checkpoint before packed $collStats');
         await waitForCheckpoint({ "settle": true, "force": true });
         let packed = $collStats(tmpStatsDbName, tmpName) || {};
         if (!wtCheckpoint().available) {
            console.log('M0: no checkpoint metrics; polling packed $collStats');
            packed = await waitForPackedStats(tmpStatsDbName, tmpName);
         }
         const { indexes, ...stats } = packed;
         const ps = pageStats(stats);
         const live = Math.max(0, (stats.storageSize || 0) - (stats.freeStorageSize || 0));
         const compression = live > 0 ? (stats.dataSize || 0) / live : 1;
         const ratio = Number(pageFillRatio) > 0 ? +pageFillRatio : 1;
         const leafFill = Math.max(1, Math.ceil((ratio * (ps.dataPageSize || leaf) * compression) / (stats.avgObjSize > 0 ? stats.avgObjSize : avg)));
         let tfr = Math.max(1, ps.pageFillActual);
         if (ps.nPages <= 1) {
            tfr = leafFill;
            console.log(`packed nPages=${ps.nPages} (unsettled or tiny file); TFR from leaf fill = ${tfr}`);
         }
         console.log(`calibrated TFR=${tfr} (packedFill) compression=${compression.toFixed(3)} packedFill=${ps.pageFillActual} packedPages=${ps.nPages} objects=${ps.documentCount} avgObjSize=${stats.avgObjSize} storageSize=${stats.storageSize}`);
         let modes = [];
         let shapes = [];
         const wantShapes = strategy === 'shapeQuantile' || sampler === 'shapeQuantile';
         try {
            if (wantShapes) {
               shapes = detectShapes(tmpDb, tmpName);
               if (shapes.length >= 2) {
                  shapes = await measureShapeCompression(tmpDb, tmpName, shapes, compressor, compression);
               }
            } else {
               modes = detectSizeModes(tmpDb, tmpName, compression, Math.floor((Number(pageFillRatio) > 0 ? +pageFillRatio : 0.9) * (ps.dataPageSize || 32 * 1024)));
               if (modes.length >= 2) {
                  modes = await measureModeCompression(tmpDb, tmpName, modes, compressor, compression);
               }
            }
         } catch(e) {
            console.log(`calibrate modes/shapes skipped: ${e.message || e}`);
            modes = [];
            shapes = [];
         }
         return { "tfr": tfr, "compression": compression, "avgObjSize": stats.avgObjSize, "ps": ps, "modes": modes, "shapes": shapes };
      } finally {
         dropTmpSample(tmpDb, tmpName, 'calibrate');
      }
   }

   // strategy 'slidingShuffle': TFR stride passes; pass p takes _id ranks
   // p, p+TFR, p+2TFR, … in batches of TFR. Each _id once. Writes when
   // checkpoint idle, lag and updates % in bounds.
   async function slidingShuffleMain() {
      const srcSnap = collSnapshot();
      console.log(EJSON.stringify({ "state": "initial storage", ...srcSnap }));
      const cal = await calibrateTFR();
      const tfr = cal.tfr;
      const nDocs = srcSnap.objects || pageStats(srcSnap).documentCount || 0;
      const totalBatches = Math.max(1, Math.ceil(nDocs / tfr));
      const conc = Math.max(1, Number(writeConcurrency) > 0 ? Math.ceil(writeConcurrency) : 1);
      const dirtyTune = {
         "base": Number(lowStressDirtyMax) > 0 ? +lowStressDirtyMax : 0.07,
         "soft": Number(lowStressDirtyMax) > 0 ? +lowStressDirtyMax : 0.07,
         "hard": Number(lowStressDirtyHard) > 0 ? +lowStressDirtyHard : 0.08
      };
      console.log(`strategy: slidingShuffle TFR=${tfr} stridePasses=${tfr} coverBatches=${totalBatches} (docs ${nDocs} / TFR) idsPerBatch=${tfr} writeConcurrency=${conc} updates soft ${(dirtyTune.soft * 100).toFixed(2)}% hard ${(dirtyTune.hard * 100).toFixed(2)}%`);

      const { drain: drainWrites, enqueue: enqueueWrite } = makeWritePool();

      let globalBatch = 0;
      const writeWindow = { "snap": srcSnap, "bytes": 0 };
      for (let p = 0; p < tfr; p++) {
         console.log(`slidingShuffle stride ${p + 1}/${tfr} (ranks ${p}, ${p + tfr}, ${p + 2 * tfr}, …) until EOF`);
         let afterId, i = 0, strideBatch = 0;
         for (;;) {
            await waitForDirtyUnder(dirtyTune);
            await waitForReplLag({ "abortIfCheckpoint": true });
            await waitForCheckpoint();
            const ckpt = wtCheckpoint();
            if (ckpt.available && ckpt.running) continue;
            const ids = [];
            const q = afterId !== undefined ? { "_id": { "$gt": afterId } } : {};
            const cursor = namespace.find(q, { "_id": 1 }).sort({ "_id": 1 }).hint({ "_id": 1 });
            let eof = true;
            try {
               for await (const doc of cursor) {
                  if (i % tfr === p) {
                     ids.push(doc._id);
                     afterId = doc._id;
                  }
                  i++;
                  if (ids.length >= tfr) {
                     eof = false;
                     break;
                  }
               }
            } finally {
               try { cursor.close(); } catch(_) { /* exhausted */ }
            }
            if (!ids.length) break;
            const nextBytes = estimateRewriteBytes(ids.length, cal);
            await ensureReusableRoom(writeWindow, nextBytes);
            writeWindow.bytes += nextBytes;
            strideBatch++;
            globalBatch++;
            console.log(`\tslidingShuffle stride ${p + 1}/${tfr} batch ${strideBatch} global ${globalBatch}/${totalBatches} n=${ids.length} filter=$in ${ids.length}`);
            await enqueueWrite(rewriteFilter({ "_id": { "$in": ids } }), conc);
            if (eof) break;
         }
         await drainWrites();
      }

      await drainWrites();
      console.log(EJSON.stringify({ "state": "settled storage", ...collSnapshot() }));
   }

   // Shared write/throttle/budget path for slidingWindow, quantile, rndQuantile,
   // shapeQuantile. dirtyBudgetRatio caps packed rewrite bytes per checkpoint
   // at that fraction of freeStorageSize. Falling-edge collStats refreshes R.
   async function slidingPackedMain(label, startWalk) {
      const srcSnap = collSnapshot();
      console.log(EJSON.stringify({ "state": "initial storage", ...srcSnap }));
      const cal = await calibrateTFR();
      const nDocs = srcSnap.objects || pageStats(srcSnap).documentCount || 0;
      const batch = Object.prototype.hasOwnProperty.call(userOptions, 'curatorBatchSize') && Number(curatorBatchSize) > 0
                  ? Math.ceil(+curatorBatchSize)
                  : cal.tfr;
      let walk = startWalk({ "nDocs": nDocs, "batch": batch, "cal": cal });
      if (walk && typeof walk.then === 'function') walk = await walk;
      const streaming = !!walk.streaming;
      const totalBatches = walk.totalBatches > 0 ? walk.totalBatches : Math.max(1, Math.ceil(nDocs / batch));
      const conc = Math.max(1, Number(writeConcurrency) > 0 ? Math.ceil(writeConcurrency) : 1);
      const dirtyTune = {
         "base": Number(lowStressDirtyMax) > 0 ? +lowStressDirtyMax : 0.07,
         "soft": Number(lowStressDirtyMax) > 0 ? +lowStressDirtyMax : 0.07,
         "hard": Number(lowStressDirtyHard) > 0 ? +lowStressDirtyHard : 0.08
      };
      const budgetSnap = collSnapshot();
      const R0 = +budgetSnap.freeStorageSize;
      const frac = Number(dirtyBudgetRatio) > 0 ? dirtyBudgetRatio : 0.05;
      const cap0 = Number.isFinite(R0) && R0 > 0 ? frac * R0 : 0;
      const packedCover = estimateRewriteBytes(nDocs, cal);
      const packedPctR = R0 > 0 ? 100 * packedCover / R0 : 0;
      const live0 = Math.max(0, (budgetSnap.storageSize || 0) - (Number.isFinite(R0) ? R0 : 0));
      const reusablePct = budgetSnap.storageSize > 0 && Number.isFinite(R0) ? 100 * R0 / budgetSnap.storageSize : 0;
      console.log(`strategy: ${label} TFR=${cal.tfr} batch=${batch} buckets=${streaming ? 'first-fit' : totalBatches} (docs ${nDocs}) writeConcurrency=${conc} updates soft ${(dirtyTune.soft * 100).toFixed(2)}% hard ${(dirtyTune.hard * 100).toFixed(2)}% C=${(Number(cal.compression) > 0 ? +cal.compression : 1).toFixed(3)} pageFill=${Number(pageFillRatio) > 0 ? +pageFillRatio : 0.9} dirtyBudgetRatio=${frac} reusable=${Number.isFinite(R0) ? R0 : 0} (${reusablePct.toFixed(1)}% of storageSize) cap=${Math.round(cap0)} (${(100 * frac).toFixed(0)}% of R, compressed) packedCover=${Math.round(packedCover)} (${packedPctR.toFixed(1)}% of R) sourceLive=${live0} storageSize=${budgetSnap.storageSize || 0}`);

      const { drain: drainWrites, enqueue: enqueueWrite } = makeWritePool();

      let pass = 0;
      const writeWindow = { "snap": budgetSnap, "bytes": 0 };
      for (;;) {
         await waitForDirtyUnder(dirtyTune);
         await waitForReplLag({ "abortIfCheckpoint": true });
         const waited = await waitForCheckpoint();
         const ckpt = wtCheckpoint();
         if (!ignoreCheckpoint && ckpt.available && ckpt.running) continue;
         if (waited.completed) {
            await drainWrites();
            refreshReusableCap(writeWindow, 'checkpoint');
         } else if (ignoreCheckpoint) {
            const s = consumeAsyncSnap();
            if (s) refreshReusableCap(writeWindow, 'async stats', s);
            kickCollStats();
         }
         const { value, done } = await walk.gen.next();
         if (done || value == null) break;
         pass++;
         const nextBytes = (Number(value.bson) > 0 || Number(value.packed) > 0)
                         ? batchAllocBytes(value, (cal.ps && cal.ps.dataPageSize) || 32 * 1024, pageFillRatio, cal.compression)
                         : estimateRewriteBytes(value.n || batch, cal);
         await ensureReusableRoom(writeWindow, nextBytes, { "refreshSnap": true, "beforeWait": drainWrites });
         writeWindow.bytes += nextBytes;
         const packedNote = Number(value.packed) > 0 ? ` packed=${Math.round(value.packed)}` : '';
         const bsonNote = Number(value.bson) > 0 ? ` bson=${Math.round(value.bson)}` : '';
         const passTag = streaming ? `${label} ${pass}` : `${label} ${pass}/${totalBatches}`;
         const expect = value.n;
         if (value.ids) {
            const shapeNote = value.shape != null && value.shape !== '' ? ` shape=${value.shape}` : '';
            console.log(`${passTag} n=${value.n}${bsonNote}${packedNote}${shapeNote}`);
            await enqueueWrite(rewriteIds(value.ids, { "expect": expect }), conc);
         } else {
            const bounds = value.range.$lte !== undefined
                         ? `[${value.range.$gte}, ${value.range.$lte}]`
                         : `[${value.range.$gte}, ${value.range.$lt}]`;
            console.log(`${passTag} n=${value.n}${bsonNote}${packedNote} filter=_id ${bounds}`);
            await enqueueWrite(rewriteFilter({ "_id": value.range }, { "expect": expect }), conc);
         }
         if (ignoreCheckpoint) kickCollStats();
      }

      await drainWrites();
      if (streaming) console.log(`${label} done batches=${pass}`);
      console.log(EJSON.stringify({ "state": "settled storage", ...collSnapshot() }));
   }

   // strategy 'slidingWindow': calibrate TFR; adjacent consecutive _id batches
   // of TFR (1–TFR, TFR+1–2TFR, …). Same gates as slidingPackedMain.
   async function slidingWindowMain() {
      await slidingPackedMain('slidingWindow', ({ nDocs, batch }) => startCurator(1, batch, nDocs, 'ranges'));
   }

   // strategy 'quantile': slidingPackedMain + startQuantileCurator.
   async function quantileMain() {
      await slidingPackedMain('quantile', ({ nDocs, cal }) => startQuantileCurator(cal, nDocs));
   }

   // strategy 'rndQuantile': slidingPackedMain + startRndQuantileCurator.
   async function rndQuantileMain() {
      await slidingPackedMain('rndQuantile', ({ nDocs, cal }) => startRndQuantileCurator(cal, nDocs));
   }

   // strategy 'shapeQuantile': slidingPackedMain + startShapeQuantileCurator.
   async function shapeQuantileMain() {
      await slidingPackedMain('shapeQuantile', ({ nDocs, cal }) => startShapeQuantileCurator(cal, nDocs));
   }

   async function naturalWindowMain() {
      await slidingPackedMain('naturalWindow', async({ nDocs, cal }) => startNaturalWindowCurator(cal, nDocs));
   }

   // Frozen $in batches: dirty-budget window, rewrite 1, then replay the same
   // _ids if write 1 extended or R was 0. Skip-replay (no extend) does not wait
   // for a checkpoint; rBudget decrements until a settle replenishes R.
   // Halloween-safe (parked _id).
   async function parkedWindowReplay(label, cal, allBatches, nDocs) {
      const { packedBudget, fillRatio, leaf, compression } = packedPageBudget(cal);
      const dirtyTune = {
         "base": Number(lowStressDirtyMax) > 0 ? +lowStressDirtyMax : 0.07,
         "soft": Number(lowStressDirtyMax) > 0 ? +lowStressDirtyMax : 0.07,
         "hard": Number(lowStressDirtyHard) > 0 ? +lowStressDirtyHard : 0.08
      };
      const frac = Number(dirtyBudgetRatio) > 0 ? +dirtyBudgetRatio : 0.05;
      const conc = Math.max(1, Number(writeConcurrency) > 0 ? Math.ceil(writeConcurrency) : 1);
      const target = allBatches.reduce((s, b) => s + (b.packed || 0), 0);
      const allocCover = allBatches.reduce((s, b) => s + batchAllocBytes(b, leaf, fillRatio, compression), 0);
      const budgetSnap = collSnapshot();
      let R0 = +budgetSnap.freeStorageSize;
      if (!Number.isFinite(R0) || R0 < 0) R0 = 0;
      const window0 = R0 > 0 ? Math.max(leaf / Math.max(compression, 0.01), frac * R0) : leaf;
      const estWindows = window0 > 0 ? Math.max(1, Math.ceil(allocCover / window0)) : 1;
      const reusablePct = budgetSnap.storageSize > 0 ? 100 * R0 / budgetSnap.storageSize : 0;
      console.log(`strategy: ${label} TFR=${cal.tfr} packedBudget=${packedBudget} pageFillRatio=${fillRatio} leaf=${leaf} C=${compression.toFixed(3)} docs=${nDocs} batches=${allBatches.length} packedCover=${Math.round(target)} allocCover=${Math.round(allocCover)} (compressed, nPages×leaf/C) reusable=${R0} (${reusablePct.toFixed(1)}% of storageSize) dirtyBudgetRatio=${frac} windowCap=${Math.round(window0)} (${(100 * frac).toFixed(0)}% of R) estWindows≈${estWindows} writeConcurrency=${conc} updateDelayMs=${Number(updateDelayMs) > 0 ? +updateDelayMs : 0} replay=per-window`);

      const { drain: drainWrites, enqueue: enqueueWrite } = makeWritePool();

      let prevSz = budgetSnap.storageSize;
      let packedDone = 0;
      let cycle = 0;
      let bi = 0;
      let rBudget = R0;
      while (bi < allBatches.length) {
         await waitForDirtyUnder(dirtyTune);
         await waitForReplLag({ "abortIfCheckpoint": true });
         await waitForCheckpoint();
         const ckpt = wtCheckpoint();
         if (ckpt.available && ckpt.running) continue;
         if (!(rBudget >= leaf)) {
            await waitForCheckpoint({ "settle": true });
            await waitForReplLag();
            const replenished = collSnapshot();
            rBudget = +replenished.freeStorageSize;
            if (!Number.isFinite(rBudget) || rBudget < 0) rBudget = 0;
            prevSz = replenished.storageSize;
            if (!(rBudget >= leaf)) rBudget = leaf;
         }
         const snap0 = collSnapshot();
         const windowCap = Math.max(leaf, rBudget * frac);
         const batches = [];
         let windowPacked = 0, windowAlloc = 0, windowN = 0;
         while (bi < allBatches.length && (windowAlloc < windowCap || !batches.length)) {
            const b = allBatches[bi++];
            batches.push(b);
            windowPacked += b.packed || 0;
            windowAlloc += batchAllocBytes(b, leaf, fillRatio, compression);
            windowN += b.n || 0;
         }
         cycle++;
         const sz0 = snap0.storageSize || 0;
         const Rbefore = rBudget;
         console.log(`${label} ${cycle} packedDone=${Math.round(packedDone)}/${Math.round(target)} window n=${windowN} batches=${batches.length}/${allBatches.length} packed=${Math.round(windowPacked)} alloc=${Math.round(windowAlloc)} R=${Number.isFinite(Rbefore) ? Rbefore : 0} cap=${Math.round(windowCap)} storageSize=${sz0} rewrite 1`);
         for (const b of batches) {
            await waitForDirtyUnder(dirtyTune);
            await enqueueWrite(rewriteIds(b.ids, { "expect": b.n }), conc);
         }
         await drainWrites();
         kickCollStats();
         const snap1 = consumeAsyncSnap() || collSnapshot();
         const extended = (snap1.storageSize || 0) > sz0;
         const noReusable = !(Number.isFinite(Rbefore) && Rbefore > 0);
         if (extended || noReusable) {
            await waitForCheckpoint({ "settle": true });
            await waitForReplLag();
            const snapReplay = collSnapshot();
            console.log(`${label} ${cycle} replay batches=${batches.length} n=${windowN} storageSize=${snapReplay.storageSize} reusable=${snapReplay.freeStorageSize || 0} rewrite 2 (${extended ? 'extended' : 'R=0'})`);
            for (const b of batches) {
               await waitForDirtyUnder(dirtyTune);
               await enqueueWrite(rewriteIds(b.ids, { "expect": b.n }), conc);
            }
            await drainWrites();
            kickCollStats();
            await waitForCheckpoint({ "settle": true });
            await waitForReplLag();
            const settled = collSnapshot();
            rBudget = +settled.freeStorageSize;
            if (!Number.isFinite(rBudget) || rBudget < 0) rBudget = 0;
            prevSz = settled.storageSize;
         } else {
            console.log(`${label} ${cycle} skip replay (no extend, R>0) storageSize=${snap1.storageSize} reusable=${snap1.freeStorageSize || 0}`);
            rBudget = Math.max(0, rBudget - windowAlloc);
         }
         packedDone += windowPacked;
         const snap2 = collSnapshot();
         const dSz = (snap2.storageSize || 0) - (prevSz || 0);
         const Rafter = +snap2.freeStorageSize;
         console.log(`${label} cycle ${cycle} packedDone=${Math.round(packedDone)}/${Math.round(target)} packed=${Math.round(windowPacked)} alloc=${Math.round(windowAlloc)} R=${Number.isFinite(Rbefore) ? Rbefore : 0} dStorageSize=${dSz} storageSize=${snap2.storageSize} reusable=${Number.isFinite(Rafter) ? Rafter : 0} rBudget=${Math.round(rBudget)}${dSz > 0 ? ' EXTEND' : ''}`);
         if ((snap2.storageSize || 0) > (prevSz || 0)) prevSz = snap2.storageSize;
      }
      console.log(`${label} done cycles=${cycle} packedDone=${Math.round(packedDone)} targetPacked=${Math.round(target)}`);
      console.log(EJSON.stringify({ "state": "settled storage", ...collSnapshot() }));
   }

   // strategy 'doubleParked': $natural:-1 cover, then parkedWindowReplay.
   async function doubleParkedMain() {
      const srcSnap = collSnapshot();
      console.log(EJSON.stringify({ "state": "initial storage", ...srcSnap }));
      const cal = await calibrateTFR();
      const nDocs = srcSnap.objects || pageStats(srcSnap).documentCount || 0;
      console.log(`doubleParked: scanning ${nDocs} docs $natural:-1 $bsonSize (full cover)`);
      const allBatches = await naturalPackedBatches(cal, nDocs, -1);
      await parkedWindowReplay('doubleParked', cal, allBatches, nDocs);
   }

   // strategy 'naturalReply': naturalWindow cover, then parkedWindowReplay
   // (per-window rewrite 1, conditional replay). Same loop as doubleParked.
   // passes = how many unique $natural covers; each pass rescans (new RecordIds).
   async function naturalReplyMain() {
      const srcSnap = collSnapshot();
      console.log(EJSON.stringify({ "state": "initial storage", ...srcSnap }));
      const cal = await calibrateTFR();
      const dir = Number(naturalDir) >= 0 ? 1 : -1;
      const coverPasses = Number(passes) > 0 ? Math.ceil(passes) : 1;
      for (let pass = 1; pass <= coverPasses; pass++) {
         const snap = pass === 1 ? srcSnap : collSnapshot();
         const nDocs = snap.objects || pageStats(snap).documentCount || 0;
         const label = coverPasses > 1 ? `naturalReply ${pass}/${coverPasses}` : 'naturalReply';
         console.log(`naturalReply: pass ${pass}/${coverPasses} scanning ${nDocs} docs $natural:${dir} $bsonSize (full cover, per-window replay)`);
         const allBatches = await naturalPackedBatches(cal, nDocs, dir);
         await parkedWindowReplay(label, cal, allBatches, nDocs);
         if (pass < coverPasses) await waitForCheckpoint({ "settle": true });
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

   let lagSample = { "at": 0, "value": null };

   function timestampSec(ts) {
      if (ts == null) return null;
      if (typeof ts.t === 'number') return ts.t;
      if (ts.t != null && ts.i != null) return Number(ts.t);
      return null;
   }

   function replLag(fresh = false) {
      // Seconds the commit point / secondaries trail this node's applied optime.
      // Do not use optimeDate min/max (heartbeat alignment → false 0).
      if (!fresh && lagSample.value && Date.now() - lagSample.at < 1000) return lagSample.value;
      let value;
      try {
         const st = db.adminCommand({ "replSetGetStatus": 1 });
         let lag = 0, n = 0;
         const applied = timestampSec(st.optimes?.appliedOpTime?.ts ?? st.optimes?.writtenOpTime?.ts);
         const committed = timestampSec(st.optimes?.lastCommittedOpTime?.ts);
         if (applied != null && committed != null) {
            n++;
            lag = Math.max(lag, applied - committed);
         }
         const members = st.members || [];
         const now = st.date ? +new Date(st.date) : Date.now();
         const primary = members.find(m => m.health && m.stateStr === 'PRIMARY');
         const p = timestampSec(primary?.optime?.ts ?? primary?.optime) ?? (primary?.optimeDate != null ? +new Date(primary.optimeDate) / 1000 : null);
         if (p != null) {
            for (const m of members) {
               if (!m.health || m.stateStr !== 'SECONDARY') continue;
               if (m.lastHeartbeat && now - +new Date(m.lastHeartbeat) > 4000) continue;
               const s = timestampSec(m.optime?.ts ?? m.optime) ?? (m.optimeDate != null ? +new Date(m.optimeDate) / 1000 : null);
               if (s == null) continue;
               n++;
               lag = Math.max(lag, p - s);
            }
         }
         if (n) value = { "available": true, "lagSeconds": Math.max(0, lag), "source": "replSetGetStatus" };
      } catch(_) { /* M0/Flex / unauthorized */ }
      if (!value) {
         const { lastWrite } = serverStatus({ "repl": true }).repl || {};
         const last = lastWrite?.lastWriteDate;
         const maj = lastWrite?.majorityWriteDate;
         value = (last == null || maj == null)
               ? { "available": false, "lagSeconds": 0, "source": null }
               : {
                  "available": true,
                  "lagSeconds": Math.max(0, (new Date(last) - new Date(maj)) / 1000),
                  "source": "lastWrite"
               };
      }
      lagSample = { "at": Date.now(), "value": value };
      return value;
   }

   let lagSkipLogged = false;
   // Throttle when repl lag exceeds maxLagSeconds (rs.status, else lastWrite vs majority).
   async function waitForReplLag({ abortIfCheckpoint = false } = {}) {
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
      // Optime lag is not a wall-clock countdown: with writes paused, secondaries
      // can apply the backlog in one interval (14s → 0s). Wait at least (lag-cap)
      // before the first resume check, then poll every 1s.
      const minCoolMs = Math.max(lagPollMs, (lagSeconds - cap) * 1000);
      await delay(Math.min(minCoolMs, Math.max(1, deadline - Date.now())));
      do {
         if (abortIfCheckpoint && wtCheckpoint().running) {
            console.log('checkpoint running, ending lag throttle for high pass');
            return;
         }
         ({ available, lagSeconds, source } = replLag(true));
         if (!available) return;
         if (lagSeconds <= cap) break;
         console.log(`repl lag ${lagSeconds.toFixed(1)}s via ${source}, still throttling`);
         await delay(Math.min(lagPollMs, Math.max(1, deadline - Date.now())));
      } while (lagSeconds > cap && Date.now() < deadline);
      if (lagSeconds > cap) {
         console.log(`repl lag still ${lagSeconds.toFixed(1)}s after throttle timeout, continuing`);
      } else {
         console.log(`repl lag ${lagSeconds.toFixed(1)}s via ${source}, resuming`);
      }
   }

   let ckptSkipLogged = false, ckptIgnoreLogged = false, fsyncDeniedLogged = false;

   async function tryFsyncCheckpoint() {
      // Kick a WT checkpoint instead of waiting up to 60s for the periodic one.
      // Atlas M0/Flex / unauthorized: command fails; caller polls or waits.
      try {
         const r = await db.adminCommand({ "fsync": 1, "lock": false });
         return r == null || r.ok !== 0;
      } catch(e) {
         if (!fsyncDeniedLogged) {
            console.log(`checkpoint fsync unavailable, ${e.message || e}`);
            fsyncDeniedLogged = true;
         }
         return false;
      }
   }

   async function waitForPackedStats(tmpDbName, tmpName) {
      // M0 proxy for a checkpoint: poll $collStats until storageSize is stable.
      const timeoutMs = Number(checkpointTimeoutMs) > 0
                      ? Math.min(+checkpointTimeoutMs, statsSettleTimeoutMs)
                      : statsSettleTimeoutMs;
      const deadline = Date.now() + timeoutMs;
      let packed = $collStats(tmpDbName, tmpName) || {};
      let prevSz = packed.storageSize, stable = 0;
      console.log(`calibrate poll nPages=${pageStats(packed).nPages} storageSize=${packed.storageSize} objects=${packed.objects}`);
      while (Date.now() < deadline) {
         await delay(statsPollMs);
         packed = $collStats(tmpDbName, tmpName) || {};
         const nPages = pageStats(packed).nPages;
         console.log(`calibrate poll nPages=${nPages} storageSize=${packed.storageSize} objects=${packed.objects}`);
         if (packed.storageSize === prevSz) {
            stable++;
            if (nPages > 1 || stable >= 2) return packed;
         } else stable = 0;
         prevSz = packed.storageSize;
      }
      return packed;
   }

   async function waitForCheckpoint({ settle = false, force = false } = {}) {
      // Do not start writes during a WT checkpoint.
      // settle=false: wait only while a checkpoint is already running.
      // settle=true: fsync if allowed, else wait for a falling edge so
      // block-manager reusable bytes are visible in collStats.
      // force=true: wait even when ignoreCheckpoint (calibrate packed stats).
      // Returns { available, running, completed } — completed is a falling edge
      // this call observed (or fsync). Callers may collSnapshot() then.
      if (ignoreCheckpoint && !force) {
         if (!ckptIgnoreLogged) {
            console.log('ignoreCheckpoint: not pausing for checkpoints; $collStats applied next round');
            ckptIgnoreLogged = true;
         }
         kickCollStats();
         return { "available": wtCheckpoint().available, "running": false, "completed": false, "ignored": true };
      }
      let { available, running, minTimeMS, recentTimeMS } = wtCheckpoint();
      if (settle && await tryFsyncCheckpoint()) {
         ({ available, running } = wtCheckpoint());
         if (!running) {
            console.log('checkpoint fsync completed');
            return { "available": available, "running": false, "completed": true, "fsync": true };
         }
         console.log('checkpoint fsync issued, waiting to complete...');
      }
      if (!available) {
         if (!ckptSkipLogged) {
            console.log('checkpoint metrics unavailable (no wiredTiger in serverStatus), skipping wait');
            ckptSkipLogged = true;
         }
         return { "available": false, "running": false, "completed": false };
      }
      if (!settle && !running) return { "available": true, "running": false, "completed": false };
      const pollMs = Math.min(ckptPollMs, Math.max(50, Math.ceil(0.9 * (minTimeMS || ckptPollMs))));
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
      return { "available": true, "running": running, "completed": completed };
   }

   // strategy 'waves' (default): waves = docs / (TFR × concurrency) per cover
   // pass. Batch size is pinned to calibrated packed TFR (temp collection), not
   // post-wave actualFill. Settled snaps still refresh waveBudget (R / dirty).
   async function main() {
      let snap = collSnapshot();
      const fill0 = pageStats(snap);
      let batch0 = fill0.batchSize || 1;
      try {
         const cal = await calibrateTFR();
         if (Number(cal.tfr) > 0) batch0 = Math.ceil(cal.tfr);
      } catch(e) {
         console.log(`waves: calibrate TFR failed, ${e.message || e}; using pageStats batch ${batch0}`);
      }
      if (Object.prototype.hasOwnProperty.call(userOptions, 'curatorBatchSize') && Number(curatorBatchSize) > 0) {
         batch0 = Math.ceil(+curatorBatchSize);
      }
      batch0 = Math.max(1, batch0);
      const sampleRate = 1 / batch0;
      const budget0 = waveBudget(snap, fill0.dataPageSize);
      const nBatches0 = budget0.nBatches;
      const docsPerWave = Math.max(1, batch0 * Math.max(1, nBatches0));
      const wavesPerPass = Math.max(1, Math.ceil((fill0.documentCount || 0) / docsPerWave));
      const coverPasses = Number(passes) > 0 ? Math.ceil(passes) : 1;
      const maxWaves = wavesPerPass * coverPasses;

      console.log(`sampler: ${sampler}`);
      console.log(`pages: ${fill0.nPages} actualFill ${fill0.pageFillActual} targetFill ${fill0.pageFillTarget} batch ${batch0} (pinned TFR)`);
      console.log(`waves: ${maxWaves} (${coverPasses} pass(es) × ${wavesPerPass} waves/pass; docs ${fill0.documentCount} / (batch ${batch0} * concurrency ${Math.max(1, nBatches0)}))`);
      console.log(EJSON.stringify({ "state": "initial storage", ...snap }));
      let didWork = false;
      for (let wave = 1; wave <= maxWaves; ) {
         const fill = pageStats(snap);
         const sampleSize = batch0;
         const budget = waveBudget(snap, fill.dataPageSize);
         const nBatches = budget.nBatches;
         if (nBatches < 1) {
            if ((budget.reusablePages || 0) > 0) {
               console.log('dirty fill headroom exhausted; waiting for checkpoint before resume');
               await waitForCheckpoint({ "settle": true });
               await waitForReplLag();
               snap = collSnapshot();
               if (waveBudget(snap, fill.dataPageSize).nBatches < 1) await delay(idlePollMs);
               continue;
            }
            console.log('no reusable pages without extending the file, stopping');
            break;
         }
         console.log(`wave ${wave}/${maxWaves} batches ${nBatches} batchSize ${sampleSize} (pinned TFR) actualFill ${fill.pageFillActual} reusable ${snap.freeStorageSize} dirtyPages ${budget.dirtyPages} reusablePages ${budget.reusablePages}`);
         await waitForCheckpoint();
         let tasks = [];
         let update = 0;
         for await (const ids of getIds(sampleSize, nBatches, sampleRate)) {
            const updateOneIds = ids.map(id => id._id);
            if (!updateOneIds.length) continue;
            await waitForCheckpoint();
            await waitForReplLag();
            update++;
            console.log(`\tforking concurrent update ${update} with ${updateOneIds.length} IDs`);
            tasks.push(rewriteIds(updateOneIds));
         }
         console.log(`forked ${update} of ${nBatches} planned batches`);
         await Promise.allSettled(tasks);
         if (update > 0) didWork = true;
         console.log(EJSON.stringify({ "state": "volatile storage", ...collSnapshot() }));
         await waitForCheckpoint();
         await waitForReplLag();
         snap = collSnapshot();
         wave++;
      }
      if (didWork) {
         await waitForCheckpoint({ "settle": true });
         await waitForReplLag();
         console.log(EJSON.stringify({ "state": "settled storage", ...collSnapshot() }));
      }
   }

   try {
      preflightDropTmpSamples();
      if (strategy === 'meetInMiddle' || sampler === 'meetInMiddle') await meetInMiddleMain();
      else if (strategy === 'lowStressMode' || sampler === 'lowStressMode') await lowStressModeMain();
      else if (strategy === 'updateOne' || sampler === 'updateOne') await updateOneModeMain();
      else if (strategy === 'slidingShuffle' || sampler === 'slidingShuffle') await slidingShuffleMain();
      else if (strategy === 'slidingWindow' || sampler === 'slidingWindow') await slidingWindowMain();
      else if (strategy === 'quantile' || sampler === 'quantile') await quantileMain();
      else if (strategy === 'rndQuantile' || sampler === 'rndQuantile') await rndQuantileMain();
      else if (strategy === 'shapeQuantile' || sampler === 'shapeQuantile') await shapeQuantileMain();
      else if (strategy === 'naturalWindow' || sampler === 'naturalWindow') await naturalWindowMain();
      else if (strategy === 'naturalReply' || sampler === 'naturalReply') await naturalReplyMain();
      else if (strategy === 'doubleParked' || sampler === 'doubleParked') await doubleParkedMain();
      else await main();
   } catch(e) {
      console.log('[red][ERROR][/]', e.errmsg || e.message || String(e));
      throw e;
   }
})();

// EOF
