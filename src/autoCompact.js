(async() => {
   /*
    *  Name: "autoCompact.js"
    *  Version: "1.3.0"
    *  Description: "auto/background compaction (autoCompact command) with thread monitoring"
    *  Disclaimer: "https://raw.githubusercontent.com/tap1r/mongodb-scripts/master/DISCLAIMER.md"
    *  Authors: ["tap1r <luke.prochazka@gmail.com>"]
    *  Roadmap: "https://raw.githubusercontent.com/tap1r/mongodb-scripts/master/ROADMAP.md" (required context)
    *
    *  Dual-shell snapshot: legacy/mongo-shell (v0.4.36). This file is mongosh-only.
    *
    *  Notes:
    *  - automates the autoCompact command with monitoring (https://www.mongodb.com/docs/v8.0/reference/command/autoCompact/)
    *  - mongosh only; MongoDB 8.0+ WiredTiger mongod (not mongos); FCV 8.0+ (binary 8 with FCV 7 is rejected). Do not top-level-await this IIFE (rewriter SyntaxError)
    *  - Atlas M0/Flex fails fast; serverless platform string kept (deprecated). https://www.mongodb.com/docs/atlas/unsupported-commands/
    *  - per mongod only (not replicated); excludes local.oplog.rs
    *  - { autoCompact: true } (default) enables; { autoCompact: false } disables and exits (no log tail)
    *  - freeSpaceTargetMB passthrough (server default 20); runOnce defaults to true (opposite of the server)
    *  - ident map finishes before autoCompact. Naming a file needs the internal action (collectionless $listCatalog) or, on that namespace, listIndexes (targeted $listCatalog) or collStats (wiredTiger.uri, indexDetails.*.uri). With that, the line prints as ns or ns.index; without it, the line stays collection-*.wt / index-*.wt. Built-in roles have neither listIndexes nor collStats on local.replset.* or on system.views, system.rollback.id, system.keys, system.preimages, and system.indexBuilds. Idents created during the pass refresh in the background
    *  - First-pass TTY bar: distinct catalog namespaces seen in WTCMPCT logs, over the initial catalog namespace count. Ramlog loss marks the count fuzzy (~). The bar is not a latch. Piped runs stay on the log lines.
    *  - Options: autoCompact-options.jsonc (cwd, --file dir, $MDBLIB, ~/.mongodb) then var autoCompactOptions. Missing default is silent. Explicit var optionsFile. mdblib is loaded for resolveOptions; ANSI, AutoFactor, and serverStatus stay local.
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
    *  Example with an options file (autoCompact-options.jsonc). Missing default is silent.
    *
    *    mongosh "localhost:27017" --quiet --eval 'var optionsFile = "/path/to/autoCompact-options.jsonc"' -f autoCompact.js
    *
    *  We use 'var' to interoperate with mongosh's sloppy mode
    */

   const __script = { "name": "autoCompact.js", "version": "1.3.0" };

   if (typeof __lib === 'undefined') {
      /*
       *  Load helper library mdblib.js for resolveOptions.
       *  ANSI, AutoFactor, and serverStatus stay local to this IIFE.
       */
      let __lib = { "name": "mdblib.js", "paths": null, "path": null };
      __lib.paths = [process.env.MDBLIB, `${process.env.HOME}/.mongodb`, '.'];
      __lib.path = `${__lib.paths.find(path => fs.existsSync(`${path}/${__lib.name}`))}/${__lib.name}`;
      load(__lib.path);
   }

   // colour tags ([red]/[yellow]/[/] …) expanded on TTY; tags+CSI stripped when piped (local copy)
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
   // Plain object lookup (tag → CSI).
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
   const applyAnsiTags = text => text.replace(ANSI_TAG_RE, (all, tag) => {
      const code = ansiTagCodeOf(tag);
      return (code === undefined) ? all : `\x1b[${code}m`;
   });
   const stripAnsiMarkup = text => text.replace(ANSI_TAG_RE, (all, tag) => (
      ansiTagCodeOf(tag) === undefined ? all : ''
   )).replace(ANSI_CSI_RE, '');
   const createNamespaceHud = () => {
      /*
       *  Same contract as mdblib MiniHud: one TTY line via stdout.write('\\r').
       *  The painter stays local. Piped output leaves the bar off.
       */
      const enabled = typeof process !== 'undefined' && process.stdout && process.stdout.isTTY;
      let lastWidth = 0;
      const bar = (frac, width = 16) => {
         const n = Math.max(1, width);
         const p = Number.isFinite(frac) ? Math.min(1, Math.max(0, frac)) : 0;
         const filled = Math.round(p * n);
         return '█'.repeat(filled) + '░'.repeat(n - filled);
      };
      return {
         enabled,
         bar,
         clear() {
            if (!enabled || lastWidth === 0) return;
            process.stdout.write('\r\x1b[2K');
            lastWidth = 0;
         },
         render(line) {
            if (!enabled) return;
            const cols = (process.stdout.columns > 0) ? process.stdout.columns : 80;
            let msg = String(line || '').replace(/\s+/g, ' ').trim();
            let visual = stripAnsiMarkup(msg);
            const max = Math.max(1, cols - 1);
            if (visual.length > max) {
               visual = visual.slice(0, Math.max(1, cols - 2)) + '~';
               msg = visual;
            }
            process.stdout.write('\r' + applyAnsiTags(msg + '[/]') + '\x1b[K');
            lastWidth = visual.length;
         }
      };
   };
   function catalogNamespaceNames(map, catalogOk) {
      /*
       *  Distinct db.coll from the initial ident map. Internal seeds
       *  (sizeStorer, history store, catalog) are not catalog namespaces.
       *  null when $listCatalog itself failed.
       */
      if (!catalogOk || !map) return null;
      const names = new Set();
      for (const entry of map.values()) {
         if (!entry || entry.kind === 'internal') continue;
         if (typeof entry.ns !== 'string' || entry.ns.length === 0) continue;
         names.add(entry.ns);
      }
      return names;
   }
   function noteLoggedNamespace(projected, seen, entry) {
      /*
       *  One namespace counts once, when any of its files appears in a WTCMPCT
       *  line and that namespace was in the initial catalog. Unresolved
       *  filenames and internal files do not count.
       */
      if (!projected || !entry || entry.kind === 'internal') return false;
      if (typeof entry.ns !== 'string' || !projected.has(entry.ns)) return false;
      const before = seen.size;
      seen.add(entry.ns);
      return seen.size !== before;
   }
   const formatLogArgs = (args, isTTY) => {
      const paint = isTTY ? applyAnsiTags : stripAnsiMarkup;
      return [...args].map(arg => typeof arg === 'string' ? paint(arg) : arg);
   };
   (console['log'] = (function() {
      const method = () => console;
      const fn = 'log';
      const _fn = '_' + fn;
      if (method()[fn].name !== 'modifiedLog') method()[_fn] = method()[fn];
      function modifiedLog() {
         return method()[_fn].apply(null, formatLogArgs(arguments, process.stdout.isTTY));
      }
      return modifiedLog;
   })());

   function isAutoCompactCliFile() {
      /*
       *  mongosh --file/-f (or positional *.js) targeting this script.
       *  load() from a REPL or another --file is quiet.
       */
      const argv = (typeof process !== 'undefined' && Array.isArray(process.argv)) ? process.argv : [];
      const files = [];
      for (let i = 2; i < argv.length; i++) {
         const a = String(argv[i]);
         if (a === '-f' || a === '--file') {
            if (i + 1 < argv.length) files.push(argv[++i]);
            continue;
         }
         if (a.startsWith('--file=')) {
            files.push(a.slice(7));
            continue;
         }
         if (a === '--eval') { i++; continue; }
         if (a.startsWith('--eval=') || a.startsWith('-')) continue;
         if (/\.(js|mongodb)$/i.test(a)) files.push(a);
      }
      return files.some(f => /(^|[\\/])autoCompact\.js$/i.test(String(f)));
   }
   if (isAutoCompactCliFile()) {
      console.log(`\n[yellow]#### Running script ${__script.name} v${__script.version} on shell v${version()}[/]\n`);
   }

   const SERVER_STATUS_IDENTITY_KEYS = new Set([
      "ok", "host", "version", "process", "pid",
      "uptime", "uptimeMillis", "uptimeEstimate", "localTime",
      "$clusterTime", "operationTime", "clusterTime",
      "errmsg", "code", "codeName", "errorLabels"
   ]);
   const SERVER_STATUS_OPTIONS_DEFAULTS = { "none": true }; // 8.3 exclude-all; pre-8.3 learned below
   function absorbServerStatusKeys(ss) {
      /*
       *  Pre-8.3 ignores none:true; learn section names from a fat reply
       *  and exclude them on later calls. Skip identity/command fields.
       */
      if (!ss || typeof ss !== 'object' || ss.ok === 0) return false;
      let grew = false;
      for (const key of Object.keys(ss)) {
         if (SERVER_STATUS_IDENTITY_KEYS.has(key)) continue;
         if (Object.prototype.hasOwnProperty.call(SERVER_STATUS_OPTIONS_DEFAULTS, key)) continue;
         SERVER_STATUS_OPTIONS_DEFAULTS[key] = false;
         grew = true;
      }
      return grew;
   }
   const SERVER_STATUS_WT_OPTS = { "wiredTiger": true };
   const SERVER_STATUS_ENGINE_OPTS = {
      "storageEngine": true,
      "featureCompatibilityVersion": true
   };

   function serverStatus(opts = {}) {
      /*
       *  opt-in version of db.serverStatus().
       *  Pass section overlays (wiredTiger, storageEngine+FCV). Defaults grow
       *  from the first fat reply on servers that ignore none:true.
       */
      const ss = db.adminCommand({
         "serverStatus": true,
         ...SERVER_STATUS_OPTIONS_DEFAULTS,
         ...opts
      });
      absorbServerStatusKeys(ss);
      return ss;
   }

   const SERVERSTATUS_MS = 1000;
   const DISABLE_POLL_MS = 200;      // poll interval while waiting for running bit to clear
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
         } = serverStatus(SERVER_STATUS_WT_OPTS));
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
      // enable watermark: call immediately before autoCompact (not client ISODate)
      try {
         const { localTime } = serverStatus();
         if (localTime != null) return localTime;
      } catch(_) { /* fall through */ }
      return ISODate();
   };
   const delay = ms => new Promise(resolve => setTimeout(resolve, ms)); // non-blocking so $listCatalog pump can run
   const waitWhileRunning = async (running, { onTick } = {}) => {
      // Fresh running bit until it is no longer true. No timeout.
      // onTick fires every DISABLE_STATUS_MS; omit it for a quiet wait.
      if (running !== true) return running;
      const startedAt = Date.now();
      let lastStatusAt = startedAt;
      while (running === true) {
         await delay(DISABLE_POLL_MS);
         if (onTick && Date.now() - lastStatusAt >= DISABLE_STATUS_MS) {
            onTick(Date.now() - startedAt);
            lastStatusAt = Date.now();
         }
         running = getBackgroundCompact(true).running;
      }
      return running;
   };
   const SCALE_METRICS = [
      { "unit": "bytes", "symbol": "B", "factor": 1, "precision": 0 },
      { "unit": "kibibytes", "symbol": "KiB", "factor": 1024, "precision": 2 },
      { "unit": "mebibytes", "symbol": "MiB", "factor": Math.pow(1024, 2), "precision": 2 },
      { "unit": "gibibytes", "symbol": "GiB", "factor": Math.pow(1024, 3), "precision": 2 },
      { "unit": "tebibytes", "symbol": "TiB", "factor": Math.pow(1024, 4), "precision": 2 },
      { "unit": "pebibytes", "symbol": "PiB", "factor": Math.pow(1024, 5), "precision": 2 },
      { "unit": "exbibytes", "symbol": "EiB", "factor": Math.pow(1024, 6), "precision": 2 }
   ];
   class AutoFactor {
      /*
       *  Determine scale factor automatically (same idea as mdblib.js / dbstats.js)
       */
      scale(number) {
         if (number < 1) number = 1;
         return Math.min(Math.floor(Math.log2(number) / 10), SCALE_METRICS.length - 1);
      }
      metric(number) {
         return SCALE_METRICS[this.scale(number)];
      }
      format(number = 0) {
         const n = Number(number);
         if (!Number.isFinite(n)) return 'unknown';
         const value = Math.max(0, n);
         const metric = this.metric(value);
         return `${+(value / metric.factor).toFixed(metric.precision)} ${metric.symbol}`;
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
      console.log(`\n══════ [yellow]recovered[/] [blue]${scaled.format(delta)}[/] [yellow]this pass ([/][blue]${scaled.format(endBytes)}[/] [yellow]cumulative runtime)[/] ══════`);
   };
   const hostNameFromHostPort = value => {
      // Bare hostname from host:port, [IPv6]:port, or a bare host (mdblib.js)
      const s = (value == null) ? '' : String(value);
      if (!s) return '';
      if (s.charAt(0) === '[') {
         const end = s.indexOf(']');
         return (end > 1) ? s.substring(1, end) : s;
      }
      const first = s.indexOf(':');
      const last = s.lastIndexOf(':');
      if (first === -1) return s;
      if (first !== last) return s; // IPv6 without brackets
      return (/^\d+$/).test(s.substring(last + 1)) ? s.substring(0, last) : s;
   };
   const atlasPlatform = helloDoc => {
      /*
       *  sharedTier is Atlas M0 (Free) / Flex. serverless is a separate platform string.
       *  Caller already rejected mongos. One hostInfo, one bare serverStatus.
       *  Hostname: hostInfo.system.hostname, else serverStatus().host (M0/Flex),
       *  else hello().me, else unknown.
       */
      let hostInfoDoc = {};
      let hostInfoError = null;
      try {
         hostInfoDoc = db.hostInfo();
      } catch(e) {
         hostInfoError = e;
      }
      let ss;
      try {
         ss = serverStatus();
      } catch(e) {
         return { "error": e };
      }
      let hostname = (hostInfoDoc.system && hostInfoDoc.system.hostname)
         ? String(hostInfoDoc.system.hostname)
         : '';
      if (!hostname) hostname = hostNameFromHostPort(ss.host);
      if (!hostname) {
         hostname = hostNameFromHostPort(helloDoc.me);
         if (!hostname && helloDoc.msg !== 'isdbgrid' && typeof helloDoc.me === 'undefined') {
            hostname = 'serverless';
         }
      }
      if (!hostname) hostname = 'unknown';
      const isSharedTier = hostInfoError
         ? (hostInfoError.codeName == 'AtlasError')
         : (hostInfoDoc.ok != 1);
      const atlasVersion = ss.atlasVersion || false;
      const isAtlas = !!(atlasVersion || (typeof hostname === 'string' && hostname.endsWith('.mongodb.net')));
      let platform = false;
      if (isAtlas && isSharedTier) platform = 'sharedTier';
      else if (isAtlas) platform = 'dedicatedReplicaSet';
      else if (hostname == 'serverless') platform = 'serverless';
      return { "platform": platform };
   };
   const preflight = () => {
      // autoCompact is mongod 8.0+ / wiredTiger only.
      // Already-enabled is handled by the disable-wait-retry loop, not an error here.
      let helloDoc;
      try {
         helloDoc = db.hello();
      } catch(e) {
         console.log('[red][ERROR] hello() failed:[/]', e);
         return false;
      }
      if (helloDoc.msg === 'isdbgrid') {
         console.log('[red][ERROR] autoCompact is not supported on mongos; connect directly to a mongod[/]');
         return false;
      }
      const atlas = atlasPlatform(helloDoc);
      if (atlas.error) {
         console.log('[red][ERROR] serverStatus() failed:[/]', atlas.error);
         return false;
      }
      if (atlas.platform === 'sharedTier') {
         console.log('[red][ERROR] autoCompact is not supported on Atlas M0 (Free) or Flex clusters[/] (https://www.mongodb.com/docs/atlas/unsupported-commands/)');
         return false;
      }
      if (atlas.platform === 'serverless') {
         // Atlas Serverless is deprecated/gone; keep the platform string
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
         console.log(`[red][ERROR] autoCompact requires MongoDB 8.0+; detected binary ${db.version()}[/]`);
         return false;
      }
      let engine, fcv;
      try {
         ({
            'storageEngine': { 'name': engine } = {},
            'featureCompatibilityVersion': fcv
         } = serverStatus(SERVER_STATUS_ENGINE_OPTS));
      } catch(e) {
         console.log('[red][ERROR] serverStatus() failed:[/]', e);
         return false;
      }
      // explicit FCV from serverStatus; if omitted, effective FCV equals the binary version
      const fcvVersion = (typeof fcv === 'string') ? fcv : fcv?.version;
      const effectiveFcv = fcvVersion ?? db.version();
      const fcvMajor = parseInt(String(effectiveFcv).split('.')[0], 10);
      if (!Number.isFinite(fcvMajor) || fcvMajor < 8) {
         console.log(`[red][ERROR] autoCompact requires FCV 8.0+; detected binary ${db.version()}, FCV ${effectiveFcv}[/]`);
         return false;
      }
      if (engine == null) {
         console.log('[red][ERROR] autoCompact requires wiredTiger; storageEngine.name unavailable from serverStatus[/]');
         return false;
      }
      if (engine !== 'wiredTiger') {
         console.log(`[red][ERROR] autoCompact requires wiredTiger; detected storage engine "${engine}"[/]`);
         return false;
      }
      return true;
   };
   const identKey = name => {
      let s = String(name ?? '');
      if (s.startsWith('statistics:table:')) s = s.slice('statistics:table:'.length);
      else if (s.startsWith('file:')) s = s.slice('file:'.length);
      else if (s.startsWith('table:')) s = s.slice('table:'.length);
      if (s.endsWith('.wt')) s = s.slice(0, -'.wt'.length);
      return s;
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
   const WT_PREFIXED_RE = /(?:file:|table:|statistics:table:)[\w.-]+(?:\.wt)?/;
   const WT_FILE_RE = /(?:[\w.-]+\/)?[\w.-]+\.wt/;
   const wtNameFromMsg = (msg = '', dhandle) => {
      if (dhandle) return dhandle;
      const text = String(msg);
      const prefixed = text.match(WT_PREFIXED_RE);
      if (prefixed) return prefixed[0];
      const wtFile = text.match(WT_FILE_RE);
      return wtFile ? wtFile[0] : null;
   };
   const WT_NO_WORK = 'there is no useful work to do -';
   const stripWtNoWork = text => {
      const cut = text.indexOf(WT_NO_WORK);
      if (cut === -1) return text;
      let i = cut + WT_NO_WORK.length;
      while (i < text.length && text.charCodeAt(i) <= 32) i++;
      return text.slice(0, cut) + text.slice(i);
   };
   const annotateWtMsg = (msg, dhandle, resolveNs) => {
      const text = stripWtNoWork(String(msg));
      const wtName = wtNameFromMsg(text, dhandle);
      if (!wtName) return text;
      const entry = resolveNs(wtName);
      const plain = nsPlain(entry);
      if (!plain || text.includes(plain)) return text;
      const ident = identKey(wtName);
      if (!ident) return text;
      const colored = nsColored(entry);
      // longest forms first so ident is not left as a .wt suffix
      const needles = [wtName, `${ident}.wt`, `file:${ident}`, `table:${ident}`, `statistics:table:${ident}`, ident];
      for (const n of needles) {
         if (n && text.includes(n)) return text.replaceAll(n, colored);
      }
      return text;
   };
   const isSizeStorer = (msg = '', dhandle = '') => {
      // last expected file of the walk
      return `${dhandle} ${msg}`.includes('sizeStorer');
   };
   const isUnauthorized = e => e?.code == 13 || e?.codeName === 'Unauthorized'
      || e?.errorResponse?.code == 13 || e?.errorResponse?.codeName === 'Unauthorized';
   // 8.0+ injects a server-owned $match on collectionless $listCatalog for any caller
   // without the internal action: drop local.*, config.*, and system.* except system.js
   // and system.buckets.*. Targeted $listCatalog still returns those entries when the
   // user has listIndexes on that namespace; collStats is the narrower fallback.
   const isRedactedCatalogNs = (dbName, collName) => {
      if (dbName === 'local' || dbName === 'config') return true;
      if (collName === 'system.js' || collName.startsWith('system.buckets.')) return false;
      return collName.startsWith('system.');
   };
   const ingestCatalogDoc = (map, doc) => {
      const ns = doc.ns ?? (doc.db && doc.name ? `${doc.db}.${doc.name}` : null);
      if (typeof doc.ident === 'string' && ns) map.set(doc.ident, { "kind": "collection", "ns": ns });
      if (doc.idxIdent && ns) {
         for (const [idx, ident] of Object.entries(doc.idxIdent)) {
            if (typeof ident === 'string') map.set(ident, { "kind": "index", "ns": ns, "idx": idx });
         }
      }
   };
   const ingestStats = (map, ns, st) => {
      const collUri = st?.wiredTiger?.uri;
      if (typeof collUri === 'string') {
         const ident = identKey(collUri);
         if (ident) map.set(ident, { "kind": "collection", "ns": ns });
      }
      const details = st?.indexDetails;
      if (!details || typeof details !== 'object') return;
      for (const [idx, info] of Object.entries(details)) {
         const uri = info?.uri;
         if (typeof uri !== 'string') continue;
         const ident = identKey(uri);
         if (ident) map.set(ident, { "kind": "index", "ns": ns, "idx": idx });
      }
   };
   const readRedacted = async (map, dbName, collName, session) => {
      // 'named' ingested an ident. 'denied' is Unauthorized (code 13) only.
      // Any other failure stays unnamed and does not count toward the NOTE.
      const comment = `Executed by ${__script.name} v${__script.version} ident map`;
      let saw = false;
      let listDenied = false;
      try {
         const agg = db.getSiblingDB(dbName).getCollection(collName).aggregate([
            { "$listCatalog": {} }
         ], {
            "cursor": { "batchSize": 1 },
            "comment": comment
         });
         session.setCursor(agg);
         for await (const doc of agg) {
            if (session.isCancelled()) break;
            ingestCatalogDoc(map, doc);
            saw = true;
         }
      } catch(e) {
         if (saw) return 'named';
         if (session.isCancelled()) return 'cancelled';
         if (isUnauthorized(e)) listDenied = true;
      } finally {
         session.closeCursor();
      }
      if (saw) return 'named';
      if (session.isCancelled()) return 'cancelled';
      try {
         const st = db.getSiblingDB(dbName).runCommand({ "collStats": collName, "scale": 1 });
         if (st?.ok && (typeof st.wiredTiger?.uri === 'string' || st.indexDetails)) {
            ingestStats(map, `${dbName}.${collName}`, st);
            return 'named';
         }
      } catch(e) {
         // A network error on collStats is not a privilege gap unless listIndexes already was.
         if (isUnauthorized(e) || listDenied) return 'denied';
         return 'other';
      }
      return listDenied ? 'denied' : 'other';
   };
   const ingestRedactedCatalog = async (map, session) => {
      let databases;
      try {
         ({ "databases": databases = [] } = db.adminCommand({ "listDatabases": 1, "nameOnly": true }));
      } catch(_) {
         return 0;
      }
      let denied = 0;
      for (const entry of databases) {
         if (session.isCancelled()) return denied;
         const dbName = entry?.name;
         if (typeof dbName !== 'string') continue;
         // local/config are redacted wholesale; elsewhere only system.* is hidden
         const filter = (dbName === 'local' || dbName === 'config')
            ? { "type": "collection" }
            : { "type": "collection", "name": { "$regex": "^system\\." } };
         let infos;
         try {
            infos = db.getSiblingDB(dbName).getCollectionInfos(filter);
         } catch(_) {
            continue;
         }
         for (const info of infos) {
            if (session.isCancelled()) return denied;
            const collName = info?.name;
            if (typeof collName !== 'string' || !isRedactedCatalogNs(dbName, collName)) continue;
            if (await readRedacted(map, dbName, collName, session) === 'denied') denied++;
         }
      }
      return denied;
   };
   const IDENT_REFRESH_MS = 5000;
   const IDENT_BATCH = 64;
   const startNsResolver = () => {
      // ident → { kind, ns, idx? }; internals first. The first $listCatalog pass settles
      // before autoCompact so idents that already exist resolve. Later misses refresh
      // in the background. stop() from the enable finally cancels the pump.
      const map = new Map([
         ['sizeStorer', { "kind": "internal", "ns": "(sizeStorer)" }],
         ['WiredTigerHS', { "kind": "internal", "ns": "(history store)" }],
         ['_mdb_catalog', { "kind": "internal", "ns": "(catalog)" }]
      ]);
      let pumping = false;
      let cancelled = false;
      let catalogOk = false;
      let deniedCount = 0;
      let lastRefreshAt = 0;
      let initialSettled = false;
      let cursor;
      let settleInitial;
      const initialDone = new Promise(resolve => { settleInitial = resolve; });
      const markInitialSettled = () => {
         if (initialSettled) return;
         initialSettled = true;
         settleInitial();
      };
      const closeCursor = () => {
         if (!cursor) return;
         try { cursor.close(); } catch(_) { /* already closed */ }
         cursor = undefined;
      };
      const session = {
         isCancelled: () => cancelled,
         setCursor: agg => { cursor = agg; },
         closeCursor
      };
      const pump = async() => {
         if (pumping || cancelled) return;
         pumping = true;
         const firstPass = !initialSettled; // refresh stays collectionless; redacted misses would re-scan every 5s
         try {
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
                  if (cancelled) break;
                  ingestCatalogDoc(map, doc);
               }
               if (!cancelled) catalogOk = true;
            } catch(e) {
               if (!cancelled) {
                  catalogOk = false;
                  console.log('[red][WARN] $listCatalog() unavailable, WTCMPCT lines will show WT filenames:[/]', e);
               }
            } finally {
               closeCursor(); // drop the collectionless cursor before targeted aggregates
            }
            if (firstPass && !cancelled) deniedCount = await ingestRedactedCatalog(map, session);
         } finally {
            closeCursor();
            pumping = false;
            lastRefreshAt = Date.now();
            markInitialSettled(); // first pass only; later refreshes no-op
         }
      };
      pump();
      const resolveNs = name => {
         const ns = nsFromWt(name, map);
         if (ns || !name) return ns;
         if (!cancelled && !pumping && Date.now() - lastRefreshAt >= IDENT_REFRESH_MS) pump();
         return nsFromWt(name, map);
      };
      const stop = () => {
         cancelled = true;
         closeCursor();
         markInitialSettled();
      };
      return {
         initialDone,
         resolve: resolveNs,
         stop,
         size: () => map.size,
         // Privilege gap: size() is short of the files WT visits, so the count latch stays off.
         // namespaceNames() is the bar's projected total (distinct db.coll), not that latch.
         namespaceNames: () => catalogNamespaceNames(map, catalogOk),
         catalogReady: () => catalogOk && deniedCount === 0 && !pumping && !cancelled,
         denied: () => deniedCount
      };
   };
   const POLL_MS_MIN = 50;     // after new WTCMPCT, overflow, visit increment, or full ramlog
   const POLL_MS_MAX = 1000;   // quiet backoff ceiling (only once first pass is latched or still a no-op)
   const LOG_QUIET_MS = 2000;  // WTCMPCT or ramlog-overflow heartbeat
   const VISITS_QUIET_MS = 2000; // WT visit counters unchanged
   const NOOP_GRACE_MS = 5000; // no file visits and no heartbeat
   const GETLOG_CAP = 1024;    // ramlog size; overflow warn + seen Set cap
   const clampPollMS = ms => {
      const n = +ms;
      if (!Number.isFinite(n) || n <= 0) return POLL_MS_MIN;
      return Math.min(POLL_MS_MAX, Math.max(POLL_MS_MIN, n));
   };
   const regulatePollMS = (pollMS, { overflow = false, active = false, holdMin = false } = {}) =>
      // hold min while the walk is live (visits moving / still in a file) so WTCMPCT is not dropped
      (overflow || active || holdMin) ? POLL_MS_MIN : clampPollMS(pollMS * 2);
   let getLogWarned = false;
   const WTCMPCT_RE = /"c"\s*:\s*"WTCMPCT"/;
   const logKey = ({ t, 'attr': { 'message': { msg = '', session_dhandle_name = '' } = {} } = {} } = {}) =>
      `${+t}\0${session_dhandle_name}\0${msg}`;
   const rememberLog = (seen, key) => {
      // insertion-order FIFO; ramlog cannot still hold more unique WTCMPCT keys than GETLOG_CAP
      seen.add(key);
      while (seen.size > GETLOG_CAP) seen.delete(seen.keys().next().value);
   };
   const getLogs = (since, seen, lastTotal = null) => {
      // ramlog ~1024 raw lines; prefilter WTCMPCT (spacing-tolerant) before EJSON.parse
      // start watermark exclusive; later same-ms siblings kept if not yet in seen
      // unchanged totalLinesWritten → no new ramlog lines; skip the walk
      let lines, totalLinesWritten;
      try {
         ({ "log": lines = [], "totalLinesWritten": totalLinesWritten } = db.adminCommand({ "getLog": "global" }));
      } catch(e) {
         if (!getLogWarned) {
            console.log('[red][WARN] getLog() unavailable, relying on serverStatus WT file-visit counters:[/]', e);
            getLogWarned = true;
         }
         return { "logs": [], "totalLinesWritten": null, "rawCount": 0 };
      }
      if (Number.isFinite(totalLinesWritten) && totalLinesWritten === lastTotal) {
         return { "logs": [], "totalLinesWritten": totalLinesWritten, "rawCount": lines.length };
      }
      // first poll: skip t === since for the whole walk (seen grows as we remember)
      const exclusiveSince = seen.size === 0;
      const out = [];
      for (const line of lines) {
         if (!WTCMPCT_RE.test(String(line))) continue;
         try {
            const entry = EJSON.parse(line);
            if (entry.t < since) continue;
            if (exclusiveSince && +entry.t === +since) continue;
            const key = logKey(entry);
            if (seen.has(key)) continue;
            rememberLog(seen, key);
            out.push(entry);
         } catch(e) {
            // skip malformed WTCMPCT line
         }
      }
      return { "logs": out, "totalLinesWritten": totalLinesWritten, "rawCount": lines.length };
   };
   const decideFirstPass = ({
      catalogCount,
      deltaVisits,
      visitsQuiet,
      logsHeartbeat,
      startedAt,
      now,
      runOnce,
      running,
      seenRunning
   }) => {
      // First matching reason wins. sizeStorer is a line hint in the printer, not a counter test.
      if (catalogCount != null && deltaVisits != null
            && deltaVisits >= catalogCount && visitsQuiet) {
         return `WT file visits reached catalog size (${deltaVisits}/${catalogCount})`;
      }
      if (deltaVisits > 0 && visitsQuiet && !logsHeartbeat) {
         return 'WT file visits stalled (no WTCMPCT heartbeat)';
      }
      if ((deltaVisits === 0 || deltaVisits == null)
            && now - startedAt >= NOOP_GRACE_MS && !logsHeartbeat) {
         return 'serverStatus: no WT file visits (no-op)';
      }
      if (runOnce && running === false && (seenRunning || deltaVisits > 0)) {
         return 'serverStatus: background compact thread idle';
      }
      return null;
   };
   const tailLogs = async(ts, nsResolver = {}, runOnce = true) => {
      /*
       *  Follow WTCMPCT until the first catalog walk ends, then report recovered bytes.
       *  Latch (not $currentOp; WT thread never appears there):
       *  - sizeStorer WTCMPCT is a last-file hint (ramlog can drop it)
       *  - visits = success + skipped* + timeout + interrupted + failed (process-lifetime)
       *  - Δvisits >= catalog size only when catalogReady (no Unauthorized namespaces)
       *  - WTCMPCT is a heartbeat; ramlog overflow (lost lines) counts as heartbeat, not quiet
       *  - stall visits but still logging/overflow → still in a file
       *  - recovered-bytes stall is not a stop
       *  - getLog poll stays at min while visits are moving or first pass is still in a file
       *  - runOnce:true: stop getLog after first pass; wait for running === false with fresh
       *    serverStatus (DISABLE_POLL_MS, no 1s cache; null is not idle)
       *  - runOnce:false: running bit stays on; first pass = hint or visits stall
       */
      const resolveNs = nsResolver.resolve ?? (() => null);
      const hud = createNamespaceHud();
      const projectedNs = (typeof nsResolver.namespaceNames === 'function')
         ? nsResolver.namespaceNames()
         : null;
      const seenNs = new Set();
      let lastNs = '';
      let logFuzzy = false;
      const emit = (...args) => {
         hud.clear();
         console.log(...args);
      };
      const paintNamespaces = () => {
         if (!projectedNs || firstPassDone) return;
         const current = seenNs.size;
         const total = projectedNs.size;
         const frac = total > 0 ? current / total : 0;
         const count = logFuzzy ? `~${current}` : String(current);
         const last = lastNs ? ` [dim]${lastNs}[/]` : '';
         hud.render(`[yellow]autoCompact[/] [blue]${count}[/]/[blue]${total}[/] namespaces ${hud.bar(frac)}${last}`);
      };
      let pause = false;
      let firstPassDone = false;
      let seenRunning = false;
      const seen = new Set();
      let pollMS = POLL_MS_MIN;
      let lastTotal = null;
      let lastLogAt = null;
      let lastOverflowAt = null;
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
         emit(`\n══════ [yellow]${reason}[/] ══════`);
      };

      while (!firstPassDone) {
         const { logs, totalLinesWritten, rawCount = 0 } = getLogs(ts, seen, lastTotal);
         const overflow = Number.isFinite(totalLinesWritten)
            && lastTotal != null
            && totalLinesWritten - lastTotal >= GETLOG_CAP;
         const ramlogFull = rawCount >= GETLOG_CAP;
         if (overflow) {
            lastOverflowAt = Date.now();
            logFuzzy = true; // dropped WTCMPCT lines; the namespace count can only under-report
            emit(`[red][WARN] getLog overflow: ${totalLinesWritten - lastTotal} lines since last poll (ramlog ~${GETLOG_CAP}); treating as heartbeat, poll ${pollMS}ms → ${POLL_MS_MIN}ms[/]`);
         }
         if (Number.isFinite(totalLinesWritten)) lastTotal = totalLinesWritten;
         if (logs.length > 0) {
            lastLogAt = Date.now();
            logs.forEach(entry => {
               const { t = ISODate(), 'attr': { 'message': { msg = '', session_dhandle_name = '' } = {} } = {} } = entry;
               if (t > ts) ts = t;
               const wtName = wtNameFromMsg(msg, session_dhandle_name);
               const nsEntry = wtName ? resolveNs(wtName) : null;
               if (noteLoggedNamespace(projectedNs, seenNs, nsEntry)) lastNs = nsEntry.ns;
               emit(`[blue]${t.toJSON()}[/]`, annotateWtMsg(msg, session_dhandle_name, resolveNs));
               if (isSizeStorer(msg, session_dhandle_name)) {
                  markFirstPass('sizeStorer (last file of catalog walk)');
               }
            });
            pause = false;
         } else if (!pause && !hud.enabled) {
            emit('══════ [yellow]autoCompaction work in progress, waiting for new logs[/] ══════');
            pause = true;
         }
         const { running, visits } = getBackgroundCompact();
         if (running === true) seenRunning = true;
         const visitsMoved = visits != null && visits !== lastVisits;
         if (visitsMoved) {
            lastVisits = visits;
            lastVisitsAt = Date.now();
         }
         const now = Date.now();
         const deltaVisits = (visits != null && startVisits != null) ? visits - startVisits : null;
         const visitsQuiet = lastVisitsAt != null && now - lastVisitsAt >= VISITS_QUIET_MS;
         const logsHeartbeat = (lastLogAt != null && now - lastLogAt < LOG_QUIET_MS)
            || (lastOverflowAt != null && now - lastOverflowAt < LOG_QUIET_MS);
         const catalogCount = nsResolver.catalogReady?.() ? nsResolver.size() : null;

         if (!firstPassDone) {
            const reason = decideFirstPass({
               catalogCount,
               deltaVisits,
               visitsQuiet,
               logsHeartbeat,
               startedAt,
               now,
               runOnce,
               running,
               seenRunning
            });
            if (reason) markFirstPass(reason);
         }
         if (firstPassDone) break;
         paintNamespaces();
         pollMS = regulatePollMS(pollMS, {
            "overflow": overflow,
            "active": logs.length > 0 || visitsMoved || ramlogFull,
            "holdMin": deltaVisits > 0
         });
         await delay(pollMS);
      }

      hud.clear();
      if (!runOnce) {
         console.log('\n══════ [yellow]first pass complete; background compact thread left enabled (next walk ~24h)[/] ══════');
         reportRecoveredBytes(startBytes);
         return;
      }

      // sizeStorer (and other latches) are last-file hints; the running bit clears after the file
      let running = getBackgroundCompact(true).running;
      if (running === true) {
         console.log('\n══════ [yellow]last file done, waiting for background compact idle[/] ══════');
         running = await waitWhileRunning(running);
      }
      if (running === false) {
         console.log('\n══════ [yellow]serverStatus: background compact thread idle[/] ══════');
      } else {
         console.log('[red][ERROR] could not confirm background compact idle (serverStatus unavailable)[/]');
      }
      console.log('\n══════ [yellow]autoCompaction round complete[/] ══════');
      reportRecoveredBytes(startBytes);
   };

   // Caller: var autoCompactOptions = { ... } (--eval or REPL). Do not declare or assign it in this file.
   // Optional var optionsFile. Default autoCompact-options.jsonc (missing is silent).
   // Passthrough user fields as-is; default autoCompact: true and runOnce: true on enable, stamp comment.
   const __autoCompactResolved = resolveOptions({
      "defaults": {},
      "file": 'autoCompact-options.jsonc',
      "optionsFile": (typeof optionsFile !== 'undefined') ? optionsFile : null,
      "overlay": (typeof autoCompactOptions === 'undefined') ? null : autoCompactOptions
   });
   if (!__autoCompactResolved.ok) {
      const msg = (__autoCompactResolved.warnings[0] && __autoCompactResolved.warnings[0].message)
         || __autoCompactResolved.error
         || 'options file failed';
      console.log(`[red][ERROR][/] ${msg}`);
      return;
   }
   const userOptions = __autoCompactResolved.options;
   const cmd = {
      "autoCompact": true,
      ...(userOptions?.autoCompact === false ? {} : { "runOnce": true }),
      ...userOptions,
      "comment": `Executed by ${__script.name} v${__script.version}`
   };
   const enable = cmd.autoCompact !== false;
   if (!preflight()) return;
   const nsResolver = enable ? startNsResolver() : null;
   try {
      // mongod rejects autoCompact:true while WT still has background compact enabled.
      const replace = enable && getBackgroundCompact(true).running === true;
      if (enable) {
         console.log(`[yellow][NOTE][/] [blue]autoCompact[/] is per mongod instance only, cluster and replSet compaction requires targeted command execution. In addition, autoCompact excludes the '[yellow]local.oplog.rs[/]' collection.`);
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
         // Already enabled: autoCompact:false, wait unbounded for running bit to clear
         // (DISABLE_STATUS_MS progress notes), then re-issue cmd so user options take effect.
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
            running = await waitWhileRunning(running, {
               onTick: elapsedMs => {
                  console.log(`[yellow][NOTE][/] still waiting after ${Math.round(elapsedMs / 1000)}s (background compact running). CTRL+C to abort — you will need to re-run later to apply the new command options.`);
               }
            });
         }
         if (running !== false) {
            console.log('[red][ERROR] could not confirm background compact disabled (serverStatus unavailable)[/]');
            return;
         }
         console.log('══════ [yellow]serverStatus: background compact running is false; retrying with updated options[/] ══════\n');
      }
      if (nsResolver) {
         await nsResolver.initialDone; // full initial $listCatalog before enable
         const denied = nsResolver.denied();
         if (denied > 0) {
            const noun = denied === 1 ? 'namespace lacks' : 'namespaces lack';
            console.log(`[yellow][NOTE][/] ${denied} ${noun} listIndexes and collStats; those lines stay collection-*.wt / index-*.wt\n`);
         } else {
            console.log('');
         }
      }
      const ts = enable ? serverLocalTime() : null; // WTCMPCT watermark; exclusive start in getLogs
      if (!runCmd(cmd)) return;
      if (!enable) {
         console.log('══════ [yellow]background compact thread disabled[/] ══════');
         return;
      }
      await tailLogs(ts, nsResolver, cmd.runOnce === true);
   } finally {
      nsResolver?.stop?.(); // cancel $listCatalog pump on every enable exit
   }
})();

// EOF
