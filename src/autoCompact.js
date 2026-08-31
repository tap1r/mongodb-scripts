(() => {
   /*
    *  Name: "autoCompact.js"
    *  Version: "0.4.20"
    *  Description: "auto/background compaction (autoCompact command) with thread monitoring"
    *  Disclaimer: "https://raw.githubusercontent.com/tap1r/mongodb-scripts/master/DISCLAIMER.md"
    *  Authors: ["tap1r <luke.prochazka@gmail.com>"]
    *
    *  Notes:
    *  - automates the autoCompact command with monitoring (https://www.mongodb.com/docs/v8.0/reference/command/autoCompact/)
    *  - mongosh only; MongoDB 8.0+ WiredTiger mongod (not mongos)
    *  - operation is per mongod only: not replicated; does not compact the oplog
    *  - monitors compaction thread, then reports bytes recovered
    *  - { autoCompact: false } disables the background thread and exits (no log tail)
    *  - freeSpaceTargetMB is passed through only when supplied (server default 20 otherwise)
    *  - runOnce defaults to true (opposite of the server default); pass { runOnce: false } for continuous compaction
    *  - runOnce: true (default): if a background thread is already running, the script errors; disable first with { autoCompact: false }
    *  - runOnce: false: always send { autoCompact: false }, wait until serverStatus reports background compact running is false, then retry the original command (runOnce: false is kept) so new options replace the previous thread
    */

   // Usage: mongosh [direct host connection options] [--quiet] [--eval 'var autoCompactOptions = { "freeSpaceTargetMB": 1, "runOnce": true };'] [-f|--file] </path/to/>autoCompact.js

   /*
    *  Example of basic direct localhost usage:
    *
    *    mongosh "localhost:27017" autoCompact.js
    *
    *  Example using custom autoCompact command options:
    *
    *    mongosh "localhost:27017" --quiet --eval 'var autoCompactOptions = { "freeSpaceTargetMB": 64, "runOnce": true };' -f autoCompact.js
    *
    *  Example to enable continuous compaction (replaces any existing background thread):
    *
    *    mongosh "localhost:27017" --quiet --eval 'var autoCompactOptions = { "runOnce": false };' -f autoCompact.js
    *
    *  Example to disable the background compact thread:
    *
    *    mongosh "localhost:27017" --quiet --eval 'var autoCompactOptions = { "autoCompact": false };' -f autoCompact.js
    *
    *  We use 'var' to interoperate with mongosh's sloppy mode
    */

   const __script = { "name": "autoCompact.js", "version": "0.4.20" };

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
   const DISABLE_POLL_MS = 200;     // poll interval while waiting for disable to settle
   const DISABLE_WAIT_MS = 60000;   // give up if WT never clears 'background compact running'
   let bcCache = { "at": 0, "value": undefined };
   const getBackgroundCompact = (fresh = false) => {
      // running + recovered bytes; cached SERVERSTATUS_MS unless fresh (end-of-pass report)
      // success/failed/skipped/timeout/interrupted are process-lifetime totals and are not used
      // never returns null: probe failure is { running: null, bytesRecovered: null }
      if (!fresh && bcCache.value !== undefined && Date.now() - bcCache.at < SERVERSTATUS_MS) {
         return bcCache.value;
      }
      let running, bytesRecovered, value;
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
         value = {
            "running": running === undefined ? null : (running > 0 || running === true),
            "bytesRecovered": Number.isFinite(+bytesRecovered) ? +bytesRecovered : null
         };
      } catch(e) {
         value = { "running": null, "bytesRecovered": null };
      }
      bcCache = { "at": Date.now(), "value": value };
      return value;
   };
   const getAutoCompactRunning = () => getBackgroundCompact().running;
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
   const preflight = (enable = true) => {
      // autoCompact is mongod 8.0+ / wiredTiger only.
      // enable=true (runOnce: true): error if a background thread is already running.
      // enable=false: skip that check (disable path, or runOnce: false replace-then-retry).
      try {
         if (db.hello().msg === 'isdbgrid') {
            console.log('[red][ERROR] autoCompact is not supported on mongos; connect directly to a mongod[/]');
            return false;
         }
      } catch(e) {
         console.log('[red][ERROR] hello() failed:[/]', e);
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
      let engine, running;
      try {
         ({ 'storageEngine': { 'name': engine } = {},
            'wiredTiger': {
               'background-compact': {
                  'background compact running': running
               } = {}
            } = {}
         } = serverStatus({
            "storageEngine": true,
            "wiredTiger": true
         }));
      } catch(e) {
         console.log('[red][ERROR] serverStatus() failed:[/]', e);
         return false;
      }
      if (engine != null && engine !== 'wiredTiger') {
         console.log(`[red][ERROR] autoCompact requires wiredTiger; detected storage engine "${engine}"[/]`);
         return false;
      }
      if (enable && (running > 0 || running === true)) {
         console.log('[red][ERROR] background compact thread already enabled; Issue { autoCompact: false } first to disable[/]');
         return false;
      }
      return true;
   };
   const identKey = name => String(name ?? '')
      .replace(/^(?:file:|table:|statistics:table:)/, '')
      .replace(/\.wt$/, '');
   const buildIdentMap = () => {
      // ident -> { kind, ns, idx? }; overlay WTCMPCT filenames with $listCatalog (WT name is the fallback)
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
            { "comment": `Executed by ${__script.name} v${__script.version} ident map` }
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
         console.log('[red][WARN] $listCatalog() unavailable, WTCMPCT lines will show WT filenames:[/]', e);
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
   const makeNsResolver = () => {
      // unknown ident (collection created this pass): re-query $listCatalog, at most every IDENT_REFRESH_MS
      let { map } = buildIdentMap();
      let lastRefreshAt = 0;
      return name => {
         let ns = nsFromWt(name, map);
         if (ns || !name) return ns;
         if (Date.now() - lastRefreshAt >= IDENT_REFRESH_MS) {
            ({ map } = buildIdentMap());
            lastRefreshAt = Date.now();
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
   const LOG_QUIET_MS = 2000;  // no new WTCMPCT: first-pass complete if overflow seen or compact idle
   const NOOP_GRACE_MS = 5000; // never-seen-running and still idle
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
            console.log('[red][WARN] getLog() unavailable, relying on serverStatus() for idle detection:[/]', e);
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
   const tailLogs = (ts, resolveNs = () => null, runOnce = true) => {
      /*
       *  Follow WTCMPCT until the first catalog walk ends, then report recovered bytes.
       *  sizeStorer is the last file (skip or compact). runOnce=false returns then (thread stays on).
       *  runOnce=true waits for serverStatus idle so sizeStorer work is included.
       *  Missed sizeStorer (ramlog overflow): 2s with no new WTCMPCT if overflow was seen or compact is idle.
       *  The in-progress banner does not count as a log. Never running and idle for NOOP_GRACE_MS is a no-op.
       */
      let pause = false;
      let firstPassDone = false;
      let seenRunning = false;
      let overflowSeen = false;
      let idleSince = null;
      const seen = new Set();
      let pollMS = POLL_MS_MIN;
      let lastTotal = null;
      let lastLogAt = null;
      const { 'bytesRecovered': startBytes = null } = getBackgroundCompact();

      do {
         const { logs, totalLinesWritten } = getLogs(ts, seen);
         const overflow = Number.isFinite(totalLinesWritten)
            && lastTotal != null
            && totalLinesWritten - lastTotal >= GETLOG_CAP;
         if (overflow) {
            overflowSeen = true;
            console.log(`[red][WARN] getLog overflow: ${totalLinesWritten - lastTotal} lines since last poll (ramlog ~${GETLOG_CAP}); resetting poll ${pollMS}ms → ${POLL_MS_MIN}ms[/]`);
         }
         if (Number.isFinite(totalLinesWritten)) lastTotal = totalLinesWritten;
         if (logs.length > 0) {
            lastLogAt = Date.now();
            logs.forEach(entry => {
               const { t = ISODate(), 'attr': { 'message': { msg = '', session_dhandle_name = '' } = {} } = {} } = entry;
               rememberLog(seen, logKey(entry));
               if (t > ts) ts = t;
               if (isSizeStorer(msg, session_dhandle_name)) firstPassDone = true;
               console.log(t.toJSON(), annotateWtMsg(msg, session_dhandle_name, resolveNs));
            });
            pause = false; // reset pause when new log entries are present
         } else if (!pause) {
            if (firstPassDone) {
               if (runOnce) console.log('\n══════ [yellow]last file done, waiting for background compact idle[/] ══════');
            } else {
               console.log('══════ [yellow]autoCompaction work in progress, waiting for new logs[/] ══════');
            }
            pause = true;
         }
         const running = getAutoCompactRunning();
         if (running === true) {
            seenRunning = true;
            idleSince = null;
         } else if (running === false && idleSince == null) {
            idleSince = Date.now();
         }
         if (!firstPassDone && lastLogAt != null && Date.now() - lastLogAt >= LOG_QUIET_MS
               && (overflowSeen || running === false)) {
            firstPassDone = true;
            console.log(`\n══════ [yellow]no new WTCMPCT logs for ${LOG_QUIET_MS / 1000}s; assuming first pass complete[/] ══════`);
         }
         if (firstPassDone && !runOnce) break;
         if (running === false && (seenRunning || (runOnce && firstPassDone))) {
            console.log('\n══════ [yellow]serverStatus: background compact thread idle[/] ══════');
            break;
         }
         if (!seenRunning && !firstPassDone && running === false
               && idleSince != null && Date.now() - idleSince >= NOOP_GRACE_MS) {
            console.log('\n══════ [yellow]serverStatus: background compact thread idle (no-op)[/] ══════');
            break;
         }
         pollMS = regulatePollMS(pollMS, { "overflow": overflow, "active": logs.length > 0 });
         sleep(pollMS);
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
   // runOnce: false (continuous) replaces any existing thread: disable first, then retry cmd.
   const replace = enable && cmd.runOnce === false;
   if (!preflight(enable && !replace)) return;
   if (enable) {
      console.log(`[yellow][NOTE][/] autoCompact is per mongod instance only, cluster and replSet compaction requires targeted command execution. In addition, autoCompact excludes the '[yellow]local.oplog.rs[/]' collection.\n`);
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
      // mongod rejects autoCompact:true while WT still has background compact enabled.
      // Always send autoCompact:false (even if already idle), then wait for the enable bit
      // ('background compact running') to clear — not WTCMPCT quiet, not currentOp.
      // Disable is queued; WT flips the stat after the compact-server processes it.
      // cmd already has runOnce: false from the user spread; do not drop it on retry.
      console.log('[yellow][NOTE][/] runOnce is false (continuous); sending { autoCompact: false }, waiting for serverStatus background compact running to clear, then re-enabling with the requested options (runOnce: false preserved).\n');
      if (!runCmd({
         "autoCompact": false,
         "comment": `Executed by ${__script.name} v${__script.version}`
      })) return;
      const deadline = Date.now() + DISABLE_WAIT_MS;
      let running = getBackgroundCompact(true).running;
      while (running === true) {
         if (Date.now() >= deadline) {
            console.log(`[red][ERROR] timed out after ${DISABLE_WAIT_MS / 1000}s waiting for background compact to disable (serverStatus still running)[/]`);
            return;
         }
         sleep(DISABLE_POLL_MS);
         running = getBackgroundCompact(true).running;
      }
      if (running !== false) {
         console.log('[red][ERROR] could not confirm background compact disabled (serverStatus unavailable)[/]');
         return;
      }
      console.log('══════ [yellow]serverStatus: background compact running is false; retrying with updated options[/] ══════\n');
   }
   const ts = enable ? ISODate() : null;
   if (!runCmd(cmd)) return;
   if (!enable) {
      console.log('══════ [yellow]background compact thread disabled[/] ══════');
      return;
   }
   tailLogs(ts, makeNsResolver(), cmd.runOnce === true);
})();

// EOF
