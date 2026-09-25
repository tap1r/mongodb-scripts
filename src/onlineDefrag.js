/*
 *  Name: "onlineDefrag.js"
 *  Version: "1.0.2"
 *  Description: "online compaction"
 *  Disclaimer: "https://raw.githubusercontent.com/tap1r/mongodb-scripts/master/DISCLAIMER.md"
 *  Authors: ["tap1r <luke.prochazka@gmail.com>"]
 *
 *  Notes:
 *  - mongosh only. Do not top-level-await this file.
 *  - --eval must use var (not let/const) for dbName, collName, defragOptions.
 *  - Requires mdblib.js on $MDBLIB, ~/.mongodb, or cwd.
 *  - strategy: naturalReply (default) | naturalWindow | quantile | shapeQuantile
 *  - Aliases: naturalReplay → naturalReply; doubleParked → naturalReply with
 *    naturalDir:-1; concurrentUpdates → writeConcurrency;
 *    lowStressDirtyMax/Hard → updatesSoft/updatesHard.
 *  - defragOptions.replay: 'onExtend' (default) | 'never' | 'always'
 *    (naturalReply only)
 *  - pageFillRatio: omit to autotune from the packed sample's settled
 *    $collStats; set to pin (default was 0.9).
 *  - Other knobs: writeConcurrency (default 8), dirtyBudgetRatio (default 0.2),
 *    passes, naturalDir (1 | -1), updateDelayMs, updatesSoft, updatesHard,
 *    ignoreCheckpoint, tfrOverride (alias curatorBatchSize), shuffleSampleSize,
 *    maxLagSeconds, checkpointTimeoutMs.
 *
 *  TODOs:
 *  - compact after a density pass to reclaim G / relocate the geometric tail.
 *    dirtyBudgetRatio is a per-generation fraction of R, not a target reuse%.
 */

// Usage: mongosh [connection options] [--quiet] [-f|--file] </path/to/>onlineDefrag.js

/*
 *  Example:
 *    mongosh [connection options] --eval "var dbName = 'database', collName = 'collection';" -f </path/to/>onlineDefrag.js
 *    mongosh [connection options] --eval "var dbName = 'database', collName = 'collection', defragOptions = { strategy: 'naturalReplay', concurrentUpdates: 32, updateDelayMs: 0, replay: 'onExtend' };" -f </path/to/>onlineDefrag.js
 *    mongosh [connection options] --eval "var dbName = 'database', collName = 'collection', defragOptions = { strategy: 'naturalReply', naturalDir: -1 };" -f </path/to/>onlineDefrag.js
 *    mongosh [connection options] --eval "var dbName = 'database', collName = 'collection', defragOptions = { strategy: 'naturalWindow' };" -f </path/to/>onlineDefrag.js
 *    mongosh [connection options] --eval "var dbName = 'database', collName = 'collection', defragOptions = { strategy: 'quantile' };" -f </path/to/>onlineDefrag.js
 *    mongosh [connection options] --eval "var dbName = 'database', collName = 'collection', defragOptions = { strategy: 'shapeQuantile' };" -f </path/to/>onlineDefrag.js
 *
 *  We use 'var' to interoperate with mongosh's sloppy mode
 */

/*
 *  Load helper mdblib.js (https://github.com/tap1r/mongodb-scripts/blob/master/src/mdblib.js)
 *  Save libs to the $MDBLIB or other valid search path
 */

