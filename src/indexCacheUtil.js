/*
 *  Name: "indexCacheUtil.js"
 *  Version: "1.0.0"
 *  Description: "index cache util"
 *  Disclaimer: "https://raw.githubusercontent.com/tap1r/mongodb-scripts/master/DISCLAIMER.md"
 *  Authors: ["tap1r <luke.prochazka@gmail.com>"]
 *  Roadmap: "https://raw.githubusercontent.com/tap1r/mongodb-scripts/master/ROADMAP.md" (required context)
 *
 *  Legacy archive line: v0.1.5 (legacy/mongo-shell). This file is mongosh-only.
 *  Do not top-level-await this IIFE. Do not load mdblib.js; the walker stays local.
 *
 *  Notes:
 *  - Node-local WiredTiger index cache snapshot. A mongos session has no WT cache.
 *  - Catalog is collectionless $listCatalog (6.0+), drained with the driver cursor.
 *    Pre-6.0, authz failure, and Atlas M0/Flex AtlasError 8000 fall back to
 *    listDatabases + getCollectionInfos (the full list, not cursor.firstBatch).
 *  - admin, config, and local are omitted. system.* and replset.* are omitted
 *    except system.buckets.*. A timeseries view is skipped when its buckets
 *    collection is listed, so those index bytes are counted once.
 *  - $collStats runs in a pool of 8. Driver cursor._cursor.toArray() overlaps
 *    the drains; shell toArray() would serialise them. Read concern local.
 *  - serverStatus().wiredTiger.cache is read immediately before and after the pool.
 *    The headline ratios use the after sample. Drift is after minus before.
 *    Index bytes in cache are per-index "bytes currently in the cache"
 *    (the pre-1.0.0 numerator). Page-image fill stays page images / configured.
 *
 *  TODOs:
 *  - Shard / cluster-wide report (discovery fan-out)
 *  - runCommand instead of adminCommand for directed execution
 *  - admin / config / local cache scope
 */

// Usage: mongosh [<connection options>] [--quiet] [-f|--file] </path/to/>indexCacheUtil.js

