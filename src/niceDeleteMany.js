(async() => {
   /*
    *  Name: "niceDeleteMany.js"
    *  Version: "0.4.14"
    *  Description: "nice concurrent/batch deleteMany() technique with admission control"
    *  Disclaimer: "https://raw.githubusercontent.com/tap1r/mongodb-scripts/master/DISCLAIMER.md"
    *  Authors: ["tap1r <luke.prochazka@gmail.com>"]
    *  Guide: "https://raw.githubusercontent.com/tap1r/mongodb-scripts/master/mongosh-scripting-guide.md"
    *  Howto: "https://raw.githubusercontent.com/tap1r/mongodb-scripts/master/Howto-streaming-sort.md"
    *
    *  Legacy archive line: v0.4.11 is the snapshot for this script. mongosh-only
    *  (async IIFE, optional chaining; incompatible with legacy mongo). Still
    *  the demarked version for the whole-tree freeze. Further feature work
    *  (per-shard WT via discovery, Policy B curation) targets mongosh; see
    *  ROADMAP.md → Legacy mongo shell retirement.
    *
    *  Notes:
    *  - mongosh only. Do not top-level-await this IIFE.
    *  - --eval must use var (not let/const); probe typeof, do not declare
    *    dbName/collName/filter in this file.
    *  - Curation relies on a semi-blocking operator for bucket estimations
    *  - Good for matching up to 2,147,483,647,000 documents
    *  - Advanced concurrency model with AIMD and adaptive concurrency to prevent resource starvation
    *  - Prefers index-ordered curation (avoids blocking sorts / disk spill); optional user hint supported
    *  - If explain has no IXSCAN (or $setWindowFields would block), walk _id via find() and bucket in-process
    *  - "pace" admission mode when WT cache vitals are unavailable (mongos/Atlas M0/Flex)
    *  - Progress HUD shows congestion, admission, and pool utilization only — ETA is not cheap
    *  - HUD is pinned below the log; emit lines persist and are never clobbered by redraws
    *
    *  TODOs:
    *  - better sharding (per-shard WT vitals via listShards / discovery)
    *  - revise lowPriorityAdmissionBypassThreshold for backward compatibility
    *  - refine curation order (Policy B: compound equality→trailing sort probes)
    */

   // Syntax: mongosh [connection options] [--quiet] [--eval 'var dbName = "", collName = "", filter = {}, hint = {}, collation = {}, safeguard = <bool>, interactive = <bool>;'] [-f|--file] </path/to/>niceDeleteMany.js

   /*
    *  dbName: <string>       // (required) database name
    *  collName: <string>     // (required) collection name
    *  filter: <document>     // (optional) query filter
    *  hint: <document>       // (optional) query hint
    *  collation: <document>  // (optional) for curation/explain/count only (not deleteMany/_id)
    *  safeguard: <bool>      // (optional) simulates deletes only, set false to remove safeguard
    *  interactive: <bool>    // (optional) HUD mode; default process.stdout.isTTY
    */

   // Example: mongosh --host "replset/localhost" --eval 'var dbName = "database", collName = "collection", filter = { "qty": { "$lte": 100 } }, safeguard = true;' niceDeleteMany.js

   /*
    *  Start user defined options defaults
    */

   if (typeof dbName !== 'string' || !dbName) throw new Error('db name must be defined');
   if (typeof collName !== 'string' || !collName) throw new Error('collection name must be defined');
   typeof filter !== 'object' && (filter = {});
   typeof hint !== 'object' && (hint = {});
   typeof collation !== 'object' && (collation = {});
   typeof safeguard !== 'boolean' && (safeguard = true);
   typeof interactive !== 'boolean' && (interactive = !!(typeof process !== 'undefined' && process.stdout && process.stdout.isTTY));

   /*
    *  End user defined options
    */

   const __script = { "name": "niceDeleteMany.js", "version": "0.4.14" };
   let banner = `#### Running script ${__script.name} v${__script.version} on shell v${version()}`;
   let vitals = {};
   let vitalsSampling = false;
   let vitalsView = null; // singleton congestion snapshot (getters created once)

   // TTL caches: serverStatus is hot-path; hostInfo is near-static; rsStatus is low/medium volatility.
   // serverStatus uses a Promise wrapper (adminCommand is sync in mongosh) for in-flight coalescing.
   const SERVER_STATUS_CACHE_TTL_MS = 100;
   const HOST_INFO_CACHE_TTL_MS = 60 * 1000;
   const RS_STATUS_CACHE_TTL_MS = 2 * 1000; // 2s matches the Atlas no-op heartbeat interval
   const SLOWMS_CACHE_TTL_MS = 60 * 1000;
   const GET_PARAMETER_CACHE_TTL_MS = 60 * 1000;
   const VITALS_SAMPLE_INTERVAL_MS = 100;
   // EWMA: α=0.2 ≈ half-life ~0.3s at 100ms samples (reduces single-sample admission chatter).
   const EWMA_ALPHA = 0.2;
   const ewma = {
      "cacheUtil": null,
      "dirtyUtil": null,
      "dirtyUpdatesUtil": null,
      "wtWriteTicketsUtil": null
   };
   // Admission FSM: trip CLOSED at *Trigger; release only at/under *Target (hysteresis).
   const ADMISSION_COOLDOWN_MS = 1000;
   const THROTTLE_DELAY_MIN_MS = 20;
   const THROTTLE_DELAY_MAX_MS = 100; // at *Trigger edge within the soft band
   // Soft-band split (fillProgress 0 at *Target → 1 at *Trigger):
   //   below ENTER → stay OPEN with light progressive delay
   //   at/above ENTER → THROTTLE; leave only below LEAVE (hysteresis)
   const THROTTLE_ENTER_FRAC = 0.5; // midpoint of soft band (~12.5% if tgt 5 / trig 20)
   const THROTTLE_LEAVE_FRAC = 0.4;
   // mongos / no-WT: paceMaker replaces fixed jitter (see paceMaker* below).
   const PACE_WARMUP_DELAY_MIN_MS = 20; // warm-up only until pace EWMA exists
   const PACE_WARMUP_DELAY_MAX_MS = 50;
   // AIMD concurrency: MD on enter CLOSED; AI while sustained OPEN (hold in THROTTLE/COOLDOWN).
   const AIMD_INCREASE_INTERVAL_MS = 500;
   // Hybrid repl-lag bands (seconds): soft → THROTTLE; hard → CLOSED. No EWMA (sticky rsStatus).
   const REPL_LAG_SOFT_SEC = 15;
   const REPL_LAG_HARD_SEC = 30;
   // paceMaker (pace / no-WT only): EWMA clear-rate → AIMD maxInFlight + light delay.
   // Rate samples use wall-clock windows + actual deletedCount (not drain-time clustering).
   const PACE_EWMA_ALPHA = 0.2;
   const PACE_AIMD_INCREASE_INTERVAL_MS = 1000; // slower probes — prefer mild stalls over peak rate
   const PACE_MD_COOLDOWN_MS = 2000;            // longer settle after MD
   const PACE_AI_GRACE_MS = 2000;              // longer settle after +1 before judging / next probe
   const PACE_AI_MIN_IMPROVE = 0.05; // probe must raise EWMA ≥5% or hold (harder climb)
   const PACE_DROP_FRAC = 0.75;     // slightly earlier MD when goodput softens
   const PACE_MD_STRIKES = 2;       // consecutive bad windows before MD
   const PACE_DELAY_MIN_MS = 12;    // light pacing floor (15 was a touch heavy)
   const PACE_DELAY_MAX_MS = 80;
   const PACE_DELAY_JITTER = 0.10;  // ±10% desync (was ±15% — slightly tighter cadence)
   const PACE_MIN_SAMPLE_MS = 500;  // wall-clock window — absorbs clustered consumer notes
   const PACE_INSTANT_CAP_MULT = 2.0; // clamp instant vs max(ewma, peak)
   const PACE_PEAK_DECAY = 0.99;    // per accepted sample — forget stale spikes
   const PACE_MAX_IN_FLIGHT_CAP = 4; // hard ceiling for pace mode — half-pool oversubscribed M0
   let admissionState = 'OPEN'; // OPEN | THROTTLE | CLOSED | COOLDOWN | PACE
   let admissionCooldownUntil = 0;
   let maxInFlightCap = 1;
   let maxInFlight = 1;
   let aimdLastIncreaseAt = 0;
   let closedSince = 0;
   // 'wt' = WiredTiger FSM on mongod; 'pace' = paceMaker when WT vitals unavailable.
   let admissionMode = 'wt';
   let paceReason = null; // 'mongos' | 'no-wt' | null
   let paceEwmaRate = null;       // docs/sec EWMA of successful clear rate
   let pacePeakRate = null;       // best EWMA observed (goodput high-water)
   let paceLastSampleAt = 0;
   let pacePendingDocs = 0;       // deleted docs accumulated since last rate sample
   let paceDropStrikes = 0;       // consecutive below-drop windows
   let paceInWall = false;
   let paceAimdLastIncreaseAt = 0;
   let paceLastMdAt = 0;          // cooldown gate after multiplicative decrease
   let paceAiGraceUntil = 0;      // post-AI grace — suppress MD while probe settles
   let paceRateBeforeAi = null;   // EWMA snapshot at last +1 (benefit check)
   let paceClimbExhausted = false; // probe didn't help — stop AI until MD
   // Live HUD; no % complete / ETA. Interactive: pinned bars; non-interactive: plain log lines.
   const HUD_BAR_WIDTH_MIN = 12;
   const HUD_BAR_WIDTH_MAX = 48;
   const HUD_POOL_DISPLAY_MIN = 16;
   const HUD_POOL_DISPLAY_MAX_CAP = 64;
   const HUD_MIN_REDRAW_MS = 100;       // TTY refresh throttle
   const HUD_LOG_REDRAW_MS = 1000;      // non-TTY append throttle (avoid log floods)
   let lastTermCols = 0;
   let hudResizePending = false;

   function termColumns() {
      try {
         const cols = (typeof process !== 'undefined' && process.stdout && process.stdout.columns) || 80;
         return Math.max(40, cols|0);
      } catch(_) {
         return 80;
      }
   }

   function hudBarWidth() {
      // Leave room for labels + metric text; grow/shrink with the terminal.
      return Math.min(HUD_BAR_WIDTH_MAX, Math.max(HUD_BAR_WIDTH_MIN, termColumns() - 52));
   }

   function hudPoolDisplayMax() {
      return Math.min(HUD_POOL_DISPLAY_MAX_CAP, Math.max(HUD_POOL_DISPLAY_MIN, termColumns() - 40));
   }

   const ANSI_CSI_RE = /(?:\x1b\[(?:\d*[;]?[\d]*[;]?[\d]*)m)/gi;

   function stripAnsi(text) {
      // Same CSI pattern as mdblib.js. Raw \x1b only — do not strip [WARN]/[INFO] as colour tags.
      return String(text).replace(ANSI_CSI_RE, '');
   }

   // Pinned HUD: in-place overwrite of its own rows. emit() persists into banner and
   // lifts the HUD so log lines (curation WARN, batch errors, …) are never clobbered.
   let hudActive = false;
   let hudPaintedRows = 0;
   let redrawHudFn = null;

   function formatEmitArgs(args) {
      if (interactive) return [...args];
      return [...args].map(a => (typeof a === 'string' ? stripAnsi(a) : a));
   }

   function emitLineText(args) {
      return formatEmitArgs(args).map(a => (typeof a === 'string' ? a : String(a))).join(' ');
   }

   function writeConsole(...args) {
      console.log(...formatEmitArgs(args));
   }

   function persistBannerLine(text) {
      // Resize / non-TTY fallback full-repaints from banner; keep every emit line.
      if (!interactive) return;
      const line = String(text ?? '');
      if (!line) return;
      if (banner.length && !banner.endsWith('\n')) banner += '\n';
      banner += line;
      if (!banner.endsWith('\n')) banner += '\n';
   }

   function canPinHud() {
      return !!(interactive && typeof process !== 'undefined' && process.stdout && process.stdout.isTTY);
   }

   function visualRows(text) {
      const cols = Math.max(1, termColumns());
      let rows = 0;
      for (const line of String(text).split('\n')) {
         const w = stripAnsi(line).length;
         rows += Math.max(1, Math.ceil(w / cols));
      }
      return rows;
   }

   function eraseHudRegion() {
      if (!canPinHud() || hudPaintedRows <= 0) {
         hudPaintedRows = 0;
         return;
      }
      process.stdout.write(`\x1b[${hudPaintedRows}A\r\x1b[J`);
      hudPaintedRows = 0;
   }

   function paintHudRegion(hudText) {
      const body = String(hudText).replace(/\n+$/, '');
      process.stdout.write(body + '\n');
      hudPaintedRows = visualRows(body);
   }

   function emit(...args) {
      persistBannerLine(emitLineText(args));
      if (interactive && hudActive) {
         if (canPinHud()) {
            eraseHudRegion();
            writeConsole(...args);
            if (typeof redrawHudFn === 'function') redrawHudFn({ "force": true });
         } else if (typeof redrawHudFn === 'function') {
            redrawHudFn({ "force": true, "full": true });
         } else {
            writeConsole(...args);
         }
         return;
      }
      writeConsole(...args);
   }

   function installHudResizeWatch(onResize) {
      /*
       *  Node/mongosh expose process.stdout.columns and a 'resize' event.
       *  On resize: recompute bar widths and full-repaint from banner (persisted emit lines).
       */
      if (!interactive || typeof process === 'undefined' || !process.stdout || typeof process.stdout.on !== 'function') {
         return () => {};
      }
      lastTermCols = termColumns();
      const handler = () => {
         const cols = termColumns();
         if (cols === lastTermCols && !hudResizePending) return;
         lastTermCols = cols;
         hudResizePending = true;
         try { onResize(); } finally { hudResizePending = false; }
      };
      process.stdout.on('resize', handler);
      return () => {
         try { process.stdout.off('resize', handler); } catch(_) {
            try { process.stdout.removeListener('resize', handler); } catch(__) { /* ignore */ }
         }
      };
   }
   // Same vocabulary as congestionMonitor EQ: literal glyphs + \x1b colours (JS \xNN is
   // Latin-1 only — multi-byte UTF-8 via \xe2\x96… would not render as ░/▓).
   const HUD_MARK = {
      "bg": '░',
      "low": '\x1b[92m▓\x1b[0m',       // green
      "medium": '\x1b[93m▓\x1b[0m',    // yellow
      "high": '\x1b[91m▓\x1b[0m',      // red
      "run": {
         "low": '\x1b[92m■\x1b[0m',
         "medium": '\x1b[93m■\x1b[0m',
         "high": '\x1b[91m■\x1b[0m'
      },
      "buf": '\x1b[36m□\x1b[0m',       // cyan prefetch
      "free": '░',                     // available within maxInFlight
      "cap": '\x1b[90m·\x1b[0m'        // dim AIMD-reserved
   };
   let lastHudAt = 0;
   const _serverStatusCache = { "key": null, "at": 0, "value": null, "inflight": null };
   const _hostInfoCache = { "at": 0, "value": null };
   const _rsStatusCache = { "at": 0, "value": null };
   const _slowmsCache = { "at": 0, "value": null };
   const _getParameterCache = Object.create(null); // name -> { at, value }

   // Hoisted once — avoid rebuilding ~60-key maps on every serverStatus() call.
   const SERVER_STATUS_OPTIONS_DEFAULTS = { // multiversion compatible
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
   const SERVER_STATUS_OPT_IN = { // minimal metrics for admission / congestion
      "activeIndexBuilds": true,
      "flowControl": true,
      "indexBuilds": true,
      "mem": true,
      "metrics": true,
      "queues": true,
      "storageEngine": true,
      "tenantMigrations": true,
      "tcmalloc": true, // 2 for more debugging
      "wiredTiger": true
   };

   function getParameter(name, fallback = null) {
      // Near-static mongod knobs (WT runtime config, ticket limits). 60s TTL + try/catch.
      const now = Date.now();
      const hit = _getParameterCache[name];
      if (hit && (now - hit.at) < GET_PARAMETER_CACHE_TTL_MS) return hit.value;
      let value = fallback;
      try {
         value = db.adminCommand({ "getParameter": 1, [name]: 1 })[name] ?? fallback;
      } catch(e) {
         // Flex / restricted roles / unavailable param — keep fallback
      }
      _getParameterCache[name] = { "at": now, "value": value };
      return value;
   }

   function isMongos() {
      /*
       *  True when connected to a mongos router (sharded cluster).
       */
      return db.hello().msg === 'isdbgrid';
   }

   function enablePaceAdmission(reason, detail) {
      admissionMode = 'pace';
      paceReason = reason;
      emit(`\n\x1b[31m[WARN]\x1b[0m \x1b[33m${detail}\x1b[0m`);
   }

   function hasWiredTigerVitals(sample = vitals) {
      /*
       *  Atlas M0/Flex (and some restricted roles) omit serverStatus.wiredTiger.
       *  Without cache size / dirty bytes the WT admission FSM cannot pace safely.
       */
      try {
         const cacheSize = sample?.cacheSizeBytes;
         const dirty = sample?.dirtyBytes ?? sample?.dirtyUtil;
         return cacheSize != null && !Number.isNaN(+cacheSize) && +cacheSize > 0
            && dirty != null && !Number.isNaN(+dirty);
      } catch(_) {
         return false;
      }
   }

   const onMongos = isMongos();
   if (onMongos) {
      enablePaceAdmission(
         'mongos',
         'mongos detected — using paceMaker admission (no WT cache vitals); maxInFlight capped'
      );
   }

   function sortKeyFromFilter(filter = {}) {
      /*
       *  Derive a field path for window/sort order. Empty / operator-shaped filters → _id.
       */
      if (filter == null || typeof filter !== 'object' || Array.isArray(filter)) return '_id';
      const keys = Object.keys(filter);
      if (keys.length === 0) return '_id';
      const field = keys.find(k => !k.startsWith('$'));
      if (field) return field;
      if (Array.isArray(filter.$and) && filter.$and.length) return sortKeyFromFilter(filter.$and[0]);
      if (Array.isArray(filter.$or) && filter.$or.length) return sortKeyFromFilter(filter.$or[0]);
      return '_id';
   }

   function walkPlanNodes(node, visit, seen = new Set()) {
      if (node == null || typeof node !== 'object') return;
      if (seen.has(node)) return;
      seen.add(node);
      if (Array.isArray(node)) {
         for (const el of node) walkPlanNodes(el, visit, seen);
         return;
      }
      visit(node);
      for (const key of [
         'inputStage', 'inputStages', 'thenStage', 'elseStage', 'innerStage', 'outerStage',
         'shards', 'queryPlan', 'executionStages'
      ]) {
         if (node[key] != null) walkPlanNodes(node[key], visit, seen);
      }
   }

   function inspectCurationPlan(explainResult) {
      /*
       *  Inspect winningPlan physical stages only. Do NOT walk the full explain doc —
       *  it can echo the command pipeline (including $sort), which falsely looks like
       *  a blocking SORT. A separate agg-stage $sort after $cursor is blocking only
       *  when that $sort was not absorbed into the $cursor query plan.
       */
      let collScan = false, blockingSort = false, ixscan = false;
      const roots = [];
      const takeRoot = (obj) => {
         if (!obj || typeof obj !== 'object') return;
         if (obj.queryPlanner?.winningPlan) roots.push(obj.queryPlanner.winningPlan);
         if (obj.winningPlan) roots.push(obj.winningPlan);
         if (Array.isArray(obj.stages)) {
            for (const st of obj.stages) {
               if (st?.$cursor?.queryPlanner?.winningPlan) {
                  roots.push(st.$cursor.queryPlanner.winningPlan);
               } else if (
                  st && typeof st === 'object' &&
                  Object.prototype.hasOwnProperty.call(st, '$sort') &&
                  // Explain $sort stages carry sortPattern; bare pipeline echoes do not.
                  st.$sort?.sortPattern != null
               ) {
                  blockingSort = true;
               }
            }
         }
         if (obj.shards && typeof obj.shards === 'object') {
            for (const shardExpl of Object.values(obj.shards)) takeRoot(shardExpl);
         }
      };
      takeRoot(explainResult);
      for (const root of roots) {
         walkPlanNodes(root, (node) => {
            const stage = String(node.stage || node.nodeType || '');
            const upper = stage.toUpperCase();
            if (upper === 'COLLSCAN' || upper === 'COLLECTIONSCAN') collScan = true;
            if (upper === 'SORT' || upper === 'SORT_KEY_GENERATOR') blockingSort = true;
            if (
               upper === 'IXSCAN' || upper === 'EXPRESS_IXSCAN' || upper === 'IDHACK'
               || upper === 'CLUSTERED_IXSCAN' || upper === 'COUNT_SCAN'
               || upper === 'INDEXSCAN'
            ) ixscan = true;
         });
      }
      return { collScan, blockingSort, ixscan };
   }

   function planHasCollScanOrBlockingSort(explainResult) {
      const { collScan, blockingSort } = inspectCurationPlan(explainResult);
      return collScan || blockingSort;
   }

   function planIsIndexOrdered(explainResult) {
      const { collScan, blockingSort, ixscan } = inspectCurationPlan(explainResult);
      return ixscan && !collScan && !blockingSort;
   }

   function hasUserHint(h) {
      return h != null && typeof h === 'object' && !Array.isArray(h) && Object.keys(h).length > 0;
   }

   function hasUserCollation(c) {
      return c != null && typeof c === 'object' && !Array.isArray(c) && Object.keys(c).length > 0;
   }

   // Per-command readPreference only — mongosh Mongo.setReadPref() reconnects the client
   // (resetConnectionOptions → close) and runCommand ignores connection RP (mongosh 2.0+).
   // adminCommand (serverStatus/getParameter) always targets the primary.
   function commandReadPreference(readPreference = { "mode": "primary" }) {
      /*
       *  Shape for runCommand / aggregate / find / explain options. Document
       *  form carries mode + tags (probed on Atlas); empty tags still fine.
       */
      const mode = readPreference?.mode ?? 'primary';
      const tags = Array.isArray(readPreference?.tags) ? readPreference.tags : [];
      return { "mode": mode, "tags": tags };
   }

   function applyCursorReadPref(cursor, cmdRP) {
      // Shell cursor.readPref(mode, tags) plus driver options.readPreference.
      if (!cursor || typeof cursor.readPref !== 'function' || !cmdRP?.mode) return cursor;
      const next = cursor.readPref(cmdRP.mode, cmdRP.tags);
      return next ?? cursor;
   }

   function connectionHostsLabel() {
      /*
       *  Host label from the mongosh connection URI (credentials stripped).
       *  mongos hello often omits me/host — fall back here for landing INFO.
       */
      try {
         const mongo = db.getMongo();
         const uri = (typeof mongo.getURI === 'function' ? mongo.getURI() : null) ?? mongo._uri;
         if (!uri || typeof uri !== 'string') return null;
         const noAuth = uri.replace(/\/\/[^@/]+@/, '//');
         const m = noAuth.match(/^mongodb(?:\+srv)?:\/\/([^/?]+)/i);
         return m?.[1] || null;
      } catch(_) {
         return null;
      }
   }

   function curationLandingNode(readPreference = { "mode": "primary" }) {
      /*
       *  Resolve curation target via runCommand + per-command readPreference.
       *  Do not use adminCommand — that always targets the primary in mongosh.
       *  Do not use Mongo.setReadPref — reconnects client; runCommand ignores it anyway.
       *  mongos hello typically has no me/host; use connection URI hosts as fallback.
       */
      try {
         const hello = db.getSiblingDB(dbName).runCommand(
            { "hello": 1 },
            { "readPreference": commandReadPreference(readPreference) }
         );
         const role = (hello.msg === 'isdbgrid') ? 'MONGOS'
            : (hello.isWritablePrimary || hello.ismaster) ? 'PRIMARY'
            : hello.secondary ? 'SECONDARY'
            : hello.arbiterOnly ? 'ARBITER'
            : 'UNKNOWN';
         const host = hello.me
            ?? hello.host
            ?? (role === 'MONGOS' ? null : hello.primary)
            ?? connectionHostsLabel()
            ?? 'unknown';
         const tags = hello.tags ?? {};
         return { "host": host, "role": role, "tags": tags };
      } catch(e) {
         return {
            "host": connectionHostsLabel() ?? `unknown (${e?.message ?? e})`,
            "role": 'UNKNOWN',
            "tags": {}
         };
      }
   }

   function resolveCurationOrder(namespace, filter = {}, userHint = {}, readPreference = null) {
      /*
       *  Curation order (Policy A):
       *  - Derive sortBy from the filter ({} / non-field predicates → _id).
       *  - Explain $match+$sort (queryPlanner), with the candidate hint when one
       *    is in play. Index-ordered (IXSCAN, no COLLSCAN / blocking SORT) may
       *    use the $setWindowFields pipeline.
       *  - Otherwise mode 'scan': find() hinted {_id:1} walk, residual filter,
       *    bucket in-process. $setWindowFields would inject a blocking SORT
       *    (32MiB / no spill on Atlas M0).
       *  - User hint is honored only when that hinted explain is index-ordered;
       *    otherwise WARN and take the _id scan. Policy B = alternate indexes.
       */
      const idSort = { "_id": 1 };
      const idHint = { "_id": 1 };
      const sortField = sortKeyFromFilter(filter);
      const sortBy = { [sortField]: 1 };
      const explainOpts = {};
      if (hasUserCollation(collation)) explainOpts.collation = collation;
      if (readPreference?.mode) explainOpts.readPreference = commandReadPreference(readPreference);

      const runExplain = (pipeline, opts) => namespace.explain('queryPlanner').aggregate(pipeline, opts);

      const windowPrefix = sortSpec => [
         { "$match": filter },
         { "$sort": sortSpec },
         { "$setWindowFields": {
            "sortBy": sortSpec,
            "output": { "ordinal": { "$documentNumber": {} } }
         } }
      ];

      const idScan = () => {
         try {
            const expl = runExplain(
               [{ "$match": filter }, { "$sort": idSort }],
               { ...explainOpts, "hint": idHint }
            );
            if (!planIsIndexOrdered(expl)) {
               emit('\n\x1b[31m[WARN]\x1b[0m \x1b[33m_id hint explain is not IXSCAN-without-SORT; find() will still force {_id:1}\x1b[0m');
            }
         } catch(e) {
            emit('\n\x1b[31m[WARN]\x1b[0m \x1b[33mCuration _id hint explain failed\x1b[0m:', e?.message ?? e);
         }
         emit('\n\x1b[31m[WARN]\x1b[0m \x1b[33mCuration falling back to _id index order to avoid COLLSCAN/blocking SORT (filter selectivity may suffer)\x1b[0m');
         return { "sortBy": idSort, "hint": idHint, "mode": "scan" };
      };

      const tryWindow = (candidateSort, candidateHint) => {
         const opts = { ...explainOpts };
         if (hasUserHint(candidateHint)) opts.hint = candidateHint;
         const prefix = [{ "$match": filter }, { "$sort": candidateSort }];
         try {
            const prefixExpl = runExplain(prefix, opts);
            if (!planIsIndexOrdered(prefixExpl)) return null;
            const winExpl = runExplain(windowPrefix(candidateSort), opts);
            if (!planIsIndexOrdered(winExpl)) return null;
            return { "sortBy": candidateSort, "hint": candidateHint, "mode": "window" };
         } catch(e) {
            emit('\n\x1b[31m[WARN]\x1b[0m \x1b[33mCuration window explain failed\x1b[0m:', e?.message ?? e);
            return null;
         }
      };

      if (hasUserHint(userHint)) {
         const win = tryWindow(sortBy, userHint);
         if (win) return win;
         emit('\n\x1b[31m[WARN]\x1b[0m \x1b[33mcuration plan may use COLLSCAN/blocking SORT despite user hint\x1b[0m; sortBy:', JSON.stringify(sortBy));
         return idScan();
      }

      const trusted = tryWindow(sortBy, {});
      if (trusted) return trusted;
      return idScan();
   }

   async function* getIds(filter = {}, bucketSizeLimit = 100, sessionOpts = {}) {
      /*
       *  Curation via per-command readPreference (no Mongo.setReadPref):
       *  landing hello, Policy A explain, and bucketing aggregate share the same RP
       *  document so server selection can stay on one secondary / plan cache.
       *  No DriverSession (mongosh explain on a session can expire before the cursor).
       */
      const readPreference = sessionOpts.readPreference ?? { "mode": "primary" };
      const cmdRP = commandReadPreference(readPreference);
      const { host, role, tags } = curationLandingNode(readPreference);
      const landingLine = `\x1b[34m[INFO]\x1b[0m Curation query target: \x1b[33m${host} (${role})\x1b[0m tags: \x1b[33m${JSON.stringify(tags)}\x1b[0m`;
      emit(landingLine);
      if (
         role === 'PRIMARY' &&
         !onMongos &&
         readPreference.mode &&
         readPreference.mode !== 'primary'
      ) {
         emit('\x1b[31m[WARN]\x1b[0m \x1b[33mCuration expected a secondary but landed on PRIMARY — connect via replica-set/SRV seed list (not directConnection to primary), and ensure eligible secondaries exist\x1b[0m');
      }

      const namespace = db.getSiblingDB(dbName).getCollection(collName);
      const {
         "sortBy": curationSortBy,
         "hint": curationHint,
         "mode": curationMode
      } = resolveCurationOrder(namespace, filter, hint, readPreference);

      if (curationMode === 'scan') {
         yield* getIdsByIdIndexScan(namespace, filter, bucketSizeLimit, cmdRP);
         return;
      }

      // const buckets = Math.pow(2, 31) - 1; // max 32bit Int
      const aggOpts = {
         // Fail closed: a blocking SORT / spill means the plan is wrong (Policy A
         // should have forced the _id find() walk). Do not opt in to external sort.
         "allowDiskUse": false,
         // 1 agg doc = 1 bucket of bucketSizeLimit (_id)s; prefetch pulls buckets.
         "cursor": { "batchSize": 1 },
         "maxTimeMS": 0, // required to overide potential v8 defaultMaxTimeMS cluster settings
         "noCursorTimeout": true,
         "comment": "Bucketing IDs via niceDeleteMany.js",
         "let": { "bucketSizeLimit": bucketSizeLimit },
         "readPreference": cmdRP
      };
      if (hasUserCollation(collation)) aggOpts.collation = collation;
      if (hasUserHint(curationHint)) aggOpts.hint = curationHint;
      // Streaming bucket pipeline (v3). History: Howto-streaming-sort.md
      // $sort immediately after $match so an index can provide order.
      // Do not $project before $sort. Scan mode is used when this would block.
      const pipeline = [
         { "$match": filter },
         { "$sort": curationSortBy },
         { "$setWindowFields": { // assign ordinal numbers in curation order
            "sortBy": curationSortBy,
            "output": { "ordinal": { "$documentNumber": {} } }
         } },
         { "$set": {
            "bucketId": { "$ceil": { "$divide": ["$ordinal", "$$bucketSizeLimit"] } },
            "cardinal": 1 // unit contribution per document within its bucket
         } },
         { "$setWindowFields": { // per-bucket running count + id list
            "partitionBy": "$bucketId",
            "sortBy": curationSortBy,
            "output": {
               "idsInBucket": { // was IDsCumulative (per-bucket only, not global)
                  "$sum": "$cardinal",
                  "window": { "documents": ["unbounded", "current"] }
               },
               "ids": { "$push": "$_id" },
               "bucketSize": { "$sum": 1 }
            }
         } },
         { "$match": { // emit only the last document of each bucket
            "$expr": { "$eq": ["$idsInBucket", "$bucketSize"] }
         } },
         { "$project": {
            "_id": 0,
            "bucketId": 1,
            "bucketSize": 1,
            "bucketSizeLimit": "$$bucketSizeLimit",
            "ids": 1
         } }
      ];
      // offload iterator to the server's cursor (same RP as Policy A explain)
      const cursor = namespace.aggregate(pipeline, aggOpts);
      try {
         yield* cursor;
      } finally {
         try { await cursor.close(); } catch(_) { /* exhausted or already closed */ }
      }
   }

   async function* getIdsByIdIndexScan(namespace, filter = {}, bucketSizeLimit = 100, cmdRP = { "mode": "primary" }) {
      /*
       *  Hinted {_id:1} find walk. Residual filter is a FETCH (object scan);
       *  no blocking SORT / $setWindowFields. Bucket in-process to the same
       *  shape as the window pipeline ({ bucketId, ids, bucketSize, ... }).
       */
      emit('\x1b[34m[INFO]\x1b[0m Curation using hinted \x1b[33m_id\x1b[0m index walk (find); filter applied as residual');
      // Same per-command RP as aggregate (secondaryPreferred + Atlas tags).
      // Wire batchSize = bucketSizeLimit _id docs per getMore (= one yielded bucket).
      // Agg path uses cursor.batchSize 1 because each agg doc is already that bucket.
      const findOpts = {
         "sort": { "_id": 1 },
         "hint": { "_id": 1 },
         "batchSize": bucketSizeLimit,
         "maxTimeMS": 0,
         "noCursorTimeout": true,
         "comment": "Bucketing IDs via niceDeleteMany.js (_id index scan)",
         "readPreference": cmdRP
      };
      if (hasUserCollation(collation)) findOpts.collation = collation;
      let cursor = namespace.find(filter, { "_id": 1 }, findOpts);
      // mongosh Cursor is thenable (await → toArray). Only unwrap a bare Promise.
      if (cursor && typeof cursor.then === 'function' && typeof cursor.sort !== 'function') {
         cursor = await cursor;
      }
      if (typeof cursor.sort === 'function') cursor = cursor.sort({ "_id": 1 }) ?? cursor;
      if (typeof cursor.hint === 'function') cursor = cursor.hint({ "_id": 1 }) ?? cursor;
      cursor = applyCursorReadPref(cursor, cmdRP);
      try {
         let bucketId = 1;
         let ids = [];
         for await (const doc of cursor) {
            ids.push(doc._id);
            if (ids.length >= bucketSizeLimit) {
               yield {
                  "bucketId": bucketId,
                  "bucketSize": ids.length,
                  "bucketSizeLimit": bucketSizeLimit,
                  "ids": ids
               };
               bucketId += 1;
               ids = [];
            }
         }
         if (ids.length) {
            yield {
               "bucketId": bucketId,
               "bucketSize": ids.length,
               "bucketSizeLimit": bucketSizeLimit,
               "ids": ids
            };
         }
      } finally {
         try { await cursor.close(); } catch(_) { /* exhausted or already closed */ }
      }
   }

   function countIds(filter = {}, sessionOpts = {}) {
      // residual validation on primary with majority RC (matches wc:majority deletes)
      const session = db.getMongo().startSession(sessionOpts);
      try {
         const namespace = session.getDatabase(dbName).getCollection(collName);
         const pipeline = [
               { "$match": filter },
               { "$group": {
                  "_id": null,
                  "IDsTotal": { "$count": {} }
               } },
               { "$project": {
                  "_id": 0,
                  "IDsTotal": 1 // total number of IDs
               } }
            ],
            aggOpts = {
               "allowDiskUse": true,
               "readOnce": true, // may or may not work in aggregation?
               "readConcern": sessionOpts?.readConcern?.level ?? "majority",
               "hint": hint,
               "comment": "Validating IDs via niceDeleteMany.js"
            };
         if (hasUserCollation(collation)) aggOpts.collation = collation;
         return namespace.aggregate(pipeline, aggOpts).toArray()[0]?.IDsTotal ?? 0;
      } finally {
         session.endSession();
      }
   }

   async function deleteManyTask({ ids, IDs, bucketId } = {}, sessionOpts = {}) {
      // Accept ids (v0.4.8+) with legacy IDs alias for safety during upgrades.
      const idList = ids ?? IDs;
      const session = db.getMongo().startSession(sessionOpts);
      try {
         const namespace = session.getDatabase(dbName).getCollection(collName);
         const txnOpts = {
            // "readConcern": { "level": "local" },
            // "writeConcern": {
            //    "w": "majority",
            //    "j": false
            // },
            "comment": `Simulating deleteMany(${JSON.stringify(filter)}) workload via niceDeleteMany.js`
         };
         const deleteManyFilter = { "_id": { "$in": idList } };
         // Collation intentionally omitted: deletes are _id equality only (binary compare).
         const deleteManyOpts = {};
         let deletedCount = 0;
         let batchOk = true;
         const deleteMany = async() => {
            return await namespace.deleteMany(deleteManyFilter, deleteManyOpts).deletedCount;
         }
         if (safeguard) {
            let txnStarted = false;
            try {
               session.startTransaction(txnOpts);
               txnStarted = true;
               deletedCount = await deleteMany();
            } catch(e) {
               batchOk = false;
               emit('\x1b[31m[WARN]\x1b[0m \x1b[33mtransaction error (batch', bucketId, ')\x1b[0m:', e?.message ?? e);
            } finally {
               if (txnStarted) {
                  try {
                     session.abortTransaction();
                  } catch(e) {
                     batchOk = false;
                     emit('\x1b[31m[WARN]\x1b[0m \x1b[33mabort transaction error (batch', bucketId, ')\x1b[0m:', e?.message ?? e);
                  }
               }
            }
         } else {
            try {
               deletedCount = await deleteMany();
            } catch(e) {
               batchOk = false;
               emit('\x1b[31m[WARN]\x1b[0m \x1b[33mdeleteMany error (batch', bucketId, ')\x1b[0m:', e?.message ?? e);
            }
         }

         return [bucketId, deletedCount, batchOk];
      } finally {
         session.endSession();
      }
   }

   function reportResidualValidation({
      residual = 0,
      batchesDone = 0,
      docsDeleted = 0,
      batchesFailed = 0,
      bucketSizeLimit = 100,
      elapsedMs = 0
   } = {}) {
      /*
       *  Residual count is majority-RC on primary. Interpretation differs for
       *  safeguard (simulated) vs real deletes; drift can come from failed batches
       *  or concurrent writers matching the same filter.
       */
      const rate = estimatedDeleteRate({
         batchesDone, batchesFailed, bucketSizeLimit, elapsedMs
      });
      emit('\tBatches completed:', fmtNum(batchesDone));
      emit('\tBatches with errors:', fmtNum(batchesFailed));
      emit('\tDocuments deleted (reported by deleteMany):', fmtNum(docsDeleted));
      emit('\tElapsed:', fmtElapsed(elapsedMs));
      emit('\tEst. delete rate ((ok batches)×batch size / elapsed):', fmtRate(rate));
      emit('\tResidual document count matching filter:', fmtNum(residual));

      if (safeguard) {
         emit('\n\x1b[34m[INFO]\x1b[0m Safeguard was enabled — deletes ran in transactions that were rolled back.');
         emit('\tResidual matching documents are \x1b[33mexpected\x1b[0m (this run should not have removed data).');
         emit('\tTo actually remove matches, re-run with \x1b[33msafeguard = false\x1b[0m.');
         return;
      }

      if (batchesFailed > 0) {
         emit('\n\x1b[31m[WARN]\x1b[0m \x1b[33mSome batches failed\x1b[0m — residual may include IDs that were not deleted.');
      }

      if (residual > 0) {
         emit('\n\x1b[31m[WARN]\x1b[0m \x1b[33mResidual documents still match the filter.\x1b[0m');
         emit('\tPossible causes: failed batches, concurrent inserts/updates that match the filter,');
         emit('\tor documents that appeared after the curation cursor passed.');
         emit('\x1b[34m[INFO]\x1b[0m Recommendation: re-run this script with the \x1b[33msame filter\x1b[0m');
         emit('\tand \x1b[33msafeguard = false\x1b[0m to clear remaining matches (or investigate concurrent writers).');
      } else {
         emit('\n\x1b[34m[INFO]\x1b[0m No residual documents match the filter.');
         if (batchesFailed > 0) {
            emit('\t(Reported delete counts may still be incomplete due to batch errors.)');
         }
      }
   }

   async function congestionMonitor() {
      /*
       *  congestionMonitor() function
       */
      async function serverStatus(serverStatusOptions = {}) {
         /*
          *  opt-in version of db.serverStatus() with a 100ms TTL cache.
          *  Concurrent callers with the same options share one in-flight round trip.
          */
         const key = JSON.stringify(serverStatusOptions);
         const now = Date.now();
         if (_serverStatusCache.value !== null &&
               _serverStatusCache.key === key &&
               (now - _serverStatusCache.at) < SERVER_STATUS_CACHE_TTL_MS) {
            return _serverStatusCache.value;
         }
         if (_serverStatusCache.inflight !== null && _serverStatusCache.key === key) {
            return await _serverStatusCache.inflight;
         }

         // db.adminCommand() is synchronous in mongosh; wrap in a Promise so
         // await is meaningful and concurrent callers can share one in-flight fetch.
         _serverStatusCache.key = key;
         _serverStatusCache.inflight = Promise.resolve().then(() => db.adminCommand({
            "serverStatus": true,
            ...{ ...SERVER_STATUS_OPTIONS_DEFAULTS, ...serverStatusOptions }
         }));
         try {
            const value = await _serverStatusCache.inflight;
            _serverStatusCache.value = value;
            _serverStatusCache.at = Date.now();
            return value;
         } finally {
            _serverStatusCache.inflight = null;
         }
      }

      function hostInfo() {
         // Near-static (cores, RAM limits, OS). 60s TTL is plenty; container limit changes are rare.
         const now = Date.now();
         if (_hostInfoCache.value !== null && (now - _hostInfoCache.at) < HOST_INFO_CACHE_TTL_MS) {
            return _hostInfoCache.value;
         }
         let hostInfo = {};
         try {
            hostInfo = db.hostInfo();
         } catch(e) {
            // console.debug(`\x1b[31m[WARN]\x1b[0m \x1b[33minsufficient rights to execute db.hostInfo()\n${e}\x1b[0m`);
         }
         _hostInfoCache.value = hostInfo;
         _hostInfoCache.at = now;
         return hostInfo;
      }

      function rsStatus() {
         // Member set/health changes slowly; optimes move faster. TTL balances lag freshness vs rs.status() cost.
         const now = Date.now();
         if (_rsStatusCache.value !== null && (now - _rsStatusCache.at) < RS_STATUS_CACHE_TTL_MS) {
            return _rsStatusCache.value;
         }
         let rsStatus = {};
         try {
            rsStatus = rs.status();
         } catch(e) {
            // console.debug(`\x1b[31m[WARN]\x1b[0m \x1b[33minsufficient rights to execute rs.status()\n${e}\x1b[0m`);
         }
         _rsStatusCache.value = rsStatus;
         _rsStatusCache.at = now;
         return rsStatus;
      }

      function slowms() {
         // Profiling threshold rarely changes at runtime.
         const now = Date.now();
         if (_slowmsCache.value !== null && (now - _slowmsCache.at) < SLOWMS_CACHE_TTL_MS) {
            return _slowmsCache.value;
         }
         let slowms = null;
         try {
            slowms = db.getSiblingDB('admin').getProfilingStatus().slowms;
         } catch(e) {
            // console.debug(`\x1b[31m[WARN]\x1b[0m \x1b[33minsufficient rights to execute getProfilingStatus()\n${e}\x1b[0m`);
         }
         _slowmsCache.value = slowms;
         _slowmsCache.at = now;
         return slowms;
      }

      // Refresh dynamic/near-static data fields; create getter-bearing view once.
      const data = {
         "hostInfo": hostInfo(),
         "rsStatus": rsStatus(),
         "wiredTigerEngineRuntimeConfig": getParameter('wiredTigerEngineRuntimeConfig', ''),
         "storageEngineConcurrentReadTransactions": getParameter('wiredTigerConcurrentReadTransactions', null),
         // "storageEngineConcurrentReadTransactions": getParameter('storageEngineConcurrentReadTransactions', null),
         "storageEngineConcurrentWriteTransactions": getParameter('wiredTigerConcurrentWriteTransactions', null),
         // "lowPriorityAdmissionBypassThreshold": getParameter('lowPriorityAdmissionBypassThreshold', null),
         // https://www.mongodb.com/docs/manual/reference/command/serverStatus/#mongodb-serverstatus-serverstatus.wiredTiger.concurrentTransactions
         "serverStatus": await serverStatus(SERVER_STATUS_OPT_IN),
         "slowms": slowms()
      };
      if (vitalsView !== null) {
         Object.assign(vitalsView, data);
         return vitalsView;
      }
      // WT eviction defaults (https://kb.corp.mongodb.com/article/000019073)
      // evictionThreadsMin,
      // evictionThreadsMax,
      // evictionCheckpointTarget,
      // evictionDirtyTarget,    // operate in a similar way to the overall targets but only apply to dirty data in cache
      // evictionDirtyTrigger,   // application threads will be throttled if the percentage of dirty data reaches the eviction_dirty_trigger
      // evictionTarget,         // the level at which WiredTiger attempts to keep the overall cache usage
      // evictionTrigger,        // the level at which application threads start to perform the eviction
      // evictionUpdatesTarget,  // eviction in worker threads when the cache contains at least this many bytes of updates
      // evictionUpdatesTrigger, // application threads to perform eviction when the cache contains at least this many bytes of updates
      vitalsView = {
         ...data,
         wterc(regex) {
            // { "wiredTigerEngineRuntimeConfig": "eviction=(threads_min=8,threads_max=8),eviction_dirty_target=2,eviction_updates_trigger=8,checkpoint=(wait=60,log_size=2GB)" }
            return this.wiredTigerEngineRuntimeConfig.match(regex)?.[1] ?? null;
         },
         get evictionThreadsMin() {
            return +(this.wterc(/eviction=\(.*threads_min=(\d+).*\)/) ?? 4);
         },
         get evictionThreadsMax() {
            return +(this.wterc(/eviction=\(.*threads_max=(\d+).*\)/) ?? 4);
         },
         get evictionCheckpointTarget() {
            return +(this.wterc(/eviction_checkpoint_target=(\d+)/) ?? 1);
         },
         get evictionDirtyTarget() {
            return +(this.wterc(/eviction_dirty_target=(\d+)/) ?? 5);
         },
         get evictionDirtyTrigger() {
            return +(this.wterc(/eviction_dirty_trigger=(\d+)/) ?? 20);
         },
         get evictionTarget() {
            return +(this.wterc(/eviction_target=(\d+)/) ?? 80);
         },
         get evictionTrigger() {
            return +(this.wterc(/eviction_trigger=(\d+)/) ?? 95);
         },
         get evictionUpdatesTarget() {
            return +(this.wterc(/eviction_updates_target=(\d+)/) ?? 2.5);
         },
         get evictionUpdatesTrigger() {
            return +(this.wterc(/eviction_updates_trigger=(\d+)/) ?? 10);
         },
         get checkpointIntervalMS() { // checkpoint=(wait=60
            return 1000 * (this.wterc(/checkpoint=\(.*wait=(\d+).*\)/) ?? 60);
         },
         // Atlas M0/Flex omit serverStatus.wiredTiger; main() probes and switches to pace admission.
         get updatesDirtyBytes() {
            return this.serverStatus.wiredTiger?.cache?.['bytes allocated for updates'];
         },
         get dirtyBytes() {
            return +this.serverStatus.wiredTiger?.cache?.['tracked dirty bytes in the cache'];
         },
         get cacheSizeBytes() {
            return +this.serverStatus.wiredTiger?.cache?.['maximum bytes configured'];
         },
         get cachedBytes() {
            return this.serverStatus.wiredTiger?.cache?.['bytes currently in the cache'];
         },
         get cacheUtil() {
            return Number.parseFloat(((this.cachedBytes / this.cacheSizeBytes) * 100).toFixed(2));
         },
         get cacheStatus() {
            return (this.cacheUtil < this.evictionTarget) ? 'low'
                 : (this.cacheUtil > this.evictionTrigger) ? 'high'
                 : 'medium';
         },
         get dirtyUtil() {
            return Number.parseFloat(((this.dirtyBytes / this.cacheSizeBytes) * 100).toFixed(2));
         },
         get dirtyStatus() {
            return (this.dirtyUtil < this.evictionDirtyTarget) ? 'low'
                 : (this.dirtyUtil > this.evictionDirtyTrigger) ? 'high'
                 : 'medium';
         },
         get dirtyUpdatesUtil() {
            return Number.parseFloat(((this.updatesDirtyBytes / this.cacheSizeBytes) * 100).toFixed(2));
         },
         get dirtyUpdatesStatus() {
            return (this.dirtyUpdatesUtil < this.evictionUpdatesTarget) ? 'low'
                 : (this.dirtyUpdatesUtil > this.evictionUpdatesTrigger) ? 'high'
                 : 'medium';
         },
         get cacheEvictions() {
            return (this.cacheUtil > this.evictionTrigger);
         },
         get dirtyCacheEvictions() {
            return (this.dirtyUtil > this.evictionDirtyTrigger);
         },
         get dirtyUpdatesCacheEvictions() {
            return (this.dirtyUpdatesUtil > this.evictionUpdatesTrigger);
         },
         get evictionsTriggered() {
            return (this.cacheEvictions || this.dirtyCacheEvictions || this.dirtyUpdatesCacheEvictions);
         },
         get cacheHitRatio() {
            const hitBytes = this.serverStatus.wiredTiger?.cache?.['pages requested from the cache'];
            const missBytes = this.serverStatus.wiredTiger?.cache?.['pages read into cache'];
            return Number.parseFloat((100 * (hitBytes - missBytes) / hitBytes).toFixed(2));
         },
         get cacheHitStatus() {
            return (this.cacheHitRatio < 20) ? 'high'
                 : (this.cacheHitRatio > 75) ? 'low'
                 : 'medium';
         },
         get cacheMissRatio() {
            const hitBytes = this.serverStatus.wiredTiger?.cache?.['pages requested from the cache'];
            const missBytes = this.serverStatus.wiredTiger?.cache?.['pages read into cache'];
            return Number.parseFloat((100 * (1 - (hitBytes - missBytes) / hitBytes)).toFixed(2));
         },
         get cacheMissStatus() {
            return (this.cacheMissRatio < 20) ? 'low'
                 : (this.cacheMissRatio > 75) ? 'high'
                 : 'medium';
         },
         get memSizeBytes() {
            // return (this?.hostInfo?.system?.memSizeMB ?? 1024) * 1024 * 1024;
            return (this?.hostInfo?.system?.memLimitMB ?? 1024) * 1024 * 1024;
         },
         get numCores() {
            // else max 4 is probably a good default aligning with concurrency limits
            return this?.hostInfo?.system?.numCores ?? 4;
         },
         get memResidentBytes() {
            return (this.serverStatus.mem?.resident ?? 0) * 1024 * 1024;
         },
         get currentAllocatedBytes() {
            return +(this.serverStatus?.tcmalloc?.generic?.current_allocated_bytes ?? 0);
         },
         get heapSize() {
            return +(this.serverStatus?.tcmalloc?.generic?.heap_size ?? (this.memSizeBytes / 64));
         },
         get heapUtil() {
            return Number.parseFloat((100 * (this.currentAllocatedBytes / this.heapSize)).toFixed(2));
         },
         get pageheapFreeBytes() {
            // assume zero fragmentation if we cannot measure pageheap_free_bytes
            return +(this.serverStatus?.tcmalloc?.tcmalloc?.pageheap_free_bytes ?? 0);
         },
         get totalFreeBytes() {
            return +(this.serverStatus?.tcmalloc?.tcmalloc?.total_free_bytes ?? 0);
         },
         get memoryFragmentationRatio() {
            return Number.parseFloat(((this.pageheapFreeBytes / this.memSizeBytes) * 100).toFixed(2));
         },
         get memoryFragmentationStatus() {
            // mimicing the (bad) t2 derived metric for now
            return (this.memoryFragmentationRatio < 10) ? 'low'  // 25 is more realistic
                 : (this.memoryFragmentationRatio > 30) ? 'high' // 50 is more realistic
                 : 'medium';
         },
         get backupCursorOpen() {
            return this.serverStatus.storageEngine?.backupCursorOpen;
         },
         // WT tickets available
         // v6.0 (and older)
         // {
         //    write: { out: 0, available: 128, totalTickets: 128 },
         //    read: { out: 0, available: 128, totalTickets: 128 }
         //  }
         // v7.0+
         //    write: {
         //      out: 0,
         //      available: 13,
         //      totalTickets: 13,
         //      queueLength: Long('0'),
         //      processing: Long('0')
         //    },
         //    read: {
         //      out: 0,
         //      available: 13,
         //      totalTickets: 13,
         //      queueLength: Long('0'),
         //      processing: Long('0')
         //    }
         // v8.0 see db.serverStats().queues.execution
         get wtReadTicketsUtil() {
            const { out, totalTickets } = this.serverStatus.wiredTiger?.concurrentTransactions?.read ?? this.serverStatus?.queues?.execution?.read ?? {};
            return Number.parseFloat(((out / totalTickets) * 100).toFixed(2));
         },
         get wtReadTicketsAvail() {
            const { available, totalTickets } = this.serverStatus.wiredTiger?.concurrentTransactions?.read ?? this.serverStatus?.queues?.execution?.read ?? {};
            return Number.parseFloat(((available / totalTickets) * 100).toFixed(2));
         },
         get wtWriteTicketsUtil() {
            const { out, totalTickets } = this.serverStatus.wiredTiger?.concurrentTransactions?.write ?? this.serverStatus?.queues?.execution?.write ?? {};
            return Number.parseFloat(((out / totalTickets) * 100).toFixed(2));
         },
         get wtWriteTicketsAvail() {
            const { available, totalTickets } = this.serverStatus.wiredTiger?.concurrentTransactions?.write ?? this.serverStatus?.queues?.execution?.write ?? {};
            return Number.parseFloat(((available / totalTickets) * 100).toFixed(2));
         },
         get wtReadTicketsStatus() {
            return (this.wtReadTicketsUtil < 20) ? 'low'
                 : (this.wtReadTicketsUtil > 75) ? 'high'
                 : 'medium';
         },
         get wtWriteTicketsStatus() {
            return (this.wtWriteTicketsUtil < 20) ? 'low'
                 : (this.wtWriteTicketsUtil > 75) ? 'high'
                 : 'medium';
         },
         get activeShardMigrations() {
            const { currentMigrationsDonating, currentMigrationsReceiving } = this.serverStatus.tenantMigrations ?? {};
            return (currentMigrationsDonating > 0 || currentMigrationsReceiving > 0);
         },
         get activeFlowControl() {
            return (this.serverStatus.flowControl?.isLagged === true && this.serverStatus.flowControl?.enabled === true);
         },
         get activeIndexBuilds() {
            return (this.serverStatus?.indexBuilds?.total ?? 0) > (this.serverStatus?.indexBuilds?.phases?.commit ?? 0) || (this.serverStatus?.activeIndexBuilds?.total ?? 0) > 0;
         },
         get activeCheckpoint() {
            return !!(this.serverStatus.wiredTiger?.transaction?.['transaction checkpoint currently running'] || this.serverStatus.wiredTiger?.checkpoint?.['progress state']);
         },
         get slowRecentCheckpoint() {
            return (this.serverStatus.wiredTiger?.transaction?.['transaction checkpoint most recent time (msecs)'] > 60000);
         },
         get checkpointRuntimeRatio() {
            return Number.parseFloat((((this.serverStatus.wiredTiger?.transaction?.['transaction checkpoint most recent time (msecs)'] ?? this.serverStatus.wiredTiger?.checkpoint?.['most recent time (msecs)']) / this.checkpointIntervalMS) * 100).toFixed(2));
         },
         get checkpointStatus() {
            return (this.checkpointRuntimeRatio < 50) ? 'low'
                 : (this.checkpointRuntimeRatio > 100) ? 'high'
                 : 'medium';
         },
         get activeReplLag() { // calculate the highest repl-lag from healthy members
            const members = this.rsStatus?.members;
            if (!Array.isArray(members) || members.length === 0) return 0;
            const opTimers = members.map(({
               stateStr,
               health,
               optimeDate
            } = {}) => {
               return {
                  "stateStr": stateStr,
                  "health": health,
                  "optimeDate": optimeDate
               };
            }).filter(({ health, stateStr }) => {
               return (health && (stateStr === 'PRIMARY' || stateStr === 'SECONDARY'));
            }).map(({ optimeDate }) => optimeDate).filter(optimeDate => optimeDate != null);
            if (opTimers.length === 0) return 0;
            return +((Math.max(...opTimers) - Math.min(...opTimers)) / 1000).toFixed(0);
         },
         get replLagStatus() {
            return (this.activeReplLag < this.heartbeatIntervalMillis / 1000) ? 'low'
                 : (this.activeReplLag > 90) ? 'high' // maxStalenessSeconds
                 : 'medium';
         },
         get replLagScale() {
            return 30;
         },
         get heartbeatIntervalMillis() {
            return this.rsStatus?.heartbeatIntervalMillis ?? 2000;
         }
      };
      return vitalsView;
   }

   function ewmaStep(prev, sample, alpha = EWMA_ALPHA) {
      if (sample == null || Number.isNaN(+sample)) return prev;
      sample = +sample;
      if (prev == null || Number.isNaN(prev)) return sample;
      return alpha * sample + (1 - alpha) * prev;
   }

   function updateEwma(sample) {
      /*
       *  Update smoothed util series from a vitals snapshot (called each sample).
       *  admissionControl bands on these values instead of raw point samples.
       */
      if (sample == null || typeof sample !== 'object') return;
      try {
         ewma.cacheUtil = ewmaStep(ewma.cacheUtil, sample.cacheUtil);
         ewma.dirtyUtil = ewmaStep(ewma.dirtyUtil, sample.dirtyUtil);
         ewma.dirtyUpdatesUtil = ewmaStep(ewma.dirtyUpdatesUtil, sample.dirtyUpdatesUtil);
         ewma.wtWriteTicketsUtil = ewmaStep(ewma.wtWriteTicketsUtil, sample.wtWriteTicketsUtil);
      } catch(e) {
         // getters may throw if serverStatus shape is incomplete; keep prior ewma
      }
   }

   function bandStatus(util, lowMax, highMin) {
      if (util == null || Number.isNaN(util)) return 'medium';
      return (util < lowMax) ? 'low'
           : (util > highMin) ? 'high'
           : 'medium';
   }

   function utilAbove(util, min) {
      return util != null && !Number.isNaN(util) && util > min;
   }

   function utilAtOrBelow(util, max) {
      return util == null || Number.isNaN(util) || util <= max;
   }

   function utilInBand(util, lo, hi) {
      return util != null && !Number.isNaN(util) && util >= lo && util <= hi;
   }

   function fillProgress(util, target, trigger) {
      // 0 at target (or below), 1 at/above trigger — fraction through the soft band.
      if (util == null || Number.isNaN(+util)) return 0;
      const span = trigger - target;
      if (!(span > 0)) return (+util > trigger) ? 1 : 0;
      return Math.min(1, Math.max(0, (+util - target) / span));
   }

   function progressiveThrottleDelay(dirtyUtil, dirtyUpdatesUtil, {
      evictionDirtyTarget,
      evictionDirtyTrigger,
      evictionUpdatesTarget,
      evictionUpdatesTrigger
   } = {}) {
      /*
       *  Map EWMA dirty/updates fill through [target, trigger] → [min, max] ms.
       *  Uses the more stressed of the two signals; light ±20% jitter for desync.
       */
      const t = Math.max(
         fillProgress(dirtyUtil, evictionDirtyTarget, evictionDirtyTrigger),
         fillProgress(dirtyUpdatesUtil, evictionUpdatesTarget, evictionUpdatesTrigger)
      );
      const delay = THROTTLE_DELAY_MIN_MS + (THROTTLE_DELAY_MAX_MS - THROTTLE_DELAY_MIN_MS) * t;
      const jitter = 0.8 + Math.random() * 0.4;
      return Math.floor(delay * jitter);
   }

   function fmtElapsed(ms) {
      const s = Math.max(0, Math.floor(ms / 1000));
      const hh = Math.floor(s / 3600);
      const mm = Math.floor((s % 3600) / 60);
      const ss = s % 60;
      const p = n => String(n).padStart(2, '0');
      return hh > 0 ? `${p(hh)}:${p(mm)}:${p(ss)}` : `${p(mm)}:${p(ss)}`;
   }

   function fmtNum(n) {
      return Number(n || 0).toLocaleString('en-US');
   }

   function hudStatusColour(status) {
      // Match congestionMonitor EQ: low=green, medium=yellow, high=red.
      return status === 'high' ? '\x1b[91m'
         : status === 'medium' ? '\x1b[93m'
         : '\x1b[92m';
   }

   // HUD text: metric names green, values yellow (bars keep their own colours).
   // Non-TTY log mode still builds these; emit() strips ANSI via stripAnsi().
   const HUD_LABEL_COLOUR = '\x1b[92m';
   const HUD_VALUE_COLOUR = '\x1b[93m';
   const HUD_TEXT_RESET = '\x1b[0m';
   function hudLabel(text) {
      return `${HUD_LABEL_COLOUR}${text}${HUD_TEXT_RESET}`;
   }
   function hudValue(text) {
      return `${HUD_VALUE_COLOUR}${text}${HUD_TEXT_RESET}`;
   }

   function hudFillMark(status = 'low') {
      return HUD_MARK[status] ?? HUD_MARK.low;
   }

   function renderMeterBar(fill01, width = hudBarWidth(), status = 'low') {
      const t = Math.min(1, Math.max(0, +fill01 || 0));
      const filled = Math.round(t * width);
      const mark = hudFillMark(status);
      let out = '[';
      for (let i = 0; i < width; i++) {
         out += i < filled ? mark : HUD_MARK.bg;
      }
      return out + ']';
   }

   function admitStateStatus(state) {
      if (state === 'CLOSED') return 'high';
      if (state === 'OPEN') return 'low';
      return 'medium'; // THROTTLE | COOLDOWN | PACE
   }

   function renderAdmitBand(state, width = hudBarWidth()) {
      const status = admitStateStatus(state);
      const label = ` ${state} `;
      const pad = Math.max(0, width - label.length);
      const left = Math.floor(pad / 2);
      const right = pad - left;
      const mark = hudFillMark(status);
      const colouredLabel = hudStatusColour(status) + label + '\x1b[0m';
      return '[' + mark.repeat(left) + colouredLabel + mark.repeat(right) + ']';
   }

   function pushPoolSlots(target, run, buf, free, cap, admitStatus) {
      const runMark = HUD_MARK.run[admitStatus] ?? HUD_MARK.run.low;
      for (let i = 0; i < run; i++) target.push(runMark);
      for (let i = 0; i < buf; i++) target.push(HUD_MARK.buf);
      for (let i = 0; i < free; i++) target.push(HUD_MARK.free);
      for (let i = 0; i < cap; i++) target.push(HUD_MARK.cap);
   }

   function renderPoolBar(poolSize, executing, buffered, inFlightLimit, admitStatus) {
      const run = Math.max(0, Math.min(poolSize, executing|0));
      const buf = Math.max(0, Math.min(poolSize - run, buffered|0));
      const free = Math.max(0, Math.min(poolSize - run - buf, Math.max(0, inFlightLimit - run - buf)));
      const cap = Math.max(0, poolSize - run - buf - free);
      const slots = [];
      pushPoolSlots(slots, run, buf, free, cap, admitStatus);

      let display = slots;
      const poolDisplayMax = hudPoolDisplayMax();
      if (poolSize > poolDisplayMax) {
         const scale = poolDisplayMax / poolSize;
         const counts = [
            Math.round(run * scale),
            Math.round(buf * scale),
            Math.round(free * scale),
            Math.round(cap * scale)
         ];
         // Fix rounding so display width is exact.
         let sum = counts.reduce((a, b) => a + b, 0);
         while (sum > poolDisplayMax) {
            const idx = counts.indexOf(Math.max(...counts));
            counts[idx]--;
            sum--;
         }
         while (sum < poolDisplayMax) {
            counts[3]++; // grow cap visually
            sum++;
         }
         display = [];
         pushPoolSlots(display, counts[0], counts[1], counts[2], counts[3], admitStatus);
      }
      return {
         "bar": '[' + display.join('') + ']',
         "run": run,
         "buf": buf,
         "free": free,
         "cap": cap
      };
   }

   function fmtRate(docsPerSec) {
      if (docsPerSec == null || !Number.isFinite(docsPerSec) || docsPerSec < 0) return 'n/a';
      if (docsPerSec >= 100) return `${Math.round(docsPerSec)}/s`;
      if (docsPerSec >= 10) return `${docsPerSec.toFixed(1)}/s`;
      return `${docsPerSec.toFixed(2)}/s`;
   }

   function estimatedDeleteRate({
      batchesDone = 0,
      batchesFailed = 0,
      bucketSizeLimit = 100,
      elapsedMs = 0
   } = {}) {
      /*
       *  (completed − failed) × bucketSizeLimit / elapsed.
       *  Approximate throughput from successful batch slots (last batch may be smaller).
       */
      const okBatches = Math.max(0, (batchesDone|0) - (batchesFailed|0));
      const elapsedSec = Math.max(0, elapsedMs) / 1000;
      if (elapsedSec <= 0 || okBatches <= 0) return null;
      return (okBatches * (bucketSizeLimit|0)) / elapsedSec;
   }

   function renderHud({
      startedAt,
      batchesDone = 0,
      batchesFailed = 0,
      docsDeleted = 0,
      bucketSizeLimit = 100,
      admission = {},
      poolSize = 1,
      executing = 0,
      buffered = 0,
      bars = interactive
   } = {}) {
      const elapsedMs = Date.now() - (startedAt || Date.now());
      const elapsed = fmtElapsed(elapsedMs);
      const state = admission.state ?? admissionState;
      const delayMs = admission.delayMs ?? 0;
      const mif = admission.maxInFlight ?? maxInFlight;
      const mifCap = maxInFlightCap;
      const inFlightLimit = Math.max(1, Math.min(poolSize, mif));
      const admitStatus = admitStateStatus(state);
      const rate = estimatedDeleteRate({
         batchesDone, batchesFailed, bucketSizeLimit, elapsedMs
      });
      const paceBit = (admissionMode === 'pace' && paceEwmaRate != null)
         ? `   ${hudLabel('pace')}  ${hudValue(fmtRate(paceEwmaRate))}` +
            (pacePeakRate != null
               ? ` (${hudLabel('peak')} ${hudValue(fmtRate(pacePeakRate))})`
               : '') +
            (paceInWall ? ` ${hudValue('WALL')}` : '')
         : '';
      const statsLine = `${hudLabel('elapsed')}  ${hudValue(elapsed)}` +
         `   ${hudLabel('batches')}  ${hudValue(fmtNum(batchesDone))}` +
         `   ${hudLabel('failed')}  ${hudValue(fmtNum(batchesFailed))}` +
         `   ${hudLabel('deleted')}  ${hudValue(fmtNum(docsDeleted))}` +
         `   ${hudLabel('rate')}  ${hudValue(fmtRate(rate))}` + paceBit;

      // Congestion: max(dirty, updates) soft-band fill (reuse fillProgress).
      let congMetric = 'n/a';
      let congDetail = '';
      let congStatus = 'low';
      let congFill = 0;
      if (admissionMode === 'pace') {
         const why = paceReason === 'mongos' ? 'pace mongos'
            : paceReason === 'no-wt' ? 'no WT (M0/Flex?)'
            : 'pace';
         congDetail = `(${why}; paceMaker)`;
      } else {
         const dirtyTarget = vitals.evictionDirtyTarget ?? 5;
         const dirtyTrigger = vitals.evictionDirtyTrigger ?? 20;
         const updatesTarget = vitals.evictionUpdatesTarget ?? 2.5;
         const updatesTrigger = vitals.evictionUpdatesTrigger ?? 10;
         const dirtyUtil = ewma.dirtyUtil ?? vitals.dirtyUtil;
         const dirtyUpdatesUtil = ewma.dirtyUpdatesUtil ?? vitals.dirtyUpdatesUtil;
         const dirtyFill = fillProgress(dirtyUtil, dirtyTarget, dirtyTrigger);
         const updatesFill = fillProgress(dirtyUpdatesUtil, updatesTarget, updatesTrigger);
         const peakIsUpdates = updatesFill > dirtyFill;
         congFill = Math.max(dirtyFill, updatesFill);
         const peakUtil = peakIsUpdates ? dirtyUpdatesUtil : dirtyUtil;
         const peakLabel = peakIsUpdates ? 'updates' : 'dirty';
         const tgt = peakIsUpdates ? updatesTarget : dirtyTarget;
         const trig = peakIsUpdates ? updatesTrigger : dirtyTrigger;
         // Colour tracks soft-band split: lower=green, upper=yellow, ≥trigger=red.
         const peakFill = fillProgress(peakUtil, tgt, trig);
         congStatus = utilAbove(peakUtil, trig) || peakFill >= 1 ? 'high'
            : peakFill >= THROTTLE_ENTER_FRAC ? 'medium'
            : 'low';
         const flags = [];
         try { if (vitals.checkpointStatus === 'high' || vitals.activeCheckpoint) flags.push('ckpt'); } catch(_) { /* ignore */ }
         if (admission.flowControl) flags.push('flow');
         if (admission.indexBuilds) flags.push('idx');
         if (admission.backupCursor) flags.push('backup');
         const lag = admission.replLag ?? vitals.activeReplLag ?? 0;
         if (lag > 0) flags.push(`lag ${Math.round(lag)}s`);
         const flagTxt = flags.length ? `  ${flags.join(' ')}` : '';
         if (peakUtil == null || Number.isNaN(+peakUtil)) {
            congDetail = '(no WT)';
         } else {
            congMetric = `${peakLabel} ${Number(peakUtil).toFixed(1)}%`;
            congDetail = `(tgt ${tgt} → trig ${trig})${flagTxt}`;
         }
      }

      const closedSec = (state === 'CLOSED' && closedSince > 0)
         ? `  ${hudLabel('closed')} ${hudValue(`${Math.round((Date.now() - closedSince) / 1000)}s`)}`
         : '';
      const pool = {
         "run": Math.max(0, Math.min(poolSize, executing|0)),
         "buf": 0,
         "free": 0,
         "cap": 0,
         "bar": ''
      };
      pool.buf = Math.max(0, Math.min(poolSize - pool.run, buffered|0));
      pool.free = Math.max(0, Math.min(poolSize - pool.run - pool.buf, Math.max(0, inFlightLimit - pool.run - pool.buf)));
      pool.cap = Math.max(0, poolSize - pool.run - pool.buf - pool.free);

      // Coloured labels/values for both modes; emit() strips ANSI when non-TTY.
      // Glyph bars only when bars=true (interactive).
      const congText = admissionMode === 'pace' || congMetric === 'n/a'
         ? `${hudValue('n/a')} ${hudValue(congDetail)}`.trimEnd()
         : `${hudValue(congMetric)}  ${hudValue(congDetail)}`.trimEnd();
      const admitText = `${hudLabel('delay')} ${hudValue(`${delayMs}ms`)}` +
         `  ${hudLabel('maxInFlight')} ${hudValue(`${mif}/${mifCap}`)}${closedSec}`;
      const poolText = `${hudLabel('run')} ${hudValue(String(pool.run))}` +
         `  ${hudLabel('buf')} ${hudValue(String(pool.buf))}` +
         `  ${hudLabel('free')} ${hudValue(String(pool.free))}` +
         `  ${hudLabel('cap')} ${hudValue(String(pool.cap))}` +
         `  ${hudLabel('pool')} ${hudValue(String(poolSize))}`;

      if (!bars) {
         return [
            statsLine,
            `${hudLabel('congestion')}  ${congText}`,
            `${hudLabel('admission')}   ${hudValue(state)}  ${admitText}`,
            `${hudLabel('task pool')}   ${poolText}`
         ].join('\n');
      }

      const barW = hudBarWidth();
      const congLine = `${hudLabel('congestion')} ${
         admissionMode === 'pace' || congMetric === 'n/a'
            ? renderMeterBar(0, barW, 'low')
            : renderMeterBar(congFill, barW, congStatus)
      }  ${congText}`;
      const admitLine = `${hudLabel('admission')}  ${renderAdmitBand(state, barW)}  ${admitText}`;
      const pooled = renderPoolBar(poolSize, executing, buffered, inFlightLimit, admitStatus);
      const poolLine = `${hudLabel('task pool')}  ${pooled.bar}  ${poolText}`;
      return `${statsLine}\n${congLine}\n${admitLine}\n${poolLine}`;
   }

   async function vitalsSampler(intervalMs = VITALS_SAMPLE_INTERVAL_MS) {
      /*
       *  Vitals are sampled on a background loop (decoupled from task scheduling);
       *  EWMA is updated here; admissionControl reads the smoothed series.
       *  Sleeps first so the caller's initial sample is not immediately repeated.
       */
      while (vitalsSampling) {
         await sleep(intervalMs);
         if (!vitalsSampling) break;
         try {
            // adminCommand → primary; no connection readPreference involved.
            vitals = await congestionMonitor();
            updateEwma(vitals);
         } catch(e) {
            emit('\x1b[31m[WARN]\x1b[0m \x1b[33mvitals sample failed\x1b[0m:', e);
         }
      }
   }

   function paceWarmupDelay() {
      return Math.floor(PACE_WARMUP_DELAY_MIN_MS + Math.random() * (PACE_WARMUP_DELAY_MAX_MS - PACE_WARMUP_DELAY_MIN_MS));
   }

   function paceMakerReset() {
      paceEwmaRate = null;
      pacePeakRate = null;
      paceLastSampleAt = 0;
      pacePendingDocs = 0;
      paceDropStrikes = 0;
      paceInWall = false;
      const now = Date.now();
      paceAimdLastIncreaseAt = now;
      paceLastMdAt = 0;
      paceAiGraceUntil = 0;
      paceRateBeforeAi = null;
      paceClimbExhausted = false;
   }

   function paceMakerAimd(now = Date.now(), { fromSample = false } = {}) {
      /*
       *  Probe +1 on a timer while healthy; MD after sustained clear-rate drop.
       *  After each +1, require ≥ PACE_AI_MIN_IMPROVE goodput gain once grace
       *  ends — otherwise hold (no step-back cliff; that made stalls longer).
       *  Drop strikes advance only on rate samples (not every admit tick).
       */
      if (paceEwmaRate == null || pacePeakRate == null || !(pacePeakRate > 0)) return;
      const ratio = paceEwmaRate / pacePeakRate;
      const inAiGrace = now < paceAiGraceUntil;
      const dropping = ratio < PACE_DROP_FRAC && !inAiGrace;

      // Evaluate last concurrency probe after settle window.
      if (fromSample && !inAiGrace && paceRateBeforeAi != null) {
         const baseline = paceRateBeforeAi;
         paceRateBeforeAi = null;
         const improved = paceEwmaRate >= baseline * (1 + PACE_AI_MIN_IMPROVE);
         if (!improved) {
            // Keep current mif; just stop climbing. Stepping back caused concurrency cliffs.
            paceClimbExhausted = true;
            paceAimdLastIncreaseAt = now;
            return;
         }
      }

      if (dropping) {
         if (fromSample) {
            paceDropStrikes += 1;
            if (paceDropStrikes >= PACE_MD_STRIKES && !paceInWall) {
               maxInFlight = Math.max(1, Math.floor(maxInFlight / 2));
               pacePeakRate = paceEwmaRate;
               paceInWall = true;
               paceLastMdAt = now;
               paceAimdLastIncreaseAt = now;
               paceDropStrikes = 0;
               paceRateBeforeAi = null;
               paceClimbExhausted = false; // allow re-climb after congestion clears
            }
         }
         return; // hold AI while below drop threshold (outside grace)
      }
      paceDropStrikes = 0;
      paceInWall = false;
      if (inAiGrace || paceClimbExhausted) return;
      const cooledDown = paceLastMdAt === 0 || (now - paceLastMdAt) >= PACE_MD_COOLDOWN_MS;
      if (cooledDown
            && (now - paceAimdLastIncreaseAt) >= PACE_AIMD_INCREASE_INTERVAL_MS
            && maxInFlight < maxInFlightCap) {
         paceRateBeforeAi = paceEwmaRate;
         maxInFlight += 1;
         paceAimdLastIncreaseAt = now;
         paceAiGraceUntil = now + PACE_AI_GRACE_MS;
         paceDropStrikes = 0;
      }
   }

   function paceMakerNoteBatchOk({ deletedCount = 0, at = Date.now() } = {}) {
      /*
       *  Wall-clock goodput: accumulate actual deletedCount until ≥ MIN_SAMPLE_MS
       *  of real time elapses, then sample docs/sec. Consumer drain clustering no
       *  longer inflates instant rate (that was false-WALL → MD thrash to mif=1).
       */
      if (admissionMode !== 'pace') return;
      const docs = Math.max(0, deletedCount|0);
      pacePendingDocs += docs;
      const prevAt = paceLastSampleAt;
      if (prevAt <= 0) {
         // Arm clock only — do not credit docs against a zero-width window.
         paceLastSampleAt = at;
         pacePendingDocs = docs; // keep this batch for the first real window
         return;
      }
      const elapsedMs = at - prevAt;
      if (elapsedMs < PACE_MIN_SAMPLE_MS) return; // keep prevAt + pending docs
      const pending = pacePendingDocs;
      pacePendingDocs = 0;
      paceLastSampleAt = at;
      const elapsedSec = elapsedMs / 1000;
      let instant = pending / elapsedSec;
      if (!(instant > 0) || !Number.isFinite(instant)) {
         paceMakerAimd(at, { "fromSample": true });
         return;
      }
      const capRef = Math.max(paceEwmaRate ?? 0, pacePeakRate ?? 0);
      if (capRef > 0) {
         instant = Math.min(instant, capRef * PACE_INSTANT_CAP_MULT);
      }
      paceEwmaRate = ewmaStep(paceEwmaRate, instant, PACE_EWMA_ALPHA);
      if (pacePeakRate == null) {
         pacePeakRate = paceEwmaRate;
      } else {
         pacePeakRate = Math.max(paceEwmaRate, pacePeakRate * PACE_PEAK_DECAY);
      }
      paceMakerAimd(at, { "fromSample": true });
   }

   function paceMakerControl() {
      /*
       *  pace / no-WT admit gate: shortfall-scaled delay + light jitter.
       *  Zero delay → burst/choke; fully deterministic delay → synchronized
       *  longer M0 stalls. ±PACE_DELAY_JITTER desyncs admits. maxInFlight
       *  owned by paceMakerAimd.
       */
      admissionState = 'PACE';
      const now = Date.now();
      paceMakerAimd(now);

      let delayMs;
      if (paceEwmaRate == null || pacePeakRate == null || !(pacePeakRate > 0)) {
         delayMs = paceWarmupDelay(); // warm-up
      } else {
         const shortfall = Math.max(0, 1 - (paceEwmaRate / pacePeakRate));
         delayMs = PACE_DELAY_MIN_MS
            + shortfall * (PACE_DELAY_MAX_MS - PACE_DELAY_MIN_MS);
         const j = PACE_DELAY_JITTER;
         delayMs = Math.floor(delayMs * ((1 - j) + Math.random() * (2 * j)));
      }

      return {
         "state": admissionState,
         "proceed": true,
         "delayMs": delayMs,
         "maxInFlight": maxInFlight,
         "paceRate": paceEwmaRate,
         "pacePeak": pacePeakRate,
         "paceWall": paceInWall,
         "replLag": 0,
         "flowControl": false,
         "indexBuilds": false,
         "backupCursor": false
      };
   }

   function admissionControl() {
      /*
       *  Admission FSM with hysteresis (see https://jira.mongodb.org/browse/SPM-1123):
       *    OPEN     — admit; light progressive delay in the *lower* soft band only
       *    THROTTLE — upper soft band (fill ≥ ENTER); progressive delay; leave below LEAVE
       *    CLOSED   — wait; trip at *Trigger, release only at/under *Target
       *    COOLDOWN — after CLOSED, brief paced resume to avoid thundering herd
       *    PACE     — no WT vitals: paceMaker (EWMA clear-rate AIMD + light delay)
       *  Soft-band fill: 0 at *Target → 1 at *Trigger (dirty/updates). Steady ~8–14%
       *  with tgt 5 / trig 20 stays OPEN (below midpoint) instead of sticky THROTTLE.
       *  Repl lag: >=15s soft → THROTTLE; >=30s hard → CLOSED.
       *  Booleans: flowControl + backupCursor → CLOSED; activeIndexBuilds → THROTTLE.
       */

      if (admissionMode === 'pace') {
         return paceMakerControl();
      }

      const {
         evictionTarget = 80,
         evictionTrigger = 95,
         evictionDirtyTarget = 5,
         evictionDirtyTrigger = 20,
         evictionUpdatesTarget = 2.5,
         evictionUpdatesTrigger = 10,
         activeReplLag = 0
      } = vitals;

      // Prefer EWMA; fall back to raw vitals until the first successful updateEwma().
      const cacheUtil = ewma.cacheUtil ?? vitals.cacheUtil;
      const dirtyUtil = ewma.dirtyUtil ?? vitals.dirtyUtil;
      const dirtyUpdatesUtil = ewma.dirtyUpdatesUtil ?? vitals.dirtyUpdatesUtil;
      const wtWriteTicketsUtil = ewma.wtWriteTicketsUtil ?? vitals.wtWriteTicketsUtil;
      const softLag = activeReplLag >= REPL_LAG_SOFT_SEC;
      const hardLag = activeReplLag >= REPL_LAG_HARD_SEC;

      // Boolean vitals getters may throw if serverStatus sections are missing.
      let activeFlowControl = false, activeIndexBuilds = false, backupCursorOpen = false;
      try { activeFlowControl = !!vitals.activeFlowControl; } catch(_) { /* ignore */ }
      try { activeIndexBuilds = !!vitals.activeIndexBuilds; } catch(_) { /* ignore */ }
      try { backupCursorOpen = !!vitals.backupCursorOpen; } catch(_) { /* ignore */ }

      const dirtySoftFill = fillProgress(dirtyUtil, evictionDirtyTarget, evictionDirtyTrigger);
      const updatesSoftFill = fillProgress(dirtyUpdatesUtil, evictionUpdatesTarget, evictionUpdatesTrigger);
      const softFill = Math.max(dirtySoftFill, updatesSoftFill);

      const hardPressure = utilAbove(cacheUtil, evictionTrigger)
         || utilAbove(dirtyUtil, evictionDirtyTrigger)
         || utilAbove(dirtyUpdatesUtil, evictionUpdatesTrigger)
         || hardLag
         || activeFlowControl
         || backupCursorOpen;
      // Upper soft band (or lag / index builds) → yellow THROTTLE.
      const upperSoftPressure = softFill >= THROTTLE_ENTER_FRAC
         || softLag
         || activeIndexBuilds;
      // Leave THROTTLE once below leave frac (hysteresis) and lag/index clear.
      const leaveThrottleOk = softFill < THROTTLE_LEAVE_FRAC
         && !softLag
         && !activeIndexBuilds;
      // Lower soft band: stay OPEN but apply light progressive delay.
      const lowerSoftPace = softFill > 0 && softFill < THROTTLE_ENTER_FRAC;
      // CLOSED release still requires at/under *Target (full hysteresis to trigger).
      const releaseOk = utilAtOrBelow(cacheUtil, evictionTarget)
         && utilAtOrBelow(dirtyUtil, evictionDirtyTarget)
         && utilAtOrBelow(dirtyUpdatesUtil, evictionUpdatesTarget)
         && activeReplLag < REPL_LAG_HARD_SEC
         && !activeFlowControl
         && !backupCursorOpen;
      const blockAimdIncrease = softLag || activeIndexBuilds || softFill >= THROTTLE_ENTER_FRAC;

      const bandDelayOpts = {
         evictionDirtyTarget,
         evictionDirtyTrigger,
         evictionUpdatesTarget,
         evictionUpdatesTrigger
      };

      const now = Date.now();
      const prevState = admissionState;
      switch (admissionState) {
         case 'OPEN':
            if (hardPressure) admissionState = 'CLOSED';
            else if (upperSoftPressure) admissionState = 'THROTTLE';
            break;
         case 'THROTTLE':
            if (hardPressure) admissionState = 'CLOSED';
            else if (leaveThrottleOk) admissionState = 'OPEN';
            break;
         case 'CLOSED':
            // Hysteresis: do not reopen at the trigger line — wait until at/under targets.
            if (releaseOk) {
               admissionState = 'COOLDOWN';
               admissionCooldownUntil = now + ADMISSION_COOLDOWN_MS;
            }
            break;
         case 'COOLDOWN':
            if (hardPressure) {
               admissionState = 'CLOSED';
            } else if (now >= admissionCooldownUntil) {
               admissionState = upperSoftPressure ? 'THROTTLE' : 'OPEN';
            }
            break;
         default:
            admissionState = 'OPEN';
      }

      // AIMD on concurrency: MD once when entering CLOSED; AI only while sustained OPEN and soft signals calm.
      if (admissionState === 'CLOSED' && prevState !== 'CLOSED') {
         maxInFlight = Math.max(1, Math.floor(maxInFlight / 2));
         closedSince = now;
      } else if (admissionState !== 'CLOSED') {
         closedSince = 0;
      }
      if (admissionState === 'OPEN' && !blockAimdIncrease) {
         if (prevState !== 'OPEN') {
            aimdLastIncreaseAt = now; // grace period before first +1 after re-entering OPEN
         } else if ((now - aimdLastIncreaseAt) >= AIMD_INCREASE_INTERVAL_MS && maxInFlight < maxInFlightCap) {
            maxInFlight += 1;
            aimdLastIncreaseAt = now;
         }
      }

      const admissionSignals = {
         "replLag": activeReplLag,
         "flowControl": activeFlowControl,
         "indexBuilds": activeIndexBuilds,
         "backupCursor": backupCursorOpen
      };

      if (admissionState === 'CLOSED') {
         return { "state": admissionState, "proceed": false, "delayMs": 0, "maxInFlight": maxInFlight, ...admissionSignals };
      }

      if (admissionState === 'THROTTLE' || admissionState === 'COOLDOWN') {
         return {
            "state": admissionState,
            "proceed": true,
            "delayMs": progressiveThrottleDelay(dirtyUtil, dirtyUpdatesUtil, bandDelayOpts),
            "maxInFlight": maxInFlight,
            ...admissionSignals
         };
      }

      // OPEN: light soft-band pace and/or ticket+checkpoint pacing
      const wtWriteTicketsStatus = bandStatus(wtWriteTicketsUtil, 20, 75);
      const { checkpointStatus } = vitals;
      const ticketDelay = (wtWriteTicketsStatus == 'high' && checkpointStatus == 'high')
         ? Math.floor(100 + Math.random() * 100)
         : 0;
      const softDelay = lowerSoftPace
         ? progressiveThrottleDelay(dirtyUtil, dirtyUpdatesUtil, bandDelayOpts)
         : 0;
      return {
         "state": admissionState,
         "proceed": true,
         "delayMs": Math.max(ticketDelay, softDelay),
         "maxInFlight": maxInFlight,
         ...admissionSignals
      };
   }

   async function* prepend(first, rest) {
      yield first;
      yield* rest;
   }

   async function* asyncPool(tasks = [], method = () => {}, { poolSize = 1, onHud } = {}) {
      /*
       *  Prefetch up to 4 buckets (capped by poolSize) so getMore overlaps
       *  in-flight deletes. Do not wait for a full prefetch before the first
       *  slot: schedule as soon as one bucket is available, top up only while
       *  parked or waiting on a slot. Admission parks/paces before a slot is
       *  taken; executing only holds deleteMany/txn work. Effective concurrency
       *  is min(poolSize, admission.maxInFlight) via AIMD.
       *  onHud({ admission, poolSize, executing, buffered }) drives the live HUD.
       */
      // pace / paceMaker: hard cap PACE_MAX_IN_FLIGHT_CAP (not half pool — that
      // oversubscribed M0). Start at 1 and climb only while probes improve goodput.
      maxInFlightCap = (admissionMode === 'pace')
         ? Math.max(1, Math.min(PACE_MAX_IN_FLIGHT_CAP, Math.floor(poolSize / 2)))
         : poolSize;
      maxInFlight = (admissionMode === 'pace') ? 1 : maxInFlightCap;
      aimdLastIncreaseAt = Date.now();
      if (admissionMode === 'pace') paceMakerReset();
      const executing = new Set();
      const buf = [];
      const prefetch = Math.min(4, poolSize);
      let srcDone = false;
      const source = (typeof tasks[Symbol.asyncIterator] === 'function')
         ? tasks[Symbol.asyncIterator]()
         : (async function*() { for (const task of tasks) yield task; })();

      function emitHud(admission) {
         if (typeof onHud !== 'function') return;
         onHud({
            "admission": admission,
            "poolSize": poolSize,
            "executing": executing.size,
            "buffered": buf.length
         });
      }

      async function fill(target = prefetch) {
         while (buf.length < target && !srcDone) {
            const { 'value': value, 'done': done } = await source.next();
            if (done) {
               srcDone = true;
               break;
            }
            buf.push(value);
         }
      }

      async function consume() {
         const [taskPromise, outcome] = await Promise.race(executing);
         executing.delete(taskPromise);
         if (outcome.ok === false) throw outcome.error;
         return outcome.value;
      }

      function schedule(task) {
         /*
          *  Wrap method() in an async fn to ensure we get a promise.
          *  Then expose such promise, so it's possible to later reference
          *  and remove it from the executing pool. Both fulfillment and
          *  rejection settle to a tuple so consume() can always delete.
          */
         const taskPromise = (async() => method(task))().then(
            value => [taskPromise, { "ok": true, "value": value }],
            error => [taskPromise, { "ok": false, "error": error }]
         );
         executing.add(taskPromise);
      }

      await fill(1);

      while (buf.length || executing.size || !srcDone) {
         let admission = admissionControl(); // { state, proceed, delayMs, maxInFlight }
         while (!admission.proceed) {
            emitHud(admission);
            await fill();
            if (executing.size) {
               yield await consume();
               await fill();
            } else {
               await sleep(Math.floor(500 + Math.random() * 500));
            }
            admission = admissionControl();
         }
         if (admission.delayMs > 0) await sleep(admission.delayMs);

         const inFlightLimit = Math.max(1, Math.min(poolSize, admission.maxInFlight ?? poolSize));
         if (executing.size >= inFlightLimit) {
            yield await consume();
            await fill(1);
         }

         if (!buf.length) {
            await fill(1);
            if (!buf.length) {
               while (executing.size) yield await consume();
               break;
            }
         }

         if (executing.size >= inFlightLimit) continue;

         const task = buf.shift();
         emitHud(admission);
         schedule(task);
      }
      emitHud(admissionControl());
   }

   async function main() {
      // One-shot vitals for concurrency sizing + WT probe; sampler runs only in 'wt' mode.
      try {
         vitals = await congestionMonitor();
         if (admissionMode === 'wt' && !hasWiredTigerVitals(vitals)) {
            enablePaceAdmission(
               'no-wt',
               'WiredTiger cache vitals unavailable — using paceMaker admission (Atlas M0/Flex or restricted serverStatus); maxInFlight capped'
            );
         } else if (admissionMode === 'wt') {
            updateEwma(vitals);
         }
      } catch(e) {
         emit('\x1b[31m[WARN]\x1b[0m \x1b[33minitial congestionMonitor failed\x1b[0m:', e?.message ?? e);
         vitals = {};
         if (admissionMode === 'wt') {
            enablePaceAdmission(
               'no-wt',
               'congestionMonitor failed — using paceMaker admission; maxInFlight capped'
            );
         }
      }

      const numCores = vitals?.numCores;
      const concurrency = Math.max((numCores > 4) ? numCores : 4, 32); // admission control throttles; do not chase live write tickets
      const bucketSizeLimit = 100; // aligns with SPM-2227
      const readConcern = { "level": "local" }, writeConcern = { "w": "majority" }; // support monotonic writes
      /*
       *  Curation uses secondaryPreferred; deletes and residual count use
       *  primary (count: majority RC). On mongos, secondaryPreferred selects
       *  eligible shard secondaries via the router.
       */
      const curationReadPreference = {
         // "mode": "nearest", // offload the bucket generation to a less busy node
         "mode": "secondaryPreferred",
         "tags": [ // Atlas friendly defaults
            { "nodeType": "READ_ONLY", "diskState": "READY" },
            { "nodeType": "ANALYTICS", "diskState": "READY" },
            { "workloadType": "OPERATIONAL", "diskState": "READY" },
            { "diskState": "READY" },
            {}
         ]
      };
      const writeReadPreference = { "mode": "primary" };
      const readSessionOpts = {
         "causalConsistency": true,
         "readConcern": readConcern,
         "readPreference": curationReadPreference
      };
      const writeSessionOpts = {
         "causalConsistency": true,
         "readConcern": readConcern,
         "readPreference": writeReadPreference,
         "retryWrites": true,
         "writeConcern": writeConcern
      };
      const countSessionOpts = {
         "causalConsistency": true,
         "readConcern": { "level": "majority" },
         "readPreference": writeReadPreference
      };

      banner = `\n\x1b[33m${banner}\x1b[0m`;
      banner += `\n\nCurating '\x1b[32m_id\x1b[0m' deletion list from namespace:` +
                `\n\n\t\x1b[32m${dbName}.${collName}\x1b[0m` +
                `\n\nwith filter:` +
                `\n\n\t\x1b[32m${JSON.stringify(filter)}\x1b[0m` +
                `\n\n...please wait\n`;
      if (safeguard) {
         banner += '\n\x1b[31m[WARN]\x1b[0m \x1b[33mSafeguard is enabled, simulating deletes only (via transaction rollbacks)\n\x1b[0m';
      }

      // WT sampler only for mongod admission; mongos uses paceMaker (no cache vitals).
      const useVitalsSampler = admissionMode === 'wt';
      vitalsSampling = useVitalsSampler;
      const sampler = useVitalsSampler ? vitalsSampler() : Promise.resolve();
      const startedAt = Date.now();
      let batchesDone = 0;
      let docsDeleted = 0;
      let batchesFailed = 0;
      let hudSnap = {
         "admission": { "state": admissionState, "delayMs": 0, "maxInFlight": maxInFlight },
         "poolSize": concurrency,
         "executing": 0,
         "buffered": 0
      };

      function redrawHud({ force = false, final = false, full = false } = {}) {
         const now = Date.now();
         const minMs = interactive ? HUD_MIN_REDRAW_MS : HUD_LOG_REDRAW_MS;
         // TTY: force refreshes immediately. Log mode: throttle always except first/final.
         if (!final && lastHudAt !== 0) {
            if (interactive) {
               if (!force && (now - lastHudAt) < minMs) return;
            } else if ((now - lastHudAt) < minMs) {
               return;
            }
         }
         lastHudAt = now;
         const hud = renderHud({
            "startedAt": startedAt,
            "batchesDone": batchesDone,
            "batchesFailed": batchesFailed,
            "docsDeleted": docsDeleted,
            "bucketSizeLimit": bucketSizeLimit,
            "bars": interactive,
            ...hudSnap
         });
         if (interactive) {
            const pin = canPinHud() && !full;
            if (pin) {
               eraseHudRegion();
               paintHudRegion(hud);
            } else {
               console.clear();
               writeConsole(banner);
               if (canPinHud()) paintHudRegion(hud);
               else writeConsole(hud);
            }
         } else {
            // Append-only plain status (ANSI stripped via writeConsole); no bars / no clear.
            writeConsole(hud);
         }
      }
      redrawHudFn = redrawHud;

      // TTY resize → recompute bar widths and full-repaint from banner (only while HUD is live).
      const uninstallResize = installHudResizeWatch(() => {
         if (!hudActive) return;
         redrawHud({ "force": true, "full": true });
      });
      try {
         if (interactive) console.clear();
         writeConsole(banner);
         const deletionList = getIds(filter, bucketSizeLimit, readSessionOpts);
         const { 'value': initialBatch, 'done': initialEmptyBatch } = await deletionList.next();
         if (initialEmptyBatch === true) {
            emit('\tNo matching documents found to match the filter, double-check the namespace and filter');
         } else {
            emit(interactive
               ? `\x1b[34m[INFO]\x1b[0m HUD: congestion / admission / pool — no % complete or ETA`
               : `[INFO] status: elapsed / congestion / admission / pool (plain, no bars) — no % complete or ETA`);
            hudActive = true;
            redrawHud({ "force": true });
            for await (const [, deletedCount, batchOk] of asyncPool(
               prepend(initialBatch, deletionList),
               task => deleteManyTask(task, writeSessionOpts),
               {
                  "poolSize": concurrency,
                  onHud(snap) {
                     hudSnap = snap;
                     redrawHud();
                  }
               }
            )) {
               batchesDone += 1;
               docsDeleted += deletedCount ?? 0;
               if (batchOk === false) {
                  batchesFailed += 1;
               } else {
                  paceMakerNoteBatchOk({ "deletedCount": deletedCount ?? 0 });
               }
               if (interactive) redrawHud({ "force": true });
            }
            redrawHud({ "final": true });
            hudActive = false;
         }
         uninstallResize();
         emit(`\nValidating deletion results ...please wait\n`);
         emit('...you may CTRL+C here to exit gracefully if validation is not required\n');
         // countIds uses a primary-oriented session; no connection setReadPref.
         const finalCount = countIds(filter, countSessionOpts);
         reportResidualValidation({
            "residual": finalCount,
            "batchesDone": batchesDone,
            "docsDeleted": docsDeleted,
            "batchesFailed": batchesFailed,
            "bucketSizeLimit": bucketSizeLimit,
            "elapsedMs": Date.now() - startedAt
         });
         emit('\nDone!');
      } finally {
         hudActive = false;
         redrawHudFn = null;
         uninstallResize();
         vitalsSampling = false;
         await sampler;
      }
   }

   await main();
})();

// EOF
