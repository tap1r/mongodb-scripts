(() => {
   /*
    *  Name: "autoCompact.js"
    *  Version: "0.3.8"
    *  Description: "autoCompact() with log and serverStatus monitoring"
    *  Disclaimer: "https://raw.githubusercontent.com/tap1r/mongodb-scripts/master/DISCLAIMER.md"
    *  Authors: ["tap1r <luke.prochazka@gmail.com>"]
    *
    *  Notes:
    *  - mongosh only
    *  - customise command options "freeSpaceTargetMB", "runOnce", and/or "timeoutMS" if required
    *  - waits for first pass (sizeStorer WTCMPCT line); runOnce=true also ends on serverStatus idle
    *  - runOnce=false: exit after first pass and leave background compact enabled (next walk ~24h)
    *  - never-seen-running + still idle after a short grace is treated as a no-op complete
    *  - timeoutMS aborts the wait (0/omitted = no timeout)
    *  - log poll interval follows getProfilingStatus().slowms, clamped to 25-500ms (re-read every 10s; 100ms without enableProfiler)
    *  - getLog totalLinesWritten jump >= 1024 warns of missed lines and halves the poll interval until the next slowms read
    *  - preflight rejects mongos, server < 8.0, non-wiredTiger, and an already-running compact
    *  - WTCMPCT filenames are replaced with the $listCatalog namespace when resolved (WT name is the fallback)
    *  - getLog prefilters "c":"WTCMPCT" before EJSON.parse; a bad line or getLog failure does not abort the wait
    *  - log watermark is exclusive at start, then inclusive same-ms with t+msg+dhandle dedup
    *  - reports wiredTiger background-compact recovered bytes for this pass
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

   const __script = { "name": "autoCompact.js", "version": "0.3.8" };
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

   const getBackgroundCompact = () => {
      // WiredTiger background-compact.running is the authoritative idle/active flag
      let running, bytesRecovered;
      try {
         ({ 'wiredTiger': {
               'background-compact': {
                  'background compact running': running,
                  'background compact recovered bytes': bytesRecovered
               } = {}
            } = {}
         } = serverStatus({
            "wiredTiger": true
         }));
      } catch(e) {
         return null;
      }
      return {
         "running": running === undefined ? null : (running > 0 || running === true),
         "bytesRecovered": Number.isFinite(+bytesRecovered) ? +bytesRecovered : null
      };
   };
   const getAutoCompactRunning = () => getBackgroundCompact()?.running ?? null;
   class AutoFactor {
      /*
       *  Determine scale factor automatically (same idea as mdblib.js / dbstats.js)
       */
      scale(number) {
         if (number < 1) number = 1;
         return Math.min(Math.floor(Math.log2(number) / 10), this.metrics.length - 1);
      }
      metric(number) {
         return this.metrics[this.scale(number)];
      }
      format(number = 0) {
         const n = Number(number);
         if (!Number.isFinite(n)) return 'unknown';
         const value = Math.max(0, n);
         const metric = this.metric(value);
         return `${+(value / metric.factor).toFixed(metric.precision)} ${metric.symbol}`;
      }
      get metrics() {
         return [
            { "unit": "bytes", "symbol": "B", "factor": 1, "precision": 0 },
            { "unit": "kibibytes", "symbol": "KiB", "factor": 1024, "precision": 2 },
            { "unit": "mebibytes", "symbol": "MiB", "factor": Math.pow(1024, 2), "precision": 2 },
            { "unit": "gibibytes", "symbol": "GiB", "factor": Math.pow(1024, 3), "precision": 2 },
            { "unit": "tebibytes", "symbol": "TiB", "factor": Math.pow(1024, 4), "precision": 2 },
            { "unit": "pebibytes", "symbol": "PiB", "factor": Math.pow(1024, 5), "precision": 2 },
            { "unit": "exbibytes", "symbol": "EiB", "factor": Math.pow(1024, 6), "precision": 2 }
         ];
      }
   }
   const scaled = new AutoFactor();
   const reportRecoveredBytes = startBytes => {
      const endBytes = getBackgroundCompact()?.bytesRecovered;
      if (endBytes == null) {
         console.log('\t══════ recovered bytes: unavailable ══════');
         return;
      }
      const delta = startBytes != null ? endBytes - startBytes : endBytes;
      console.log(`\n\t══════ recovered ${scaled.format(delta)} this pass (${scaled.format(endBytes)} cumulative) ══════`);
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
         console.log(`\x1b[31m[ERROR] autoCompact() requires MongoDB 8.0+; detected ${db.version()}\x1b[0m`);
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
            "storageEngine": true,
            "wiredTiger": true
         }));
      } catch(e) {
         console.log('\x1b[31m[ERROR] serverStatus() failed:\x1b[0m', e);
         return false;
      }
      if (engine != null && engine !== 'wiredTiger') {
         console.log(`\x1b[31m[ERROR] autoCompact() requires wiredTiger; detected storage engine "${engine}"\x1b[0m`);
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
         console.log('\x1b[31m[WARN] $listCatalog() unavailable, WTCMPCT lines will show WT filenames:\x1b[0m', e);
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
      return text.includes('sizeStorer') // sizeStorer is assumed to be the last WT namespace, but only if it was skipped
   };
   const POLL_MS_MIN = 25;
   const POLL_MS_MAX = 500;
   const POLL_MS_FALLBACK = 100;
   const SLOWMS_REFRESH_MS = 10000;
   const GETLOG_CAP = 1024;
   const clampPollMS = ms => {
      const n = +ms;
      if (!Number.isFinite(n) || n <= 0) return POLL_MS_FALLBACK;
      return Math.min(POLL_MS_MAX, Math.max(POLL_MS_MIN, n));
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
   const logKey = ({ t, 'attr': { 'message': { msg = '', session_dhandle_name = '' } = {} } = {} } = {}) =>
      `${+t}\0${session_dhandle_name}\0${msg}`;
   const getLogs = (since, seen) => {
      // ramlog is ~1024 raw JSON lines; skip non-WTCMPCT before EJSON.parse
      let lines, totalLinesWritten;
      try {
         ({ "log": lines = [], "totalLinesWritten": totalLinesWritten } = db.adminCommand({ "getLog": "global" }));
      } catch(e) {
         if (!getLogWarned) {
            console.log('\x1b[31m[WARN] getLog() unavailable, relying on serverStatus() for idle detection:\x1b[0m', e);
            getLogWarned = true;
         }
         return { "logs": [], "totalLinesWritten": null };
      }
      const out = [];
      for (const line of lines) {
         if (!String(line).includes('"c":"WTCMPCT"')) continue;
         try {
            const entry = EJSON.parse(line);
            // start watermark is exclusive; later same-ms siblings are kept if not yet seen
            if (entry.t < since) continue;
            if (+entry.t === +since && seen.size === 0) continue;
            const key = logKey(entry);
            if (seen.has(key)) continue;
            out.push(entry);
         } catch(e) {
            // skip malformed WTCMPCT line
         }
      }
      return { "logs": out, "totalLinesWritten": totalLinesWritten };
   };
   const tailLogs = (ts, timeoutMS = 0, resolveNs = () => null, runOnce = true) => {
      let pause = false;
      let firstPassDone = false;
      let seenRunning = false;
      let fallbackWarned = false;
      const graceMS = 2000;
      const started = Date.now();
      const seen = new Set();
      const slowms = getSlowms();
      if (slowms == null) {
         console.log(`\x1b[31m[WARN] getProfilingStatus() unavailable, polling every ${POLL_MS_FALLBACK}ms\x1b[0m`);
         fallbackWarned = true;
      }
      let pollMS = clampPollMS(slowms);
      let lastSlowmsAt = Date.now();
      let lastTotal = null;
      const startBytes = getBackgroundCompact()?.bytesRecovered;

      do {
         if (timeoutMS > 0 && Date.now() - started >= timeoutMS) {
            console.log(`\x1b[31m[ERROR] timed out after ${timeoutMS}ms waiting for autoCompact()\x1b[0m`);
            reportRecoveredBytes(startBytes);
            return;
         }
         const { logs, totalLinesWritten } = getLogs(ts, seen);
         if (Number.isFinite(totalLinesWritten)) {
            if (lastTotal != null && totalLinesWritten - lastTotal >= GETLOG_CAP) {
               const next = Math.max(POLL_MS_MIN, Math.floor(pollMS / 2));
               console.log(`\x1b[31m[WARN] getLog overflow: ${totalLinesWritten - lastTotal} lines since last poll (ramlog ~${GETLOG_CAP}); tightening poll ${pollMS}ms → ${next}ms\x1b[0m`);
               pollMS = next;
            }
            lastTotal = totalLinesWritten;
         }
         if (logs.length > 0) {
            logs.forEach(entry => {
               const { t = ISODate(), 'attr': { 'message': { msg = '', session_dhandle_name = '' } = {} } = {} } = entry;
               seen.add(logKey(entry));
               if (t > ts) ts = t;
               if (isSizeStorerSkip(msg, session_dhandle_name)) firstPassDone = true;
               console.log(t.toJSON(), annotateWtMsg(msg, session_dhandle_name, resolveNs));
            });
            pause = false; // reset pause when new log entries are present
         } else if (!pause) {
            console.log('\t══════ autoCompaction work in progress, waiting for new logs ══════\n');
            pause = true; // set pause to prevent repeated messages
         }
         if (firstPassDone) break;
         // 1→0 means the thread stopped (runOnce finished, or compact was disabled).
         // runOnce=false stays running after the first pass — do not require idle.
         const running = getAutoCompactRunning();
         if (running === true) seenRunning = true;
         if (seenRunning && running === false) {
            console.log('\n\t══════ serverStatus: background compact idle ══════');
            break;
         }
         if (!seenRunning && running === false && Date.now() - started >= graceMS) {
            console.log('\n\t══════ serverStatus: background compact idle (no-op) ══════');
            break;
         }
         if (Date.now() - lastSlowmsAt >= SLOWMS_REFRESH_MS) {
            const refreshed = getSlowms();
            if (refreshed == null && !fallbackWarned) {
               console.log(`\x1b[31m[WARN] getProfilingStatus() unavailable, polling every ${POLL_MS_FALLBACK}ms\x1b[0m`);
               fallbackWarned = true;
            }
            pollMS = clampPollMS(refreshed);
            lastSlowmsAt = Date.now();
         }
         sleep(pollMS);
      } while (!firstPassDone);
      if (!runOnce && firstPassDone) {
         console.log('\n\t══════ first pass complete; background compact left enabled (next walk ~24h) ══════');
         reportRecoveredBytes(startBytes);
         return;
      }
      console.log('\n\t══════ autoCompaction round complete ══════');
      reportRecoveredBytes(startBytes);
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
   console.log(`Executing shell command:\ndb.adminCommand(${EJSON.stringify(cmd, null, 3)});\n`);
   const ts = ISODate();
   let result;
   try {
      result = db.adminCommand(cmd);
   } catch(e) {
      console.log('\x1b[31m[ERROR] autoCompact() failed:\x1b[0m', e);
      return;
   }
   if (result?.ok !== 1) {
      console.log('\x1b[31m[ERROR] autoCompact() failed:\x1b[0m', result);
      return;
   }
   tailLogs(ts, options.timeoutMS, resolveNs, options.runOnce);
})();

// EOF
