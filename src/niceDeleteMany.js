(async() => {
   /*
    *  Name: "niceDeleteMany.js"
    *  Version: "0.11.0"
    *  Description: "nice concurrent/batch deleteMany() technique with admission control"
    *  Disclaimer: "https://raw.githubusercontent.com/tap1r/mongodb-scripts/master/DISCLAIMER.md"
    *  Authors: ["tap1r <luke.prochazka@gmail.com>"]
    *  Guide: "https://raw.githubusercontent.com/tap1r/mongodb-scripts/master/mongosh-scripting-guide.md"
    *  Howto: "https://raw.githubusercontent.com/tap1r/mongodb-scripts/master/Howto-streaming-sort.md"
    *
    *  Legacy archive line: v0.4.11 is the snapshot for this script. mongosh-only
    *  (async IIFE, optional chaining; incompatible with legacy mongo). Still
    *  the demarked version for the whole-tree freeze. Further feature work
    *  targets mongosh; see ROADMAP.md → Legacy mongo shell retirement.
    *
    *  Notes:
    *  - mongosh only. Do not top-level-await this IIFE.
    *  - --eval must use var (not let/const); probe typeof, do not declare
    *    dbName/collName/filter in this file.
    *  - Window mode: index-ordered $match+$sort + $setWindowFields (semi-blocking bucket estimates)
    *  - Scan mode: hinted {_id:1} find with readOnce, residual FETCH, in-process buckets (no $setWindowFields)
    *  - User hint is kept only when the hinted explain is IXSCAN without a blocking SORT; otherwise WARN and _id scan
    *  - Policy B: compound equality prefix → trailing index sort when the first filter field is not index-ordered
    *  - Unhinted window: if winningPlan is not IXSCAN-without-SORT, hint the first ranked rejectedPlan that is (planner order)
    *  - Good for matching up to 2,147,483,647,000 documents
    *  - Advanced concurrency model with AIMD and adaptive concurrency to prevent resource starvation
    *  - Atlas M0/Flex (no WT vitals) always walk _id via find(); leftover window SORT cannot spill
    *  - On mongos: WT admission from collection-owning shard primaries (worst-shard fold, owners refreshed each sample); paceMaker if any of those shards is unreachable at attach, or after consecutive mid-run misses
    *  - "pace" admission mode when WT cache vitals are unavailable (unreachable shards / Atlas M0/Flex)
    *  - Repl lag: lastCommittedOpTime (majority commit point) when rs.status is available; else lastWrite vs majorityWriteDate (M0/Flex)
    *  - Progress HUD shows congestion, admission, and pool utilization only — ETA is not cheap
    *  - HUD is pinned below the log; emit lines persist and are never clobbered by redraws
    *  - Colour tags ([red]/[yellow]/[/] …) expanded on TTY; tags+CSI stripped when piped
    *  - Forked from congestionMonitor.js v0.2.13 (do not load that file): 2s
    *    rs.status TTL, collection-owning shard fold, SERVER_STATUS_OPT_IN
    *
    *  TODOs:
    *  - Balancer-aware throttle from shardingStatistics.rangeDeleterTasks (THROTTLE band, same as index builds; not CLOSED; not tenantMigrations)
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

   const __script = { "name": "niceDeleteMany.js", "version": "0.11.0" };
   let banner = `#### Running script ${__script.name} v${__script.version} on shell v${version()}`;
   let vitals = {};
   let vitalsSampling = false;

   // TTL caches: serverStatus is hot-path; hostInfo is near-static; rsStatus is low/medium volatility.
   // serverStatus uses a Promise wrapper (adminCommand is sync in mongosh) for in-flight coalescing.
   const SERVER_STATUS_CACHE_TTL_MS = 100;
   const HOST_INFO_CACHE_TTL_MS = 60 * 1000;
   const RS_STATUS_CACHE_TTL_MS = 2 * 1000; // 2s matches the Atlas no-op heartbeat interval
   const SLOWMS_CACHE_TTL_MS = 60 * 1000;
   const GET_PARAMETER_CACHE_TTL_MS = 60 * 1000;
   const VITALS_SAMPLE_INTERVAL_MS = 100;
   const SHARD_VITALS_SAMPLE_INTERVAL_MS = 2000; // collection-owning shard primaries (1–5s band)
   const SHARD_CONNECT_TIMEOUT_MS = 5000;
   const SHARD_VITALS_MISS_STRIKES = 3; // consecutive mid-run misses before latching pace
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
   // mongos / no-WT: paceMaker replaces fixed jitter (see createAdmissionController).
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
   // Admission FSM + paceMaker state lives on admissionCtl (createAdmissionController).
   let startupLogDone = false; // after writeConsole(banner); attach WARN is banner-only until then
   let shardVitalsClients = []; // [{ id, mongo, admin }, ...] collection-owning shard primaries
   let shardVitalsEnabled = false;
   let shardVitalsMissStrikes = 0;
   let lastCuration = { "mode": "scan", "hint": {} }; // Policy A result for residual countIds
   // Live HUD; no % complete / ETA. Interactive: pinned bars; non-interactive: plain log lines.
   const HUD_BAR_WIDTH_MIN = 12;
   const HUD_BAR_WIDTH_MAX = 48;
   const HUD_POOL_DISPLAY_MIN = 16;
   const HUD_POOL_DISPLAY_MAX_CAP = 64;
   const HUD_MIN_REDRAW_MS = 100;       // TTY refresh throttle
   const HUD_LOG_REDRAW_MS = 1000;      // non-TTY append throttle (avoid log floods)

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

   // colour tags ([red]/[yellow]/[/] …) expanded on TTY; tags+CSI stripped when piped.
   // Inlined from mdblib.js / autoCompact.js — do not load() mdblib.
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
   // One scan per string. TTY expands [red]/[/] … to CSI; piped output strips tags+CSI.
   // Case-sensitive lookup first so [R] (bright red) is not eaten by [r].
   const ANSI_TAG_RE = /\[(\/|bg bright \w+|bright \w+|bg \w+|\w+)\]/gi;
   const ANSI_CSI_RE = /(?:\x1b\[(?:\d*[;]?[\d]*[;]?[\d]*)m)/gi;
   const ansiTagCode = {};
   ansiTags.forEach(({ tag, code }) => {
      ansiTagCode[tag] = code;
      const lower = tag.toLowerCase();
      if (ansiTagCode[lower] === undefined) ansiTagCode[lower] = code;
   });
   const ansiTagCodeOf = tag => {
      let code = ansiTagCode[tag];
      if (code === undefined) code = ansiTagCode[tag.toLowerCase()];
      return code;
   };
   const applyAnsiTags = text => String(text).replace(ANSI_TAG_RE, (all, tag) => {
      const code = ansiTagCodeOf(tag);
      return (code === undefined) ? all : `\x1b[${code}m`;
   });
   const stripAnsiMarkup = text => String(text).replace(ANSI_TAG_RE, (all, tag) => (
      ansiTagCodeOf(tag) === undefined ? all : ''
   )).replace(ANSI_CSI_RE, '');
   const stripAnsi = stripAnsiMarkup;

   function createHud({ interactive } = {}) {
      /*
       *  Pin/emit/resize lifecycle. Bar-drawing stays on renderHud / HUD_MARK.
       *  start({ render }) registers the text builder; emit lifts the pin and
       *  redraws. stop() drops the pin without erasing the last frame.
       */
      let hudActive = false;
      let hudPaintedRows = 0;
      let lastHudAt = 0;
      let lastTermCols = 0;
      let hudResizePending = false;
      let renderFn = null;
      let uninstallResize = () => {};

      function formatEmitArgs(args) {
         const paint = interactive ? applyAnsiTags : stripAnsiMarkup;
         return [...args].map(a => (typeof a === 'string' ? paint(a) : a));
      }

      function emitLineText(args) {
         // Persist tagged source so TTY resize can re-expand; writeConsole paints.
         return [...args].map(a => (typeof a === 'string' ? a : String(a))).join(' ');
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
         process.stdout.write(applyAnsiTags(body) + '\n');
         hudPaintedRows = visualRows(body);
      }

      function emit(...args) {
         persistBannerLine(emitLineText(args));
         if (interactive && hudActive) {
            if (canPinHud()) {
               eraseHudRegion();
               writeConsole(...args);
               redraw({ "force": true });
            } else {
               redraw({ "force": true, "full": true });
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

      function redraw({ force = false, final = false, full = false } = {}) {
         if (typeof renderFn !== 'function') return;
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
         const hudText = renderFn();
         if (interactive) {
            const pin = canPinHud() && !full;
            if (pin) {
               eraseHudRegion();
               paintHudRegion(hudText);
            } else {
               console.clear();
               writeConsole(banner);
               if (canPinHud()) paintHudRegion(hudText);
               else writeConsole(hudText);
            }
         } else {
            // Append-only plain status (ANSI stripped via writeConsole); no bars / no clear.
            writeConsole(hudText);
         }
      }

      function start({ render } = {}) {
         stop();
         renderFn = typeof render === 'function' ? render : null;
         hudActive = true;
         lastHudAt = 0;
         uninstallResize = installHudResizeWatch(() => {
            if (!hudActive) return;
            redraw({ "force": true, "full": true });
         });
      }

      function stop() {
         hudActive = false;
         renderFn = null;
         uninstallResize();
         uninstallResize = () => {};
      }

      return { emit, redraw, start, stop, writeConsole };
   }

   const hud = createHud({ interactive });
   function emit(...args) { hud.emit(...args); }

   // Same vocabulary as congestionMonitor EQ: literal glyphs + colour tags (JS \xNN is
   // Latin-1 only — multi-byte UTF-8 via \xe2\x96… would not render as ░/▓).
   const HUD_MARK = {
      "bg": '░',
      "low": '[G]▓[/]',       // bright green
      "medium": '[Y]▓[/]',    // bright yellow
      "high": '[R]▓[/]',      // bright red
      "run": {
         "low": '[G]■[/]',
         "medium": '[Y]■[/]',
         "high": '[R]■[/]'
      },
      "buf": '[cyan]□[/]',    // cyan prefetch
      "free": '░',            // available within maxInFlight
      "cap": '[K]·[/]'        // bright black / dim AIMD-reserved
   };
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
      "repl": true, // lastWrite / majorityWriteDate when rs.status is unavailable
      "storageEngine": true,
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

   function getParameterCompat(names, fallback = null) {
      /*
       *  Canonical name first, then legacy aliases (7.0 storageEngineConcurrent*
       *  vs wiredTigerConcurrent*). First defined value wins. Missing knobs on
       *  M0/Flex/old mongod stay fallback.
       */
      const list = Array.isArray(names) ? names : [names];
      for (const name of list) {
         const value = getParameter(name, undefined);
         if (value !== undefined) return value;
      }
      return fallback;
   }

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
         // console.debug(`[red][WARN][/] [yellow]insufficient rights to execute db.hostInfo()\n${e}[/]`);
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
         // console.debug(`[red][WARN][/] [yellow]insufficient rights to execute rs.status()\n${e}[/]`);
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
         // console.debug(`[red][WARN][/] [yellow]insufficient rights to execute getProfilingStatus()\n${e}[/]`);
      }
      _slowmsCache.value = slowms;
      _slowmsCache.at = now;
      return slowms;
   }

   function isMongos() {
      /*
       *  True when connected to a mongos router (sharded cluster).
       */
      return db.hello().msg === 'isdbgrid';
   }

   function enablePaceAdmission(reason, detail) {
      /*
       *  Attach-time WARN is appended once on the reconstructed banner
       *  (writeConsole(banner)). emit() here would print a second copy
       *  on non-TTY before that dump. After the banner is written
       *  (mid-run latch, or latch during curation) emit so the HUD
       *  lifts and TTY resize persist keeps the line.
       */
      admissionCtl.enablePace(reason, detail);
      if (startupLogDone) {
         emit(`\n[red][WARN][/] [yellow]${detail}[/]`);
      }
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

   function curationCannotSpill() {
      /*
       *  Atlas M0/Flex (and mongod with no WT in serverStatus) ignore
       *  allowDiskUse. A leftover $setWindowFields SORT fails at 32MiB.
       *  mongos pace is different: shards can spill, so window mode stays eligible.
       *  Set in main() before getIds (paceReason 'no-wt').
       */
      return admissionCtl.mode === 'pace' && admissionCtl.reason === 'no-wt';
   }

   function isCurationSortMemoryError(err) {
      const code = err?.code ?? err?.codeName;
      if (code === 292 || code === 'QueryExceededMemoryLimitNoDiskUseAllowed') return true;
      const msg = String(err?.message ?? err ?? '');
      return /Sort exceeded \d+ bytes/i.test(msg)
         || /did not opt in to external sorting/i.test(msg);
   }

   function windowBucketPipeline(filter, sortBy) {
      /*
       *  v3 window pipeline. $sort immediately after $match so an index can
       *  provide order. History: Howto-streaming-sort.md
       */
      return [
         { "$match": filter },
         { "$sort": sortBy },
         { "$setWindowFields": { // assign ordinal numbers in curation order
            "sortBy": sortBy,
            "output": { "ordinal": { "$documentNumber": {} } }
         } },
         { "$set": {
            "bucketId": { "$ceil": { "$divide": ["$ordinal", "$$bucketSizeLimit"] } },
            "cardinal": 1 // unit contribution per document within its bucket
         } },
         { "$setWindowFields": { // per-bucket running count + id list
            "partitionBy": "$bucketId",
            "sortBy": sortBy,
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
   }

   const onMongos = isMongos();

   function redactMessage(value) {
      return String(value ?? '').replace(/\/\/[^@/]+@/g, '//');
   }

   function timestampSec(ts) {
      if (ts == null) return null;
      if (typeof ts.t === 'number') return ts.t;
      if (ts.t != null && ts.i != null) return Number(ts.t);
      return null;
   }

   function majorityCommitLagSeconds(rsSt, ss) {
      /*
       *  Seconds the majority commit point / secondaries trail applied optime
       *  (same proxy as onlineDefrag.js replLag). Do not use optimeDate min/max
       *  (heartbeat alignment → false 0). Atlas M0/Flex: lastWriteDate vs
       *  majorityWriteDate from serverStatus.repl.lastWrite.
       */
      let lag = 0, n = 0;
      const applied = timestampSec(rsSt?.optimes?.appliedOpTime?.ts ?? rsSt?.optimes?.writtenOpTime?.ts);
      const committed = timestampSec(rsSt?.optimes?.lastCommittedOpTime?.ts);
      if (applied != null && committed != null) {
         n++;
         lag = Math.max(lag, applied - committed);
      }
      const members = rsSt?.members;
      if (Array.isArray(members) && members.length) {
         const now = rsSt.date ? +new Date(rsSt.date) : Date.now();
         const primary = members.find(m => m.health && m.stateStr === 'PRIMARY');
         const p = timestampSec(primary?.optime?.ts ?? primary?.optime)
            ?? (primary?.optimeDate != null ? +new Date(primary.optimeDate) / 1000 : null);
         if (p != null) {
            for (const m of members) {
               if (!m.health || m.stateStr !== 'SECONDARY') continue;
               if (m.lastHeartbeat && now - +new Date(m.lastHeartbeat) > 4000) continue;
               const s = timestampSec(m.optime?.ts ?? m.optime)
                  ?? (m.optimeDate != null ? +new Date(m.optimeDate) / 1000 : null);
               if (s == null) continue;
               n++;
               lag = Math.max(lag, p - s);
            }
         }
      }
      if (n) return Math.max(0, lag);
      const lastWrite = ss?.repl?.lastWrite;
      const last = lastWrite?.lastWriteDate;
      const maj = lastWrite?.majorityWriteDate;
      if (last == null || maj == null) return 0;
      return Math.max(0, (new Date(last) - new Date(maj)) / 1000);
   }

   function localNumCores() {
      try {
         return db.hostInfo()?.system?.numCores ?? 4;
      } catch(_) {
         return 4;
      }
   }

   // Mongos shard WT vitals: collection-owning shard primaries only.
   // Separate from mongod congestionMonitor().
   function collectionOwningShardIds() {
      /*
       *  Shard ids that currently own the target namespace. collStats.shards
       *  first (sharded + unsplittable), then config.chunks by uuid/ns, then
       *  the database primary for an unsharded collection.
       */
      const ids = new Set();
      try {
         const stats = db.getSiblingDB(dbName).runCommand({ "collStats": collName });
         if (stats?.shards && typeof stats.shards === 'object') {
            for (const id of Object.keys(stats.shards)) {
               if (id) ids.add(id);
            }
         }
         if (typeof stats?.primary === 'string' && stats.primary) ids.add(stats.primary);
      } catch(_) { /* missing ns / auth */ }

      if (ids.size) return [...ids];

      try {
         const config = db.getSiblingDB('config');
         const ns = `${dbName}.${collName}`;
         const collDoc = config.getCollection('collections').findOne({
            "$or": [{ "_id": ns }, { "ns": ns }]
         });
         if (collDoc && collDoc.dropped !== true) {
            const chunkFilter = collDoc.uuid ? { "uuid": collDoc.uuid } : { "ns": ns };
            const shards = config.getCollection('chunks').distinct('shard', chunkFilter);
            if (Array.isArray(shards)) {
               for (const id of shards) {
                  if (id) ids.add(id);
               }
            }
         }
      } catch(_) { /* config auth */ }

      if (ids.size) return [...ids];

      try {
         const dbDoc = db.getSiblingDB('config').getCollection('databases').findOne({ "_id": dbName });
         if (typeof dbDoc?.primary === 'string' && dbDoc.primary) ids.add(dbDoc.primary);
      } catch(_) { /* config auth */ }

      return [...ids];
   }

   function parentConnectionParts() {
      // Public Mongo.getURI(); mongosh _uri is private and can lag the session.
      const rawUri = db.getMongo().getURI();
      if (!rawUri || typeof rawUri !== 'string') throw new Error('missing parent URI');
      const isSrv = /^mongodb\+srv:/i.test(rawUri);
      const stripped = rawUri.replace(/^mongodb\+srv:/i, 'mongodb:');
      const url = new URL(stripped);
      const searchParams = new URLSearchParams(url.searchParams);
      searchParams.delete('srvMaxHosts');
      searchParams.delete('srvServiceName');
      // Seed list / SRV hostname (WHATWG url.host is the first host only).
      const authority = stripped.replace(/^mongodb:\/\//i, '').split(/[/?]/, 1)[0];
      const at = authority.lastIndexOf('@');
      const hosts = (at >= 0 ? authority.slice(at + 1) : authority) || url.host || '';
      return {
         "isSrv": isSrv,
         "username": url.username || '',
         "password": url.password || '',
         "pathname": url.pathname && url.pathname.length ? url.pathname : '/',
         "searchParams": searchParams,
         "hosts": hosts
      };
   }

   function shardPrimaryUri(shardHost) {
      /*
       *  Child mongodb:// URI to the shard replica-set primary (or standalone
       *  shard). Auth/TLS follow the parent session; SRV children force tls.
       */
      const parent = parentConnectionParts();
      const params = new URLSearchParams(parent.searchParams);
      params.delete('tags');
      params.delete('readPreferenceTags');
      params.delete('maxStalenessSeconds');
      params.delete('minPoolSize');
      params.delete('readPreference');
      params.set('maxPoolSize', '2');
      params.set('serverSelectionTimeoutMS', String(SHARD_CONNECT_TIMEOUT_MS));
      params.set('connectTimeoutMS', String(SHARD_CONNECT_TIMEOUT_MS));
      params.set('socketTimeoutMS', String(SHARD_CONNECT_TIMEOUT_MS));
      if (parent.isSrv && !params.has('tls') && !params.has('ssl')) {
         params.set('tls', 'true');
      }
      const host = String(shardHost || '');
      const slash = host.indexOf('/');
      let hosts;
      if (slash > 0) {
         params.set('replicaSet', host.slice(0, slash));
         params.set('directConnection', 'false');
         params.set('readPreference', 'primary');
         hosts = host.slice(slash + 1);
      } else {
         params.delete('replicaSet');
         params.set('directConnection', 'true');
         params.set('readPreference', 'primary');
         hosts = host;
      }
      if (!hosts) throw new Error('shard host is empty');
      params.sort();
      let auth = '';
      if (parent.username) {
         auth = parent.username;
         if (parent.password !== '' && parent.password != null) auth += `:${parent.password}`;
         auth += '@';
      }
      const path = parent.pathname || '/';
      const q = params.toString();
      return `mongodb://${auth}${hosts}${path}${q ? `?${q}` : ''}`;
   }

   function openShardPrimary(uri) {
      if (typeof Mongo === 'function') return new Mongo(uri);
      const handle = connect(uri);
      return (handle && typeof handle.getMongo === 'function') ? handle.getMongo() : handle;
   }

   function shardAdmin(mongo) {
      if (mongo && typeof mongo.getDB === 'function') return mongo.getDB('admin');
      if (mongo && typeof mongo.getSiblingDB === 'function') return mongo.getSiblingDB('admin');
      throw new Error('shard handle has no admin db');
   }

   function closeShardClient(c) {
      try {
         if (c?.mongo && typeof c.mongo.close === 'function') c.mongo.close();
      } catch(_) { /* already closed */ }
   }

   function closeShardVitalsClients() {
      for (const c of shardVitalsClients) closeShardClient(c);
      shardVitalsClients = [];
      shardVitalsEnabled = false;
      shardVitalsMissStrikes = 0;
   }

   async function openShardClient(id, host) {
      const mongo = openShardPrimary(shardPrimaryUri(host));
      try {
         return { "id": id, "mongo": mongo, "admin": shardAdmin(mongo) };
      } catch(e) {
         closeShardClient({ "mongo": mongo });
         throw e;
      }
   }

   function listShardMap() {
      try {
         const listed = db.adminCommand({ "listShards": 1 }).shards ?? [];
         return { "ok": true, "byId": new Map(listed.map(s => [s._id, s])) };
      } catch(e) {
         return {
            "ok": false,
            "detail": `mongos: listShards failed (${redactMessage(e?.message ?? e)}) — using paceMaker admission; maxInFlight capped`
         };
      }
   }

   async function reconcileOwningShardClients({ latchOnEmpty = false } = {}) {
      /*
       *  Refresh collection-owning shard primaries. Discovery failure mid-run
       *  leaves the current client set in place (sampler strikes then latch).
       *  New owners are opened before old ones are dropped so a connect miss
       *  does not shrink the last-good set.
       */
      const owning = collectionOwningShardIds();
      if (!owning.length) {
         if (latchOnEmpty || !shardVitalsClients.length) {
            return {
               "ok": false,
               "detail": 'mongos: no collection-owning shards found — using paceMaker admission; maxInFlight capped'
            };
         }
         return {
            "ok": false,
            "detail": 'mongos: collection-owning shard discovery returned empty — using paceMaker admission; maxInFlight capped'
         };
      }
      const mapped = listShardMap();
      if (!mapped.ok) return mapped;
      const missing = owning.filter(id => !mapped.byId.has(id) || !mapped.byId.get(id)?.host);
      if (missing.length) {
         return {
            "ok": false,
            "detail": `mongos: owning shard(s) ${missing.join(', ')} not in listShards — using paceMaker admission; maxInFlight capped`
         };
      }

      const have = new Map(shardVitalsClients.map(c => [c.id, c]));
      const desired = new Set(owning);
      const toAdd = owning.filter(id => !have.has(id));
      const toDrop = shardVitalsClients.filter(c => !desired.has(c.id));
      const opened = [];
      try {
         if (toAdd.length) {
            const settled = await Promise.allSettled(toAdd.map(id => Promise.resolve().then(() =>
               openShardClient(id, mapped.byId.get(id).host)
            )));
            for (let i = 0; i < settled.length; i++) {
               if (settled[i].status === 'fulfilled') {
                  opened.push(settled[i].value);
               } else {
                  throw new Error(`${toAdd[i]}: ${redactMessage(settled[i].reason?.message ?? settled[i].reason)}`);
               }
            }
         }
      } catch(e) {
         for (const c of opened) closeShardClient(c);
         return {
            "ok": false,
            "detail": `mongos: collection-owning shard primary unreachable (${redactMessage(e?.message ?? e)}) — using paceMaker admission; maxInFlight capped`
         };
      }

      const hadClients = shardVitalsClients.length > 0;
      for (const c of toDrop) closeShardClient(c);
      const addedById = new Map(opened.map(c => [c.id, c]));
      shardVitalsClients = owning.map(id => have.get(id) || addedById.get(id)).filter(Boolean);
      shardVitalsEnabled = shardVitalsClients.length > 0;
      if (hadClients && (toAdd.length || toDrop.length)) {
         emit(`[blue][INFO][/] WT owning shards now: [yellow]${owning.join(', ')}[/]`);
      }
      return { "ok": true, "added": toAdd, "removed": toDrop.map(c => c.id) };
   }

   function noteShardVitalsMiss(latchDetail) {
      /*
       *  Mid-run only. Attach-time unreachable still latches immediately.
       *  Consecutive misses (stepdown / brief network) keep last vitals;
       *  latch to paceMaker once SHARD_VITALS_MISS_STRIKES is reached.
       */
      shardVitalsMissStrikes += 1;
      if (shardVitalsMissStrikes < SHARD_VITALS_MISS_STRIKES) {
         emit(`[red][WARN][/] [yellow]mongos: collection-owning shard vitals miss ${shardVitalsMissStrikes}/${SHARD_VITALS_MISS_STRIKES} — retrying[/]`);
         return false;
      }
      enablePaceAdmission('mongos', latchDetail);
      closeShardVitalsClients();
      vitalsSampling = false;
      return true;
   }

   function evictionConfigFromWterc(wterc = '') {
      const cfg = String(wterc || '');
      const num = (re, d) => {
         const m = cfg.match(re);
         return m ? +m[1] : d;
      };
      return {
         "evictionThreadsMin": num(/eviction=\(.*threads_min=(\d+).*\)/, 4),
         "evictionThreadsMax": num(/eviction=\(.*threads_max=(\d+).*\)/, 4),
         "evictionCheckpointTarget": num(/eviction_checkpoint_target=(\d+)/, 1),
         "evictionDirtyTarget": num(/eviction_dirty_target=(\d+)/, 5),
         "evictionDirtyTrigger": num(/eviction_dirty_trigger=(\d+)/, 20),
         "evictionTarget": num(/eviction_target=(\d+)/, 80),
         "evictionTrigger": num(/eviction_trigger=(\d+)/, 95),
         "evictionUpdatesTarget": num(/eviction_updates_target=(\d+)/, 2.5),
         "evictionUpdatesTrigger": num(/eviction_updates_trigger=(\d+)/, 10),
         "checkpointIntervalMS": 1000 * num(/checkpoint=\(.*wait=(\d+).*\)/, 60)
      };
   }

   function vitalsFromServerStatus(ss = {}, rsSt = {}, wterc = '') {
      /*
       *  Plain WT snapshot used by mongod congestionMonitor and shard
       *  sampleShardPrimary. Admission and HUD read these fields only.
       */
      const cache = ss.wiredTiger?.cache;
      const cacheSizeBytes = +(cache?.['maximum bytes configured'] ?? NaN);
      const dirtyBytes = +(cache?.['tracked dirty bytes in the cache'] ?? NaN);
      const cachedBytes = +(cache?.['bytes currently in the cache'] ?? 0);
      const updatesDirtyBytes = +(cache?.['bytes allocated for updates'] ?? 0);
      const eviction = evictionConfigFromWterc(wterc);
      const writeTickets = ss.wiredTiger?.concurrentTransactions?.write
         ?? ss.queues?.execution?.write
         ?? {};
      const wtWriteTicketsUtil = (writeTickets.totalTickets > 0)
         ? Number.parseFloat(((writeTickets.out / writeTickets.totalTickets) * 100).toFixed(2))
         : 0;
      const checkpointMs = +(ss.wiredTiger?.transaction?.['transaction checkpoint most recent time (msecs)']
         ?? ss.wiredTiger?.checkpoint?.['most recent time (msecs)']
         ?? 0);
      const checkpointRuntimeRatio = Number.parseFloat(
         ((checkpointMs / eviction.checkpointIntervalMS) * 100).toFixed(2)
      );
      const checkpointStatus = checkpointRuntimeRatio < 50 ? 'low'
         : checkpointRuntimeRatio > 100 ? 'high'
         : 'medium';
      return {
         "cacheSizeBytes": cacheSizeBytes,
         "dirtyBytes": dirtyBytes,
         "cacheUtil": Number.parseFloat(((cachedBytes / cacheSizeBytes) * 100).toFixed(2)),
         "dirtyUtil": Number.parseFloat(((dirtyBytes / cacheSizeBytes) * 100).toFixed(2)),
         "dirtyUpdatesUtil": Number.parseFloat(((updatesDirtyBytes / cacheSizeBytes) * 100).toFixed(2)),
         "wtWriteTicketsUtil": wtWriteTicketsUtil,
         "activeReplLag": +majorityCommitLagSeconds(rsSt, ss).toFixed(0),
         "activeFlowControl": ss.flowControl?.isLagged === true && ss.flowControl?.enabled === true,
         "activeIndexBuilds": (ss.indexBuilds?.total ?? 0) > (ss.indexBuilds?.phases?.commit ?? 0)
            || (ss.activeIndexBuilds?.total ?? 0) > 0,
         "backupCursorOpen": !!ss.storageEngine?.backupCursorOpen,
         "activeCheckpoint": !!(ss.wiredTiger?.transaction?.['transaction checkpoint currently running']
            || ss.wiredTiger?.checkpoint?.['progress state']),
         "slowRecentCheckpoint": checkpointMs > 60000,
         "checkpointStatus": checkpointStatus,
         "checkpointRuntimeRatio": checkpointRuntimeRatio,
         ...eviction
      };
   }

   function sampleShardPrimary(admin) {
      const cmdOpts = { "readPreference": { "mode": "primary" } };
      const ss = admin.runCommand({
         "serverStatus": true,
         ...SERVER_STATUS_OPTIONS_DEFAULTS,
         ...SERVER_STATUS_OPT_IN
      }, cmdOpts);
      let wterc = '';
      try {
         wterc = admin.runCommand({
            "getParameter": 1,
            "wiredTigerEngineRuntimeConfig": 1
         }, cmdOpts).wiredTigerEngineRuntimeConfig || '';
      } catch(_) { /* restricted / missing */ }
      let rsSt = {};
      try {
         rsSt = admin.runCommand({ "replSetGetStatus": 1 }, cmdOpts);
      } catch(_) { /* standalone shard / auth */ }
      const snap = vitalsFromServerStatus(ss, rsSt, wterc);
      if (!hasWiredTigerVitals(snap)) {
         throw new Error('WiredTiger cache vitals unavailable');
      }
      return snap;
   }

   function foldWorstShardVitals(namedSamples = []) {
      /*
       *  Conservative fold: max of util/lag, OR of boolean pressure, min of
       *  eviction targets/triggers so any owning primary can trip the FSM.
       */
      const nums = key => namedSamples.map(s => +s[key]).filter(n => !Number.isNaN(n));
      const maxNum = (key, d = 0) => {
         const xs = nums(key);
         return xs.length ? Math.max(...xs) : d;
      };
      const minNum = (key, d) => {
         const xs = nums(key);
         return xs.length ? Math.min(...xs) : d;
      };
      const rank = { "low": 0, "medium": 1, "high": 2 };
      let checkpointStatus = 'low';
      for (const s of namedSamples) {
         if ((rank[s.checkpointStatus] ?? 0) > rank[checkpointStatus]) checkpointStatus = s.checkpointStatus;
      }
      let worst = namedSamples[0];
      let worstScore = -1;
      for (const s of namedSamples) {
         const score = Math.max(
            s.dirtyUtil || 0,
            s.dirtyUpdatesUtil || 0,
            s.cacheUtil || 0,
            ((s.activeReplLag || 0) / REPL_LAG_HARD_SEC) * 100
         );
         if (score > worstScore) {
            worstScore = score;
            worst = s;
         }
      }
      return {
         "cacheSizeBytes": maxNum('cacheSizeBytes'),
         "dirtyBytes": maxNum('dirtyBytes'),
         "cacheUtil": maxNum('cacheUtil'),
         "dirtyUtil": maxNum('dirtyUtil'),
         "dirtyUpdatesUtil": maxNum('dirtyUpdatesUtil'),
         "wtWriteTicketsUtil": maxNum('wtWriteTicketsUtil'),
         "activeReplLag": maxNum('activeReplLag'),
         "activeFlowControl": namedSamples.some(s => s.activeFlowControl),
         "activeIndexBuilds": namedSamples.some(s => s.activeIndexBuilds),
         "backupCursorOpen": namedSamples.some(s => s.backupCursorOpen),
         "activeCheckpoint": namedSamples.some(s => s.activeCheckpoint),
         "slowRecentCheckpoint": namedSamples.some(s => s.slowRecentCheckpoint),
         "checkpointStatus": checkpointStatus,
         "evictionDirtyTarget": minNum('evictionDirtyTarget', 5),
         "evictionDirtyTrigger": minNum('evictionDirtyTrigger', 20),
         "evictionTarget": minNum('evictionTarget', 80),
         "evictionTrigger": minNum('evictionTrigger', 95),
         "evictionUpdatesTarget": minNum('evictionUpdatesTarget', 2.5),
         "evictionUpdatesTrigger": minNum('evictionUpdatesTrigger', 10),
         "evictionCheckpointTarget": minNum('evictionCheckpointTarget', 1),
         "checkpointIntervalMS": minNum('checkpointIntervalMS', 60000),
         "worstShard": worst?.id,
         "owningShards": namedSamples.map(s => s.id)
      };
   }

   async function sampleOwningShardVitals({ reconcile = true } = {}) {
      if (reconcile) {
         const rec = await reconcileOwningShardClients();
         if (!rec.ok) return rec;
      }
      if (!shardVitalsClients.length) {
         return {
            "ok": false,
            "detail": 'mongos: no collection-owning shard primary clients — using paceMaker admission; maxInFlight capped'
         };
      }
      const settled = await Promise.allSettled(
         shardVitalsClients.map(c => Promise.resolve().then(() => ({
            "id": c.id,
            ...sampleShardPrimary(c.admin)
         })))
      );
      const ok = [];
      const failed = [];
      for (let i = 0; i < settled.length; i++) {
         const id = shardVitalsClients[i].id;
         if (settled[i].status === 'fulfilled') {
            ok.push(settled[i].value);
         } else {
            failed.push(`${id}: ${redactMessage(settled[i].reason?.message ?? settled[i].reason)}`);
         }
      }
      if (failed.length || ok.length !== shardVitalsClients.length) {
         return {
            "ok": false,
            "detail": `mongos: collection-owning shard primary unreachable (${
               failed.join('; ') || 'incomplete sample'
            }) — using paceMaker admission; maxInFlight capped`
         };
      }
      const folded = foldWorstShardVitals(ok);
      if (vitals?.numCores != null) folded.numCores = vitals.numCores;
      return { "ok": true, "vitals": folded };
   }

   async function attachCollectionShardVitals() {
      /*
       *  Direct connections to collection-owning shard primaries. Any miss
       *  (empty owner set, listShards gap, Atlas-unreachable, no WT) stays
       *  on paceMaker — no half-metric from mongos shardingStatistics.
       *  The sampler later re-runs reconcileOwningShardClients each tick.
       */
      const rec = await reconcileOwningShardClients({ "latchOnEmpty": true });
      if (!rec.ok) return rec;
      const sampled = await sampleOwningShardVitals({ "reconcile": false });
      if (!sampled.ok) {
         closeShardVitalsClients();
         return sampled;
      }
      if (!hasWiredTigerVitals(sampled.vitals)) {
         closeShardVitalsClients();
         return {
            "ok": false,
            "detail": 'mongos: collection-owning shard primaries reachable but WT cache vitals missing — using paceMaker admission; maxInFlight capped'
         };
      }
      return sampled;
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

   function isEqualityOperand(v) {
      if (v === undefined) return false;
      if (v === null) return true;
      const t = typeof v;
      if (t === 'string' || t === 'number' || t === 'boolean' || t === 'bigint') return true;
      if (t !== 'object') return false;
      if (Array.isArray(v)) return true;
      if (v instanceof Date || v instanceof RegExp) return v instanceof Date;
      const ctor = v.constructor?.name ?? '';
      if (/^(ObjectId|Long|Int32|Double|Decimal128|Binary|UUID|Timestamp|MinKey|MaxKey|Code)$/.test(ctor)) return true;
      const keys = Object.keys(v);
      if (keys.length === 0) return true;
      if (keys.some(k => k.startsWith('$'))) {
         if (keys.length === 1 && keys[0] === '$eq') return isEqualityOperand(v.$eq);
         if (keys.length === 1 && keys[0] === '$in' && Array.isArray(v.$in) && v.$in.length === 1) return true;
         return false;
      }
      return true; // subdocument equality
   }

   function equalityFieldsFromFilter(filter = {}, acc = []) {
      if (filter == null || typeof filter !== 'object' || Array.isArray(filter)) return acc;
      for (const [k, v] of Object.entries(filter)) {
         if (k === '$and' && Array.isArray(v)) {
            for (const clause of v) equalityFieldsFromFilter(clause, acc);
            continue;
         }
         if (k.startsWith('$')) continue;
         if (isEqualityOperand(v) && !acc.includes(k)) acc.push(k);
      }
      return acc;
   }

   async function listCurationIndexes(namespace) {
      /*
       *  btree indexes only. Skip _id (scan fallback), hidden, text/hashed/geo/wildcard.
       */
      try {
         let specs = namespace.getIndexes();
         if (specs && typeof specs.then === 'function') specs = await specs;
         if (!Array.isArray(specs)) return [];
         const out = [];
         for (const spec of specs) {
            if (!spec || spec.hidden) continue;
            const key = spec.key;
            if (key == null || typeof key !== 'object' || Array.isArray(key)) continue;
            const fields = Object.entries(key);
            if (!fields.length) continue;
            if (fields.length === 1 && fields[0][0] === '_id') continue;
            if (fields.some(([f, d]) =>
               f === '_fts' || f.includes('$')
               || d === 'hashed' || d === 'text' || d === '2dsphere' || d === '2d'
               || typeof d !== 'number'
            )) continue;
            out.push({ "name": spec.name, "key": key, "fields": fields });
         }
         return out;
      } catch(_) {
         return [];
      }
   }

   function policyBSortCandidates(filter, indexes, policyASort) {
      /*
       *  Compound equality → trailing sort (ESR). For each btree whose prefix
       *  keys are equality fields of the filter, probe:
       *    - prefix keys in index order (absorbed $sort)
       *    - the next key after that prefix (Howto Example D: createdAt)
       */
      const eqs = equalityFieldsFromFilter(filter);
      if (!eqs.length || !Array.isArray(indexes) || !indexes.length) return [];
      const eqSet = new Set(eqs);
      const skipA = JSON.stringify(policyASort ?? {});
      const seen = new Set();
      const candidates = [];
      const add = (sortBy, hint) => {
         if (sortBy == null || typeof sortBy !== 'object' || !Object.keys(sortBy).length) return;
         if (JSON.stringify(sortBy) === skipA && !hasUserHint(hint)) return;
         const sig = JSON.stringify(sortBy) + '\0' + JSON.stringify(hint ?? {});
         if (seen.has(sig)) return;
         seen.add(sig);
         candidates.push({ "sortBy": sortBy, "hint": hint ?? {} });
      };
      for (const idx of indexes) {
         const fields = idx.fields;
         let i = 0;
         while (i < fields.length && eqSet.has(fields[i][0])) i++;
         if (i === 0) continue;
         const prefixSort = {};
         for (let j = 0; j < i; j++) prefixSort[fields[j][0]] = fields[j][1];
         add(prefixSort, {});
         add(prefixSort, idx.key);
         if (i < fields.length) {
            const [tf, td] = fields[i];
            const trail = { [tf]: td };
            add(trail, {});
            add(trail, idx.key);
         }
      }
      return candidates;
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
            const upper = String(node.stage || node.nodeType || '').toUpperCase();
            if (upper === 'COLLSCAN' || upper === 'COLLECTIONSCAN') collScan = true;
            if (upper === 'SORT' || upper === 'SORT_KEY_GENERATOR') blockingSort = true;
            if (isIxscanStage(node)) ixscan = true;
         });
      }
      return { collScan, blockingSort, ixscan };
   }

   function planIsIndexOrdered(explainResult) {
      const { collScan, blockingSort, ixscan } = inspectCurationPlan(explainResult);
      return ixscan && !collScan && !blockingSort;
   }

   function isIxscanStage(node) {
      const upper = String(node?.stage || node?.nodeType || '').toUpperCase();
      return upper === 'IXSCAN' || upper === 'EXPRESS_IXSCAN' || upper === 'IDHACK'
         || upper === 'CLUSTERED_IXSCAN' || upper === 'COUNT_SCAN' || upper === 'INDEXSCAN';
   }

   function planTreeIsIndexOrdered(planRoot) {
      let collScan = false, blockingSort = false, ixscan = false;
      walkPlanNodes(planRoot, (node) => {
         const upper = String(node.stage || node.nodeType || '').toUpperCase();
         if (upper === 'COLLSCAN' || upper === 'COLLECTIONSCAN') collScan = true;
         if (upper === 'SORT' || upper === 'SORT_KEY_GENERATOR') blockingSort = true;
         if (isIxscanStage(node)) ixscan = true;
      });
      return ixscan && !collScan && !blockingSort;
   }

   function ixscanKeyPattern(planRoot) {
      let keyPattern = null;
      walkPlanNodes(planRoot, (node) => {
         if (keyPattern == null && isIxscanStage(node) && node.keyPattern != null) {
            keyPattern = node.keyPattern;
         }
      });
      return keyPattern;
   }

   function collectQueryPlanners(explainResult) {
      const out = [];
      const take = (obj) => {
         if (!obj || typeof obj !== 'object') return;
         if (obj.queryPlanner) out.push(obj.queryPlanner);
         if (Array.isArray(obj.stages)) {
            for (const st of obj.stages) {
               if (st?.$cursor?.queryPlanner) out.push(st.$cursor.queryPlanner);
            }
         }
         if (obj.shards && typeof obj.shards === 'object') {
            for (const sh of Object.values(obj.shards)) take(sh);
         }
      };
      take(explainResult);
      return out;
   }

   function firstViableWindowHint(explainResult, indexes) {
      /*
       *  Planner order: winningPlan, then rejectedPlans. Viable = IXSCAN without
       *  COLLSCAN/SORT whose keyPattern is a window-safe btree (listCurationIndexes).
       *  Winner already viable → no hint. Else first ranked viable keyPattern as hint.
       */
      const allowed = new Set((indexes || []).map(idx => JSON.stringify(idx.key)));
      const planners = collectQueryPlanners(explainResult);
      if (!planners.length || !allowed.size) return null;
      let allWinnersViable = true;
      const viableKeys = [];
      const seen = new Set();
      for (const qp of planners) {
         const winning = qp.winningPlan;
         if (!winning || !planTreeIsIndexOrdered(winning)) {
            allWinnersViable = false;
         } else {
            const kp = ixscanKeyPattern(winning);
            if (!kp || !allowed.has(JSON.stringify(kp))) allWinnersViable = false;
         }
         const ranked = [winning, ...(Array.isArray(qp.rejectedPlans) ? qp.rejectedPlans : [])].filter(Boolean);
         for (const plan of ranked) {
            if (!planTreeIsIndexOrdered(plan)) continue;
            const kp = ixscanKeyPattern(plan);
            if (!kp) continue;
            const sig = JSON.stringify(kp);
            if (!allowed.has(sig) || seen.has(sig)) continue;
            seen.add(sig);
            viableKeys.push(kp);
         }
      }
      if (allWinnersViable) return { "hint": {}, "fromWinner": true };
      if (viableKeys.length) return { "hint": viableKeys[0], "fromWinner": false };
      return null;
   }

   function hasNonEmptyDoc(d) {
      return d != null && typeof d === 'object' && !Array.isArray(d) && Object.keys(d).length > 0;
   }

   function hasUserHint(h) { return hasNonEmptyDoc(h); }

   function hasUserCollation(c) { return hasNonEmptyDoc(c); }

   function applyUserCollation(opts) {
      if (hasUserCollation(collation)) opts.collation = collation;
      return opts;
   }

   function applyHint(opts, h) {
      if (hasUserHint(h)) opts.hint = h;
      return opts;
   }

   // Per-command readPreference only — mongosh Mongo.setReadPref() reconnects the client
   // (resetConnectionOptions → close) and runCommand ignores connection RP (mongosh 2.0+).
   // adminCommand (serverStatus/getParameter) always targets the primary.
   function commandReadPreference(readPreference = { "mode": "primary" }) {
      /*
       *  Shape for runCommand / aggregate / find / explain options. Document
       *  form carries mode + tags (probed on Atlas); empty tags still fine.
       *  RunCommandCursor needs driverReadPreference() on this document —
       *  the Node cursor constructor only keeps an instanceof ReadPreference.
       */
      const mode = readPreference?.mode ?? 'primary';
      const tags = Array.isArray(readPreference?.tags) ? readPreference.tags : [];
      return { "mode": mode, "tags": tags };
   }

   function driverReadPreference(cmdRP) {
      /*
       *  mongosh Database._runCursorCommand builds a Node RunCommandCursor.
       *  That cursor stores options.readPreference only when the value is a
       *  driver ReadPreference instance. A {mode, tags} document is ignored
       *  and the cursor defaults to primary, so secondaryPreferred + Atlas
       *  tags never take effect. fromOptions() builds the instance from the
       *  same document commandReadPreference() returns.
       *  FindCursor/AggregationCursor keep using applyCursorReadPref /
       *  cursor.readPref(); RunCommandCursor has no readPref().
       */
      try {
         const ReadPreference = db.getMongo()._serviceProvider.mongoClient.db(dbName).readPreference.constructor;
         if (typeof ReadPreference.fromOptions === 'function') {
            return ReadPreference.fromOptions({ "readPreference": cmdRP }) ?? cmdRP;
         }
      } catch(_) { /* keep document form */ }
      return cmdRP;
   }

   function applyCursorReadPref(cursor, cmdRP) {
      // FindCursor / AggregationCursor (idScan explain, window aggregate).
      // RunCommandCursor has no readPref(); scan walk uses driverReadPreference.
      if (!cursor || typeof cursor.readPref !== 'function' || !cmdRP?.mode) return cursor;
      const next = cursor.readPref(cmdRP.mode, cmdRP.tags);
      return next ?? cursor;
   }

   async function unwrapShellCursor(cursor) {
      /*
       *  mongosh FindCursor / AggregationCursor / RunCommandCursor are
       *  thenable (await → toArray). _runCursorCommand is async, so the
       *  first value is a Promise (no .close) wrapping the cursor (has
       *  .close). Unwrap only a bare Promise. Do not use .sort — agg and
       *  run-command cursors lack it.
       */
      if (cursor && typeof cursor.then === 'function' && typeof cursor.close !== 'function') {
         return await cursor;
      }
      return cursor;
   }

   async function closeCursor(cursor) {
      // Exhausted and already-closed are fine; missing close (failed open) is a no-op.
      if (!cursor || typeof cursor.close !== 'function') return;
      try { await cursor.close(); } catch(_) { /* already closed */ }
   }

   function connectionHostsLabel() {
      /*
       *  Host label from the mongosh connection URI (credentials stripped).
       *  mongos hello often omits me/host — fall back here for landing INFO.
       */
      try {
         return parentConnectionParts().hosts || null;
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

   function explainCurationAggregate(namespace, pipeline, opts) {
      return namespace.explain('queryPlanner').aggregate(pipeline, opts);
   }

   async function idScan(namespace, filter, explainOpts, why) {
      const idSort = { "_id": 1 };
      const idHint = { "_id": 1 };
      let cursor;
      try {
         const findExplainOpts = {
            "sort": idSort,
            "hint": idHint
         };
         applyUserCollation(findExplainOpts);
         if (explainOpts.readPreference) findExplainOpts.readPreference = explainOpts.readPreference;
         cursor = namespace.find(filter, { "_id": 1 }, findExplainOpts);
         cursor = await unwrapShellCursor(cursor);
         if (typeof cursor.sort === 'function') cursor = cursor.sort(idSort) ?? cursor;
         if (typeof cursor.hint === 'function') cursor = cursor.hint(idHint) ?? cursor;
         if (explainOpts.readPreference) cursor = applyCursorReadPref(cursor, explainOpts.readPreference);
         const expl = await cursor.explain('queryPlanner');
         if (!planIsIndexOrdered(expl)) {
            emit('\n[red][WARN][/] [yellow]_id find() explain is not IXSCAN-without-SORT; scan will still force hinted {_id:1}[/]');
         }
      } catch(e) {
         emit('\n[red][WARN][/] [yellow]Curation _id find() explain failed[/]:', e?.message ?? e);
      } finally {
         await closeCursor(cursor);
      }
      emit(why ?? '\n[red][WARN][/] [yellow]Curation falling back to _id index order to avoid COLLSCAN/blocking SORT (filter selectivity may suffer)[/]');
      return { "sortBy": idSort, "hint": idHint, "mode": "scan" };
   }

   async function tryWindow(namespace, filter, explainOpts, candidateSort, candidateHint) {
      const opts = { ...explainOpts };
      applyHint(opts, candidateHint);
      const prefix = [{ "$match": filter }, { "$sort": candidateSort }];
      const fullOpts = { ...opts, "allowDiskUse": false, "let": { "bucketSizeLimit": 100 } };
      try {
         const prefixExpl = await explainCurationAggregate(namespace, prefix, opts);
         if (!planIsIndexOrdered(prefixExpl)) return null;
         const fullExpl = await explainCurationAggregate(namespace, windowBucketPipeline(filter, candidateSort), fullOpts);
         if (!planIsIndexOrdered(fullExpl)) return null;
         return { "sortBy": candidateSort, "hint": candidateHint, "mode": "window" };
      } catch(e) {
         emit('\n[red][WARN][/] [yellow]Curation window explain failed[/]:', e?.message ?? e);
         return null;
      }
   }

   async function tryWindowFromPlanner(namespace, filter, explainOpts, candidateSort, indexes) {
      /*
       *  Unhinted $match+$sort. If the winner is index-ordered, no hint.
       *  Else hint the first ranked rejectedPlan that stays IXSCAN-without-SORT
       *  on a window-safe btree. Confirm the full window pipeline.
       */
      const prefix = [{ "$match": filter }, { "$sort": candidateSort }];
      const fullLet = { "allowDiskUse": false, "let": { "bucketSizeLimit": 100 } };
      try {
         const prefixExpl = await explainCurationAggregate(namespace, prefix, explainOpts);
         if (planIsIndexOrdered(prefixExpl)) {
            const fullExpl = await explainCurationAggregate(namespace, windowBucketPipeline(filter, candidateSort), { ...explainOpts, ...fullLet });
            if (!planIsIndexOrdered(fullExpl)) return null;
            return { "sortBy": candidateSort, "hint": {}, "mode": "window" };
         }
         const pick = firstViableWindowHint(prefixExpl, indexes);
         if (!pick || pick.fromWinner || !hasUserHint(pick.hint)) return null;
         const hinted = await tryWindow(namespace, filter, explainOpts, candidateSort, pick.hint);
         if (!hinted) return null;
         emit(`\n[blue][INFO][/] Curation planner hint [yellow]${JSON.stringify(hinted.hint)}[/] for sortBy [yellow]${JSON.stringify(candidateSort)}[/]`);
         return hinted;
      } catch(e) {
         emit('\n[red][WARN][/] [yellow]Curation window explain failed[/]:', e?.message ?? e);
         return null;
      }
   }

   async function tryPolicyB(namespace, filter, explainOpts, sortBy, forcedHint, indexes) {
      const POLICY_B_MAX_PROBES = 8;
      const candidates = policyBSortCandidates(filter, indexes, sortBy);
      const seenSort = new Set();
      let probes = 0;
      for (const cand of candidates) {
         if (probes >= POLICY_B_MAX_PROBES) break;
         if (hasUserHint(forcedHint)) {
            probes++;
            const win = await tryWindow(namespace, filter, explainOpts, cand.sortBy, forcedHint);
            if (win) {
               emit(`\n[blue][INFO][/] Curation Policy B window sortBy [yellow]${JSON.stringify(win.sortBy)}[/]`);
               return win;
            }
            continue;
         }
         const sig = JSON.stringify(cand.sortBy);
         if (seenSort.has(sig)) continue;
         seenSort.add(sig);
         probes++;
         const win = await tryWindowFromPlanner(namespace, filter, explainOpts, cand.sortBy, indexes);
         if (win) {
            emit(`\n[blue][INFO][/] Curation Policy B window sortBy [yellow]${JSON.stringify(win.sortBy)}[/]`);
            return win;
         }
      }
      return null;
   }

   async function resolveCurationOrder(namespace, filter = {}, userHint = {}, readPreference = null) {
      /*
       *  Curation order (Policy A):
       *  - Derive sortBy from the filter ({} / non-field predicates → _id).
       *  - Explain $match+$sort (queryPlanner), with the candidate hint when one
       *    is in play. Then explain the full v3 window pipeline (both SWF stages).
       *    Index-ordered (IXSCAN, no COLLSCAN / blocking SORT) may use the
       *    $setWindowFields pipeline — except on hosts that cannot spill.
       *  - Atlas M0/Flex (paceReason 'no-wt') skip window even when those explains
       *    look index-ordered: leftover SWF SORT cannot spill (32MiB).
       *  - Otherwise mode 'scan': find() hinted {_id:1} walk, residual filter,
       *    bucket in-process. idScan explains that find() (same hint/sort/projection).
       *  - User hint is honored only when that hinted explain is index-ordered;
       *    otherwise WARN and take the _id scan.
       *  - Policy B: when the first filter field is not index-ordered, probe
       *    compound equality prefixes and trailing btree keys (ESR / Howto Example D).
       *  - Unhinted: if winningPlan is not IXSCAN-without-SORT, hint the first
       *    ranked rejectedPlan that is (queryPlanner order, window-safe btree).
       *    Empty viable set → _id find() scan. Catch-292 still covers live SORT.
       */
      const sortField = sortKeyFromFilter(filter);
      const sortBy = { [sortField]: 1 };
      const explainOpts = {};
      applyUserCollation(explainOpts);
      if (readPreference?.mode) explainOpts.readPreference = commandReadPreference(readPreference);

      if (curationCannotSpill()) {
         return await idScan(namespace, filter, explainOpts, '\n[red][WARN][/] [yellow]Curation forcing hinted _id find() walk — this host cannot spill a leftover $setWindowFields SORT (Atlas M0/Flex / no WT vitals)[/]');
      }

      const indexes = await listCurationIndexes(namespace);

      if (hasUserHint(userHint)) {
         const win = await tryWindow(namespace, filter, explainOpts, sortBy, userHint);
         if (win) return win;
         const b = await tryPolicyB(namespace, filter, explainOpts, sortBy, userHint, indexes);
         if (b) return b;
         emit('\n[red][WARN][/] [yellow]curation plan may use COLLSCAN/blocking SORT despite user hint[/]; sortBy:', JSON.stringify(sortBy));
         return await idScan(namespace, filter, explainOpts);
      }

      const trusted = await tryWindowFromPlanner(namespace, filter, explainOpts, sortBy, indexes);
      if (trusted) return trusted;
      const b = await tryPolicyB(namespace, filter, explainOpts, sortBy, {}, indexes);
      if (b) return b;
      return await idScan(namespace, filter, explainOpts);
   }

   async function* getIds(filter = {}, bucketSizeLimit = 100, sessionOpts = {}) {
      /*
       *  Curation via per-command readPreference (no Mongo.setReadPref):
       *  landing hello, Policy A explain, and bucketing aggregate share the same RP
       *  document so server selection can stay on one secondary / plan cache.
       *  Scan walk converts that document with driverReadPreference() for
       *  _runCursorCommand (Node RunCommandCursor ignores {mode, tags}).
       *  No DriverSession (mongosh explain on a session can expire before the cursor).
       */
      const readPreference = sessionOpts.readPreference ?? { "mode": "primary" };
      const cmdRP = commandReadPreference(readPreference);
      const { host, role, tags } = curationLandingNode(readPreference);
      const landingLine = `[blue][INFO][/] Curation query target: [yellow]${host} (${role})[/] tags: [yellow]${JSON.stringify(tags)}[/]`;
      emit(landingLine);
      if (
         role === 'PRIMARY' &&
         !onMongos &&
         readPreference.mode &&
         readPreference.mode !== 'primary'
      ) {
         emit('[red][WARN][/] [yellow]Curation expected a secondary but landed on PRIMARY — connect via replica-set/SRV seed list (not directConnection to primary), and ensure eligible secondaries exist[/]');
      }

      const namespace = db.getSiblingDB(dbName).getCollection(collName);
      const {
         "sortBy": curationSortBy,
         "hint": curationHint,
         "mode": curationMode
      } = await resolveCurationOrder(namespace, filter, hint, readPreference);
      lastCuration = { "mode": curationMode, "hint": curationHint };

      if (curationMode === 'scan') {
         yield* getIdsByIdIndexScan(namespace, filter, bucketSizeLimit, cmdRP);
         return;
      }

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
      applyUserCollation(aggOpts);
      applyHint(aggOpts, curationHint);
      const pipeline = windowBucketPipeline(filter, curationSortBy);
      // offload iterator to the shell's cursor (same RP as Policy A explain)
      try {
         let cursor = namespace.aggregate(pipeline, aggOpts);
         cursor = await unwrapShellCursor(cursor);
         try {
            yield* cursor;
         } finally {
            await closeCursor(cursor);
         }
      } catch(e) {
         if (!isCurationSortMemoryError(e)) throw e;
         emit('\n[red][WARN][/] [yellow]Window curation hit in-memory SORT limit; continuing with hinted _id find() walk[/]');
         lastCuration = { "mode": "scan", "hint": { "_id": 1 } };
         yield* getIdsByIdIndexScan(namespace, filter, bucketSizeLimit, cmdRP);
      }
   }

   async function* getIdsByIdIndexScan(namespace, filter = {}, bucketSizeLimit = 100, cmdRP = { "mode": "primary" }) {
      /*
       *  Hinted {_id:1} find walk. Residual filter is a FETCH (object scan);
       *  no blocking SORT / $setWindowFields. Bucket in-process to the same
       *  shape as the window pipeline ({ bucketId, ids, bucketSize, ... }).
       *
       *  readOnce is a find-command flag (WiredTiger one-shot pages; IDL
       *  unstable/deprecated). It is a find field, not a $match option.
       *  mongosh collection.find() forwards known FindOptions only, so
       *  readOnce never reaches the server on the helper. Public
       *  db.runCursorCommand is a Help object (not callable).
       *  Database._runCursorCommand sends the find command as-is; the
       *  driver RunCommandCursor pins getMore to the selected member
       *  (required for secondaryPreferred). A later runCommand({getMore})
       *  with the same RP document can select a different member
       *  (CursorNotFound). Pass driverReadPreference(cmdRP). No
       *  DriverSession on this cursor (implicit cursor session only).
       */
      emit('[blue][INFO][/] Curation using hinted [yellow]_id[/] index walk (find); filter applied as residual');
      // Same per-command RP as aggregate (secondaryPreferred + Atlas tags).
      // find.batchSize = firstBatch; getMore.batchSize is driver setBatchSize.
      // Shell RunCommandCursor.batchSize() throws. Agg path uses cursor
      // batchSize 1 because each agg doc is already one yielded bucket.
      const database = namespace.getDB();
      const findCmd = {
         "find": namespace.getName(),
         "filter": filter,
         "projection": { "_id": 1 },
         "sort": { "_id": 1 },
         "hint": { "_id": 1 },
         "batchSize": bucketSizeLimit,
         "maxTimeMS": 0,
         "readOnce": true,
         "comment": "Bucketing IDs via niceDeleteMany.js (_id index scan)"
      };
      // Atlas M0/Flex reject noTimeout cursors; session idle already bounds the walk.
      if (!curationCannotSpill()) findCmd.noCursorTimeout = true;
      applyUserCollation(findCmd);
      let cursor = database._runCursorCommand(findCmd, {
         "readPreference": driverReadPreference(cmdRP)
      });
      cursor = await unwrapShellCursor(cursor);
      // RunCommandCursor.getMore reads getMoreOptions.batchSize (setBatchSize).
      // AbstractCursor.batchSize() / shell .batchSize() throw on this cursor.
      if (typeof cursor?._cursor?.setBatchSize === 'function') {
         cursor._cursor.setBatchSize(bucketSizeLimit);
      }
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
         await closeCursor(cursor);
      }
   }

   function countIds(filter = {}, sessionOpts = {}) {
      /*
       *  Residual validation on primary with majority RC (matches wc:majority deletes).
       *  allowDiskUse false: $count is O(1) memory; spill is a failed plan (Policy A).
       *  Hint only when window mode honored a user hint. Scan drops a rejected hint
       *  so the planner can pick a filter index for $match.
       *  aggregate IDL has no readOnce field (runCommand → 40415 IDLUnknownField);
       *  collection.aggregate() strips it as a silent no-op. Residual $match+$count
       *  is small; the one-shot WT walk is getIdsByIdIndexScan.
       */
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
               "allowDiskUse": false,
               "readConcern": sessionOpts?.readConcern?.level ?? "majority",
               "comment": "Validating IDs via niceDeleteMany.js"
            };
         if (lastCuration.mode === 'window') applyHint(aggOpts, lastCuration.hint);
         applyUserCollation(aggOpts);
         return namespace.aggregate(pipeline, aggOpts).toArray()[0]?.IDsTotal ?? 0;
      } finally {
         session.endSession();
      }
   }

   async function deleteManyTask({ ids = [], bucketId } = {}, sessionOpts = {}) {
      const session = db.getMongo().startSession(sessionOpts);
      try {
         const namespace = session.getDatabase(dbName).getCollection(collName);
         const txnOpts = {
            "comment": `Simulating deleteMany(${JSON.stringify(filter)}) workload via niceDeleteMany.js`
         };
         const deleteManyFilter = { "_id": { "$in": ids } };
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
               emit('[red][WARN][/] [yellow]transaction error (batch', bucketId, ')[/]:', e?.message ?? e);
            } finally {
               if (txnStarted) {
                  try {
                     session.abortTransaction();
                  } catch(e) {
                     batchOk = false;
                     emit('[red][WARN][/] [yellow]abort transaction error (batch', bucketId, ')[/]:', e?.message ?? e);
                  }
               }
            }
         } else {
            try {
               deletedCount = await deleteMany();
            } catch(e) {
               batchOk = false;
               emit('[red][WARN][/] [yellow]deleteMany error (batch', bucketId, ')[/]:', e?.message ?? e);
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
         emit('\n[blue][INFO][/] Safeguard was enabled — deletes ran in transactions that were rolled back.');
         emit('\tResidual matching documents are [yellow]expected[/] (this run should not have removed data).');
         emit('\tTo actually remove matches, re-run with [yellow]safeguard = false[/].');
         return;
      }

      if (batchesFailed > 0) {
         emit('\n[red][WARN][/] [yellow]Some batches failed[/] — residual may include IDs that were not deleted.');
      }

      if (residual > 0) {
         emit('\n[red][WARN][/] [yellow]Residual documents still match the filter.[/]');
         emit('\tPossible causes: failed batches, concurrent inserts/updates that match the filter,');
         emit('\tor documents that appeared after the curation cursor passed.');
         emit('[blue][INFO][/] Recommendation: re-run this script with the [yellow]same filter[/]');
         emit('\tand [yellow]safeguard = false[/] to clear remaining matches (or investigate concurrent writers).');
      } else {
         emit('\n[blue][INFO][/] No residual documents match the filter.');
         if (batchesFailed > 0) {
            emit('\t(Reported delete counts may still be incomplete due to batch errors.)');
         }
      }
   }

   async function congestionMonitor() {
      /*
       *  Mongod WT snapshot: cached hostInfo / rs.status / wterc / opt-in
       *  serverStatus, projected through vitalsFromServerStatus. Shard
       *  primaries use sampleShardPrimary (same projection, separate loop).
       */
      const ss = await serverStatus(SERVER_STATUS_OPT_IN);
      const snap = vitalsFromServerStatus(
         ss,
         rsStatus(),
         getParameter('wiredTigerEngineRuntimeConfig', '') || ''
      );
      const hi = hostInfo();
      snap.numCores = hi?.system?.numCores ?? 4;
      return snap;
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
       *  wtAdmissionControl bands on these values instead of raw point samples.
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
      return status === 'high' ? '[R]'
         : status === 'medium' ? '[Y]'
         : '[G]';
   }

   // HUD text: metric names green, values yellow (bars keep their own colours).
   // Non-TTY log mode still builds these; emit()/writeConsole strip tags via stripAnsiMarkup.
   function hudLabel(text) {
      return `[G]${text}[/]`;
   }
   function hudValue(text) {
      return `[Y]${text}[/]`;
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
      const colouredLabel = hudStatusColour(status) + label + '[/]';
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
      const snap = admissionCtl.snapshot();
      const state = admission.state ?? snap.state;
      const delayMs = admission.delayMs ?? 0;
      const mif = admission.maxInFlight ?? snap.maxInFlight;
      const mifCap = snap.maxInFlightCap;
      const inFlightLimit = Math.max(1, Math.min(poolSize, mif));
      const admitStatus = admitStateStatus(state);
      const rate = estimatedDeleteRate({
         batchesDone, batchesFailed, bucketSizeLimit, elapsedMs
      });
      const paceBit = (snap.mode === 'pace' && snap.paceEwmaRate != null)
         ? `   ${hudLabel('pace')}  ${hudValue(fmtRate(snap.paceEwmaRate))}` +
            (snap.pacePeakRate != null
               ? ` (${hudLabel('peak')} ${hudValue(fmtRate(snap.pacePeakRate))})`
               : '') +
            (snap.paceInWall ? ` ${hudValue('WALL')}` : '')
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
      if (snap.mode === 'pace') {
         const why = snap.reason === 'mongos' ? 'pace mongos'
            : snap.reason === 'no-wt' ? 'no WT (M0/Flex?)'
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
         if (vitals.worstShard) flags.push(vitals.worstShard);
         const flagTxt = flags.length ? `  ${flags.join(' ')}` : '';
         if (peakUtil == null || Number.isNaN(+peakUtil)) {
            congDetail = '(no WT)';
         } else {
            congMetric = `${peakLabel} ${Number(peakUtil).toFixed(1)}%`;
            congDetail = `(tgt ${tgt} → trig ${trig})${flagTxt}`;
         }
      }

      const closedSec = (state === 'CLOSED' && snap.closedSince > 0)
         ? `  ${hudLabel('closed')} ${hudValue(`${Math.round((Date.now() - snap.closedSince) / 1000)}s`)}`
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
      const congText = snap.mode === 'pace' || congMetric === 'n/a'
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
         snap.mode === 'pace' || congMetric === 'n/a'
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
       *  EWMA is updated here; wtAdmissionControl reads the smoothed series.
       *  Sleeps first so the caller's initial sample is not immediately repeated.
       *  On mongos, sample collection-owning shard primaries (owners refreshed
       *  each tick); consecutive misses retry, then latch to paceMaker. Last
       *  good vitals stay in force between misses.
       */
      while (vitalsSampling) {
         const waitMs = shardVitalsEnabled ? SHARD_VITALS_SAMPLE_INTERVAL_MS : intervalMs;
         await sleep(waitMs);
         if (!vitalsSampling) break;
         try {
            if (shardVitalsEnabled) {
               const next = await sampleOwningShardVitals();
               if (!next.ok) {
                  if (noteShardVitalsMiss(next.detail)) break;
                  continue;
               }
               shardVitalsMissStrikes = 0;
               const cores = vitals?.numCores;
               vitals = next.vitals;
               if (cores != null) vitals.numCores = cores;
               updateEwma(vitals);
            } else {
               // adminCommand → primary; no connection readPreference involved.
               vitals = await congestionMonitor();
               updateEwma(vitals);
            }
         } catch(e) {
            if (shardVitalsEnabled) {
               if (noteShardVitalsMiss(
                  `mongos: collection-owning shard primary unreachable (${redactMessage(e?.message ?? e)}) — using paceMaker admission; maxInFlight capped`
               )) break;
            } else {
               emit('[red][WARN][/] [yellow]vitals sample failed[/]:', redactMessage(e?.message ?? e));
            }
         }
      }
   }

   function createAdmissionController() {
      /*
       *  Owns WT/pace FSM lets. asyncPool calls reset/decide; the delete
       *  consumer calls noteBatchOk. HUD/banner/attach use snapshot() and
       *  mode/reason/detail getters. Do not mutate these fields from the pool.
       */
      let admissionState = 'OPEN'; // OPEN | THROTTLE | CLOSED | COOLDOWN | PACE
      let admissionCooldownUntil = 0;
      let maxInFlightCap = 1;
      let maxInFlight = 1;
      let aimdLastIncreaseAt = 0;
      let closedSince = 0;
      // 'wt' = WiredTiger FSM (mongod, or worst collection-owning shard on mongos);
      // 'pace' = paceMaker when WT vitals unavailable.
      let admissionMode = 'wt';
      let paceReason = null; // 'mongos' | 'no-wt' | null
      let paceDetail = null;
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

         let lag = 0;
         try { lag = +(vitals.activeReplLag) || 0; } catch(_) { /* no vitals yet */ }
         const hardLag = lag >= REPL_LAG_HARD_SEC;
         const softLag = lag >= REPL_LAG_SOFT_SEC;

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
         if (softLag) delayMs = Math.max(delayMs, PACE_DELAY_MAX_MS);

         return {
            "state": admissionState,
            "proceed": !hardLag,
            "delayMs": hardLag ? 0 : delayMs,
            "maxInFlight": maxInFlight,
            "paceRate": paceEwmaRate,
            "pacePeak": pacePeakRate,
            "paceWall": paceInWall,
            "replLag": lag,
            "flowControl": false,
            "indexBuilds": false,
            "backupCursor": false
         };
      }

      function wtAdmissionControl() {
         /*
          *  WT admission FSM with hysteresis (see https://jira.mongodb.org/browse/SPM-1123):
          *    OPEN     — admit; light progressive delay in the *lower* soft band only
          *    THROTTLE — upper soft band (fill ≥ ENTER); progressive delay; leave below LEAVE
          *    CLOSED   — wait; trip at *Trigger, release only at/under *Target
          *    COOLDOWN — after CLOSED, brief paced resume to avoid thundering herd
          *  Soft-band fill: 0 at *Target → 1 at *Trigger (dirty/updates). Steady ~8–14%
          *  with tgt 5 / trig 20 stays OPEN (below midpoint) instead of sticky THROTTLE.
          *  Repl lag: >=15s soft → THROTTLE; >=30s hard → CLOSED.
          *  Booleans: flowControl + backupCursor → CLOSED; activeIndexBuilds → THROTTLE.
          */

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

      function admissionControl() {
         return admissionMode === 'pace' ? paceMakerControl() : wtAdmissionControl();
      }

      function reset(mode, poolSize) {
         /*
          *  pace: hard cap PACE_MAX_IN_FLIGHT_CAP (half-pool oversubscribed M0).
          *  Start at 1 and climb only while probes improve goodput.
          */
         if (mode === 'pace' || mode === 'wt') admissionMode = mode;
         const pace = admissionMode === 'pace';
         maxInFlightCap = pace
            ? Math.max(1, Math.min(PACE_MAX_IN_FLIGHT_CAP, Math.floor(poolSize / 2)))
            : poolSize;
         maxInFlight = pace ? 1 : maxInFlightCap;
         aimdLastIncreaseAt = Date.now();
         if (pace) {
            paceMakerReset();
            admissionState = 'PACE';
         }
      }

      function enablePace(reason, detail) {
         const switchingFromWt = admissionMode === 'wt';
         admissionMode = 'pace';
         paceReason = reason;
         paceDetail = detail;
         if (switchingFromWt) {
            maxInFlightCap = Math.max(1, Math.min(PACE_MAX_IN_FLIGHT_CAP, maxInFlightCap|0 || PACE_MAX_IN_FLIGHT_CAP));
            maxInFlight = 1;
            paceMakerReset();
            admissionState = 'PACE';
         }
      }

      function snapshot() {
         return {
            "mode": admissionMode,
            "reason": paceReason,
            "detail": paceDetail,
            "state": admissionState,
            "delayMs": 0,
            "maxInFlight": maxInFlight,
            "maxInFlightCap": maxInFlightCap,
            "closedSince": closedSince,
            "paceEwmaRate": paceEwmaRate,
            "pacePeakRate": pacePeakRate,
            "paceInWall": paceInWall
         };
      }

      return {
         reset,
         decide: admissionControl,
         noteBatchOk: paceMakerNoteBatchOk,
         snapshot,
         enablePace,
         get mode() { return admissionMode; },
         get reason() { return paceReason; },
         get detail() { return paceDetail; }
      };
   }

   const admissionCtl = createAdmissionController();

   async function* prepend(first, rest) {
      yield first;
      yield* rest;
   }

   async function* asyncPool(tasks = [], method = () => {}, { poolSize = 1, onHud, admission = admissionCtl } = {}) {
      /*
       *  Prefetch up to 4 buckets (capped by poolSize) so getMore overlaps
       *  in-flight deletes. Do not wait for a full prefetch before the first
       *  slot: schedule as soon as one bucket is available, top up only while
       *  parked or waiting on a slot. Admission parks/paces before a slot is
       *  taken; executing only holds deleteMany/txn work. Effective concurrency
       *  is min(poolSize, gate.maxInFlight) via AIMD. The pool only calls
       *  admission.reset and admission.decide; the consumer calls noteBatchOk.
       *  onHud({ admission, poolSize, executing, buffered }) drives the live HUD.
       */
      admission.reset(admission.mode, poolSize);
      const executing = new Set();
      const buf = [];
      const prefetch = Math.min(4, poolSize);
      let srcDone = false;
      const source = (typeof tasks[Symbol.asyncIterator] === 'function')
         ? tasks[Symbol.asyncIterator]()
         : (async function*() { for (const task of tasks) yield task; })();

      function emitHud(gate) {
         if (typeof onHud !== 'function') return;
         onHud({
            "admission": gate,
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
         let gate = admission.decide(); // { state, proceed, delayMs, maxInFlight }
         while (!gate.proceed) {
            emitHud(gate);
            await fill();
            if (executing.size) {
               yield await consume();
               await fill();
            } else {
               await sleep(Math.floor(500 + Math.random() * 500));
            }
            gate = admission.decide();
         }
         if (gate.delayMs > 0) await sleep(gate.delayMs);

         const inFlightLimit = Math.max(1, Math.min(poolSize, gate.maxInFlight ?? poolSize));
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
         emitHud(gate);
         schedule(task);
      }
      emitHud(admission.decide());
   }

   function sessionOpts(kind) {
      /*
       *  Curation uses secondaryPreferred; deletes and residual count use
       *  primary (count: majority RC). On mongos, secondaryPreferred selects
       *  eligible shard secondaries via the router.
       */
      const readConcern = { "level": "local" }, writeConcern = { "w": "majority" }; // support monotonic writes
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
      if (kind === 'read') {
         return {
            "causalConsistency": true,
            "readConcern": readConcern,
            "readPreference": curationReadPreference
         };
      }
      if (kind === 'write') {
         return {
            "causalConsistency": true,
            "readConcern": readConcern,
            "readPreference": writeReadPreference,
            "retryWrites": true,
            "writeConcern": writeConcern
         };
      }
      if (kind === 'count') {
         return {
            "causalConsistency": true,
            "readConcern": { "level": "majority" },
            "readPreference": writeReadPreference
         };
      }
      throw new Error(`unknown session kind: ${kind}`);
   }

   async function attachVitals() {
      // One-shot vitals for concurrency sizing + WT probe; sampler runs only in 'wt' mode.
      try {
         if (onMongos) {
            const attached = await attachCollectionShardVitals();
            if (attached.ok) {
               vitals = attached.vitals;
               vitals.numCores = localNumCores();
               updateEwma(vitals);
            } else {
               enablePaceAdmission('mongos', attached.detail);
               vitals = { "numCores": localNumCores() };
            }
         } else {
            vitals = await congestionMonitor();
            if (admissionCtl.mode === 'wt' && !hasWiredTigerVitals(vitals)) {
               enablePaceAdmission(
                  'no-wt',
                  'WiredTiger cache vitals unavailable — using paceMaker admission (Atlas M0/Flex or restricted serverStatus); maxInFlight capped'
               );
            } else if (admissionCtl.mode === 'wt') {
               updateEwma(vitals);
            }
         }
      } catch(e) {
         emit('[red][WARN][/] [yellow]initial congestionMonitor failed[/]:', redactMessage(e?.message ?? e));
         vitals = { "numCores": localNumCores() };
         if (admissionCtl.mode === 'wt') {
            enablePaceAdmission(
               onMongos ? 'mongos' : 'no-wt',
               onMongos
                  ? `mongos: collection-owning shard primary unreachable (${redactMessage(e?.message ?? e)}) — using paceMaker admission; maxInFlight capped`
                  : 'congestionMonitor failed — using paceMaker admission; maxInFlight capped'
            );
         }
      }
   }

   function buildStartupBanner(heading) {
      /*
       *  Attach-time HUD header. heading is the script title plus any
       *  persistBannerLine emits from attach. Pace WARN is one copy here;
       *  enablePaceAdmission emits only after startupLogDone.
       */
      let text = `\n[yellow]${heading}[/]`;
      text += `\n\nCurating '[green]_id[/]' deletion list from namespace:` +
              `\n\n\t[green]${dbName}.${collName}[/]` +
              `\n\nwith filter:` +
              `\n\n\t[green]${JSON.stringify(filter)}[/]` +
              `\n\n...please wait\n`;
      if (safeguard) {
         text += '\n[red][WARN][/] [yellow]Safeguard is enabled, simulating deletes only (via transaction rollbacks)\n[/]';
      }
      if (admissionCtl.mode === 'pace' && admissionCtl.detail) {
         text += `\n[red][WARN][/] [yellow]${admissionCtl.detail}[/]\n`;
      } else if (onMongos && Array.isArray(vitals.owningShards) && vitals.owningShards.length) {
         text += `\n[blue][INFO][/] WT admission from collection-owning shard primaries: [yellow]${vitals.owningShards.join(', ')}[/] (worst-shard fold)\n`;
      }
      return text;
   }

   async function main() {
      await attachVitals();
      const numCores = vitals?.numCores;
      const concurrency = Math.max((numCores > 4) ? numCores : 4, 32); // admission control throttles; do not chase live write tickets
      const bucketSizeLimit = 100; // aligns with SPM-2227
      const readSessionOpts = sessionOpts('read');
      const writeSessionOpts = sessionOpts('write');
      const countSessionOpts = sessionOpts('count');

      banner = buildStartupBanner(banner);

      // WT sampler for mongod and for mongos with attached shard primaries.
      const useVitalsSampler = admissionCtl.mode === 'wt';
      vitalsSampling = useVitalsSampler;
      const sampler = useVitalsSampler ? vitalsSampler() : Promise.resolve();
      const startedAt = Date.now();
      let batchesDone = 0;
      let docsDeleted = 0;
      let batchesFailed = 0;
      let hudSnap = {
         "admission": admissionCtl.snapshot(),
         "poolSize": concurrency,
         "executing": 0,
         "buffered": 0
      };

      try {
         if (interactive) console.clear();
         hud.writeConsole(banner);
         startupLogDone = true;
         const deletionList = getIds(filter, bucketSizeLimit, readSessionOpts);
         const { 'value': initialBatch, 'done': initialEmptyBatch } = await deletionList.next();
         if (initialEmptyBatch === true) {
            emit('\tNo matching documents found to match the filter, double-check the namespace and filter');
         } else {
            emit(interactive
               ? `[blue][INFO][/] HUD: congestion / admission / pool — no % complete or ETA`
               : `[INFO] status: elapsed / congestion / admission / pool (plain, no bars) — no % complete or ETA`);
            hud.start({
               render() {
                  return renderHud({
                     "startedAt": startedAt,
                     "batchesDone": batchesDone,
                     "batchesFailed": batchesFailed,
                     "docsDeleted": docsDeleted,
                     "bucketSizeLimit": bucketSizeLimit,
                     "bars": interactive,
                     ...hudSnap
                  });
               }
            });
            hud.redraw({ "force": true });
            for await (const [, deletedCount, batchOk] of asyncPool(
               prepend(initialBatch, deletionList),
               task => deleteManyTask(task, writeSessionOpts),
               {
                  "poolSize": concurrency,
                  "admission": admissionCtl,
                  onHud(snap) {
                     hudSnap = snap;
                     hud.redraw();
                  }
               }
            )) {
               batchesDone += 1;
               docsDeleted += deletedCount ?? 0;
               if (batchOk === false) {
                  batchesFailed += 1;
               } else {
                  admissionCtl.noteBatchOk({ "deletedCount": deletedCount ?? 0 });
               }
               if (interactive) hud.redraw({ "force": true });
            }
            hud.redraw({ "final": true });
            hud.stop();
         }
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
         hud.stop();
         vitalsSampling = false;
         await sampler;
         closeShardVitalsClients();
      }
   }

   await main();
})();

// EOF