(() => { // mongosh only; top-level await on this IIFE is a rewriter SyntaxError.
   const __script = { "name": "onlineDefrag.js", "version": "1.0.2" };
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

   // Caller: var defragOptions = { ... } (--eval or REPL). Do not declare
   // dbName/collName/defragOptions here — IIFE const would shadow the overlay.
   const userOptions = typeof defragOptions === 'undefined' ? {} : defragOptions;

   const STRATEGIES = ['naturalReply', 'naturalWindow', 'quantile', 'shapeQuantile'];

   function normalizeOptions(raw) {
      const o = (raw && typeof raw === 'object') ? raw : {};
      const rawStrategy = o.strategy == null || o.strategy === '' ? 'naturalReply' : o.strategy;
      let strategy = rawStrategy === 'naturalReplay' ? 'naturalReply' : rawStrategy;
      let naturalDir = Number(o.naturalDir) < 0 ? -1 : 1;
      if (rawStrategy === 'doubleParked' || strategy === 'doubleParked') {
         strategy = 'naturalReply';
         if (!Object.prototype.hasOwnProperty.call(o, 'naturalDir')) naturalDir = -1;
      }
      if (STRATEGIES.indexOf(strategy) < 0) {
         throw new Error(`unknown defragOptions.strategy "${rawStrategy}" (use ${STRATEGIES.join('|')}; aliases naturalReplay, doubleParked)`);
      }
      const writeConcurrency = Number(o.writeConcurrency) > 0
         ? Math.ceil(o.writeConcurrency)
         : (Number(o.concurrentUpdates) > 0 ? Math.ceil(o.concurrentUpdates) : 8);
      const replayIn = o.replay;
      const replay = (replayIn === 'never' || replayIn === false || replayIn === 'skip') ? 'never'
                   : (replayIn === 'always' ? 'always' : 'onExtend');
      const coverPassesOpt = Number(o.passes) > 0 ? Math.ceil(o.passes) : 0;
      const updatesSoft = Number(o.updatesSoft) > 0 ? +o.updatesSoft
                        : (Number(o.lowStressDirtyMax) > 0 ? +o.lowStressDirtyMax : 0.07);
      const updatesHard = Number(o.updatesHard) > 0 ? +o.updatesHard
                        : (Number(o.lowStressDirtyHard) > 0 ? +o.lowStressDirtyHard : 0.08);
      const pageFillExplicit = Object.prototype.hasOwnProperty.call(o, 'pageFillRatio')
         && Number(o.pageFillRatio) > 0;
      const tfrOverride = Number(o.tfrOverride) > 0 ? Math.ceil(o.tfrOverride)
                        : (Number(o.curatorBatchSize) > 0 ? Math.ceil(o.curatorBatchSize) : 0);
      return Object.assign({}, o, {
         "strategy": strategy,
         "writeConcurrency": writeConcurrency,
         "replay": replay,
         "naturalDir": naturalDir,
         "coverPassesOpt": coverPassesOpt,
         "updatesSoft": updatesSoft,
         "updatesHard": updatesHard,
         "pageFillExplicit": pageFillExplicit,
         "tfrOverride": tfrOverride
      });
   }

   const {
      "strategy": strategy,
      "shuffleSampleSize": shuffleSampleSize,
      "pageFillRatio": pageFillRatio = 0.9,
      "pageFillExplicit": pageFillExplicit,
      "updatesSoft": updatesSoft,
      "updatesHard": updatesHard,
      "dirtyBudgetRatio": dirtyBudgetRatio = 0.2,
      "writeConcurrency": writeConcurrency,
      "tfrOverride": tfrOverride,
      "maxLagSeconds": maxLagSeconds = 10,
      "checkpointTimeoutMs": checkpointTimeoutMs,
      "ignoreCheckpoint": ignoreCheckpoint = false,
      "naturalDir": naturalDir,
      "replay": replay,
      "coverPassesOpt": coverPassesOpt,
      "updateDelayMs": updateDelayMs = 0
   } = normalizeOptions(userOptions);

   function coverPassCount(defaultN = 1) {
      return coverPassesOpt > 0 ? coverPassesOpt : defaultN;
   }

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

   // $sample random-cursor path: n>100 and size <5% of n. Otherwise COLLSCAN,
   // attach a random key, sort. Atlas M0/Flex ignore allowDiskUse and cap
   // in-memory sorts at 32MiB, so calibrate/$sample stay under 5% of n.
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

   function bsonProjectStage() {
      return { "$project": { "bson": { "$ifNull": [{ "$bsonSize": "$$ROOT" }, 0] } } };
   }

   function scanOpts(comment, hint) {
      return aggOpts(comment, {
         "hint": hint,
         "allowDiskUse": true,
         "cursor": { "batchSize": 256 }
      });
   }

   async function* aggDocs(pipeline, opts) {
      const cursor = namespace.aggregate(pipeline, opts);
      try {
         if (typeof cursor[Symbol.asyncIterator] === 'function') {
            for await (const doc of cursor) yield doc;
            return;
         }
         for (;;) {
            let has = typeof cursor.hasNext === 'function' ? cursor.hasNext() : false;
            if (has && typeof has.then === 'function') has = await has;
            if (!has) break;
            let doc = cursor.next();
            if (doc && typeof doc.then === 'function') doc = await doc;
            if (doc == null) break;
            yield doc;
         }
      } finally {
         try { cursor.close(); } catch(_) { /* exhausted or already closed */ }
      }
   }

   function liveBytes(stats = {}) {
      const sz = Number(stats.storageSize) > 0 ? +stats.storageSize : 0;
      const Rraw = +stats.freeStorageSize;
      const R = Number.isFinite(Rraw) && Rraw > 0 ? Rraw : 0;
      return Math.max(0, sz - R);
   }

   // nPages = live/32KiB (compressed file bytes over uncompressed leaf_page_max).
   function pageStats(stats = {}) {
      const {
         objects: documentCount,
         dataPageSize: leafPageSize
      } = stats;
      const live = liveBytes(stats);
      const dataPageSize = Number(leafPageSize) > 0 ? leafPageSize : 32 * 1024;
      const nPages = Math.max(1, Math.ceil(live / dataPageSize));
      const pageFillActual = Math.max(1, Math.ceil((documentCount || 0) / nPages));
      return {
         "pageFillActual": pageFillActual,
         "documentCount": documentCount,
         "nPages": nPages,
         "dataPageSize": dataPageSize
      };
   }

   const updatePipeline = [{ "$unset": "_id" }]; // leverages SERVER-36405
   const updateManyOpts = {
      "upsert": false, // must only update existing documents
      "hint": { "_id": 1 }, // must force hint to avoid $expr collscan
      "comment": "online compacting updates"
   };
   let txnFailed = 0;

   // Sole source-collection writer: updateMany + $unset _id in a txn.
   // No retry — competing writes take preference and still move RecordIds.
   async function rewriteFilter(filter, { expect } = {}) {
      if (Number(updateDelayMs) > 0) await delay(updateDelayMs);
      const session = db.getMongo().startSession({
         "readPreference": { "mode": "primary" },
         "causalConsistency": true
      });
      const coll = session.getDatabase(nsDb).getCollection(nsColl);
      try {
         session.startTransaction({
            "readConcern": { "level": "local" },
            "writeConcern": { "w": "majority", "j": true }
         });
         const { modifiedCount } = await coll.updateMany(filter, updatePipeline, updateManyOpts);
         await session.commitTransaction();
         if (expect != null && modifiedCount !== expect) {
            console.log(`\tmodifiedCount: ${modifiedCount}`);
         }
      } catch(error) {
         txnFailed++;
         try { await session.abortTransaction(); } catch(_) { /* already aborted */ }
         console.log(`\ttxn failed (${txnFailed}): ${error.message || error}`);
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

   function makeWritePool() {
      let inflight = [];
      return {
         async drain() {
            if (!inflight.length) return;
            await Promise.allSettled(inflight);
            inflight = [];
         },
         async enqueue(p, cap) {
            inflight.push(p);
            while (inflight.length >= cap) await inflight.shift();
         }
      };
   }

   function dirtyTune() {
      const base = Number(updatesSoft) > 0 ? +updatesSoft : 0.07;
      const hard = Number(updatesHard) > 0 ? +updatesHard : 0.08;
      return { "base": base, "soft": base, "hard": hard };
   }

   function wtCache() {
      const cache = serverStatus({ "wiredTiger": true }).wiredTiger?.cache;
      if (!cache) return null;
      const max = +cache['maximum bytes configured'];
      if (!(max > 0)) return null;
      return {
         "max": max,
         "updates": +cache['bytes allocated for updates'] || 0
      };
   }

   function cacheUpdatesUtil() {
      const c = wtCache();
      return c ? c.updates / c.max : null;
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

   async function writeGate(tune, onReady) {
      for (;;) {
         await waitForDirtyUnder(tune);
         await waitForReplLag({ "abortIfCheckpoint": true });
         const waited = await waitForCheckpoint();
         const ckpt = wtCheckpoint();
         if (!ignoreCheckpoint && ckpt.available && ckpt.running) continue;
         if (typeof onReady === 'function') await onReady(waited);
         return waited;
      }
   }

   function estimateRewriteBytes(nDocs, packed) {
      // On-disk bytes after block compression, from the packed sample:
      // n * avgObjSize (BSON) / (dataSize / live). Do not debit uncompressed
      // 32KiB leaves — freeStorageSize is compressed block-manager units.
      const avg = +packed?.avgObjSize > 0 ? +packed.avgObjSize : 256;
      const compression = Number(packed?.compression) > 0 ? +packed.compression : 1;
      return nDocs * avg / Math.max(compression, 0.01);
   }

   function dirtyBudgetCap(snap, cal) {
      // Per-generation dest cap in compressed bytes: dirtyBudgetRatio × R.
      // Not a target for collStats reuse% (G). Never exceed R (no-extend).
      const frac = Number(dirtyBudgetRatio) > 0 ? +dirtyBudgetRatio : 0.05;
      const Rraw = +snap?.freeStorageSize;
      const R = Number.isFinite(Rraw) && Rraw > 0 ? Rraw : 0;
      const sz = +snap?.storageSize;
      const storageSize = Number.isFinite(sz) && sz > 0 ? sz : 0;
      const live = liveBytes(snap);
      const G = storageSize > 0 ? R / storageSize : 0;
      const leaf = Number(cal?.ps?.dataPageSize) > 0 ? +cal.ps.dataPageSize
                 : (Number(cal?.leaf) > 0 ? +cal.leaf : 32 * 1024);
      const C = Math.max(Number(cal?.compression) > 0 ? +cal.compression : 1, 0.01);
      const minPage = leaf / C;
      const cap = R > 0 ? Math.max(minPage, frac * R) : 0;
      return {
         "frac": frac, "R": R, "G": G, "live": live, "cap": cap,
         "storageSize": storageSize, "leaf": leaf, "compression": C,
         "minPage": minPage, "units": "compressed"
      };
   }

   function formatDirtyBudget(b) {
      return `reusable=${b.R} (${(100 * b.G).toFixed(1)}% of storageSize) cap=${Math.round(b.cap)} (${(100 * b.frac).toFixed(0)}% of R, ${b.units})`;
   }

   function refreshReusableCap(window, reason = 'checkpoint', snap, cal) {
      // Caller has just observed a checkpoint falling edge (or M0 proxy wait),
      // or ignoreCheckpoint delivered an async $collStats for the next round.
      window.snap = snap || collSnapshot();
      window.bytes = 0;
      const b = dirtyBudgetCap(window.snap, cal);
      console.log(`${reason}: settled stats ${formatDirtyBudget(b)} live=${b.live} storageSize=${b.storageSize}`);
      return b.cap;
   }

   async function ensureReusableRoom(window, nextBytes, { refreshSnap = true, beforeWait, cal } = {}) {
      // Cap cumulative estimated rewrite bytes at dirtyBudgetRatio * R per
      // checkpoint. R comes from window.snap (refreshed on falling edge).
      const b = dirtyBudgetCap(window.snap, cal);
      if (!(b.R > 0)) return;
      if (window.bytes + nextBytes <= b.cap) return;
      if (typeof beforeWait === 'function') await beforeWait();
      if (ignoreCheckpoint) {
         window.bytes = 0;
         const s = consumeAsyncSnap();
         if (s) refreshReusableCap(window, 'async stats', s, cal);
         kickCollStats();
         return;
      }
      console.log(`reusable budget ${Math.round(window.bytes)}+${Math.round(nextBytes)} > ${Math.round(b.cap)} (${b.frac}*freeStorageSize ${b.R}); waiting for checkpoint`);
      const waited = await waitForCheckpoint({ "settle": true });
      if (!waited.available && !waited.completed) {
         await delay(statsPollMs);
      }
      window.bytes = 0;
      if (refreshSnap && (waited.completed || !waited.available)) refreshReusableCap(window, 'reusable budget', null, cal);
   }

   function autotunePageFillRatio(ps, compression, avgObjSize) {
      // Packed sample: TFR docs/leaf × avg / C = packed bytes per estimated
      // leaf. Ratio = that / leaf_page_max, clamped to the WT split_pct band.
      const leaf = Number(ps?.dataPageSize) > 0 ? +ps.dataPageSize : 32 * 1024;
      const tfr = Number(ps?.pageFillActual) > 0 ? +ps.pageFillActual : 0;
      const C = Math.max(Number(compression) > 0 ? +compression : 1, 0.01);
      const avg = Number(avgObjSize) > 0 ? +avgObjSize : 256;
      if (!(tfr > 1) || !(ps.nPages > 1)) return 0.9;
      const observed = (tfr * avg) / (C * leaf);
      if (!(observed > 0)) return 0.9;
      return Math.min(0.95, Math.max(0.5, observed));
   }

   function packedPageBudget(cal) {
      // First-fit fill: Σ ($bsonSize / C_mode) ≤ floor(pageFillRatio × leaf).
      // C_mode from calibrate size-band temps, else global dataSize/live.
      const leaf = cal?.ps?.dataPageSize || 32 * 1024;
      const fillRatio = Number(cal?.pageFillRatio) > 0 ? +cal.pageFillRatio
                      : (Number(pageFillRatio) > 0 ? +pageFillRatio : 0.9);
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

   function firstFit(budget) {
      let cur = null;
      return {
         offer(packed, start) {
            let closed = null;
            if (cur && cur.n > 0 && cur.packed + packed > budget) {
               closed = cur;
               cur = null;
            }
            if (!cur) cur = (start || firstFit.emptyIds)();
            return closed;
         },
         add(bson, packed) {
            cur.n++;
            cur.bson += bson;
            cur.packed += packed;
            return cur;
         },
         flush() {
            const b = cur && cur.n ? cur : null;
            cur = null;
            return b;
         }
      };
   }
   firstFit.emptyIds = () => ({ "ids": [], "n": 0, "bson": 0, "packed": 0 });

   function shapeProjectStage() {
      return {
         "$project": {
            "bson": { "$ifNull": [{ "$bsonSize": "$$ROOT" }, 0] },
            "shape": {
               "$toHashedIndexKey": {
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
               }
            }
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

   function curatorState(cal, maxDocs) {
      const b = packedPageBudget(cal);
      return Object.assign({}, b, {
         "state": { "batchSize": b.packedBudget, "maxDocs": maxDocs }
      });
   }

   async function* naturalPackedBatches(cal, maxDocs, naturalDir = -1) {
      // Record-store cover in $natural order; $limit then $bsonSize on the
      // server. Yield a first-fit $in when packedBudget fills. $limit maxDocs
      // excludes inserts appended during the scan (Halloween).
      const { packedBudget } = packedPageBudget(cal);
      const dir = Number(naturalDir) >= 0 ? 1 : -1;
      const pipeline = [
         { "$limit": Math.max(1, maxDocs) },
         bsonProjectStage()
      ];
      const fit = firstFit(packedBudget);
      for await (const doc of aggDocs(pipeline, scanOpts(`natural ${dir} $bsonSize`, { "$natural": dir }))) {
         const bson = +doc.bson || 0;
         if (bson < 1) continue;
         const packed = packedOf(bson, cal);
         const closed = fit.offer(packed, firstFit.emptyIds);
         if (closed) yield closed;
         fit.add(bson, packed).ids.push(doc._id);
      }
      const last = fit.flush();
      if (last) yield last;
   }

   function startNaturalWindowCurator(cal, maxDocs) {
      // Stream $natural first-fit batches into density writes. $limit nDocs
      // with dir=1 excludes concurrent tail inserts; dir=-1 is newest n.
      const { packedBudget, bsonCap, leaf, fillRatio, compression, state } = curatorState(cal, maxDocs);
      const dir = Number(naturalDir) >= 0 ? 1 : -1;
      console.log(`naturalWindow curator: $natural:${dir} scan nDocs=${maxDocs} packedBudget=${packedBudget} leaf=${leaf} pageFillRatio=${fillRatio} compression=${compression.toFixed(3)}`);
      const gen = naturalPackedBatches(cal, maxDocs, dir);
      return { "state": state, "gen": gen, "packedBudget": packedBudget, "bsonCap": bsonCap };
   }

   function startQuantileCurator(cal, maxDocs) {
      // Stream first-fit _id ranges while Σ ($bsonSize / C_mode) ≤ packedBudget.
      // $sort _id first (IXSCAN), then $limit, then $bsonSize.
      const { compression, packedBudget, bsonCap, leaf, fillRatio, state } = curatorState(cal, maxDocs);
      const nModes = Array.isArray(cal?.modes) ? cal.modes.length : 0;
      console.log(`quantile curator: first-fit packedBudget=${packedBudget} bsonCap≈${Math.round(bsonCap)} leaf=${leaf} pageFillRatio=${fillRatio} compression=${compression.toFixed(3)} modes=${nModes >= 2 ? nModes : 'unimodal'}`);
      async function* gen() {
         const pipeline = [
            { "$sort": { "_id": 1 } },
            { "$limit": Math.max(1, maxDocs) },
            bsonProjectStage()
         ];
         const fit = firstFit(packedBudget);
         const emit = (row) => ({
            "range": { "$gte": row.min, "$lte": row.max },
            "n": row.n, "packed": row.packed, "bson": row.bson
         });
         for await (const doc of aggDocs(pipeline, scanOpts("quantile first-fit packed ranges", { "_id": 1 }))) {
            const bson = +doc.bson || 0;
            const packed = packedOf(bson, cal);
            const closed = fit.offer(packed, () => ({ "min": doc._id, "max": doc._id, "n": 0, "bson": 0, "packed": 0 }));
            if (closed) yield emit(closed);
            const cur = fit.add(bson, packed);
            cur.max = doc._id;
         }
         const last = fit.flush();
         if (last) yield emit(last);
      }
      return { "state": state, "gen": gen(), "packedBudget": packedBudget, "bsonCap": bsonCap };
   }

   // strategy 'shapeQuantile': first-fit packed $in per server-side hash of
   // sorted top-level keys ($toHashedIndexKey). Client sees {_id, bson, shape}.
   function startShapeQuantileCurator(cal, maxDocs) {
      const { packedBudget, bsonCap, leaf, fillRatio, compression, state } = curatorState(cal, maxDocs);
      const nShapes = Array.isArray(cal?.shapes) ? cal.shapes.length : 0;
      console.log(`shapeQuantile curator: first-fit packedBudget=${packedBudget} bsonCap≈${Math.round(bsonCap)} leaf=${leaf} pageFillRatio=${fillRatio} compression=${compression.toFixed(3)} shapes=${nShapes || 'unmeasured'}`);
      async function* gen() {
         const fits = new Map();
         const pending = [];
         const fitFor = (sig) => {
            let f = fits.get(sig);
            if (!f) {
               f = firstFit(packedBudget);
               fits.set(sig, f);
            }
            return f;
         };
         const emit = (b) => ({ "ids": b.ids, "n": b.n, "packed": b.packed, "bson": b.bson, "shape": b.sig });
         for await (const doc of aggDocs([
            { "$limit": Math.max(1, maxDocs) },
            shapeProjectStage()
         ], scanOpts("shapeQuantile $bsonSize $toHashedIndexKey", { "_id": 1 }))) {
            const sig = keysSig(doc.shape);
            const bson = +doc.bson || 0;
            const packed = bson / Math.max(shapeCompression(sig, cal), 0.01);
            const fit = fitFor(sig);
            const closed = fit.offer(packed, () => Object.assign(firstFit.emptyIds(), { "sig": sig }));
            if (closed) pending.push(closed);
            fit.add(bson, packed).ids.push(doc._id);
            while (pending.length) yield emit(pending.shift());
         }
         for (const fit of fits.values()) {
            const last = fit.flush();
            if (last) yield emit(last);
         }
      }
      return {
         "state": state,
         "gen": gen(),
         "packedBudget": packedBudget,
         "bsonCap": bsonCap
      };
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
            console.log('checkpoint running, ending lag throttle');
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

   function tmpOidHex() {
      const oid = new ObjectId();
      return typeof oid.toHexString === 'function'
           ? oid.toHexString()
           : String(oid).replace(/[^a-f0-9]/gi, '').slice(-24);
   }

   function createPackedTemp(tmpDb, suffix, compressor) {
      const name = `${tmpSamplePrefix()}_${suffix}_${tmpOidHex()}`;
      try {
         tmpDb.createCollection(name, {
            "storageEngine": { "wiredTiger": { "configString": `block_compressor=${compressor}` } }
         });
      } catch(_) {
         tmpDb.createCollection(name);
      }
      return name;
   }

   function packedTempStats(name, fallbackC) {
      const packed = $collStats(tmpStatsDbName, name) || {};
      const { indexes, ...stats } = packed;
      const ps = pageStats(stats);
      const live = liveBytes(stats);
      const C = live > 0 && (stats.dataSize || 0) > 0 ? stats.dataSize / live : fallbackC;
      return {
         "compression": Number(C) > 0 ? C : fallbackC,
         "tfr": ps.pageFillActual,
         "avgObjSize": stats.avgObjSize,
         "objects": ps.documentCount,
         "ps": ps,
         "storageSize": stats.storageSize
      };
   }

   async function settlePackedTemps(created, label) {
      const tag = label ? ` ${label}` : '';
      console.log(`calibrate${tag}: waiting for checkpoint before packed $collStats`);
      await waitForCheckpoint({ "settle": true, "force": true });
      if (!wtCheckpoint().available && created[0]) {
         console.log(`M0: polling${tag} temps for packed $collStats`);
         await waitForPackedStats(tmpStatsDbName, created[0]);
      }
   }

   function mergeInto(srcColl, stages, intoName, comment, whenMatched = 'keepExisting') {
      srcColl.aggregate([
         ...stages,
         { "$merge": {
            "into": { "db": tmpStatsDbName, "coll": intoName },
            "whenMatched": whenMatched,
            "whenNotMatched": "insert"
         } }
      ], aggOpts(comment)).toArray();
   }

   function sampleMerge(srcColl, intoName, sampleN, nObjs, comment) {
      const cap = randomCursorSampleCap(nObjs);
      let remaining = Math.max(1, Math.ceil(+sampleN) || 1);
      if (nObjs > 0) remaining = Math.min(remaining, nObjs);
      if (nObjs > 100 && remaining > cap) {
         console.log(`calibrate: $sample ${remaining} is >=5% of ${nObjs}; ${Math.ceil(remaining / cap)} random-cursor draws of <=${cap}`);
      }
      while (remaining > 0) {
         const size = (nObjs > 100) ? Math.min(remaining, Math.max(1, cap)) : remaining;
         mergeInto(srcColl, [{ "$sample": { "size": size } }], intoName, comment, 'keepExisting');
         remaining -= size;
         if (nObjs <= 100) break;
      }
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
            const name = createPackedTemp(tmpDb, `m${k}`, compressor);
            created.push(name);
            const C0 = Math.max(Number(fallbackC) > 0 ? +fallbackC : 1, 0.01);
            const packedExpr = { "$divide": [{ "$ifNull": [{ "$bsonSize": "$$ROOT" }, 0] }, C0] };
            const bound = k === modes.length - 1
                        ? { "$lte": [packedExpr, m.max] }
                        : { "$lt": [packedExpr, m.max] };
            mergeInto(tmpDb.getCollection(srcName), [
               { "$match": { "$expr": { "$and": [
                  { "$gte": [packedExpr, m.min] },
                  bound
               ] } } }
            ], name, `${strategy} calibrate mode ${k} $merge`, 'replace');
         }
         await settlePackedTemps(created, 'modes');
         for (let k = 0; k < modes.length; k++) {
            Object.assign(modes[k], packedTempStats(created[k], fallbackC));
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
      const todo = shapes.slice(0, 12);
      const created = [];
      try {
         for (let k = 0; k < todo.length; k++) {
            const name = createPackedTemp(tmpDb, `s${k}`, compressor);
            created.push(name);
            mergeInto(tmpDb.getCollection(srcName), [
               { "$set": { "shape": shapeProjectStage().$project.shape } },
               { "$match": { "shape": todo[k].hash } },
               { "$unset": "shape" }
            ], name, `${strategy} calibrate shape ${k} $merge`, 'replace');
         }
         await settlePackedTemps(created, 'shapes');
         for (let k = 0; k < todo.length; k++) {
            Object.assign(todo[k], packedTempStats(created[k], fallbackC));
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
         const live = liveBytes(src);
         const compression = live > 0 && (src.dataSize || 0) > 0 ? src.dataSize / live : 1;
         console.log(`calibrate: avgObjSize=${avg} >= leaf=${leaf}; TFR=1 skip sample and bin analysis`);
         return {
            "tfr": 1, "compression": compression, "avgObjSize": avg, "ps": fill,
            "modes": [], "shapes": [],
            "pageFillRatio": pageFillExplicit ? +pageFillRatio : 0.9
         };
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
      const tmpDb = tmpStatsDb();
      const tmpName = createPackedTemp(tmpDb, 'c', compressor);
      console.log(`${strategy} calibrate: $sample ${sampleN} (${nBins} packed bins × ${perLowBin} docs; 2 leaves at bson>=${minBson} C=${assumeC}) compressor=${compressor} -> ${tmpStatsDbName}.${tmpName}`);
      try {
         console.log(`calibrate collection created: ${tmpStatsDbName}.${tmpName}`);
         sampleMerge(namespace, tmpName, sampleN, nObjs, `${strategy} calibrate $merge`);
         await settlePackedTemps([tmpName], '');
         const measured = packedTempStats(tmpName, 1);
         const ps = measured.ps;
         const compression = measured.compression;
         let tfr = Math.max(1, ps.pageFillActual);
         const tunedFill = pageFillExplicit
                         ? +pageFillRatio
                         : autotunePageFillRatio(ps, compression, measured.avgObjSize);
         const leafFill = Math.max(1, Math.ceil((tunedFill * (ps.dataPageSize || leaf) * compression) / (measured.avgObjSize > 0 ? measured.avgObjSize : avg)));
         if (ps.nPages <= 1) {
            tfr = leafFill;
            console.log(`packed nPages=${ps.nPages} (unsettled or tiny file); TFR from leaf fill = ${tfr}`);
         }
         console.log(`calibrated TFR=${tfr} (packedFill) compression=${compression.toFixed(3)} pageFillRatio=${tunedFill.toFixed(3)}${pageFillExplicit ? ' (pinned)' : ' (packed sample)'} packedFill=${ps.pageFillActual} packedPages=${ps.nPages} objects=${ps.documentCount} avgObjSize=${measured.avgObjSize} storageSize=${measured.storageSize}`);
         let modes = [];
         let shapes = [];
         const wantShapes = strategy === 'shapeQuantile';
         try {
            if (wantShapes) {
               shapes = detectShapes(tmpDb, tmpName);
               if (shapes.length >= 2) {
                  shapes = await measureShapeCompression(tmpDb, tmpName, shapes, compressor, compression);
               }
            } else {
               modes = detectSizeModes(tmpDb, tmpName, compression, Math.floor(tunedFill * (ps.dataPageSize || 32 * 1024)));
               if (modes.length >= 2) {
                  modes = await measureModeCompression(tmpDb, tmpName, modes, compressor, compression);
               }
            }
         } catch(e) {
            console.log(`calibrate modes/shapes skipped: ${e.message || e}`);
            modes = [];
            shapes = [];
         }
         return { "tfr": tfr, "compression": compression, "avgObjSize": measured.avgObjSize, "ps": ps, "modes": modes, "shapes": shapes, "pageFillRatio": tunedFill };
      } finally {
         dropTmpSample(tmpDb, tmpName, 'calibrate');
      }
   }

   // Density write loop for naturalWindow, quantile, shapeQuantile.
   // dirtyBudgetRatio caps packed rewrite bytes per checkpoint at that fraction
   // of freeStorageSize. Falling-edge collStats refreshes R.
   async function densityStart() {
      const srcSnap = collSnapshot();
      console.log(EJSON.stringify({ "state": "initial storage", ...srcSnap }));
      const cal = await calibrateTFR();
      const nDocs = srcSnap.objects || pageStats(srcSnap).documentCount || 0;
      return { "srcSnap": srcSnap, "cal": cal, "nDocs": nDocs };
   }

   async function packedWriteMain(label, startCuratorFn) {
      const { cal, nDocs } = await densityStart();
      const batch = tfrOverride > 0 ? tfrOverride : cal.tfr;
      let walk = startCuratorFn(cal, nDocs);
      if (walk && typeof walk.then === 'function') walk = await walk;
      const conc = Math.max(1, Number(writeConcurrency) > 0 ? Math.ceil(writeConcurrency) : 1);
      const tune = dirtyTune();
      const budgetSnap = collSnapshot();
      const budget0 = dirtyBudgetCap(budgetSnap, cal);
      const packedCover = estimateRewriteBytes(nDocs, cal);
      const packedPctR = budget0.R > 0 ? 100 * packedCover / budget0.R : 0;
      const fillRatio = packedPageBudget(cal).fillRatio;
      console.log(`strategy: ${label} TFR=${cal.tfr} batch=${batch} buckets=first-fit (docs ${nDocs}) writeConcurrency=${conc} updates soft ${(tune.soft * 100).toFixed(2)}% hard ${(tune.hard * 100).toFixed(2)}% C=${budget0.compression.toFixed(3)} pageFill=${fillRatio} dirtyBudgetRatio=${budget0.frac} ${formatDirtyBudget(budget0)} packedCover=${Math.round(packedCover)} (${packedPctR.toFixed(1)}% of R) sourceLive=${budget0.live} storageSize=${budget0.storageSize}`);

      const { drain: drainWrites, enqueue: enqueueWrite } = makeWritePool();

      let pass = 0;
      const writeWindow = { "snap": budgetSnap, "bytes": 0 };
      for (;;) {
         await writeGate(tune, async(waited) => {
            if (waited.completed) {
               await drainWrites();
               refreshReusableCap(writeWindow, 'checkpoint', null, cal);
            } else if (ignoreCheckpoint) {
               const s = consumeAsyncSnap();
               if (s) refreshReusableCap(writeWindow, 'async stats', s, cal);
               kickCollStats();
            }
         });
         const { value, done } = await walk.gen.next();
         if (done || value == null) break;
         pass++;
         const nextBytes = (Number(value.bson) > 0 || Number(value.packed) > 0)
                         ? batchAllocBytes(value, (cal.ps && cal.ps.dataPageSize) || 32 * 1024, fillRatio, cal.compression)
                         : estimateRewriteBytes(value.n || batch, cal);
         await ensureReusableRoom(writeWindow, nextBytes, { "refreshSnap": true, "beforeWait": drainWrites, "cal": cal });
         writeWindow.bytes += nextBytes;
         const packedNote = Number(value.packed) > 0 ? ` packed=${Math.round(value.packed)}` : '';
         const bsonNote = Number(value.bson) > 0 ? ` bson=${Math.round(value.bson)}` : '';
         const passTag = `${label} ${pass}`;
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
      console.log(`${label} done batches=${pass} txnFailed=${txnFailed}`);
      console.log(EJSON.stringify({ "state": "settled storage", ...collSnapshot() }));
   }

   function shouldReplay({ extended, R }) {
      // onExtend: rewrite 2 only if write 1 grew storageSize or R was 0 (EOF trim path).
      // never: skip-replay even after an extend. always: rewrite 2 every window.
      if (replay === 'always') return { "replay": true, "reason": "always" };
      if (replay === 'never') return { "replay": false, "reason": "never" };
      if (extended) return { "replay": true, "reason": "extended" };
      if (!(Number.isFinite(R) && R > 0)) return { "replay": true, "reason": "R=0" };
      return { "replay": false, "reason": "no extend, R>0" };
   }

   async function eachCoverPass(defaultN, body) {
      const n = coverPassCount(defaultN);
      for (let pass = 1; pass <= n; pass++) await body(pass, n);
   }

   // Stream first-fit batches into a dirty-budget window, freeze that window's
   // _ids, rewrite 1, then shouldReplay. Halloween-safe (parked _id).
   async function parkedWindowReplay(label, cal, batchSource, nDocs) {
      const { packedBudget, fillRatio, leaf, compression } = packedPageBudget(cal);
      const conc = Math.max(1, Number(writeConcurrency) > 0 ? Math.ceil(writeConcurrency) : 1);
      const tune = dirtyTune();
      const packedCover = estimateRewriteBytes(nDocs, cal);
      const budgetSnap = collSnapshot();
      const budget0 = dirtyBudgetCap(budgetSnap, cal);
      const R0 = budget0.R;
      const window0 = R0 > 0 ? budget0.cap : budget0.minPage;
      console.log(`strategy: ${label} TFR=${cal.tfr} packedBudget=${packedBudget} pageFillRatio=${fillRatio} leaf=${leaf} C=${compression.toFixed(3)} docs=${nDocs} batches=streaming packedCover≈${Math.round(packedCover)} dirtyBudgetRatio=${budget0.frac} ${formatDirtyBudget(budget0)} windowCap=${Math.round(window0)} writeConcurrency=${conc} updateDelayMs=${Number(updateDelayMs) > 0 ? +updateDelayMs : 0} replay=${replay}`);

      const { drain: drainWrites, enqueue: enqueueWrite } = makeWritePool();
      const gen = typeof batchSource[Symbol.asyncIterator] === 'function'
                ? batchSource
                : (async function*() { for (const b of batchSource) yield b; })();
      let held = null;
      let sourceDone = false;

      async function takeBatch() {
         if (held) {
            const b = held;
            held = null;
            return b;
         }
         if (sourceDone) return null;
         const step = await gen.next();
         if (step.done) {
            sourceDone = true;
            return null;
         }
         return step.value;
      }

      let prevSz = budgetSnap.storageSize;
      let packedDone = 0;
      let cycle = 0;
      let rBudget = R0;
      for (;;) {
         await writeGate(tune);
         if (!(rBudget >= budget0.minPage)) {
            await waitForCheckpoint({ "settle": true });
            await waitForReplLag();
            const replenished = collSnapshot();
            const bR = dirtyBudgetCap(replenished, cal);
            rBudget = bR.R;
            prevSz = replenished.storageSize;
            if (!(rBudget >= budget0.minPage)) rBudget = budget0.minPage;
         }
         const snap0 = collSnapshot();
         const windowCap = rBudget > 0
            ? dirtyBudgetCap({ "freeStorageSize": rBudget, "storageSize": snap0.storageSize }, cal).cap
            : budget0.minPage;
         const batches = [];
         let windowPacked = 0, windowAlloc = 0, windowN = 0;
         for (;;) {
            const b = await takeBatch();
            if (!b) break;
            const add = batchAllocBytes(b, leaf, fillRatio, compression);
            if (batches.length && windowAlloc + add > windowCap) {
               held = b;
               break;
            }
            batches.push(b);
            windowPacked += b.packed || 0;
            windowAlloc += add;
            windowN += b.n || 0;
            if (windowAlloc >= windowCap) break;
         }
         if (!batches.length) break;
         cycle++;
         const sz0 = snap0.storageSize || 0;
         const Rbefore = rBudget;
         console.log(`${label} ${cycle} packedDone=${Math.round(packedDone)}/${Math.round(packedCover)} window n=${windowN} batches=${batches.length} packed=${Math.round(windowPacked)} alloc=${Math.round(windowAlloc)} R=${Number.isFinite(Rbefore) ? Rbefore : 0} cap=${Math.round(windowCap)} storageSize=${sz0} rewrite 1`);
         for (const b of batches) {
            await waitForDirtyUnder(tune);
            await enqueueWrite(rewriteIds(b.ids, { "expect": b.n }), conc);
         }
         await drainWrites();
         kickCollStats();
         const snap1 = consumeAsyncSnap() || collSnapshot();
         const extended = (snap1.storageSize || 0) > sz0;
         const decision = shouldReplay({ "extended": extended, "R": Rbefore });
         if (decision.replay) {
            await waitForCheckpoint({ "settle": true });
            await waitForReplLag();
            const snapReplay = collSnapshot();
            console.log(`${label} ${cycle} replay batches=${batches.length} n=${windowN} storageSize=${snapReplay.storageSize} reusable=${snapReplay.freeStorageSize || 0} rewrite 2 (${decision.reason})`);
            for (const b of batches) {
               await waitForDirtyUnder(tune);
               await enqueueWrite(rewriteIds(b.ids, { "expect": b.n }), conc);
            }
            await drainWrites();
            kickCollStats();
            await waitForCheckpoint({ "settle": true });
            await waitForReplLag();
            const settled = collSnapshot();
            rBudget = dirtyBudgetCap(settled, cal).R;
            prevSz = settled.storageSize;
         } else {
            console.log(`${label} ${cycle} skip replay (${decision.reason}) storageSize=${snap1.storageSize} reusable=${snap1.freeStorageSize || 0}`);
            rBudget = Math.max(0, rBudget - windowAlloc);
         }
         packedDone += windowPacked;
         const snap2 = collSnapshot();
         const dSz = (snap2.storageSize || 0) - (prevSz || 0);
         const Rafter = +snap2.freeStorageSize;
         console.log(`${label} cycle ${cycle} packedDone=${Math.round(packedDone)}/${Math.round(packedCover)} packed=${Math.round(windowPacked)} alloc=${Math.round(windowAlloc)} R=${Number.isFinite(Rbefore) ? Rbefore : 0} dStorageSize=${dSz} storageSize=${snap2.storageSize} reusable=${Number.isFinite(Rafter) ? Rafter : 0} rBudget=${Math.round(rBudget)}${dSz > 0 ? ' EXTEND' : ''}`);
         if ((snap2.storageSize || 0) > (prevSz || 0)) prevSz = snap2.storageSize;
      }
      console.log(`${label} done cycles=${cycle} packedDone=${Math.round(packedDone)} txnFailed=${txnFailed}`);
      console.log(EJSON.stringify({ "state": "settled storage", ...collSnapshot() }));
   }

   async function parkedNaturalCover(label, dir, defaultPasses = 1) {
      const started = await densityStart();
      await eachCoverPass(defaultPasses, async(pass, n) => {
         const snap = pass === 1 ? started.srcSnap : collSnapshot();
         const nDocs = pass === 1 ? started.nDocs : (snap.objects || pageStats(snap).documentCount || 0);
         const cal = started.cal;
         const tag = n > 1 ? `${label} ${pass}/${n}` : label;
         console.log(`${label}: pass ${pass}/${n} scanning ${nDocs} docs $natural:${dir} $bsonSize (streamed cover, freeze per dirty window)`);
         await parkedWindowReplay(tag, cal, naturalPackedBatches(cal, nDocs, dir), nDocs);
         if (pass < n) await waitForCheckpoint({ "settle": true });
      });
   }

   try {
      preflightDropTmpSamples();
      const packedCurators = {
         "naturalWindow": (cal, nDocs) => startNaturalWindowCurator(cal, nDocs),
         "quantile": (cal, nDocs) => startQuantileCurator(cal, nDocs),
         "shapeQuantile": (cal, nDocs) => startShapeQuantileCurator(cal, nDocs)
      };
      if (strategy === 'naturalReply') await parkedNaturalCover('naturalReply', naturalDir, 1);
      else await packedWriteMain(strategy, packedCurators[strategy]);
   } catch(e) {
      console.log('[red][ERROR][/]', e.errmsg || e.message || String(e));
      throw e;
   }
})();

// EOF
