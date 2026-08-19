(() => {
   /*
    *  Name: "autoCompact.js"
    *  Version: "0.3.4"
    *  Description: "autoCompact() with log and serverStatus monitoring"
    *  Disclaimer: "https://raw.githubusercontent.com/tap1r/mongodb-scripts/master/DISCLAIMER.md"
    *  Authors: ["tap1r <luke.prochazka@gmail.com>"]
    *
    *  Notes:
    *  - customise command options "freeSpaceTargetMB", "runOnce", and/or "timeoutMS" if required
    *  - waits for a sizeStorer "skipping compaction" WTCMPCT line, or serverStatus background compact idle
    *  - timeoutMS aborts the wait (0/omitted = no timeout)
    *  - log poll interval follows getProfilingStatus().slowms (re-read each poll); 100ms without enableProfiler
    *  - mongosh only
    *  - preflight rejects mongos, server < 8.0, non-wiredTiger, and an already-running compact
    *  - WTCMPCT filenames are replaced with the $listCatalog namespace when resolved (WT name is the fallback)
    *  - getLog prefilters "c":"WTCMPCT" before EJSON.parse; a bad line or getLog failure does not abort the wait
    */

   // Usage: mongosh [direct host connection options] [--quiet] [--eval 'const freeSpaceTargetMB = 1, runOnce = true, timeoutMS = 0;'] [-f|--file] </path/to/>autoCompact.js

   /*
    *  Example of basic direct localhost usage:
    *
    *    mongosh "localhost:27017" autoCompact.js
    *
    *  Example using custom autoCompact command options:
    *
    *    mongosh "localhost:27017" --quiet --eval 'const freeSpaceTargetMB = 64, runOnce = true, timeoutMS = 3600000;' -f autoCompact.js
    */

   const __script = { "name": "autoCompact.js", "version": "0.3.4" };
   console.log(`\n\x1b[33m#### Running script ${__script.name} v${__script.version} on shell v${version()}\x1b[0m\n`);

   function serverStatus(serverStatusOptions = {}) {
      /*
      *  opt-in version of db.serverStatus()
      */
      const serverStatusOptionsDefaults = { // multiversion compatible
         "activeIndexBuilds": false,
         "asserts": false,
         "batchedDeletes": false,
         "bucketCatalog": false,
         "catalogStats": false,
         "changeStreamPreImages": false,
         "collectionCatalog": false,
         "connections": false,
         "defaultRWConcern": false,
         "directShardConnections": false,
         "electionMetrics": false,
         "encryptionAtRest": false,
         "extra_info": false,
         "featureCompatibilityVersion": false,
         "fle": false,
         "flowControl": false,
         "globalLock": false,
         "health": false,
         "hedgingMetrics": false,
         "indexBuilds": false,
         "indexBulkBuilder": false,
         "indexStats": false,
         "internalTransactions": false,
         "Instance Information": false,
         "latchAnalysis": false,
         "locks": false,
         "logicalSessionRecordCache": false,
         "mem": false,
         "metrics": false,
         "mirroredReads": false,
         "network": false,
         "opLatencies": false,
         "opReadConcernCounters": false,
         "opWorkingTime": false,
         "opWriteConcernCounters": false,
         "opcounters": false,
         "opcountersRepl": false,
         "oplogTruncation": false,
         "oplogTruncationThread": false,
         "planCache": false,
         "profiler": false,
         "queryAnalyzers": false,
         "querySettings": false,
         "queues": false,
         "readConcernCounters": false,
         "readPreferenceCounters": false,
         "recoveryOplogApplier": false,
         "repl": false,
         "scramCache": false,
         "security": false,
         "sharding": false,
         "shardingStatistics": false,
         "shardedIndexConsistency": false,
         "shardSplits": false,
         "storageEngine": false,
         "tcmalloc": false,
         "tenantMigrations": false,
         "trafficRecording": false,
         "transactions": false,
         "transportSecurity": false,
         "twoPhaseCommitCoordinator": false,
         "watchdog": false,
         "wiredTiger": false,
         "writeBacksQueued": false
      };

      return db.adminCommand({
         "serverStatus": true,
         ...{ ...serverStatusOptionsDefaults, ...serverStatusOptions }
      });
   }

   const getAutoCompactRunning = () => {
      // WiredTiger background-compact.running is the authoritative idle/active flag
      let running;
      try {
         ({ 'wiredTiger': {
               'background-compact': {
                  'background compact running': running
               } = {}
            } = {}
         } = serverStatus({
            "wiredTiger": true
         }));
      } catch(e) {
         return null;
      }
      if (running === undefined) return null;
      return running > 0 || running === true;
   };
   const preflight = () => {
      // autoCompact is mongod 8.0+ / wiredTiger only and errors if already running
      try {
         if (db.hello().msg === 'isdbgrid') {
            console.log('\x1b[31m[ERROR] autoCompact() is not supported on mongos; connect directly to a mongod\x1b[0m');
            return false;
         }
      } catch(e) {
         console.log('\x1b[31m[ERROR] hello() failed:\x1b[0m', e);
         return false;
      }
      let major;
      try {
         major = parseInt(String(db.version()).split('.')[0], 10);
      } catch(e) {
         console.log('\x1b[31m[ERROR] db.version() failed:\x1b[0m', e);
         return false;
      }
      if (!Number.isFinite(major) || major < 8) {
         console.log(`\x1b[31m[ERROR] autoCompact requires MongoDB 8.0+; detected ${db.version()}\x1b[0m`);
         return false;
      }
      let engine, running;
      try {
         ({ 'storageEngine': { 'name': engine = '' } = {},
            'wiredTiger': {
               'background-compact': {
                  'background compact running': running = ''
               } = {}
            } = {}
         } = serverStatus({
            "wiredTiger": true
         }));
      } catch(e) {
         console.log('\x1b[31m[ERROR] serverStatus failed:\x1b[0m', e);
         return false;
      }
      if (engine != null && engine !== 'wiredTiger') {
         console.log(`\x1b[31m[ERROR] autoCompact requires wiredTiger; detected storage engine "${engine}"\x1b[0m`);
         return false;
      }
      if (running > 0 || running === true) {
         console.log('\x1b[31m[ERROR] background compact already running; disable first with db.adminCommand({ "autoCompact": false })\x1b[0m');
         return false;
      }
      return true;
   };
   const identKey = name => String(name ?? '')
      .replace(/^(?:file:|table:|statistics:table:)/, '')
      .replace(/\.wt$/, '');
   const buildIdentMap = () => {
      // ident -> { kind, ns, idx? }; special WT files are internal
      const map = new Map([
         ['sizeStorer', { "kind": "internal", "ns": "(sizeStorer)" }],
         ['WiredTigerHS', { "kind": "internal", "ns": "(history store)" }],
         ['_mdb_catalog', { "kind": "internal", "ns": "(catalog)" }]
      ]);
      let ok = false;
      try {
         db.getSiblingDB('admin').aggregate([
            { "$listCatalog": {} },
            { "$project": {
               "ns": 1,
               "db": 1,
               "name": 1,
               "ident": 1,
               "idxIdent": 1
            } }],
            { "comment": `${__script.name} v${__script.version} ident map` }
         ).forEach(doc => {
            const ns = doc.ns ?? (doc.db && doc.name ? `${doc.db}.${doc.name}` : null);
            if (typeof doc.ident === 'string' && ns) map.set(doc.ident, { "kind": "collection", "ns": ns });
            if (doc.idxIdent && ns) {
               for (const [idx, ident] of Object.entries(doc.idxIdent)) {
                  if (typeof ident === 'string') map.set(ident, { "kind": "index", "ns": ns, "idx": idx });
               }
            }
         });
         ok = true;
      } catch(e) {
         console.log('\x1b[31m[WARN] $listCatalog unavailable, WTCMPCT lines will show WT filenames:\x1b[0m', e);
      }
      return { map, ok };
   };
   const nsFromWt = (name, map) => {
      const key = identKey(name);
      return key ? map.get(key) ?? null : null;
   };
   const nsPlain = entry => {
      if (!entry) return null;
      return entry.kind === 'index' ? `${entry.ns}.${entry.idx}` : entry.ns;
   };
   const nsColored = entry => {
      if (!entry) return null;
      if (entry.kind === 'internal') return `\x1b[31m${entry.ns}\x1b[0m`;
      if (entry.kind === 'index') return `\x1b[33m${entry.ns}\x1b[0m.\x1b[32m${entry.idx}\x1b[0m`;
      return `\x1b[33m${entry.ns}\x1b[0m`;
   };
   const wtNameFromMsg = (msg = '', dhandle) => {
      if (dhandle) return dhandle;
      const match = String(msg).match(/(?:file:|table:)?(?:[\w.-]+\/)?[\w.-]+\.wt/);
      return match ? match[0] : null;
   };
   const makeNsResolver = () => {
      let { map, ok } = buildIdentMap();
      let refreshed = !ok;
      return name => {
         let ns = nsFromWt(name, map);
         if (ns || !name) return ns;
         if (!refreshed) {
            // unknown ident: collection created during this pass
            refreshed = true;
            ({ map } = buildIdentMap());
            ns = nsFromWt(name, map);
         }
         return ns;
      };
   };
   const annotateWtMsg = (msg, dhandle, resolveNs) => {
      const text = String(msg);
      const wtName = wtNameFromMsg(text, dhandle);
      let out = text;
      if (wtName) {
         const entry = resolveNs(wtName);
         const plain = nsPlain(entry);
         if (plain && !text.includes(plain)) {
            const key = identKey(wtName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            if (key) {
               const substituted = text.replace(new RegExp(`(?:file:|table:)?${key}(?:\\.wt)?`, 'g'), nsColored(entry));
               if (substituted !== text) out = substituted;
            }
         }
      }
      return out.replace(/there is no useful work to do -\s*/g, '');
   };
   const isSizeStorerSkip = (msg = '', dhandle = '') => {
      // first-pass end: WT skipped sizeStorer (wording varies by verbosity)
      const text = `${dhandle} ${msg}`;
      return text.includes('sizeStorer') // sizeStorer is assumed to be the last WT namespace, skipped or otherwise
   };
   const getSlowms = () => {
      // Atlas may change the effective threshold at runtime; profile status is the live value
      try {
         const { slowms } = db.getSiblingDB('admin').getProfilingStatus();
         if (Number.isFinite(+slowms) && +slowms > 0) return +slowms;
      } catch(e) {
         return null; // enableProfiler required
      }
      return null;
   };
   let getLogWarned = false;
   const getLogs = ts => {
      // ramlog is ~1024 raw JSON lines; skip non-WTCMPCT before EJSON.parse
      let lines;
      try {
         ({ "log": lines = [] } = db.adminCommand({ "getLog": "global" }));
      } catch(e) {
         if (!getLogWarned) {
            console.log('\x1b[31m[WARN] getLog() unavailable, relying on serverStatus idle:\x1b[0m', e);
            getLogWarned = true;
         }
         return [];
      }
      const out = [];
      for (const line of lines) {
         if (!String(line).includes('"c":"WTCMPCT"')) continue;
         try {
            const entry = EJSON.parse(line);
            if (entry.t > ts) out.push(entry);
         } catch(e) {
            // skip malformed WTCMPCT line
         }
      }
      return out;
   };
   const tailLogs = (ts, timeoutMS = 0, resolveNs = () => null) => {
      let pause = false;
      let firstPassDone = false;
      let seenRunning = false;
      let fallbackWarned = false;
      const fallbackMS = 100;
      const started = Date.now();

      do {
         if (timeoutMS > 0 && Date.now() - started >= timeoutMS) {
            console.log(`\x1b[31m[ERROR] timed out after ${timeoutMS}ms waiting for autoCompact\x1b[0m`);
            return;
         }
         const logs = getLogs(ts);
         if (logs.length > 0) {
            logs.forEach(({ t = ISODate(), 'attr': { 'message': { msg = '', session_dhandle_name = '' } = {} } = {} } = {}) => {
               ts = t;
               if (isSizeStorerSkip(msg, session_dhandle_name)) firstPassDone = true;
               console.log(t.toJSON(), annotateWtMsg(msg, session_dhandle_name, resolveNs));
            });
            pause = false; // reset pause when new log entries are present
         } else if (!pause) {
            console.log('\n\t══════ Compaction work in progress, waiting for new logs ══════\n');
            pause = true; // set pause to prevent repeated messages
         }
         // serverStatus 1→0 overrides the log stop line (log text/verbosity is version-fragile)
         const running = getAutoCompactRunning();
         if (running === true) seenRunning = true;
         if (seenRunning && running === false) {
            console.log('\n\t══════ serverStatus: background compact idle ══════');
            break;
         }
         const slowms = getSlowms();
         if (slowms == null && !fallbackWarned) {
            console.log(`\x1b[31m[WARN] getProfilingStatus() unavailable, polling every ${fallbackMS}ms\x1b[0m`);
            fallbackWarned = true;
         }
         sleep(slowms ?? fallbackMS);
      } while (!firstPassDone);
      console.log('\n\t══════ autoCompaction round complete ══════');
   };

   // --eval may bind these with const; never reassign, resolve into locals
   const timeoutMSOpt = typeof timeoutMS === 'undefined' ? 0 : timeoutMS ?? 0;
   const options = {
      "freeSpaceTargetMB": typeof freeSpaceTargetMB === 'undefined' ? 1 : freeSpaceTargetMB ?? 1,
      "runOnce": typeof runOnce === 'undefined' ? true : runOnce ?? true,
      "timeoutMS": Number.isFinite(+timeoutMSOpt) && +timeoutMSOpt > 0 ? +timeoutMSOpt : 0
   };
   if (!preflight()) return;
   const resolveNs = makeNsResolver();
   const cmd = {
      "autoCompact": true,
      "freeSpaceTargetMB": options.freeSpaceTargetMB,
      "runOnce": options.runOnce
   };
   console.log(`Executing command:\ndb.adminCommand(${EJSON.stringify(cmd, null, 3)});\n`);
   const ts = ISODate();
   let result;
   try {
      result = db.adminCommand(cmd);
   } catch(e) {
      console.log('\x1b[31m[ERROR] autoCompact failed:\x1b[0m', e);
      return;
   }
   if (result?.ok !== 1) {
      console.log('\x1b[31m[ERROR] autoCompact failed:\x1b[0m', result);
      return;
   }
   tailLogs(ts, options.timeoutMS, resolveNs);
})();

// EOF
