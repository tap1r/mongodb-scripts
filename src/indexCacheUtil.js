/*
 *  Name: "indexCacheUtil.js"
 *  Version: "1.1.0"
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
 *  - Cache sample is { serverStatus: 1, none: true, wiredTiger: 1 }, once after
 *    the catalog and once after the pool. Full serverStatus is the fallback.
 *    Headline ratios use the end sample. Drift is end minus start.
 *  - Index bytes are per-index "bytes currently in the cache" via $getField.
 *    A missing field is unknown (n/a), not 0. Page-image fill stays
 *    page images / configured. Bytes not belonging to page images sit beside
 *    occupancy.
 *  - The collection btree's cache bytes come from the same $collStats.
 *    Other bytes currently in the cache are the server total minus indexes
 *    minus those collection bytes.
 *  - Up to 5 namespaces: the report lists each namespace and each index.
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
   const INDEX_DETAIL_MAX_NAMESPACES = 5;

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

   function cacheBlock(status) {
      return status && status.wiredTiger && status.wiredTiger.cache;
   }

   function readCache() {
      /*
       *  Point sample of this node's WiredTiger cache.
       *  none:true plus wiredTiger is the slim 8.0 shape. Older servers fall
       *  back to a full serverStatus.
       */
      let cache = null;
      try {
         cache = cacheBlock(db.adminCommand({
            "serverStatus": 1,
            "none": true,
            "wiredTiger": 1
         }));
      } catch(e) {
         cache = null;
      }
      if (!cache) cache = cacheBlock(db.serverStatus());
      if (!cache) throw new Error('serverStatus().wiredTiger.cache is absent');
      const current = +cache['bytes currently in the cache'] || 0;
      const pageImages = +cache['bytes belonging to page images in the cache'] || 0;
      const notPage = cache['bytes not belonging to page images in the cache'];
      return {
         "configured": +cache['maximum bytes configured'] || 0,
         "current": current,
         "pageImages": pageImages,
         "notPageImages": (notPage == null) ? (current - pageImages) : +notPage
      };
   }

   function formatPct(numerator, denominator) {
      /*
       *  A missing numerator or a zero/non-finite denominator prints n/a.
       *  +null is 0, so null must be rejected before coercion.
       */
      if (numerator == null || denominator == null) return 'n/a';
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

   function formatBytes(value) {
      if (value == null || !Number.isFinite(+value)) return 'n/a';
      return `${value} bytes`;
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

   function wtField(parent, section, field) {
      /*
       *  $getField so a space-bearing WiredTiger name is one field, and a
       *  missing field stays missing instead of collapsing to 0.
       */
      return {
         "$getField": {
            "field": field,
            "input": { "$getField": { "field": section, "input": parent } }
         }
      };
   }

   function knownOrNull(expr) {
      return {
         "$let": {
            "vars": { "v": expr },
            "in": {
               "$cond": [
                  { "$eq": [{ "$type": "$$v" }, "missing"] },
                  null,
                  "$$v"
               ]
            }
         }
      };
   }

   function diskOf(fileBytes, reuseBytes) {
      if (fileBytes == null || reuseBytes == null) return null;
      const file = +fileBytes;
      const reuse = +reuseBytes;
      if (!Number.isFinite(file) || !Number.isFinite(reuse)) return null;
      return Math.max(0, file - reuse);
   }

   async function getIndexCacheStats({ dbName, collName }) {
      /*
       *  One $collStats document. Resident bytes are per-index and collection
       *  "bytes currently in the cache". On-disk index bytes are file size
       *  minus bytes available for reuse. A missing counter stays null.
       */
      const pipeline = [
         { "$collStats": {
            "storageStats": { "scale": 1 }
         } },
         { "$project": {
            "_id": 0,
            "indexDetailsPresent": {
               "$ne": [{ "$type": "$storageStats.indexDetails" }, "missing"]
            },
            "collResident": knownOrNull(wtField(
               "$storageStats.wiredTiger", "cache", "bytes currently in the cache"
            )),
            "indexes": {
               "$map": {
                  "input": { "$objectToArray": { "$ifNull": ["$storageStats.indexDetails", {}] } },
                  "as": "i",
                  "in": {
                     "name": "$$i.k",
                     "resident": knownOrNull(wtField(
                        "$$i.v", "cache", "bytes currently in the cache"
                     )),
                     "fileBytes": knownOrNull(wtField(
                        "$$i.v", "block-manager", "file size in bytes"
                     )),
                     "reuseBytes": knownOrNull(wtField(
                        "$$i.v", "block-manager", "file bytes available for reuse"
                     ))
                  }
               }
            }
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
      let resident = 0;
      let residentComplete = true;
      let diskBytes = 0;
      let diskComplete = true;
      let collResident = 0;
      let collComplete = true;
      const indexes = [];
      for (const doc of docs) {
         if (!doc.indexDetailsPresent) {
            residentComplete = false;
            diskComplete = false;
         } else {
            for (const idx of doc.indexes || []) {
               const idxResident = (idx.resident == null) ? null : +idx.resident;
               const idxDisk = diskOf(idx.fileBytes, idx.reuseBytes);
               if (idxResident == null || !Number.isFinite(idxResident)) residentComplete = false;
               else resident += idxResident;
               if (idxDisk == null) diskComplete = false;
               else diskBytes += idxDisk;
               indexes.push({
                  "name": idx.name,
                  "resident": (idxResident == null || !Number.isFinite(idxResident)) ? null : idxResident,
                  "diskBytes": idxDisk
               });
            }
         }
         if (doc.collResident == null || !Number.isFinite(+doc.collResident)) collComplete = false;
         else collResident += +doc.collResident;
      }
      return {
         "resident": residentComplete ? resident : null,
         "residentComplete": residentComplete,
         "diskBytes": diskComplete ? diskBytes : null,
         "diskComplete": diskComplete,
         "collResident": collComplete ? collResident : null,
         "collComplete": collComplete,
         "indexes": indexes
      };
   }

   function printLine(label, value) {
      console.log(`\t${String(label).padEnd(36)}${value}`);
   }

   function formatIndexLine(row) {
      const cache = (row.resident == null) ? 'n/a' : `${row.resident} bytes in cache`;
      const disk = (row.diskBytes == null) ? 'n/a' : `${row.diskBytes} bytes on disk`;
      const pct = (row.resident == null || row.diskBytes == null)
         ? 'n/a'
         : formatPct(row.resident, row.diskBytes);
      return `${cache}    ${disk}    ${pct}`;
   }

   function printReport({
      before, after, resident, residentComplete, diskBytes, diskComplete,
      collResident, collComplete, indexRows, showDetail, catalog, measured, failed
   }) {
      /*
       *  Headline cache figures are the sample taken when the pool finished.
       *  before is the sample taken when the pool started.
       *  An incomplete index or collection sum prints n/a, not a partial total.
       */
      const cache = after || before;
      const indexBytes = residentComplete ? resident : null;
      const indexDisk = diskComplete ? diskBytes : null;
      const collBytes = collComplete ? collResident : null;
      const otherBytes = (indexBytes == null || collBytes == null)
         ? null
         : (cache.current - indexBytes - collBytes);
      console.log('\n');
      printLine('Configured WT cache size:', formatBytes(cache.configured));
      printLine('Total bytes in cache:', formatBytes(cache.pageImages));
      printLine('Total cache util:', formatPct(cache.pageImages, cache.configured));
      console.log('');
      printLine('Bytes currently in the cache:', formatBytes(cache.current));
      printLine('Bytes not belonging to page images:', formatBytes(cache.notPageImages));
      printLine('Cache occupancy:', formatPct(cache.current, cache.configured));
      console.log('');
      printLine('Total indexes size on disk:', formatBytes(indexDisk));
      printLine('Index bytes in cache:', formatBytes(indexBytes));
      printLine('Cache util by indexes:', formatPct(indexBytes, cache.current));
      printLine('Index share of page images:', formatPct(indexBytes, cache.pageImages));
      printLine('Index working set util:', formatPct(indexBytes, indexDisk));
      console.log('');
      printLine('Collection bytes in cache:', formatBytes(collBytes));
      printLine('Other bytes in cache:', formatBytes(otherBytes));
      console.log('');
      console.log('\tGather drift (end minus start):');
      printLine('Bytes currently in the cache:', after ? formatDelta(after.current - before.current) : 'n/a');
      printLine('Total bytes in cache:', after ? formatDelta(after.pageImages - before.pageImages) : 'n/a');
      console.log('');
      printLine('Catalog:', catalog.builder === 'listCatalog' ? '$listCatalog' : 'listCollections');
      printLine('Namespaces measured:', measured);
      if (showDetail) {
         for (const ns of catalog.namespaces || []) {
            console.log(`\t${ns.dbName}.${ns.collName}`);
         }
         if (indexRows.length) {
            const rows = indexRows.slice().sort((a, b) => {
               const ar = (a.resident == null) ? -1 : a.resident;
               const br = (b.resident == null) ? -1 : b.resident;
               return br - ar;
            });
            console.log('');
            console.log('\tIndexes:');
            for (const row of rows) {
               console.log(`\t${row.ns}  ${row.name}`);
               console.log(`\t    ${formatIndexLine(row)}`);
            }
         }
      }
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
      let residentComplete = true;
      let diskBytes = 0;
      let diskComplete = true;
      let collResident = 0;
      let collComplete = true;
      let failed = 0;
      const statFailures = [];
      const indexRows = [];
      let before = null;
      let after = null;
      try {
         before = readCache();
         await mapPool(namespaces, STATS_CONCURRENCY, async ns => {
            try {
               const stats = await getIndexCacheStats(ns);
               const nsName = `${ns.dbName}.${ns.collName}`;
               if (!stats.residentComplete) residentComplete = false;
               else resident += stats.resident;
               if (!stats.diskComplete) diskComplete = false;
               else diskBytes += stats.diskBytes;
               if (!stats.collComplete) collComplete = false;
               else collResident += stats.collResident;
               for (const idx of stats.indexes) {
                  indexRows.push({ "ns": nsName, ...idx });
               }
            } catch(e) {
               failed++;
               residentComplete = false;
               diskComplete = false;
               collComplete = false;
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
         residentComplete,
         diskBytes,
         diskComplete,
         collResident,
         collComplete,
         indexRows,
         "showDetail": total <= INDEX_DETAIL_MAX_NAMESPACES,
         catalog,
         "measured": total - failed,
         failed
      });
   }

   await main();
})();

// EOF
