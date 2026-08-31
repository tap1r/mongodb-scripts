(async() => {
   /*
    *  Name: "autoCompact.js"
    *  Version: "0.4.25"
    *  Description: "auto/background compaction (autoCompact command) with thread monitoring"
    *  Disclaimer: "https://raw.githubusercontent.com/tap1r/mongodb-scripts/master/DISCLAIMER.md"
    *  Authors: ["tap1r <luke.prochazka@gmail.com>"]
    *
    *  Notes:
    *  - automates the autoCompact command with monitoring (https://www.mongodb.com/docs/v8.0/reference/command/autoCompact/)
    *  - mongosh only; MongoDB 8.0+ WiredTiger mongod (not mongos). Do not top-level-await this IIFE (rewriter SyntaxError)
    *  - Atlas M0/Flex: isAtlasPlatform('sharedTier') fails fast; serverless platform string kept (deprecated). https://www.mongodb.com/docs/atlas/unsupported-commands/
    *  - per mongod only (not replicated); excludes local.oplog.rs
    *  - { autoCompact: true } (default) enables; { autoCompact: false } disables and exits (no log tail)
    *  - freeSpaceTargetMB passthrough (server default 20); runOnce defaults to true (opposite of the server)
    *  - already-enabled: autoCompact:false, wait for running bit to clear (unbounded, 30s notes), re-issue user options
    *  - ident → ns map from background $listCatalog (first batch or IDENT_FIRST_MS); await delay() so the pump can run
    *  - WTCMPCT watermark is serverStatus.localTime immediately before enable (not client ISODate)
    *  - first-pass latch: sizeStorer hint, or WT visits (success+skipped*+timeout+interrupted+failed) stall with no WTCMPCT heartbeat, or visits >= catalog ident count after $listCatalog. runOnce:false does not clear the running bit. $currentOp is unused (command only). Recovered-bytes stall is not a stop.
    */

   // Usage: mongosh [direct host connection options] [--quiet] [--eval 'var autoCompactOptions = { "autoCompact": true };'] [-f|--file] </path/to/>autoCompact.js

   /*
    *  Example of basic direct localhost usage (autoCompact: true, runOnce: true):
    *
    *    mongosh "localhost:27017" autoCompact.js
    *
    *  Example to enable with custom command options:
    *
    *    mongosh "localhost:27017" --quiet --eval 'var autoCompactOptions = { "autoCompact": true, "freeSpaceTargetMB": 64, "runOnce": true };' -f autoCompact.js
    *
    *  Example to enable continuous compaction:
    *
    *    mongosh "localhost:27017" --quiet --eval 'var autoCompactOptions = { "autoCompact": true, "runOnce": false };' -f autoCompact.js
    *
    *  Example to disable the background compact thread:
    *
    *    mongosh "localhost:27017" --quiet --eval 'var autoCompactOptions = { "autoCompact": false };' -f autoCompact.js
    *
    *  We use 'var' to interoperate with mongosh's sloppy mode
    */

   const __script = { "name": "autoCompact.js", "version": "0.4.25" };

   // colour tags ([red]/[yellow]/[/] …) expanded on TTY; ANSI stripped when piped (from mdblib.js)
   const isMongosh = () => typeof process !== 'undefined';
   const ansiTags = [
      { "tag": "\/", "code": 0 },
      { "tag": "bold", "code": 1 },
      { "tag": "dim", "code": 2 },
      { "tag": "italic", "code": 3 },
      { "tag": "underline", "code": 4 },
      { "tag": "blink", "code": 5 },
      { "tag": "reverse", "code": 7 },
      { "tag": "hide", "code": 8 },
      { "tag": "strike", "code": 9 },
      { "tag": "black", "code": 30 },
      { "tag": "k", "code": 30 },
      { "tag": "red", "code": 31 },
      { "tag": "r", "code": 31 },
      { "tag": "green", "code": 32 },
      { "tag": "g", "code": 32 },
      { "tag": "yellow", "code": 33 },
      { "tag": "y", "code": 33 },
      { "tag": "blue", "code": 34 },
      { "tag": "b", "code": 34 },
      { "tag": "magenta", "code": 35 },
      { "tag": "m", "code": 35 },
      { "tag": "cyan", "code": 36 },
      { "tag": "c", "code": 36 },
      { "tag": "white", "code": 37 },
      { "tag": "e", "code": 37 },
      { "tag": "default", "code": 39 },
      { "tag": "bg black", "code": 40 },
      { "tag": "bg red", "code": 41 },
      { "tag": "bg green", "code": 42 },
      { "tag": "bg yellow", "code": 43 },
      { "tag": "bg blue", "code": 44 },
      { "tag": "bg magenta", "code": 45 },
      { "tag": "bg cyan", "code": 46 },
      { "tag": "bg white", "code": 47 },
      { "tag": "bg default", "code": 49 },
      { "tag": "bright black", "code": 90 },
      { "tag": "K", "code": 90 },
      { "tag": "bright red", "code": 91 },
      { "tag": "R", "code": 91 },
      { "tag": "bright green", "code": 92 },
      { "tag": "G", "code": 92 },
      { "tag": "bright yellow", "code": 93 },
      { "tag": "Y", "code": 93 },
      { "tag": "bright blue", "code": 94 },
      { "tag": "B", "code": 94 },
      { "tag": "bright magenta", "code": 95 },
      { "tag": "M", "code": 95 },
      { "tag": "bright cyan", "code": 96 },
      { "tag": "C", "code": 96 },
      { "tag": "bright white", "code": 97 },
      { "tag": "W", "code": 97 },
      { "tag": "bg bright black", "code": 100 },
      { "tag": "bg bright red", "code": 101 },
      { "tag": "bg bright green", "code": 102 },
      { "tag": "bg bright yellow", "code": 103 },
      { "tag": "bg bright blue", "code": 104 },
      { "tag": "bg bright magenta", "code": 105 },
      { "tag": "bg bright cyan", "code": 106 },
      { "tag": "bg bright white", "code": 107 }
   ];
   isMongosh() && (console['log'] = (function() {
      const method = () => console;
      const fn = 'log';
      const _fn = '_' + fn;
      if (method()[fn].name !== 'modifiedLog') method()[_fn] = method()[fn];
      function modifiedLog() {
         const isTTY = process.stdout.isTTY;
         const markup = text => {
            ansiTags.forEach(({ tag, code }) => {
               text = text.replaceAll(new RegExp(`\\[${tag}\\]`, 'gi'), `\x1b[${code}m`);
            });
            return text;
         };
         const colourise = args => [...args].map(arg => typeof arg === 'string' ? markup(arg) : arg);
         const noEsc = args => {
            const ansi = /(?:\x1b\[(?:\d*[;]?[\d]*[;]?[\d]*)m)/gi;
            return [...args].map(arg => typeof arg === 'string' ? arg.replaceAll(ansi, '') : arg);
         };
         return method()[_fn].apply(null, isTTY ? colourise(arguments) : noEsc(colourise(arguments)));
      }
      return modifiedLog;
   })());

   console.log(`\n[yellow]#### Running script ${__script.name} v${__script.version} on shell v${version()}[/]\n`);

   function serverStatus(serverStatusOptions = {}) {
      /*
       *  opt-in version of db.serverStatus()
       *  command options are multiversion compatible
       */
      const serverStatusOptionsDefaults = {
         "none": true, // 8.3 feature: exclude all optional fields, then opt-in
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
         "ftdcCollectionMetrics": false,
         "globalLock": false,
         "health": false,
         "hedgingMetrics": false,
         "indexBuilds": false,
         "indexBulkBuilder": false,
         "indexStats": false,
         "internalTransactions": false,
         "latchAnalysis": false,
         "locks": false,
         "lockContentionMetrics": false,
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
         "queryStats": false,
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
         "spillWiredTiger": false,
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

   const SERVERSTATUS_MS = 1000;
   const DISABLE_POLL_MS = 200;      // poll interval while waiting for disable to settle
   const DISABLE_STATUS_MS = 30000;  // progress note while waiting indefinitely
   let bcCache = { "at": 0, "value": undefined };
   // WT file-visit outcomes (process-lifetime totals). Recovered-bytes and EMA are not visits.
   const BC_VISIT_KEYS = [
      'background compact successful calls',
      'background compact skipped file, not meeting requirements for compaction',
      'background compact skipped file, it is part of the exclude list',
      'background compact skipped, there is a permissions issue',
      'background compact skipped, no such file exists',
      'background compact skipped file, it is smaller than 1MB in size',
      'background compact skipped, last compact was unsuccessful/less successful than average',
      'background compact timeout',
      'background compact interrupted',
      'background compact failed calls'
   ];
   const getBackgroundCompact = (fresh = false) => {
      // running + recovered bytes + file-visit totals; cached SERVERSTATUS_MS unless fresh
      // never returns null: probe failure is { running: null, bytesRecovered: null, visits: null }
      if (!fresh && bcCache.value !== undefined && Date.now() - bcCache.at < SERVERSTATUS_MS) {
         return bcCache.value;
      }
      let running, bytesRecovered, bc = {}, value;
      try {
         ({ 'wiredTiger': {
               'background-compact': bc = {}
            } = {}
         } = serverStatus({
            "wiredTiger": true
         }));
         ({ 'background compact running': running,
            'background compact recovered bytes': bytesRecovered
         } = bc);
         const visitN = BC_VISIT_KEYS.reduce((sum, key) => {
            const n = +bc[key];
            return sum + (Number.isFinite(n) ? n : 0);
         }, 0);
         value = {
            "running": running === undefined ? null : (running > 0 || running === true),
            "bytesRecovered": Number.isFinite(+bytesRecovered) ? +bytesRecovered : null,
            "visits": Object.keys(bc).length ? visitN : null
         };
      } catch(e) {
         value = { "running": null, "bytesRecovered": null, "visits": null };
      }
      bcCache = { "at": Date.now(), "value": value };
      return value;
   };
   const serverLocalTime = () => {
      // core serverStatus field (not an opt-in section); same clock as getLog t
      try {
         const { localTime } = serverStatus();
         if (localTime != null) return localTime;
      } catch(_) { /* fall through */ }
      return ISODate();
   };
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
      // this-pass delta vs process-lifetime cumulative recovered bytes
      const { 'bytesRecovered': endBytes = null } = getBackgroundCompact(true);
      if (endBytes == null) {
         console.log('══════ [yellow]recovered bytes: unavailable[/] ══════');
         return;
      }
      const delta = startBytes != null ? endBytes - startBytes : endBytes;
      console.log(`\n══════ [yellow]recovered ${scaled.format(delta)} this pass (${scaled.format(endBytes)} cumulative runtime)[/] ══════`);
   };
   const hostInfo = () => {
      /*
       *  mdblib.js hostInfo() — swallow Atlas/privilege failures; hostname fallbacks
       */
      let info = {};
      try {
         db.hostInfo(); // required by legacy mongo to capture server exception
         info = db.hostInfo();
      } catch(_) { /* Atlas M0/Flex, serverless, or unauthorized */ }
      if (typeof info.system === 'undefined' && typeof db.hello().me === 'undefined') {
         info = { "system": { "hostname": "serverless" } };
      } else if (typeof info.system === 'undefined' && typeof db.hello().me !== 'undefined') {
         info = { "system": { "hostname": db.hello().me.match(/(.*):/)[1] } };
      } else if (typeof info.system !== 'undefined') {
         // keep info
      } else {
         info = { "system": { "hostname": "unknown" } };
      }
      return info;
   };
   const isAtlasPlatform = (type = null) => {
      /*
       *  mdblib.js isAtlasPlatform() — 'sharedTier' is Atlas M0 (Free) / Flex
       */
      const { 'msg': helloMsg = false } = db.hello();
      const isMongos = (helloMsg == 'isdbgrid') ? true : false;
      const { hostname = false } = hostInfo().system;
      const { atlasVersion = false } = serverStatus();
      let isSharedTier = false;
      try {
         isSharedTier = (db.hostInfo().ok != 1);
      } catch(e) {
         isSharedTier = (e.codeName == 'AtlasError') ? true : false;
      }
      const atlasDomain = new RegExp(/\.mongodb\.net$/);
      const isAtlas = (atlasVersion || atlasDomain.test(hostname)) ? true : false;
      return (type === null && isMongos && isAtlas && hostname != 'serverless') ? 'dedicatedShardedCluster'
           : (type == 'dedicatedShardedCluster' && isMongos && isAtlas && hostname != 'serverless') ? true
           : (type === null && !isMongos && isAtlas && isSharedTier) ? 'sharedTier'
           : (type == 'sharedTier' && !isMongos && isAtlas && isSharedTier) ? true
           : (type === null && !isMongos && isAtlas) ? 'dedicatedReplicaSet'
           : (type == 'dedicatedReplicaSet' && !isMongos && isAtlas) ? true
           : (type === null && hostname == 'serverless') ? 'serverless'
           : (type == 'serverless' && hostname == 'serverless') ? true
           : false;
   };
   const preflight = () => {
      // autoCompact is mongod 8.0+ / wiredTiger only.
      // Atlas M0/Flex = isAtlasPlatform('sharedTier'); serverless is a separate platform string.
      // Already-enabled is handled by the disable-wait-retry loop, not an error here.
      try {
         if (db.hello().msg === 'isdbgrid') {
            console.log('[red][ERROR] autoCompact is not supported on mongos; connect directly to a mongod[/]');
            return false;
         }
      } catch(e) {
         console.log('[red][ERROR] hello() failed:[/]', e);
         return false;
      }
      const atlasPlatform = isAtlasPlatform();
      if (atlasPlatform === 'sharedTier') {
         console.log('[red][ERROR] autoCompact is not supported on Atlas M0 (Free) or Flex clusters[/] (https://www.mongodb.com/docs/atlas/unsupported-commands/)');
         return false;
      }
      if (atlasPlatform === 'serverless') {
         // Atlas Serverless is deprecated/gone; keep the mdblib.js platform string
         console.log('[red][ERROR] autoCompact is not supported on Atlas Serverless[/] (https://www.mongodb.com/docs/atlas/unsupported-commands/)');
         return false;
      }
      let major;
      try {
         major = parseInt(String(db.version()).split('.')[0], 10);
      } catch(e) {
         console.log('[red][ERROR] db.version() failed:[/]', e);
         return false;
      }
      if (!Number.isFinite(major) || major < 8) {
         console.log(`[red][ERROR] autoCompact requires MongoDB 8.0+; detected ${db.version()}[/]`);
         return false;
      }
      let engine;
      try {
         ({ 'storageEngine': { 'name': engine } = {} } = serverStatus({
            "storageEngine": true
         }));
      } catch(e) {
         console.log('[red][ERROR] serverStatus() failed:[/]', e);
         return false;
      }
      if (engine != null && engine !== 'wiredTiger') {
         console.log(`[red][ERROR] autoCompact requires wiredTiger; detected storage engine "${engine}"[/]`);
         return false;
      }
      return true;
   };
   const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
   const identKey = name => String(name ?? '')
      .replace(/^(?:file:|table:|statistics:table:)/, '')
      .replace(/\.wt$/, '');
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
      if (entry.kind === 'internal') return `[red]${entry.ns}[/]`;
      if (entry.kind === 'index') return `[yellow]${entry.ns}[/].[green]${entry.idx}[/]`;
      return `[yellow]${entry.ns}[/]`;
   };
   const wtNameFromMsg = (msg = '', dhandle) => {
      if (dhandle) return dhandle;
      const text = String(msg);
      const prefixed = text.match(/(?:file:|table:|statistics:table:)[\w.-]+(?:\.wt)?/);
      if (prefixed) return prefixed[0];
      const wtFile = text.match(/(?:[\w.-]+\/)?[\w.-]+\.wt/);
      return wtFile ? wtFile[0] : null;
   };
   const IDENT_REFRESH_MS = 5000;
   const IDENT_BATCH = 64;
   const IDENT_FIRST_MS = 5000; // do not block autoCompact if $listCatalog stalls
   const startNsResolver = () => {
      // ident -> { kind, ns, idx? }; internals first; $listCatalog fills the rest in the background
      const map = new Map([
         ['sizeStorer', { "kind": "internal", "ns": "(sizeStorer)" }],
         ['WiredTigerHS', { "kind": "internal", "ns": "(history store)" }],
         ['_mdb_catalog', { "kind": "internal", "ns": "(catalog)" }]
      ]);
      let pumping = false;
      let catalogOk = false;
      let lastRefreshAt = 0;
      let firstSeen = false;
      let firstResolve;
      const ready = new Promise(resolve => { firstResolve = resolve; });
      const signalReady = () => {
         if (!firstSeen) {
            firstSeen = true;
            firstResolve();
         }
      };
      const ingest = doc => {
         const ns = doc.ns ?? (doc.db && doc.name ? `${doc.db}.${doc.name}` : null);
         if (typeof doc.ident === 'string' && ns) map.set(doc.ident, { "kind": "collection", "ns": ns });
         if (doc.idxIdent && ns) {
            for (const [idx, ident] of Object.entries(doc.idxIdent)) {
               if (typeof ident === 'string') map.set(ident, { "kind": "index", "ns": ns, "idx": idx });
            }
         }
      };
      const pump = async() => {
         if (pumping) return;
         pumping = true;
         let cursor;
         try {
            cursor = db.getSiblingDB('admin').aggregate([
               { "$listCatalog": {} },
               { "$project": {
                  "ns": 1,
                  "db": 1,
                  "name": 1,
                  "ident": 1,
                  "idxIdent": 1
               } }
            ], {
               "cursor": { "batchSize": IDENT_BATCH },
               "comment": `Executed by ${__script.name} v${__script.version} ident map`
            });
            for await (const doc of cursor) {
               ingest(doc);
               signalReady();
            }
            catalogOk = true;
         } catch(e) {
            catalogOk = false;
            console.log('[red][WARN] $listCatalog() unavailable, WTCMPCT lines will show WT filenames:[/]', e);
         } finally {
            if (cursor) {
               try { cursor.close(); } catch(_) { /* already closed */ }
            }
            pumping = false;
            lastRefreshAt = Date.now();
            signalReady();
         }
      };
      pump();
      const resolveNs = name => {
         const ns = nsFromWt(name, map);
         if (ns || !name) return ns;
         if (!pumping && Date.now() - lastRefreshAt >= IDENT_REFRESH_MS) pump();
         return nsFromWt(name, map);
      };
      return {
         ready,
         resolve: resolveNs,
         size: () => map.size,
         catalogReady: () => catalogOk && !pumping
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
               const substituted = text.replace(new RegExp(`(?:file:|table:|statistics:table:)?${key}(?:\\.wt)?`, 'g'), nsColored(entry));
               if (substituted !== text) out = substituted;
            }
         }
      }
      return out.replace(/there is no useful work to do -\s*/g, '');
   };
   const isSizeStorer = (msg = '', dhandle = '') => {
      // last expected file of the walk
      return `${dhandle} ${msg}`.includes('sizeStorer');
   };
   const POLL_MS_MIN = 50;     // after new WTCMPCT lines or ramlog overflow
   const POLL_MS_MAX = 1000;   // quiet backoff ceiling
   const LOG_QUIET_MS = 2000;  // WTCMPCT heartbeat: still in a file if lines arrived within this window
   const VISITS_QUIET_MS = 2000; // WT visit counters unchanged
   const NOOP_GRACE_MS = 5000; // no file visits and no WTCMPCT heartbeat
   const GETLOG_CAP = 1024;    // ramlog size; overflow warn + seen Set cap
   const clampPollMS = ms => {
      const n = +ms;
      if (!Number.isFinite(n) || n <= 0) return POLL_MS_MIN;
      return Math.min(POLL_MS_MAX, Math.max(POLL_MS_MIN, n));
   };
   const regulatePollMS = (pollMS, { overflow = false, active = false } = {}) =>
      // reset to min on new WTCMPCT or overflow; otherwise double toward max
      (overflow || active) ? POLL_MS_MIN : clampPollMS(pollMS * 2);
   let getLogWarned = false;
   const WTCMPCT_RE = /"c"\s*:\s*"WTCMPCT"/;
   const logKey = ({ t, 'attr': { 'message': { msg = '', session_dhandle_name = '' } = {} } = {} } = {}) =>
      `${+t}\0${session_dhandle_name}\0${msg}`;
   const rememberLog = (seen, key) => {
      // insertion-order FIFO; ramlog cannot still hold more unique WTCMPCT keys than GETLOG_CAP
      seen.add(key);
      while (seen.size > GETLOG_CAP) seen.delete(seen.keys().next().value);
   };
   const getLogs = (since, seen) => {
      // ramlog ~1024 raw lines; prefilter WTCMPCT (spacing-tolerant) before EJSON.parse
      // start watermark exclusive; later same-ms siblings kept if not yet in seen
      let lines, totalLinesWritten;
      try {
         ({ "log": lines = [], "totalLinesWritten": totalLinesWritten } = db.adminCommand({ "getLog": "global" }));
      } catch(e) {
         if (!getLogWarned) {
            console.log('[red][WARN] getLog() unavailable, relying on serverStatus WT file-visit counters:[/]', e);
            getLogWarned = true;
         }
         return { "logs": [], "totalLinesWritten": null };
      }
      const out = [];
      for (const line of lines) {
         if (!WTCMPCT_RE.test(String(line))) continue;
         try {
            const entry = EJSON.parse(line);
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
   const tailLogs = async(ts, nsResolver = {}, runOnce = true) => {
      /*
       *  Follow WTCMPCT until the first catalog walk ends, then report recovered bytes.
       *  Latch (not $currentOp; WT thread never appears there):
       *  - sizeStorer WTCMPCT is a last-file hint (ramlog can drop it)
       *  - visits = success + skipped* + timeout + interrupted + failed (process-lifetime)
       *  - WTCMPCT is a heartbeat: stall visits but still logging → still in a file
       *  - runOnce:true: running bit clears when the thread stops; wait for that after first pass
       *  - runOnce:false: running bit stays on; first pass = hint or visits stall
       */
      const resolveNs = nsResolver.resolve ?? (() => null);
      let pause = false;
      let firstPassDone = false;
      let seenRunning = false;
      const seen = new Set();
      let pollMS = POLL_MS_MIN;
      let lastTotal = null;
      let lastLogAt = null;
      const startedAt = Date.now();
      const {
         'bytesRecovered': startBytes = null,
         'visits': startVisits = null
      } = getBackgroundCompact(true);
      let lastVisits = startVisits;
      let lastVisitsAt = startedAt;

      const markFirstPass = reason => {
         if (firstPassDone) return;
         firstPassDone = true;
         console.log(`\n══════ [yellow]${reason}[/] ══════`);
      };

      do {
         const { logs, totalLinesWritten } = getLogs(ts, seen);
         const overflow = Number.isFinite(totalLinesWritten)
            && lastTotal != null
            && totalLinesWritten - lastTotal >= GETLOG_CAP;
         if (overflow) {
            console.log(`[red][WARN] getLog overflow: ${totalLinesWritten - lastTotal} lines since last poll (ramlog ~${GETLOG_CAP}); resetting poll ${pollMS}ms → ${POLL_MS_MIN}ms[/]`);
         }
         if (Number.isFinite(totalLinesWritten)) lastTotal = totalLinesWritten;
         if (logs.length > 0) {
            lastLogAt = Date.now();
            logs.forEach(entry => {
               const { t = ISODate(), 'attr': { 'message': { msg = '', session_dhandle_name = '' } = {} } = {} } = entry;
               rememberLog(seen, logKey(entry));
               if (t > ts) ts = t;
               if (isSizeStorer(msg, session_dhandle_name)) {
                  markFirstPass('sizeStorer (last file of catalog walk)');
               }
               console.log(t.toJSON(), annotateWtMsg(msg, session_dhandle_name, resolveNs));
            });
            pause = false;
         } else if (!pause) {
            if (firstPassDone) {
               if (runOnce) console.log('\n══════ [yellow]last file done, waiting for background compact idle[/] ══════');
            } else {
               console.log('══════ [yellow]autoCompaction work in progress, waiting for new logs[/] ══════');
            }
            pause = true;
         }
         const { running, visits } = getBackgroundCompact();
         if (running === true) seenRunning = true;
         if (visits != null && visits !== lastVisits) {
            lastVisits = visits;
            lastVisitsAt = Date.now();
         }
         const now = Date.now();
         const deltaVisits = (visits != null && startVisits != null) ? visits - startVisits : null;
         const visitsQuiet = lastVisitsAt != null && now - lastVisitsAt >= VISITS_QUIET_MS;
         const logsHeartbeat = lastLogAt != null && now - lastLogAt < LOG_QUIET_MS;
         const catalogCount = nsResolver.catalogReady?.() ? nsResolver.size() : null;

         if (!firstPassDone && catalogCount != null && deltaVisits != null
               && deltaVisits >= catalogCount && visitsQuiet) {
            markFirstPass(`WT file visits reached catalog size (${deltaVisits}/${catalogCount})`);
         }
         if (!firstPassDone && deltaVisits > 0 && visitsQuiet && !logsHeartbeat) {
            markFirstPass('WT file visits stalled (no WTCMPCT heartbeat)');
         }
         if (!firstPassDone && (deltaVisits === 0 || deltaVisits == null)
               && now - startedAt >= NOOP_GRACE_MS && !logsHeartbeat) {
            markFirstPass('serverStatus: no WT file visits (no-op)');
         }

         if (firstPassDone && !runOnce) break;
         if (runOnce && firstPassDone && running !== true) {
            console.log('\n══════ [yellow]serverStatus: background compact thread idle[/] ══════');
            break;
         }
         if (runOnce && !firstPassDone && running === false && (seenRunning || deltaVisits > 0)) {
            markFirstPass('serverStatus: background compact thread idle');
            break;
         }
         pollMS = regulatePollMS(pollMS, { "overflow": overflow, "active": logs.length > 0 });
         await delay(pollMS);
      } while (true);
      if (!runOnce && firstPassDone) {
         console.log('\n══════ [yellow]first pass complete; background compact thread left enabled (next walk ~24h)[/] ══════');
         reportRecoveredBytes(startBytes);
         return;
      }
      console.log('\n══════ [yellow]autoCompaction round complete[/] ══════');
      reportRecoveredBytes(startBytes);
   };

   // Caller: var autoCompactOptions = { ... } (--eval or REPL). Do not declare or assign it in this file.
   // Passthrough user fields as-is; default autoCompact: true and runOnce: true on enable, stamp comment.
   const userOptions = typeof autoCompactOptions === 'undefined' ? {} : autoCompactOptions;
   const cmd = {
      "autoCompact": true,
      ...(userOptions?.autoCompact === false ? {} : { "runOnce": true }),
      ...userOptions,
      "comment": `Executed by ${__script.name} v${__script.version}`
   };
   const enable = cmd.autoCompact !== false;
   if (!preflight()) return;
   const nsResolver = enable ? startNsResolver() : null;
   // mongod rejects autoCompact:true while WT still has background compact enabled.
   const replace = enable && getBackgroundCompact(true).running === true;
   if (enable) {
      console.log(`[yellow][NOTE][/] [blue]autoCompact[/] is per mongod instance only, cluster and replSet compaction requires targeted command execution. In addition, autoCompact excludes the '[yellow]local.oplog.rs[/]' collection.\n`);
   }
   const runCmd = cmdDoc => {
      console.log(`[yellow]Executing shell command:[/]\n[blue]db.adminCommand(${EJSON.stringify(cmdDoc, null, 3)});[/]\n`);
      try {
         const result = db.adminCommand(cmdDoc);
         if (result?.ok !== 1) {
            console.log('[red][ERROR] autoCompact failed:[/]', result);
            return null;
         }
         return result;
      } catch(e) {
         console.log('[red][ERROR] autoCompact failed:[/]', e);
         return null;
      }
   };
   if (replace) {
      // Already enabled: send autoCompact:false, wait for the enable bit to clear, then
      // re-issue cmd so new user options take effect (runOnce and the rest of cmd are kept).
      // Wait is serverStatus 'background compact running' — not WTCMPCT quiet, not currentOp.
      console.log('[yellow][NOTE][/] background compact already enabled; sending [blue]{ "autoCompact": false }[/], waiting for [blue]serverStatus[/] background compact running to clear, then re-enabling with the requested options.\n');
      if (!runCmd({
         "autoCompact": false,
         "comment": `Executed by ${__script.name} v${__script.version}`
      })) return;
      let running = getBackgroundCompact(true).running;
      if (running === true) {
         // disable is queued; WT flips the enable bit after the current file compact is safe to stop
         console.log('[yellow][NOTE][/] existing autoCompaction still in progress; waiting indefinitely for serverStatus background compact running to clear. CTRL+C to abort — if you do, re-run later so the new command options are applied.\n');
      }
      const startedAt = Date.now();
      let lastStatusAt = startedAt;
      while (running === true) {
         await delay(DISABLE_POLL_MS);
         if (Date.now() - lastStatusAt >= DISABLE_STATUS_MS) {
            console.log(`[yellow][NOTE][/] still waiting after ${Math.round((Date.now() - startedAt) / 1000)}s (background compact running). CTRL+C to abort — you will need to re-run later to apply the new command options.`);
            lastStatusAt = Date.now();
         }
         running = getBackgroundCompact(true).running;
      }
      if (running !== false) {
         console.log('[red][ERROR] could not confirm background compact disabled (serverStatus unavailable)[/]');
         return;
      }
      console.log('══════ [yellow]serverStatus: background compact running is false; retrying with updated options[/] ══════\n');
   }
   if (nsResolver) await Promise.race([nsResolver.ready, delay(IDENT_FIRST_MS)]);
   const ts = enable ? serverLocalTime() : null;
   if (!runCmd(cmd)) return;
   if (!enable) {
      console.log('══════ [yellow]background compact thread disabled[/] ══════');
      return;
   }
   await tailLogs(ts, nsResolver, cmd.runOnce === true);
})();

// EOF