(async() => {
   /*
    *  Index cache util
    */
   const STATS_CONCURRENCY = 8;

   function commandErrorMessage(e) {
      if (!e) return 'unknown error';
      return e.codeName || e.errmsg || e.message || String(e);
   }

   function serverAtLeast(spec) {
      /*
       *  Integer major.minor.patch. Number("8.0") is 8; parseInt on each part.
       */
      const got = String(db.version() || '').split('.').map(part => parseInt(part, 10) || 0);
      const need = String(spec).split('.').map(part => parseInt(part, 10) || 0);
      for (let i = 0; i < 3; i++) {
         const a = got[i] || 0;
         const b = need[i] || 0;
         if (a !== b) return a > b;
      }
      return true;
   }

   function isMongos() {
      const doc = db.adminCommand({ "hello": 1 });
      return !!(doc && doc.msg === 'isdbgrid');
   }

   function readCache() {
      /*
       *  Point sample of this node's WiredTiger cache.
       */
      const status = db.serverStatus();
      const cache = status && status.wiredTiger && status.wiredTiger.cache;
      if (!cache) throw new Error('serverStatus().wiredTiger.cache is absent');
      return {
         "configured": +cache['maximum bytes configured'] || 0,
         "current": +cache['bytes currently in the cache'] || 0,
         "pageImages": +cache['bytes belonging to page images in the cache'] || 0
      };
   }

   function formatPct(numerator, denominator) {
      /*
       *  Zero or non-finite denominator prints n/a.
       */
      const num = +numerator;
      const den = +denominator;
      if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return 'n/a';
      return `${+(100 * (num / den)).toFixed(2)}%`;
   }

   function formatDelta(value) {
      const n = +value;
      if (!Number.isFinite(n)) return 'n/a';
      if (n > 0) return `+${n} bytes`;
      return `${n} bytes`;
   }

   function progressLine(text) {
      /*
       *  TTY redraw only. Piped output stays a clean report.
       */
      if (typeof process === 'undefined' || !process.stdout || !process.stdout.isTTY) return;
      const cols = (process.stdout.columns > 0) ? process.stdout.columns : 80;
      let msg = String(text || '').replace(/\s+/g, ' ').trim();
      if (msg.length >= cols) msg = msg.slice(0, Math.max(1, cols - 2)) + '~';
      process.stdout.write('\r' + msg + '\x1b[K');
   }

   function clearProgress() {
      if (typeof process === 'undefined' || !process.stdout || !process.stdout.isTTY) return;
      process.stdout.write('\r\x1b[2K');
   }

   async function drainAggCursor(cursor) {
      /*
       *  Drain an aggregation to an array. Do not await a live cursor (thenable
       *  drains). Driver _cursor.toArray() is a native Promise so the pool overlaps.
       *  Shell toArray() is rewriter-unwrapped to an array and serialises.
       */
      if (cursor && typeof cursor.then === 'function' && typeof cursor.close !== 'function') {
         cursor = await cursor;
      }
      if (!cursor) return [];
      const driverToArray = cursor._cursor && cursor._cursor.toArray;
      let docs = (typeof driverToArray === 'function')
         ? driverToArray.call(cursor._cursor)
         : (typeof cursor.toArray === 'function')
            ? cursor.toArray()
            : cursor;
      if (docs && typeof docs.then === 'function') docs = await docs;
      if (Array.isArray(docs)) return docs;
      return docs == null ? [] : [docs];
   }

   async function mapPool(items, concurrency, worker, onProgress) {
      /*
       *  Bounded async pool. Single-threaded next++ is safe. Yields before and
       *  after each item so sibling workers start and progress can paint between
       *  sync mongosh commands.
       */
      const list = items || [];
      const results = new Array(list.length);
      if (!list.length) return results;
      const limit = Math.max(1, Math.min(Math.floor(+concurrency) || 1, list.length));
      let next = 0, inFlight = 0, done = 0;

      function emit() {
         if (typeof onProgress === 'function') {
            onProgress({
               "done": done,
               "inFlight": inFlight,
               "queued": Math.max(0, list.length - next),
               "total": list.length
            });
         }
      }

      async function runWorker() {
         while (true) {
            const idx = next++;
            if (idx >= list.length) return;
            inFlight++;
            emit();
            await Promise.resolve();
            try {
               results[idx] = await worker(list[idx], idx);
            } finally {
               inFlight--;
               done++;
               emit();
               await Promise.resolve();
            }
         }
      }

      await Promise.all(Array.from({ length: limit }, () => runWorker()));
      return results;
   }

   function isSkippedSystemName(name) {
      /*
       *  system.* and replset.* stay out of the snapshot. system.buckets.* is
       *  the WiredTiger collection behind a timeseries view, so it stays in.
       */
      const s = String(name);
      if (s.startsWith('system.buckets.')) return false;
      return /^(system\.|replset\.)/.test(s);
   }

   function catalogEntryDb(doc = {}) {
      if (doc.db != null && String(doc.db).length) return String(doc.db);
      const ns = (doc.ns != null) ? String(doc.ns)
               : (doc.md && doc.md.ns != null) ? String(doc.md.ns)
               : '';
      const dot = ns.indexOf('.');
      return dot >= 0 ? ns.slice(0, dot) : '';
   }

   function catalogEntryName(doc = {}) {
      if (doc.name != null && String(doc.name).length) return String(doc.name);
      const ns = (doc.ns != null) ? String(doc.ns)
               : (doc.md && doc.md.ns != null) ? String(doc.md.ns)
               : '';
      const dbName = catalogEntryDb(doc);
      if (dbName && ns.startsWith(`${dbName}.`)) return ns.slice(dbName.length + 1);
      const dot = ns.indexOf('.');
      return dot >= 0 ? ns.slice(dot + 1) : ns;
   }

   function catalogEntryType(doc = {}) {
      /*
       *  listCollections: type collection|view|timeseries.
       *  $listCatalog: type, or viewOn, or md.options.timeseries.
       */
      const options = (doc.options && typeof doc.options === 'object') ? doc.options
                    : (doc.md && doc.md.options && typeof doc.md.options === 'object') ? doc.md.options
                    : {};
      if (options.timeseries) return 'timeseries';
      if (doc.viewOn != null || (doc.md && doc.md.viewOn != null) || options.viewOn != null) {
         return 'view';
      }
      const explicit = doc.type != null ? String(doc.type) : '';
      if (explicit === 'view' || explicit === 'timeseries' || explicit === 'collection') return explicit;
      return 'collection';
   }

   function normalizeCatalogEntry(doc = {}) {
      const dbName = catalogEntryDb(doc);
      const collName = catalogEntryName(doc);
      if (!dbName || !collName) return null;
      return {
         "dbName": dbName,
         "collName": collName,
         "type": catalogEntryType(doc)
      };
   }

   function dedupeEntries(entries) {
      const seen = new Map();
      for (const entry of entries) {
         if (!entry || !entry.dbName || !entry.collName) continue;
         const key = `${entry.dbName}\0${entry.collName}`;
         if (!seen.has(key)) seen.set(key, entry);
      }
      return [...seen.values()];
   }

   function selectNamespaces(entries) {
      /*
       *  User collections on this node. Count system.buckets.<name> and skip the
       *  logical collection of the same suffix when that buckets row is listed.
       *  If the buckets name is absent, keep the timeseries name.
       */
      const kept = [];
      const bucketKeys = new Set();
      for (const entry of entries) {
         if (!entry || !entry.dbName || !entry.collName) continue;
         if (entry.dbName === 'admin' || entry.dbName === 'config' || entry.dbName === 'local') continue;
         if (entry.type === 'view') continue;
         if (String(entry.collName).startsWith('system.buckets.')) {
            bucketKeys.add(`${entry.dbName}\0${entry.collName}`);
            kept.push({
               "dbName": entry.dbName,
               "collName": entry.collName,
               "type": 'collection'
            });
            continue;
         }
         if (isSkippedSystemName(entry.collName)) continue;
         if (entry.type === 'timeseries') {
            kept.push({
               "dbName": entry.dbName,
               "collName": entry.collName,
               "type": 'timeseries'
            });
            continue;
         }
         if (entry.type === 'collection') {
            kept.push({
               "dbName": entry.dbName,
               "collName": entry.collName,
               "type": 'collection'
            });
         }
      }
      return kept.filter(entry => {
         /*
          *  Drop the logical name whenever its buckets collection is listed,
          *  whatever type the catalog gave that name. Counting both doubles
          *  the index bytes. A timeseries name with no buckets row stays.
          */
         if (String(entry.collName).startsWith('system.buckets.')) return true;
         return !bucketKeys.has(`${entry.dbName}\0system.buckets.${entry.collName}`);
      });
   }

   async function listCatalogEntries() {
      /*
       *  Collectionless $listCatalog on admin (6.0+). One snapshot of this node.
       *  $listClusterCatalog is a cluster listing and is not used here.
       */
      const pipeline = [
         { "$listCatalog": {} },
         { "$project": {
            "db": 1,
            "name": 1,
            "type": 1,
            "ns": 1,
            "viewOn": 1,
            "md.options.timeseries": 1,
            "md.viewOn": 1,
            "options.timeseries": 1,
            "options.viewOn": 1
         } }
      ];
      const options = {
         "cursor": { "batchSize": 1000 },
         "readConcern": { "level": "local" },
         "comment": "indexCacheUtil $listCatalog"
      };
      const docs = await drainAggCursor(
         db.getSiblingDB('admin').aggregate(pipeline, options)
      );
      return dedupeEntries(docs.map(normalizeCatalogEntry).filter(Boolean));
   }

   async function listNamespacesLegacy(listErrors) {
      /*
       *  Full getCollectionInfos list. listDatabases.filter is applied client-side
       *  (Atlas shared tiers reject the server-side filter).
       */
      await Promise.resolve();
      const listed = db.adminCommand({
         "listDatabases": 1,
         "nameOnly": true,
         "authorizedDatabases": true
      });
      await Promise.resolve();
      const dbNames = (listed.databases || [])
         .map(entry => entry.name)
         .filter(name => name && name !== 'admin' && name !== 'config' && name !== 'local');
      const rows = [];
      for (let i = 0; i < dbNames.length; i++) {
         const dbName = dbNames[i];
         progressLine(`catalog  ${i + 1}/${dbNames.length}  ${dbName}`);
         await Promise.resolve();
         try {
            let infos = db.getSiblingDB(dbName).getCollectionInfos(
               { "type": /^(collection|timeseries)$/ },
               { "nameOnly": true, "authorizedCollections": true }
            );
            infos = await Promise.resolve(infos);
            for (const info of infos || []) {
               if (!info || !info.name) continue;
               rows.push({
                  "dbName": dbName,
                  "collName": info.name,
                  "type": info.type || 'collection'
               });
            }
         } catch(e) {
            listErrors.push(`${dbName}: ${commandErrorMessage(e)}`);
         }
         await Promise.resolve();
      }
      return selectNamespaces(rows);
   }

   async function listNamespaces() {
      const listErrors = [];
      if (serverAtLeast('6.0')) {
         try {
            const entries = await listCatalogEntries();
            return {
               "builder": 'listCatalog',
               "fallback": false,
               "fallbackError": null,
               "listErrors": listErrors,
               "namespaces": selectNamespaces(entries)
            };
         } catch(e) {
            const stageError = commandErrorMessage(e);
            try {
               const namespaces = await listNamespacesLegacy(listErrors);
               return {
                  "builder": 'legacy',
                  "fallback": true,
                  "fallbackError": stageError,
                  "listErrors": listErrors,
                  "namespaces": namespaces
               };
            } catch(legacyError) {
               throw new Error(`${stageError}; ${commandErrorMessage(legacyError)}`);
            }
         }
      }
      return {
         "builder": 'legacy',
         "fallback": false,
         "fallbackError": null,
         "listErrors": listErrors,
         "namespaces": await listNamespacesLegacy(listErrors)
      };
   }

   async function getIndexCacheStats({ dbName, collName }) {
      /*
       *  One $collStats document.
       *  resident: per-index "bytes currently in the cache" (pre-1.0.0 numerator).
       *  On-disk bytes are index file size minus bytes available for reuse.
       */
      const pipeline = [
         { "$collStats": {
            "storageStats": { "scale": 1 }
         } },
         { "$project": {
            "indexStats": {
               "$objectToArray": { "$ifNull": ["$storageStats.indexDetails", {}] }
            }
         } },
         { "$project": {
            "_id": 0,
            "totals": {
               "$reduce": {
                  "input": "$indexStats",
                  "initialValue": { "resident": 0, "fileBytes": 0, "reuseBytes": 0 },
                  "in": {
                     "resident": { "$add": [
                        "$$value.resident",
                        { "$ifNull": ["$$this.v.cache.bytes currently in the cache", 0] }
                     ] },
                     "fileBytes": { "$add": [
                        "$$value.fileBytes",
                        { "$ifNull": ["$$this.v.block-manager.file size in bytes", 0] }
                     ] },
                     "reuseBytes": { "$add": [
                        "$$value.reuseBytes",
                        { "$ifNull": ["$$this.v.block-manager.file bytes available for reuse", 0] }
                     ] }
                  }
               }
            }
         } },
         { "$project": {
            "resident": "$totals.resident",
            "fileBytes": "$totals.fileBytes",
            "reuseBytes": "$totals.reuseBytes"
         } }
      ];
      const options = {
         "cursor": { "batchSize": 1 },
         "readConcern": { "level": "local" },
         "comment": "Index cache usage query"
      };
      const docs = await drainAggCursor(
         db.getSiblingDB(dbName).getCollection(collName).aggregate(pipeline, options)
      );
      if (!docs.length) throw new Error('empty $collStats result');
      let resident = 0, fileBytes = 0, reuseBytes = 0;
      for (const doc of docs) {
         resident += +doc.resident || 0;
         fileBytes += +doc.fileBytes || 0;
         reuseBytes += +doc.reuseBytes || 0;
      }
      return {
         "resident": resident,
         "diskBytes": Math.max(0, fileBytes - reuseBytes)
      };
   }

   function printLine(label, value) {
      console.log(`\t${String(label).padEnd(36)}${value}`);
   }

   function printReport({ before, after, resident, diskBytes, catalog, measured, failed }) {
      /*
       *  Headline cache figures are the sample taken when the pool finished.
       *  before is the sample taken when the pool started.
       */
      const cache = after || before;
      console.log('\n');
      printLine('Configured WT cache size:', `${cache.configured} bytes`);
      printLine('Total bytes in cache:', `${cache.pageImages} bytes`);
      printLine('Total cache util:', formatPct(cache.pageImages, cache.configured));
      console.log('');
      printLine('Bytes currently in the cache:', `${cache.current} bytes`);
      printLine('Cache occupancy:', formatPct(cache.current, cache.configured));
      console.log('');
      printLine('Total indexes size on disk:', `${diskBytes} bytes`);
      printLine('Index bytes in cache:', `${resident} bytes`);
      printLine('Cache util by indexes:', formatPct(resident, cache.current));
      printLine('Index share of page images:', formatPct(resident, cache.pageImages));
      printLine('Index working set util:', formatPct(resident, diskBytes));
      console.log('');
      console.log('\tGather drift (end minus start):');
      printLine('Bytes currently in the cache:', after ? formatDelta(after.current - before.current) : 'n/a');
      printLine('Total bytes in cache:', after ? formatDelta(after.pageImages - before.pageImages) : 'n/a');
      console.log('');
      printLine('Catalog:', catalog.builder === 'listCatalog' ? '$listCatalog' : 'listCollections');
      printLine('Namespaces measured:', measured);
      if (failed) printLine('Namespaces failed:', failed);
      if (catalog.fallback === true) {
         let message = 'Catalog listing used listCollections after $listCatalog was unavailable or unauthorized.';
         if (catalog.fallbackError) message += ` ${catalog.fallbackError}`;
         console.log(`\n\tNOTE: ${message}`);
      }
      console.log('');
   }

   async function main() {
      /*
       *  Catalog first, then a short overlapped $collStats window bracketed
       *  by two WiredTiger cache samples.
       */
      if (isMongos()) {
         console.log('indexCacheUtil reads the WiredTiger cache of the connected mongod. This session is a mongos; connect to a member directly.');
         return;
      }
      try {
         readCache();
      } catch(e) {
         console.error('WiredTiger cache stats are unavailable:', commandErrorMessage(e));
         return;
      }

      progressLine('catalog  listing');
      let catalog;
      try {
         catalog = await listNamespaces();
      } catch(e) {
         clearProgress();
         console.error('Catalog listing failed:', commandErrorMessage(e));
         return;
      }

      const namespaces = catalog.namespaces || [];
      const total = namespaces.length;
      let resident = 0;
      let diskBytes = 0;
      let failed = 0;
      const statFailures = [];
      let before = null;
      let after = null;
      try {
         before = readCache();
         await mapPool(namespaces, STATS_CONCURRENCY, async ns => {
            try {
               const stats = await getIndexCacheStats(ns);
               resident += stats.resident;
               diskBytes += stats.diskBytes;
            } catch(e) {
               failed++;
               statFailures.push(`${ns.dbName}.${ns.collName}: ${commandErrorMessage(e)}`);
            }
         }, ({ done, inFlight, queued }) => {
            progressLine(`collStats  ${done}/${total}  run=${inFlight}  q=${queued}`);
         });
         try {
            after = readCache();
         } catch(e) {
            statFailures.push(`serverStatus after gather: ${commandErrorMessage(e)}`);
         }
      } catch(e) {
         clearProgress();
         for (const message of catalog.listErrors || []) console.error('Listing failed:', message);
         console.error('Index cache gather failed:', commandErrorMessage(e));
         return;
      } finally {
         clearProgress();
      }

      for (const message of catalog.listErrors || []) console.error('Listing failed:', message);
      for (const message of statFailures) console.error('rejected:', message);
      printReport({
         before,
         after,
         resident,
         diskBytes,
         catalog,
         "measured": total - failed,
         failed
      });
   }

   await main();
})();

// EOF
