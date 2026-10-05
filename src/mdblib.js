/*
 *  Name: "mdblib.js"
 *  Version: "0.32.0"
 *  Description: mongosh shell helper library
 *  Disclaimer: https://raw.githubusercontent.com/tap1r/mongodb-scripts/master/DISCLAIMER.md
 *  Authors: ["tap1r <luke.prochazka@gmail.com>"]
 *  Guide: https://raw.githubusercontent.com/tap1r/mongodb-scripts/master/mongosh-scripting-guide.md
 *  Roadmap: https://raw.githubusercontent.com/tap1r/mongodb-scripts/master/ROADMAP.md (required context)
 *
 *  Dual-shell snapshot: legacy/mongo-shell (tag legacy-mongo-shell, v0.15.10).
 *  This file is mongosh-only. TopologySnapshot.fromSession() lists cluster
 *  identity; materializeNodes({ depth }) gathers remotes via child Mongo()
 *  (no load of discovery.js). resolveOptions overlays JSONC then --eval.
 *  for(db) still TBA.
 */

if (typeof __lib === 'undefined') (
   __lib = {
      "name": "mdblib.js",
      "version": "0.32.0"
});

/*  Notes:
 *  - mongosh only (floor 1.10 / 2.10+)
 *  - floor mongod to v4.4. The check sets __mdblibShellIncompatible /
 *    __mdblibServerUnsupported and does not print or read a caller's options.
 *  - bsonMax, maxWriteBatchSize, pid, and nonce are first-read globals.
 *    load() does not call hello, serverStatus, or features for them.
 *    One hello() fills both BSON limits. fuzzer reads bsonMax.
 *  - Session snapshot (first read): atlas platform, fCV, and isSharded share
 *    one hello / hostInfo / serverStatus / listShards / getParameter.
 *    hello() and serverVer() are first-read on that snapshot (helloDoc,
 *    serverVerParsed). hello(true) re-probes and updates the cache.
 *    load() does not call serverVer()/db.version(); the 4.4 floor runs on
 *    the first sessionSnapshot (ensureServerFloor). withChildSession
 *    clears hello / serverVer sidecars with the snapshot. hello msg isdbgrid
 *    still means sharded when serverStatus is {ok:0} and listShards did not
 *    return shards. Snapshot takes serverStatus (wiredTiger:1) after hello;
 *    Atlas shared-tier (atlasVersion or *.mongodb.net host, no wiredTiger,
 *    not isdbgrid) skips hostInfo / getParameter / listShards. Auto catalog
 *    still tries $listCatalog on that tier.
 *    A proc of unknown is not cached (the next read retries). An M0/Flex
 *    getParameter denial still caches once proc is known. load() does not
 *    fill the full snapshot. db.hello() stays a live shell command.
 *  - compactionHelper(type, storageSize, freeStorageSize) has no numeric
 *    defaults. Omitted storage is not the 4 KiB display floor. Omitted or
 *    null free is unknown, not an empty free list, and returns false.
 *    Thresholds stay 20% collection / 50% index / 50% dbPath.
 *  - fCV() → serverVer() on Atlas M0/Flex is by design (getParameter FCV is
 *    restricted; Atlas is not left on a lagging FCV)
 *  - serverStatus none:true is portable on 8.0 and Atlas M0 (no throw;
 *    process/pid remain). SERVER_STATUS_OPTIONS_DEFAULTS starts as none:true
 *    and grows section:false from fat replies (pre-8.3 ignores none).
 *    serverStatus(opts, null) skips the read-preference hello and runs on
 *    the connected member. A thrown command becomes { ok: 0, error }.
 *  - AutoFactor.format: non-finite is "unknown"; negatives clamp to 0;
 *    a value below 1 byte stays on the byte scale.
 *  - $collStats is async; callers must await it (user-defined async is not
 *    rewriter-awaited). Do not await the aggregate cursor (thenable drains).
 *    Drain via drainAggCursor / driver _cursor.toArray() (native Promise) so
 *    mapPool overlaps.
 *  - $listCatalog (6.0+, collectionless admin) and $listClusterCatalog
 *    (8.0.10+, admin = cluster) list namespaces as { db, name, type }.
 *    listCatalogSnapshot selects auto|legacy|listCatalog|listClusterCatalog;
 *    on authz/failure the caller falls back to getCollectionInfos.
 *    $listClusterCatalog is an optional mongos fast path, never the only path.
 *    shards:true is added only when the caller will consume owners; those
 *    ids stay on the entry. The caller skips the stage when connectionStatus
 *    already lacks clusterMonitor.
 *    Name policy is systemCollectionFilter. The getAllNonSystem* /
 *    getAllSystemNamespaces stubs are gone.
 *  - statsIncomplete compares returned $collStats shards to owning shards.
 *    Expanded mongos catalog owners win; otherwise config.chunks / db primary.
 *    Not cluster-wide listShards.
 *  - parseDbStats / parseCollStats / parseIndexStats turn normalised $stats /
 *    $collStats output into DTOs. parseDbStats stores the index count as
 *    nindexes only (db.stats() names that field indexes). Collection
 *    indexes stay IndexStats[]. DatabaseStats / DbPathStats do not alias
 *    indexes to nindexes.
 *  - UUID/Binary.base64() is a method (this.toString('base64')).
 *  - CollectionStats / DatabaseStats / DbPathStats construct from those
 *    DTOs. HostNode owns connecting-host identity; DbPathStats composes it.
 *    TopologySnapshot.fromSession() lists cluster identity (kind, setName,
 *    shard ids, advertised replica members / shard seeds) from the
 *    connecting session. Shared-tier / serverless stay one connecting node.
 *    TopologySnapshot.materializeNodes({ depth }) connects with discovery-style
 *    child mongodb:// URIs (do not load discovery.js) and runs a gather
 *    callback on each remote. depth summary|$stats vs expanded catalog+$collStats;
 *    cluster.kind selects the walk (replica/sharded keys alias depth). Serial
 *    global-db swap; not for(db). Do not gather mongos local.* from the router.
 *    There is no MetaStats façade.
 *  - Catalog identity first, stats on demand: collection.fetchStats(),
 *    database.fetchAllStats({ concurrency }), dbPath.materialize({ concurrency }).
 *    materialize uses a global $collStats in-flight cap and still calls
 *    onDatabase when each DB's collections complete (per-DB free rollup).
 *    fetchDbStats is the async $stats path (runCommand + awaitPlain) so
 *    mapPool can overlap db.stats(). $stats stays a sync helper.
 *    Cache _statsPromise per collection. Callers materialise then serialise.
 *  - Owning-shard ids live on the Map for one materialize / fetchAllStats
 *    gather. A lone $collStats does not keep them. __collStatsOnMongos
 *    stays a session cache.
 */

function isMongosh() {
   /*
    *  Evaluate the shell type
    */
   return typeof process !== 'undefined';
}

/*
 *  Options resolve (JSONC overlay)
 *  Layer: defaults → file → --eval overlay. Missing default file is not an error.
 *  Plain objects deep-merge; arrays and scalars replace. JSON has no RegExp —
 *  callers pass revive paths (dbstats filter.db / filter.collection).
 */

function isPlainObject(value) {
   return !!value && typeof value === 'object' && !Array.isArray(value)
      && !(value instanceof Date) && !(value instanceof RegExp);
}

function optionsDirOf(file) {
   const s = String(file || '');
   const slash = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
   if (slash < 0) return '.';
   if (slash === 0) return '/';
   return s.slice(0, slash);
}

function configSearchDirs(anchorDir) {
   const dirs = [];
   const add = (dir) => {
      if (typeof dir === 'string' && dir.length > 0 && !dirs.includes(dir))
         dirs.push(dir);
   };
   add(anchorDir);
   add('.');
   if (typeof __dirname === 'string') add(__dirname);
   if (typeof process !== 'undefined' && process.env) {
      add(process.env.MDBLIB);
      if (process.env.HOME) add(`${process.env.HOME}/.mongodb`);
   }
   return dirs;
}

function resolveConfigFile(name, anchorDir) {
   if (typeof name !== 'string' || name.length === 0) return null;
   const fsys = (typeof fs !== 'undefined') ? fs : null;
   if (!fsys || typeof fsys.existsSync !== 'function') return null;
   if (name.startsWith('/') || /^[A-Za-z]:[\\/]/.test(name))
      return fsys.existsSync(name) ? name : null;
   let found = null;
   configSearchDirs(anchorDir).some(dir => {
      const full = `${String(dir).replace(/\/$/, '')}/${name}`;
      if (!fsys.existsSync(full)) return false;
      found = full;
      return true;
   });
   return found;
}

function parseJsonc(text) {
   const source = String(text).replace(/^\uFEFF/, '');
   let stripped = '';
   let i = 0;
   const n = source.length;
   while (i < n) {
      const c = source[i];
      if (c === '"') {
         stripped += c;
         i++;
         while (i < n) {
            const s = source[i];
            stripped += s;
            i++;
            if (s === '\\') {
               if (i < n) {
                  stripped += source[i];
                  i++;
               }
               continue;
            }
            if (s === '"') break;
         }
         continue;
      }
      if (c === '/' && source[i + 1] === '/') {
         i += 2;
         while (i < n && source[i] !== '\n') i++;
         continue;
      }
      if (c === '/' && source[i + 1] === '*') {
         i += 2;
         while (i < n && !(source[i] === '*' && source[i + 1] === '/')) i++;
         i = Math.min(n, i + 2);
         continue;
      }
      stripped += c;
      i++;
   }
   let json = '';
   i = 0;
   const m = stripped.length;
   while (i < m) {
      const c = stripped[i];
      if (c === '"') {
         json += c;
         i++;
         while (i < m) {
            const s = stripped[i];
            json += s;
            i++;
            if (s === '\\') {
               if (i < m) {
                  json += stripped[i];
                  i++;
               }
               continue;
            }
            if (s === '"') break;
         }
         continue;
      }
      if (c === ',') {
         let j = i + 1;
         while (j < m && (stripped[j] === ' ' || stripped[j] === '\t'
               || stripped[j] === '\n' || stripped[j] === '\r'))
            j++;
         if (stripped[j] === '}' || stripped[j] === ']') {
            i++;
            continue;
         }
      }
      json += c;
      i++;
   }
   return JSON.parse(json);
}

function readJsonc(file) {
   return parseJsonc(fs.readFileSync(file, 'utf8'));
}

function deepMergeOptions(base, over) {
   if (!isPlainObject(over)) return base;
   const out = isPlainObject(base) ? { ...base } : {};
   Object.keys(over).forEach(key => {
      if (isPlainObject(over[key]) && isPlainObject(out[key]))
         out[key] = deepMergeOptions(out[key], over[key]);
      else
         out[key] = over[key];
   });
   return out;
}

function loadJsoncFile(name, { anchorDir, required = false } = {}) {
   if (typeof name !== 'string' || name.length === 0)
      return { "path": null, "value": null, "error": required ? 'path is empty' : null };
   const filePath = resolveConfigFile(name, anchorDir);
   if (!filePath)
      return { "path": required ? name : null, "value": null, "error": required ? 'not found' : null };
   try {
      const value = readJsonc(filePath);
      if (!isPlainObject(value))
         return { "path": filePath, "value": null, "error": 'must contain an object' };
      return { "path": filePath, "value": value, "error": null };
   } catch(e) {
      return { "path": filePath, "value": null, "error": (e && (e.errmsg || e.message)) || String(e) };
   }
}

function parseScriptArgv(argv) {
   /*
    *  Script-owned args after `--` so mongosh URI/TLS flags stay untouched.
    *  Recognises --config PATH and --config=PATH. mongosh 2.12 rejects
    *  unknown flags before the script runs; var optionsFile is the working
    *  explicit path.
    */
   const args = Array.isArray(argv) ? argv : [];
   const out = { "config": null, "rest": [] };
   let afterDash = false;
   for (let i = 2; i < args.length; i++) {
      const a = String(args[i]);
      if (a === '--') { afterDash = true; continue; }
      if (!afterDash) continue;
      if (a === '--config' || a === '--options-file') {
         if (i + 1 < args.length) out.config = String(args[++i]);
         continue;
      }
      if (a.startsWith('--config=')) { out.config = a.slice(9); continue; }
      if (a.startsWith('--options-file=')) { out.config = a.slice(15); continue; }
      out.rest.push(a);
   }
   return out;
}

function optionsGetPath(obj, path) {
   return String(path).split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
}

function optionsSetPath(obj, path, value) {
   const keys = String(path).split('.');
   let cur = obj;
   for (let i = 0; i < keys.length - 1; i++) {
      if (!isPlainObject(cur[keys[i]])) return;
      cur = cur[keys[i]];
   }
   if (isPlainObject(cur)) cur[keys[keys.length - 1]] = value;
}

function reviveRegex(value) {
   if (value == null || value === '') return value;
   if (value instanceof RegExp) return value;
   if (typeof value !== 'string') return value;
   const wrapped = value.match(/^\/([\s\S]*)\/([a-z]*)$/);
   try {
      if (wrapped) return new RegExp(wrapped[1], wrapped[2]);
      return new RegExp(value);
   } catch(_) {
      return value;
   }
}

function resolveOptions({
      defaults = {},
      file = null,
      optionsFile = null,
      overlay = null,
      argv = (typeof process !== 'undefined' && process.argv) || [],
      revive = {},
      aliases = {}
   } = {}) {
   const warnings = [];
   const flags = parseScriptArgv(argv);
   let explicit = optionsFile;
   if (explicit == null && flags.config) explicit = flags.config;
   const overlayObj = isPlainObject(overlay) ? { ...overlay } : null;
   if (explicit == null && overlayObj && typeof overlayObj.optionsFile === 'string')
      explicit = overlayObj.optionsFile;
   if (overlayObj) delete overlayObj.optionsFile;

   const required = (explicit != null && String(explicit).length > 0);
   const loaded = loadJsoncFile(required ? String(explicit) : file, { "required": required });
   if (loaded.error) {
      warnings.push({
         "code": 'optionsFile',
         "message": `Options file "${loaded.path}": ${loaded.error}`
      });
   }

   let options = deepMergeOptions(defaults, loaded.value || {});
   if (overlayObj) options = deepMergeOptions(options, overlayObj);

   Object.keys(aliases || {}).forEach(path => {
      const map = aliases[path];
      if (!map || typeof map !== 'object') return;
      const cur = optionsGetPath(options, path);
      if (typeof cur === 'string' && Object.prototype.hasOwnProperty.call(map, cur))
         optionsSetPath(options, path, map[cur]);
   });

   Object.keys(revive || {}).forEach(path => {
      if (revive[path] !== 'regex') return;
      const cur = optionsGetPath(options, path);
      const next = reviveRegex(cur);
      if (typeof cur === 'string' && !(next instanceof RegExp)) {
         warnings.push({
            "code": 'optionsRegex',
            "message": `Could not revive ${path} as a regular expression`
         });
      }
      optionsSetPath(options, path, next);
   });

   return {
      "ok": !loaded.error,
      options,
      warnings,
      "source": {
         "file": loaded.error ? null : loaded.path,
         "eval": !!overlayObj,
         "configArg": flags.config || null
      },
      "error": loaded.error || null
   };
}

const ansiTags = [
   { "tag": "\/", "code": 0 }, // reset
   { "tag": "bold", "code": 1 },
   { "tag": "dim", "code": 2 },
   { "tag": "italic", "code": 3 },
   { "tag": "underline", "code": 4 },
   { "tag": "blink", "code": 5 },
   { "tag": "reverse", "code": 7 },
   { "tag": "hide", "code": 8 },
   { "tag": "strike", "code": 9 },
   { "tag": "black", "code": 30 },
   { "tag": "k", "code": 30 }, // black (CMYK)
   { "tag": "red", "code": 31 },
   { "tag": "r", "code": 31 },
   { "tag": "green", "code": 32 },
   { "tag": "g", "code": 32 }, // green
   { "tag": "yellow", "code": 33 },
   { "tag": "y", "code": 33 }, // yellow (CMYK)
   { "tag": "blue", "code": 34 },
   { "tag": "b", "code": 34 }, // blue
   { "tag": "magenta", "code": 35 },
   { "tag": "m", "code": 35 }, // magenta (CMYK)
   { "tag": "cyan", "code": 36 },
   { "tag": "c", "code": 36 }, // cyan (CMYK)
   { "tag": "white", "code": 37 },
   { "tag": "e", "code": 37 }, // light grey
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
   { "tag": "K", "code": 90 }, // bold black (CMYK)
   { "tag": "bright red", "code": 91 },
   { "tag": "R", "code": 91 }, // bold red
   { "tag": "bright green", "code": 92 },
   { "tag": "G", "code": 92 }, // bold green
   { "tag": "bright yellow", "code": 93 },
   { "tag": "Y", "code": 93 }, // bold yellow (CMYK)
   { "tag": "bright blue", "code": 94 },
   { "tag": "B", "code": 94 }, // bold blue
   { "tag": "bright magenta", "code": 95 },
   { "tag": "M", "code": 95 }, // bold magenta (CMYK)
   { "tag": "bright cyan", "code": 96 },
   { "tag": "C", "code": 96 }, // bold cyan (CMYK)
   { "tag": "bright white", "code": 97 },
   { "tag": "W", "code": 97 }, // bold white
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
// Plain object lookup (tag → CSI). Case-sensitive first so [R] is not eaten by [r].
const ANSI_TAG_RE = /\[(\/|bg bright \w+|bright \w+|bg \w+|\w+)\]/gi;
const ANSI_CSI_RE = /(?:\x1b\[(?:\d*[;]?[\d]*[;]?[\d]*)m)/gi;
const ansiTagCode = {};
ansiTags.forEach(({ tag, code }) => {
   ansiTagCode[tag] = code;
   const lower = tag.toLowerCase();
   if (ansiTagCode[lower] === undefined) ansiTagCode[lower] = code;
});

function ansiTagCodeOf(tag) {
   let code = ansiTagCode[tag];
   if (code === undefined) code = ansiTagCode[tag.toLowerCase()];
   return code;
}

function applyAnsiTags(text) {
   return text.replace(ANSI_TAG_RE, (all, tag) => {
      const code = ansiTagCodeOf(tag);
      return (code === undefined) ? all : `\x1b[${code}m`;
   });
}

function stripAnsiMarkup(text) {
   // Drop known colour tags only; keep [WARN]/[ERROR]/[NOTE] labels
   return text.replace(ANSI_TAG_RE, (all, tag) => (
      ansiTagCodeOf(tag) === undefined ? all : ''
   )).replace(ANSI_CSI_RE, '');
}

function formatLogArgs(args, isTTY) {
   const paint = isTTY ? applyAnsiTags : stripAnsiMarkup;
   return [...args].map(arg => typeof arg === 'string' ? paint(arg) : arg);
}

(console['log'] = (function() {
   /*
    *  overloading the console.log() method
    *  - add colour markup support for TTY output
    *  - strips [tags] and CSI from non-TTY output (never expand-then-strip)
    */
   const method = () => console;
   const fn = 'log';
   const _fn = '_' + fn;
   if (method()[fn].name !== 'modifiedLog') {
      method()[_fn] = method()[fn];
   }
   function modifiedLog() {
      return method()[_fn].apply(null, formatLogArgs(arguments, process.stdout.isTTY));
   };

   return modifiedLog;
})());

(() => {
   /*
    *  Runtime floors (see Notes). Integer major.minor — 2.10 is not 2.1.
    *  Flags only. Callers print (dbstats CLI) or fold them into warnings[].
    */
   const [, maj, min] = String(version()).match(/^(\d+)\.(\d+)/) || [0, 0, 0];
   const major = +maj, minor = +min;
   if (!((major === 1 && minor >= 10) || (major === 2 && minor >= 10) || major >= 3)) {
      __mdblibShellIncompatible = version();
   }
   // Server 4.4 floor waits for sessionSnapshot / ensureServerFloor (no
   // db.version() at load). Callers print or fold __mdblibServerUnsupported.
})();

// Import crypto module for Node.js/mongosh environments
// if (typeof crypto === 'undefined' && isMongosh()) {
//    const crypto = require('crypto');
//    global.crypto = crypto;
// }

/*
 *  Global defaults
 */

/*
 *  First-read globals. load() does not call hello, serverStatus, or features.
 *  One hello() fills both BSON limits. pid and nonce run only if something
 *  reads them. A preset own-property (for example --eval var bsonMax) is kept.
 */
function bsonLimits() {
   if (bsonLimits.cached) return bsonLimits.cached;
   const doc = hello() || {};
   bsonLimits.cached = {
      "bsonMax": (doc.ok && typeof doc.maxBsonObjectSize === 'number')
         ? doc.maxBsonObjectSize
         : 16 * Math.pow(1024, 2),
      "maxWriteBatchSize": (typeof doc.maxWriteBatchSize === 'undefined')
         ? 100000
         : doc.maxWriteBatchSize
   };
   return bsonLimits.cached;
}

function shellPid() {
   const status = serverStatus();
   const n = (status && status.ok) ? +status.pid : NaN;
   return Number.isFinite(n) ? n : $getRandInt(0, 99999);
}

function shellNonce() {
   /*
    *  Same mix as before. A missing oidMachine or a denied features command
    *  falls back to the pid so a read does not throw the shell.
    */
   let machine = '';
   try {
      const features = db.adminCommand({ "features": 1 });
      if (features && features.oidMachine != null) machine = String(features.oidMachine);
   } catch (_) {
      machine = '';
   }
   return (+(machine + String(pid))).toString(16).substring(0, 10);
}

function installLazyGlobal(name, read) {
   const holder = (typeof globalThis !== 'undefined') ? globalThis : this;
   if (Object.prototype.hasOwnProperty.call(holder, name)) return;
   let ready = false;
   let cached;
   Object.defineProperty(holder, name, {
      configurable: true,
      enumerable: true,
      get() {
         if (!ready) {
            cached = read();
            ready = true;
         }
         return cached;
      }
   });
}

installLazyGlobal('bsonMax', () => bsonLimits().bsonMax);
installLazyGlobal('maxWriteBatchSize', () => bsonLimits().maxWriteBatchSize);
installLazyGlobal('pid', shellPid);
installLazyGlobal('nonce', shellNonce);

if (typeof idiomas === 'undefined') (
   idiomas = ['none', 'da', 'nl', 'en', 'fi', 'fr', 'de', 'hu', 'it', 'nb', 'pt', 'ro', 'ru', 'es', 'sv', 'tr']
);

/*
 *  Helper classes
 */

const SCALE_METRICS = [ // array ordered by scale factor
   { "unit":      "bytes", "symbol":   "B", "factor": 1,                 "precision": 0, "pctPoint": 2 },
   { "unit":  "kibibytes", "symbol": "KiB", "factor": 1024,              "precision": 2, "pctPoint": 1 },
   { "unit":  "mebibytes", "symbol": "MiB", "factor": Math.pow(1024, 2), "precision": 2, "pctPoint": 1 },
   { "unit":  "gibibytes", "symbol": "GiB", "factor": Math.pow(1024, 3), "precision": 2, "pctPoint": 1 },
   { "unit":  "tebibytes", "symbol": "TiB", "factor": Math.pow(1024, 4), "precision": 2, "pctPoint": 1 },
   { "unit":  "pebibytes", "symbol": "PiB", "factor": Math.pow(1024, 5), "precision": 2, "pctPoint": 1 },
   { "unit":  "exbibytes", "symbol": "EiB", "factor": Math.pow(1024, 6), "precision": 2, "pctPoint": 1 }
];

class AutoFactor {
   /*
    *  Determine scale factor automatically.
    *  format() is the display path: non-finite is "unknown", negatives
    *  clamp to 0, and a value below 1 byte stays on the byte scale
    *  (log2 of (0, 1) is negative and used to index off the table).
    *  value() still rejects a non-finite or negative assignment.
    */
   constructor() {
      this.number = 0;
   }
   scale(number = this.number) {
      if (!(number >= 1)) return 0;
      return Math.min(Math.floor(Math.log2(number) / 10), SCALE_METRICS.length - 1);
   }
   factor(number = this.number) {
      return Math.pow(1024, this.scale(number));
   }
   metric(number = this.number) {
      return SCALE_METRICS[this.scale(number)];
   }
   format(number = this.number) {
      const n = Number(number);
      if (!Number.isFinite(n)) return 'unknown';
      const value = Math.max(0, n);
      this.number = value;
      const metric = this.metric(value);
      return `${+(value / metric.factor).toFixed(metric.precision)} ${metric.symbol}`;
   }
   value(number) {
      const n = Number(number);
      if (Number.isFinite(n) && n >= 0) {
         this.number = n;
      } else {
         throw new Error(`Invalid scalar value or number type for AutoFactor: ${number}`);
      }
      return this.number;
   }
   get metrics() {
      return SCALE_METRICS;
   }
}

function toStatsNumber(value, fallback = 0) {
   if (value == null || value === '') return fallback;
   if (typeof value === 'object' && typeof value.toNumber === 'function') value = value.toNumber();
   const n = +value;
   return Number.isFinite(n) ? n : fallback;
}

function toNullableBytes(value) {
   if (value == null || value === '') return null;
   if (typeof value === 'object' && typeof value.toNumber === 'function') value = value.toNumber();
   const n = +value;
   return Number.isFinite(n) ? n : null;
}

function isNumericCount(value) {
   if (typeof value === 'number') return Number.isFinite(value);
   if (typeof value === 'object' && value !== null && typeof value.toNumber === 'function') {
      return Number.isFinite(value.toNumber());
   }
   return false;
}

function isShardCountArray(value) {
   /*
    *  Per-shard numeric counts. Empty [] stays an array — never coerce via
    *  == 0 ([] == 0 is true in JS and used to collapse sharded empty to a scalar).
    */
   return Array.isArray(value) && value.every(v => v == null || isNumericCount(v));
}

function parseCount(value, fallback = 0) {
   if (isShardCountArray(value)) return value.map(v => toStatsNumber(v, 0));
   if (isNumericCount(value)) return toStatsNumber(value, fallback);
   return fallback;
}

function parseNamespaceCount(primary, secondary, fallback = 0) {
   if (primary !== -1 && (isShardCountArray(primary) || isNumericCount(primary))) {
      return parseCount(primary, fallback);
   }
   if (secondary !== -1 && (isShardCountArray(secondary) || isNumericCount(secondary))) {
      return parseCount(secondary, fallback);
   }
   return fallback;
}

function parseIndexStats(raw = {}) {
   /*
    *  $collStats merged index row → IndexStatsDTO.
    */
   const src = raw || {};
   return {
      "name": src.name != null ? String(src.name) : '',
      "storageSize": toStatsNumber(src.storageSize, 0),
      "freeStorageSize": toNullableBytes(src.freeStorageSize),
      "freeStorageComplete": src.freeStorageComplete !== false
   };
}

function parseCollStats(raw = {}) {
   /*
    *  Normalised $collStats document → CollStatsDTO.
    *  indexes is always IndexStatsDTO[]; nindexes is the counter (shard sum).
    */
   const src = raw || {};
   const indexes = Array.isArray(src.indexes) ? src.indexes.filter(Boolean).map(parseIndexStats) : [];
   const nindexes = (src.nindexes !== undefined && src.nindexes !== -1)
      ? toStatsNumber(src.nindexes, indexes.length)
      : indexes.length;
   const internalPageSize = src.internalPageSize;
   return {
      "name": src.name != null ? String(src.name) : '',
      "dataSize": toStatsNumber(src.dataSize, 0),
      "storageSize": toStatsNumber(src.storageSize, 0),
      "freeStorageSize": toNullableBytes(src.freeStorageSize),
      "objects": toStatsNumber(src.objects, 0),
      "orphans": toStatsNumber(src.orphans, 0),
      "compressor": src.compressor != null ? src.compressor : 'none',
      "internalPageSize": internalPageSize,
      "allocUnit": (typeof internalPageSize === 'number' && internalPageSize > 0)
                 ? internalPageSize
                 : WIREDTIGER_MIN_ALLOC_SIZE,
      "indexes": indexes,
      "nindexes": nindexes,
      "totalIndexSize": toStatsNumber(src.totalIndexSize, 0),
      "totalIndexBytesReusable": toNullableBytes(src.totalIndexBytesReusable),
      "freeStorageComplete": src.freeStorageComplete !== false,
      "totalIndexBytesReusableComplete": src.totalIndexBytesReusableComplete !== false,
      "statsIncomplete": src.statsIncomplete === true,
      "statsError": src.statsError || null
   };
}

function parseDbStats(raw = {}) {
   /*
    *  Normalised $stats document → DbStatsDTO.
    *  ncollections / nviews / nindexes / namespaces are counts (scalar or
    *  per-shard array). db.stats() names the index count indexes; that
    *  feeds nindexes only. Catalog lists start empty on the entity
    *  (collections / views); collection.indexes is IndexStats[].
    */
   const src = raw || {};
   const nindexes = parseNamespaceCount(
      (src.nindexes !== undefined && src.nindexes !== -1) ? src.nindexes : undefined,
      src.indexes,
      0
   );
   return {
      "name": src.name != null ? String(src.name) : '',
      "dataSize": toStatsNumber(src.dataSize, 0),
      "storageSize": toStatsNumber(src.storageSize, 0),
      "freeStorageSize": toNullableBytes(src.freeStorageSize),
      "objects": toStatsNumber(src.objects, 0),
      "orphans": toStatsNumber(src.orphans, 0),
      "ncollections": parseNamespaceCount(src.collections, src.ncollections, 0),
      "nviews": parseNamespaceCount(src.views, src.nviews, 0),
      "namespaces": parseNamespaceCount(src.namespaces, undefined, 0),
      "nindexes": nindexes,
      "totalIndexSize": toStatsNumber(src.indexSize, toStatsNumber(src.totalIndexSize, 0)),
      "totalIndexBytesReusable": toNullableBytes(
         src.totalIndexBytesReusable != null ? src.totalIndexBytesReusable : src.indexFreeStorageSize
      ),
      "fsUsedSize": toNullableBytes(src.fsUsedSize),
      "fsTotalSize": toNullableBytes(src.fsTotalSize),
      "statsError": src.statsError || null,
      "unauthorized": src.unauthorized === true
   };
}

function parseViewRef(raw = {}) {
   const src = raw || {};
   return {
      "name": src.name != null ? String(src.name) : '',
      "type": src.type != null ? src.type : 'view'
   };
}

class StorageMetrics {
   /*
    *  Shared storage fields and compression ratio.
    *  freeStorageSize null = unknown; 0 = empty free list; storageSize 0 is measured.
    */
   constructor({
         dataSize = 0, storageSize = 0, freeStorageSize = null,
         objects = 0, orphans = 0,
         totalIndexSize = 0, totalIndexBytesReusable = null
      } = {}) {
      this.dataSize = dataSize;
      this.storageSize = storageSize;
      this.freeStorageSize = freeStorageSize;
      this.objects = objects;
      this.orphans = orphans;
      this.totalIndexSize = totalIndexSize;
      this.totalIndexBytesReusable = totalIndexBytesReusable;
   }
   get compression() {
      if (this.freeStorageSize == null || Number.isNaN(+this.freeStorageSize)) return NaN;
      const denom = +this.storageSize - +this.freeStorageSize;
      if (!(denom > 0)) return NaN;
      return this.dataSize / denom;
   }
}

class IndexStats {
   constructor(dto = {}) {
      const src = parseIndexStats(dto);
      this.name = src.name;
      this.storageSize = src.storageSize;
      this.freeStorageSize = src.freeStorageSize;
      this.freeStorageComplete = src.freeStorageComplete;
   }
}

class ViewRef {
   constructor(dto = {}) {
      const src = parseViewRef(dto);
      this.name = src.name;
      this.type = src.type;
   }
}

class CollectionStats extends StorageMetrics {
   /*
    *  Catalog identity first (name, type, dbName). Storage fields stay at
    *  constructor defaults until fetchStats / applyCollStats. type is kept
    *  so listedCollectionCount can exclude timeseries after stats land.
    */
   constructor(dto = {}) {
      super(dto);
      this.name = dto.name || '';
      this.dbName = dto.dbName || '';
      this.type = dto.type != null && dto.type !== '' ? dto.type : 'collection';
      this.compressor = dto.compressor != null ? dto.compressor : 'none';
      this.internalPageSize = dto.internalPageSize;
      this.allocUnit = (typeof dto.allocUnit === 'number' && dto.allocUnit > 0)
                     ? dto.allocUnit
                     : ((typeof dto.internalPageSize === 'number' && dto.internalPageSize > 0)
                        ? dto.internalPageSize
                        : WIREDTIGER_MIN_ALLOC_SIZE);
      this.indexes = Array.isArray(dto.indexes)
         ? dto.indexes.map(idx => (idx instanceof IndexStats) ? idx : new IndexStats(idx))
         : [];
      this.nindexes = dto.nindexes != null ? dto.nindexes : this.indexes.length;
      this.freeStorageComplete = dto.freeStorageComplete !== false;
      this.totalIndexBytesReusableComplete = dto.totalIndexBytesReusableComplete !== false;
      this.statsIncomplete = dto.statsIncomplete === true;
      this.statsError = dto.statsError || null;
      this.statsLoaded = dto.statsLoaded === true;
      Object.defineProperty(this, '_statsPromise', {
         "value": null,
         "writable": true,
         "enumerable": false,
         "configurable": true
      });
   }
   static catalogEntry({ name = '', type = 'collection', dbName = '', shards = null } = {}) {
      const collection = new CollectionStats({
         "name": name || '',
         "type": type != null && type !== '' ? type : 'collection',
         "dbName": dbName || '',
         "statsLoaded": false
      });
      if (Array.isArray(shards) && shards.length) {
         Object.defineProperty(collection, 'catalogShards', {
            "value": shards.filter(id => typeof id === 'string' && id.length),
            "enumerable": false
         });
      }
      return collection;
   }
   static from(raw, nameFallback = '') {
      const dto = parseCollStats(raw || {});
      if (nameFallback && !dto.name) dto.name = nameFallback;
      const collection = new CollectionStats(dto);
      collection.statsLoaded = true;
      return collection;
   }
   applyCollStats(raw, nameFallback = '') {
      const dto = parseCollStats(raw || {});
      this.dataSize = dto.dataSize;
      this.storageSize = dto.storageSize;
      this.freeStorageSize = dto.freeStorageSize;
      this.objects = dto.objects;
      this.orphans = dto.orphans;
      this.totalIndexSize = dto.totalIndexSize;
      this.totalIndexBytesReusable = dto.totalIndexBytesReusable;
      this.name = dto.name || nameFallback || this.name;
      this.compressor = dto.compressor != null ? dto.compressor : 'none';
      this.internalPageSize = dto.internalPageSize;
      this.allocUnit = (typeof dto.allocUnit === 'number' && dto.allocUnit > 0)
                     ? dto.allocUnit
                     : ((typeof dto.internalPageSize === 'number' && dto.internalPageSize > 0)
                        ? dto.internalPageSize
                        : WIREDTIGER_MIN_ALLOC_SIZE);
      this.indexes = Array.isArray(dto.indexes)
         ? dto.indexes.map(idx => (idx instanceof IndexStats) ? idx : new IndexStats(idx))
         : [];
      this.nindexes = dto.nindexes != null ? dto.nindexes : this.indexes.length;
      this.freeStorageComplete = dto.freeStorageComplete !== false;
      this.totalIndexBytesReusableComplete = dto.totalIndexBytesReusableComplete !== false;
      this.statsIncomplete = dto.statsIncomplete === true;
      this.statsError = dto.statsError || null;
      this.statsLoaded = true;
      return this;
   }
   fetchStats(dbName, owningShardCache) {
      if (this.statsLoaded) return Promise.resolve(this);
      if (this._statsPromise) return this._statsPromise;
      const collName = this.name;
      if (dbName) this.dbName = dbName;
      const nsDb = this.dbName
         || ((typeof db !== 'undefined' && db && typeof db.getName === 'function')
            ? db.getName()
            : '');
      if (owningShardCache instanceof Map && Array.isArray(this.catalogShards) && this.catalogShards.length) {
         const ns = `${nsDb}.${collName}`;
         if (!owningShardCache.has(ns)) owningShardCache.set(ns, this.catalogShards.slice());
      }
      this._statsPromise = (async () => {
         try {
            const raw = await $collStats(nsDb, collName, owningShardCache) || { "name": collName };
            this.applyCollStats(raw, collName);
         } catch (_) {
            this.applyCollStats({ "name": `${collName} (unavailable)` }, collName);
         }
         return this;
      })();
      return this._statsPromise;
   }
}

class DatabaseStats extends StorageMetrics {
   constructor(dto = {}) {
      super(dto);
      this.name = dto.name || '';
      this.collections = Array.isArray(dto.collections) ? dto.collections : [];
      this.views = Array.isArray(dto.views) ? dto.views : [];
      this.ncollections = dto.ncollections != null ? dto.ncollections : 0;
      this.nviews = dto.nviews != null ? dto.nviews : 0;
      this.namespaces = dto.namespaces != null ? dto.namespaces : 0;
      this.nindexes = dto.nindexes != null ? dto.nindexes : 0;
      this.shards = Array.isArray(dto.shards) ? dto.shards : [];
      this.fsUsedSize = dto.fsUsedSize != null ? dto.fsUsedSize : null;
      this.fsTotalSize = dto.fsTotalSize != null ? dto.fsTotalSize : null;
      this.statsError = dto.statsError || null;
      this.unauthorized = dto.unauthorized === true;
   }
   static from(raw, extra = {}) {
      const database = new DatabaseStats(parseDbStats(raw || {}));
      if (Array.isArray(extra.shards)) database.shards = extra.shards;
      return database;
   }
   applyDbStats(raw) {
      /*
       *  Merge $stats onto this DB. Leaves collections/views in place so
       *  catalog listing can overlap the stats fetch.
       */
      const dto = parseDbStats(raw || {});
      if (dto.name) this.name = dto.name;
      this.dataSize = dto.dataSize;
      this.storageSize = dto.storageSize;
      this.freeStorageSize = dto.freeStorageSize;
      this.objects = dto.objects;
      this.orphans = dto.orphans;
      this.ncollections = dto.ncollections;
      this.nviews = dto.nviews;
      this.namespaces = dto.namespaces;
      this.nindexes = dto.nindexes;
      this.totalIndexSize = dto.totalIndexSize;
      this.totalIndexBytesReusable = dto.totalIndexBytesReusable;
      this.fsUsedSize = dto.fsUsedSize != null ? dto.fsUsedSize : null;
      this.fsTotalSize = dto.fsTotalSize != null ? dto.fsTotalSize : null;
      this.statsError = dto.statsError || null;
      this.unauthorized = dto.unauthorized === true;
      return this;
   }
   catalogTargets() {
      const dbName = this.name;
      this.collections = (this.collections || []).map(entry => {
         if (entry instanceof CollectionStats) {
            if (!entry.dbName) entry.dbName = dbName;
            return entry;
         }
         const shards = (entry && Array.isArray(entry.catalogShards))
            ? entry.catalogShards
            : (entry && entry.shards);
         return CollectionStats.catalogEntry({
            "name": entry && entry.name,
            "type": entry && entry.type,
            "dbName": dbName,
            "shards": shards
         });
      });
      return this.collections.filter(c => c && c.name && c.type !== 'view');
   }
   async fetchAllStats({ concurrency, onProgress, owningShardCache } = {}) {
      /*
       *  Bounded $collStats pool for this DB. Views stay nameOnly.
       *  Wraps plain {name,type} catalog rows as CollectionStats shells.
       *  owningShardCache is the gather Map (materialize passes one for the
       *  whole walk). A direct call gets a Map that dies with this call.
       */
      const dbName = this.name;
      const shardCache = (owningShardCache instanceof Map) ? owningShardCache : new Map();
      const targets = this.catalogTargets();
      const pool = (Number.isFinite(+concurrency) && +concurrency > 0)
         ? Math.floor(+concurrency)
         : 8;
      if (targets.length) {
         await mapPool(targets, pool, coll => coll.fetchStats(dbName, shardCache), onProgress);
      }
      return this;
   }
}

const CHILD_CONNECT_TIMEOUT_MS = 5000;

function parseReplSetHosts(hostString) {
   const { setName = null, seedList = null } = /^(?<setName>[^/]+)\/(?<seedList>.+)$/.exec(hostString)?.groups || {};
   if (!setName || !seedList) throw new Error(`Invalid replSet connection string: ${hostString}`);
   return { setName, seedList };
}

function replicaSeedHosts(host) {
   const s = String(host || '');
   if (!s) return [];
   if (s.includes('/')) {
      try {
         return parseReplSetHosts(s).seedList.split(',').map(x => x.trim()).filter(Boolean);
      } catch (_) {
         return [s];
      }
   }
   return [s];
}

function decomposeParentUri(rawUri) {
   /*
    *  Parent session URI → parts for rebuilding legacy mongodb:// child URIs.
    *  Public Mongo.getURI(); mongosh _uri is private and can lag.
    *  WHATWG URL rejects comma-separated hosts: parse userinfo/query via the
    *  first host. Do not log the URI.
    */
   if (rawUri == null || rawUri === '') {
      rawUri = db.getMongo().getURI();
   }
   if (!rawUri || typeof rawUri !== 'string') {
      throw new Error('decomposeParentUri: missing parent URI');
   }
   const isSrv = /^mongodb\+srv:/i.test(rawUri);
   const parseable = rawUri.replace(/^mongodb\+srv:/i, 'mongodb:');
   const withoutScheme = parseable.replace(/^mongodb:\/\//i, '');
   const authEnd = withoutScheme.search(/[/?]/);
   const authority = authEnd >= 0 ? withoutScheme.slice(0, authEnd) : withoutScheme;
   const at = authority.lastIndexOf('@');
   const hosts = at >= 0 ? authority.slice(at + 1) : authority;
   const userinfo = at >= 0 ? authority.slice(0, at + 1) : '';
   const rest = authEnd >= 0 ? withoutScheme.slice(authEnd) : '/';
   const firstHost = (hosts.split(',')[0] || '').trim() || 'localhost';
   let url;
   try {
      url = new URL(`mongodb://${userinfo}${firstHost}${rest || '/'}`);
   } catch (e) {
      throw new Error(`decomposeParentUri: cannot parse parent URI (${e.message})`);
   }
   const searchParams = new URLSearchParams(url.searchParams);
   searchParams.delete('srvMaxHosts');
   searchParams.delete('srvServiceName');
   searchParams.delete('srvQueryTimeoutMS');
   return {
      "isSrv": isSrv,
      "username": url.username || '',
      "password": url.password || '',
      "pathname": url.pathname && url.pathname.length ? url.pathname : '/',
      "searchParams": searchParams,
      "hosts": hosts || url.host || ''
   };
}

function formatLegacyMongoUri({ username = '', password = '', hosts, pathname = '/', searchParams } = {}) {
   /*
    *  Always mongodb://. Re-encode userinfo: URL() may return decoded or
    *  already-percent-encoded username/password depending on Node.
    */
   if (!hosts) throw new Error('formatLegacyMongoUri: hosts required');
   const encodePart = (value) => {
      let decoded = String(value);
      try { decoded = decodeURIComponent(decoded); } catch (_) { /* keep raw */ }
      return encodeURIComponent(decoded);
   };
   let auth = '';
   if (username) {
      auth = encodePart(username);
      if (password !== '' && password != null) auth += `:${encodePart(password)}`;
      auth += '@';
   }
   const path = pathname || '/';
   const q = searchParams && searchParams.toString ? searchParams.toString() : '';
   return `mongodb://${auth}${hosts}${path}${q ? `?${q}` : ''}`;
}

function childMongoUri(host, { parent } = {}) {
   /*
    *  Child mongodb:// to one advertised member (direct) or a shard replica
    *  set (setName/seedList). SRV parent without tls/ssl forces tls.
    *  Drop loadBalanced. Do not log the URI. No socketTimeoutMS — $collStats
    *  on the child can run longer than connect.
    */
   const parts = parent || decomposeParentUri();
   const params = new URLSearchParams(parts.searchParams);
   params.delete('tags');
   params.delete('readPreferenceTags');
   params.delete('maxStalenessSeconds');
   params.delete('minPoolSize');
   params.delete('readPreference');
   params.delete('loadBalanced');
   params.set('maxPoolSize', '2');
   params.set('serverSelectionTimeoutMS', String(CHILD_CONNECT_TIMEOUT_MS));
   params.set('connectTimeoutMS', String(CHILD_CONNECT_TIMEOUT_MS));
   if (parts.isSrv && !params.has('tls') && !params.has('ssl')) {
      params.set('tls', 'true');
   }
   const spec = String(host || '');
   let hosts;
   if (spec.includes('/')) {
      const { setName, seedList } = parseReplSetHosts(spec);
      params.set('replicaSet', setName);
      params.set('directConnection', 'false');
      params.set('readPreference', 'primaryPreferred');
      hosts = seedList;
   } else {
      params.delete('replicaSet');
      params.set('directConnection', 'true');
      params.set('readPreference', 'primaryPreferred');
      hosts = spec;
   }
   if (!hosts) throw new Error('child host is empty');
   params.sort();
   return formatLegacyMongoUri({
      "username": parts.username,
      "password": parts.password,
      "hosts": hosts,
      "pathname": parts.pathname,
      "searchParams": params
   });
}

function openChildMongo(uri) {
   if (typeof Mongo === 'function') return new Mongo(uri);
   const handle = connect(uri);
   return (handle && typeof handle.getMongo === 'function') ? handle.getMongo() : handle;
}

function closeChildMongo(mongo) {
   try {
      if (mongo && typeof mongo.close === 'function') mongo.close();
   } catch (_) { /* already closed */ }
}

async function withChildSession(mongo, fn) {
   /*
    *  Serial global-db swap so $stats / $collStats / listCatalogSnapshot
    *  reuse the current session. Restores db, sessionSnapshot (including
    *  hello / serverVer sidecars), and __collStatsOnMongos. Not mdblib.for(db).
    */
   const parentDb = db;
   const parentSnap = sessionSnapshot.cached;
   const parentHello = sessionSnapshot.helloDoc;
   const parentVer = sessionSnapshot.serverVerParsed;
   const parentVerStr = sessionSnapshot.serverVerString;
   const parentCollStats = __collStatsOnMongos;
   try {
      db = mongo.getDB(parentDb.getName());
      sessionSnapshot.cached = null;
      sessionSnapshot.helloDoc = null;
      sessionSnapshot.serverVerParsed = null;
      sessionSnapshot.serverVerString = null;
      __collStatsOnMongos = undefined;
      return await fn();
   } finally {
      db = parentDb;
      sessionSnapshot.cached = parentSnap;
      sessionSnapshot.helloDoc = parentHello;
      sessionSnapshot.serverVerParsed = parentVer;
      sessionSnapshot.serverVerString = parentVerStr;
      __collStatsOnMongos = parentCollStats;
   }
}

class HostNode {
   /*
    *  Host identity. init() / discover() fill a session (connecting by
    *  default). Remote members are constructor fields until
    *  TopologySnapshot.materializeNodes() connects.
    */
   constructor({
         instance, hostname, proc, dbPath, shards = [], role, connecting, stats = null
      } = {}) {
      this.instance = instance;
      this.hostname = hostname;
      this.proc = proc;
      this.dbPath = dbPath;
      this.shards = Array.isArray(shards) ? shards : [];
      this.role = role;
      this.connecting = connecting === true;
      this.stats = stats || null;
      this.error = null;
   }
   init({ connecting = true, preserveInstance = false } = {}) {
      const advertised = this.instance;
      const snap = sessionSnapshot();
      const helloDoc = snap.helloDoc || hello();
      this.instance = (snap.atlasPlatform === 'serverless') ? 'serverless'
                    : (snap.sharded) ? 'sharded'
                    : helloDoc.me;
      if (preserveInstance && advertised != null) this.instance = advertised;
      this.hostname = snap.hostname;
      this.proc = snap.proc;
      this.dbPath = (snap.atlasPlatform === 'serverless') ? 'serverless'
                  : (snap.atlasPlatform === 'sharedTier') ? 'sharedTier'
                  : (this.proc === 'mongod') ? serverCmdLineOpts().parsed.storage.dbPath
                  : (this.proc === 'mongos') ? 'sharded'
                  : 'unknown';
      if (this.proc === 'mongos') {
         this.shards = Array.isArray(snap.shardIds)
            ? snap.shardIds
            : db.adminCommand({ "listShards": 1 }).shards.map(({ _id }) => _id);
      } else if (!Array.isArray(this.shards) || this.shards.length === 0) {
         this.shards = [];
      }
      this.connecting = connecting === true;
      return this;
   }
   static discover() {
      return new HostNode().init();
   }
}

function resolveTopologyDepth({ depth, replica, sharded } = {}) {
   /*
    *  One gather depth. Cluster kind selects the walk.
    *  replica / sharded remain aliases of depth.
    */
   const vals = [depth, replica, sharded];
   for (let i = 0; i < vals.length; i++) {
      if (String(vals[i] || '').toLowerCase() === 'expanded') return 'expanded';
   }
   return 'summary';
}

class TopologySnapshot {
   /*
    *  Cluster identity from the connecting session; per-node stats via
    *  materializeNodes({ depth }) (discovery-style child Mongo(), not load()).
    *  Do not gather mongos local.* from the router.
    */
   constructor({
         cluster = {}, connecting = null, nodes = [], aggregate = null, errors = []
      } = {}) {
      this.cluster = (cluster && typeof cluster === 'object') ? cluster : {};
      this.connecting = (connecting instanceof HostNode) ? connecting : connecting;
      this.nodes = Array.isArray(nodes) ? nodes : [];
      this.aggregate = aggregate;
      this.errors = Array.isArray(errors) ? errors : [];
   }
   static fromSession() {
      const snap = sessionSnapshot();
      const connecting = HostNode.discover();
      const errors = [];
      let helloDoc = snap.helloDoc;
      if (!helloDoc) {
         try {
            helloDoc = hello() || {};
         } catch (e) {
            errors.push({
               "step": "hello",
               "message": (e && (e.errmsg || e.message)) || String(e)
            });
            helloDoc = {};
         }
      }
      if (connecting.proc === 'mongos') connecting.role = 'mongos';
      else if (helloDoc.isWritablePrimary) connecting.role = 'PRIMARY';
      else if (helloDoc.secondary) connecting.role = 'SECONDARY';

      const atlas = snap.atlasPlatform;
      const kind = (atlas === 'sharedTier') ? 'sharedTier'
                 : (atlas === 'serverless') ? 'serverless'
                 : (snap.sharded) ? 'sharded'
                 : (helloDoc.setName) ? 'replSet'
                 : 'standalone';
      const cluster = {
         "kind": kind,
         "setName": helloDoc.setName || null,
         "shardIds": Array.isArray(snap.shardIds) ? snap.shardIds.slice() : []
      };

      const nodes = [connecting];
      const seen = new Set([connecting.instance]);
      const pushNode = node => {
         if (!node || node.instance == null || seen.has(node.instance)) return;
         seen.add(node.instance);
         nodes.push(node);
      };

      if (kind === 'sharedTier' || kind === 'serverless') {
         // One connecting node: Atlas M0/Flex advertise a replica set, but
         // compact / autoCompact cannot run on these tiers. Serverless has
         // no replica seed list.
         return new TopologySnapshot({ cluster, connecting, nodes, errors });
      }

      if (kind === 'replSet') {
         const names = [];
         if (Array.isArray(helloDoc.hosts)) names.push(...helloDoc.hosts);
         if (Array.isArray(helloDoc.passives)) names.push(...helloDoc.passives);
         const primary = helloDoc.primary;
         names.forEach(name => {
            pushNode(new HostNode({
               "instance": name,
               "hostname": hostNameFromHostPort(name),
               "proc": 'mongod',
               "shards": [],
               "role": (name === primary) ? 'PRIMARY' : 'SECONDARY',
               "connecting": false
            }));
         });
      }

      if (kind === 'sharded') {
         let shardDocs = [];
         try {
            shardDocs = db.adminCommand({ "listShards": 1 }).shards;
         } catch (e) {
            errors.push({
               "step": "listShards",
               "message": (e && (e.errmsg || e.message)) || String(e)
            });
            shardDocs = [];
         }
         if (Array.isArray(shardDocs)) {
            shardDocs.forEach(doc => {
               if (!doc) return;
               pushNode(new HostNode({
                  "instance": doc.host || doc._id,
                  "hostname": doc._id,
                  "proc": 'mongod',
                  "shards": doc._id != null ? [doc._id] : [],
                  "connecting": false
               }));
            });
         }
      }

      return new TopologySnapshot({ cluster, connecting, nodes, errors });
   }
   static discover() {
      return TopologySnapshot.fromSession();
   }
   expandShardedMembers() {
      /*
       *  Replace listShards seed-list nodes with one HostNode per seed host.
       *  Connecting mongos stays. Used when sharded depth is expanded.
       */
      const connecting = this.connecting;
      const out = connecting ? [connecting] : [];
      const seen = new Set(out.map(n => n.instance));
      const pushNode = node => {
         if (!node || node.instance == null || seen.has(node.instance)) return;
         seen.add(node.instance);
         out.push(node);
      };
      (this.nodes || []).forEach(node => {
         if (!node || node.connecting) return;
         const hosts = replicaSeedHosts(node.instance);
         if (!hosts.length) {
            pushNode(node);
            return;
         }
         hosts.forEach(host => {
            pushNode(new HostNode({
               "instance": host,
               "hostname": hostNameFromHostPort(host),
               "proc": 'mongod',
               "shards": Array.isArray(node.shards) ? node.shards.slice() : [],
               "connecting": false
            }));
         });
      });
      this.nodes = out;
      return this;
   }
   async materializeNodes({ depth, replica, sharded, gather, onProgress } = {}) {
      /*
       *  Connect to advertised remotes and run gather(node) on each child
       *  session. Serial (global db). Shared-tier / serverless / standalone
       *  are a no-op (M0/Flex compact/autoCompact cannot run; serverless has
       *  no replica seeds). Connecting node is skipped (already topology.aggregate).
       *  depth summary = $stats-depth gather; expanded = full catalog +
       *  $collStats (gather callback decides). Cluster kind selects the walk.
       *  replica / sharded alias depth. Sharded expanded fans out seed hosts.
       */
      const kind = (this.cluster && this.cluster.kind) || '';
      if (kind === 'sharedTier' || kind === 'serverless' || kind === 'standalone') {
         return this;
      }
      if (typeof gather !== 'function') {
         throw new Error('TopologySnapshot.materializeNodes requires gather');
      }
      depth = resolveTopologyDepth({ depth, replica, sharded });
      if (kind === 'sharded' && depth === 'expanded') this.expandShardedMembers();

      let parent;
      try {
         parent = decomposeParentUri(db.getMongo().getURI());
      } catch (e) {
         this.errors.push({
            "step": "parentUri",
            "message": (e && (e.errmsg || e.message)) || String(e)
         });
         return this;
      }

      const targets = (this.nodes || []).filter(n => n && n.connecting !== true);
      for (let i = 0; i < targets.length; i++) {
         const node = targets[i];
         if (typeof onProgress === 'function') {
            onProgress({ node, index: i, total: targets.length, depth });
         }
         await this.connectAndGather(node, { parent, gather, depth });
      }
      return this;
   }
   async connectAndGather(node, { parent, gather, depth } = {}) {
      const host = node && node.instance;
      if (!host || host === 'sharded' || host === 'serverless' || host === 'sharedTier') {
         const message = 'no child host';
         node.error = message;
         this.errors.push({ "step": "connect", "instance": host || null, "message": message });
         return node;
      }
      let mongo;
      try {
         mongo = openChildMongo(childMongoUri(host, { parent }));
         await withChildSession(mongo, async () => {
            const keepShards = Array.isArray(node.shards) ? node.shards.slice() : [];
            node.init({ "connecting": false, "preserveInstance": true });
            if (keepShards.length && node.proc !== 'mongos') node.shards = keepShards;
            let helloDoc = {};
            try { helloDoc = hello() || {}; } catch (_) { helloDoc = {}; }
            if (node.proc === 'mongos') node.role = 'mongos';
            else if (helloDoc.isWritablePrimary) node.role = 'PRIMARY';
            else if (helloDoc.secondary) node.role = 'SECONDARY';
            node.stats = await gather(node, { depth });
            node.error = null;
         });
      } catch (e) {
         const message = (e && (e.errmsg || e.message)) || String(e);
         node.error = message;
         node.stats = null;
         this.errors.push({
            "step": "gather",
            "instance": node.instance || host,
            "message": message
         });
      } finally {
         closeChildMongo(mongo);
      }
      return node;
   }
}

class DbPathStats extends StorageMetrics {
   constructor(dto = {}) {
      super(dto);
      this.databases = Array.isArray(dto.databases) ? dto.databases : [];
      this.ncollections = dto.ncollections != null ? dto.ncollections : 0;
      this.nviews = dto.nviews != null ? dto.nviews : 0;
      this.namespaces = dto.namespaces != null ? dto.namespaces : 0;
      this.nindexes = dto.nindexes != null ? dto.nindexes : 0;
      this.fsUsedSize = dto.fsUsedSize != null ? dto.fsUsedSize : null;
      this.fsTotalSize = dto.fsTotalSize != null ? dto.fsTotalSize : null;
      this.host = (dto.host instanceof HostNode)
         ? dto.host
         : new HostNode(dto.host || {
            "instance": dto.instance,
            "hostname": dto.hostname,
            "proc": dto.proc,
            "dbPath": dto.dbPath,
            "shards": dto.shards
         });
   }
   init() {
      if (!(this.host instanceof HostNode)) this.host = new HostNode();
      this.host.init();
      return this;
   }
   get instance() { return this.host && this.host.instance; }
   get hostname() { return this.host && this.host.hostname; }
   get proc() { return this.host && this.host.proc; }
   get dbPath() { return this.host && this.host.dbPath; }
   get shards() { return (this.host && this.host.shards) || []; }
   async materialize({ concurrency, onProgress, onDatabase } = {}) {
      /*
       *  Global $collStats in-flight cap. onDatabase runs when each DB's
       *  collections complete (sort + free-space rollup). Views stay
       *  nameOnly. $stats is the caller's (applyDbStats / fetchDbStats).
       */
      const pool = (Number.isFinite(+concurrency) && +concurrency > 0)
         ? Math.floor(+concurrency)
         : 8;
      const owningShardCache = new Map();
      const work = [];
      for (const database of (this.databases || [])) {
         const targets = database.catalogTargets();
         if (!targets.length) {
            if (typeof onDatabase === 'function') onDatabase(database);
            continue;
         }
         const state = { database, remaining: targets.length };
         for (const coll of targets) work.push({ state, coll });
      }
      if (!work.length) return this;
      let hudDb = work[0].state.database;
      await mapPool(work, pool, async ({ state, coll }) => {
         hudDb = state.database;
         try {
            await coll.fetchStats(state.database.name, owningShardCache);
         } finally {
            state.remaining--;
            if (state.remaining === 0 && typeof onDatabase === 'function') {
               onDatabase(state.database);
            }
         }
      }, (typeof onProgress === 'function')
         ? (p => onProgress({ "database": hudDb, ...p }))
         : undefined);
      return this;
   }
}

function formatHudTime(s) {
   if (!Number.isFinite(s) || s < 0) return '--';
   const sec = Math.max(0, Math.floor(s));
   const m = Math.floor(sec / 60);
   const r = sec % 60;
   return m > 0 ? `${m}m${r}s` : `${r}s`;
}

class MiniHud {
   /*
    *  Single-line TTY progress. process.stdout.write('\\r'), never console.log.
    *  Disabled for json / non-TTY. clear() before the report so the bar is gone.
    */
   constructor({ enabled = false, throttleMs = 100 } = {}) {
      this.enabled = !!(enabled && typeof process !== 'undefined' && process.stdout && process.stdout.isTTY);
      this.throttleMs = throttleMs;
      this.lastWrite = 0;
      this.lastWidth = 0;
      this.startTime = Date.now();
   }

   bar(frac, width = 16) {
      const n = Math.max(1, width);
      const p = Number.isFinite(frac) ? Math.min(1, Math.max(0, frac)) : 0;
      const filled = Math.round(p * n);
      return '█'.repeat(filled) + '░'.repeat(n - filled);
   }

   render(line, { force = false } = {}) {
      if (!this.enabled) return;
      const now = Date.now();
      if (!force && now - this.lastWrite < this.throttleMs) return;
      this.lastWrite = now;
      const cols = (process.stdout.columns > 0) ? process.stdout.columns : 80;
      let msg = String(line || '').replace(/\s+/g, ' ').trim();
      let visual = stripAnsiMarkup(msg);
      const max = Math.max(1, cols - 1);
      if (visual.length > max) {
         visual = visual.slice(0, Math.max(1, cols - 2)) + '~';
         msg = visual;
      }
      const painted = applyAnsiTags(msg + '[/]');
      process.stdout.write('\r' + painted + '\x1b[K');
      this.lastWidth = visual.length;
   }

   clear() {
      if (!this.enabled || this.lastWidth === 0) return;
      process.stdout.write('\r\x1b[2K');
      this.lastWidth = 0;
   }
}

async function mapPool(items, concurrency, worker, onProgress) {
   /*
    *  Bounded async pool. Single-threaded next++ is safe. Yields before and after
    *  each item so sibling workers can start and the HUD can paint between
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

function formatTime(s) {
   return formatHudTime(s);
}

function $rand() {
   /*
    *  Preferred PRNG (Web Crypto)
    */
   return crypto.webcrypto.getRandomValues(new Uint32Array(1))[0] / Uint32MaxVal;
}

function $ceil(num) {
   /*
    *  Choose your preferred ceiling operator
    */
   return Math.ceil(num);
}

function $floor(num) {
   /*
    *  Choose your preferred floor operator
    */
   return Math.floor(num);
}

function isReplSet() {
   /*
    *  Determine if the current host is a replSet member
    */
   return typeof hello().hosts !== 'undefined';
}

function isSharded() {
   /*
    *  Determine if the current host is a mongos
    */
   return sessionSnapshot().sharded === true;
}

function getDBNames(dbFilter = /^.+/) {
   /*
    *  getDBNames substitute for Mongo.getDBNames()
    *  Compass privilege-inferred admin/config/local ghosts are TABLED.
    */
   const atlasHide = hidesDbStatsFreeStorage();
   let command = {
      "listDatabases": 1,
      "nameOnly": true,
      "authorizedDatabases": !atlasHide
   };
   const options = {
      "readPreference": (typeof readPref !== 'undefined') ? readPref
                      : (hello().secondary) ? 'secondaryPreferred'
                      : 'primaryPreferred'
   };
   const filterOptions = 'i';
   const filterRegex = new RegExp(dbFilter, filterOptions);
   const filter = { "name": filterRegex };
   const restrictedNamespaces = atlasHide ? ['admin', 'config', 'local'] : [];
   const comment = `list databases with ${__lib.name} v${__lib.version}`;
   if (!atlasHide) {
      // Atlas shared/serverless reject listDatabases.filter; client-side regex still applies.
      command.filter = filter;
   }
   if (fCV(4.4)) {
      // ignoring comment on unsupported versions
      command.comment = comment;
   }
   const dbs = shellVer(2.0)
             ? db.getSiblingDB('admin').runCommand(command, options)
             : db.getSiblingDB('admin').runCommand(command);

   return dbs.databases.map(({ name }) => name)
      .filter(namespace => !restrictedNamespaces.includes(namespace))
      .filter(namespace => filterRegex.test(namespace));
};

/*
 *  System collection-name policy (shared by dbstats filter.system, catalog builders)
 *  "System" here means collection/view names: system.* or replset.* (not admin/config/local DBs).
 */

function isSystemCollectionName(name = '') {
   return /^(system\..+|replset\..+)$/.test(String(name));
}

function normalizeSystemFilter(system = true) {
   /*
    *  true | 'include' → include (default)
    *  false | 'exclude' → omit system/replset names
    *  'only' → system/replset names only
    */
   if (system === false || system === 'exclude') return 'exclude';
   if (system === 'only') return 'only';
   return 'include';
}

function acceptSystemCollectionName(name, system = true) {
   const mode = normalizeSystemFilter(system);
   const isSys = isSystemCollectionName(name);
   if (mode === 'exclude') return !isSys;
   if (mode === 'only') return isSys;
   return true;
}

function systemCollectionFilter(system = true) {
   /*
    *  Predicate for getCollectionInfos results: ({ name }) => boolean
    */
   return ({ name }) => acceptSystemCollectionName(name, system);
}

/*
 *  Versioned helper commands
 */

function parseVer(s) {
   const m = String(s ?? '').match(/^(\d+)\.(\d+)(?:\.(\d+))?/);
   return m ? [+m[1], +m[2], +(m[3] || 0)] : null;
}

function specToTuple(ver) {
   if (typeof ver === 'number') {
      if (Number.isInteger(ver)) return [ver, 0, 0];
      const m = String(ver).match(/^(\d+)\.(\d+)/);
      return m ? [+m[1], +m[2], 0] : null;
   }
   return parseVer(ver);
}

function cmpVer(a, b) {
   if (!a || !b) return NaN;
   for (let i = 0; i < 3; i++) {
      if (a[i] !== b[i]) return a[i] - b[i];
   }
   return 0;
}

function verNumber(tuple) {
   // 2.10 → 2.010; 2.1 → 2.001 (do not use +"x.y")
   return tuple[0] + tuple[1] / 1000 + tuple[2] / 1000000;
}

function verAtLeast(parsed, ver) {
   const need = specToTuple(ver);
   return !!(parsed && need && cmpVer(parsed, need) >= 0);
}

function rememberHelloDoc(doc) {
   if (doc && typeof doc === 'object') {
      sessionSnapshot.helloDoc = doc;
      if (sessionSnapshot.cached) sessionSnapshot.cached.helloDoc = doc;
   }
   return doc;
}

function rememberServerVerParsed(parsed) {
   if (parsed) {
      sessionSnapshot.serverVerParsed = parsed;
      if (sessionSnapshot.cached) sessionSnapshot.cached.serverVerParsed = parsed;
   }
   return parsed;
}

function rememberServerVerString(value) {
   if (typeof value === 'string' && value) {
      sessionSnapshot.serverVerString = value;
      if (sessionSnapshot.cached) sessionSnapshot.cached.serverVerString = value;
   }
   return sessionSnapshot.serverVerString;
}

function formatParsedVer(parsed) {
   if (!parsed) return '';
   return `${parsed[0]}.${parsed[1]}.${parsed[2]}`;
}

function serverVerString() {
   /*
    *  Cached binary version string (serverStatus.version / sidecar).
    *  Empty when the snapshot has not run. Does not call db.version().
    */
   if (sessionSnapshot.serverVerString) return sessionSnapshot.serverVerString;
   if (sessionSnapshot.cached && sessionSnapshot.cached.serverVerString) {
      sessionSnapshot.serverVerString = sessionSnapshot.cached.serverVerString;
      return sessionSnapshot.serverVerString;
   }
   const parsed = sessionSnapshot.serverVerParsed
      || (sessionSnapshot.cached && sessionSnapshot.cached.serverVerParsed);
   const formatted = formatParsedVer(parsed);
   if (formatted) rememberServerVerString(formatted);
   return formatted;
}

function ensureServerFloor() {
   /*
    *  mongod/s 4.4 floor after the snapshot has a binary version.
    *  Sets __mdblibServerUnsupported once; does not print.
    */
   if (typeof __mdblibServerUnsupported !== 'undefined') return;
   const parsed = sessionSnapshot.serverVerParsed
      || (sessionSnapshot.cached && sessionSnapshot.cached.serverVerParsed);
   if (parsed && !verAtLeast(parsed, 4.4)) {
      __mdblibServerUnsupported = serverVerString() || formatParsedVer(parsed);
   }
}

function cachedServerVerParsed() {
   if (sessionSnapshot.serverVerParsed) return sessionSnapshot.serverVerParsed;
   if (sessionSnapshot.cached && sessionSnapshot.cached.serverVerParsed) {
      sessionSnapshot.serverVerParsed = sessionSnapshot.cached.serverVerParsed;
      return sessionSnapshot.serverVerParsed;
   }
   const parsed = parseVer(db.version());
   if (parsed) rememberServerVerString(formatParsedVer(parsed));
   return rememberServerVerParsed(parsed);
}

function serverVer(ver = false) {
   /*
    *  Server binary version. Predicate: serverVer(4.4) / serverVer(8).
    *  Getter: numeric major.minor.patch with integer minors (2.10 ≠ 2.1).
    *  First-read on the session snapshot (load() may fill the sidecar only).
    */
   const parsed = cachedServerVerParsed();
   if (ver === false) return parsed ? verNumber(parsed) : 0;
   return verAtLeast(parsed, ver);
}

function fCV(ver = false) { // Atlas M0/Flex: getParameter FCV restricted
   /*
    *  Feature compatibility version from getParameter when present.
    *  Prefer that document on mongos (do not require process == mongod).
    *  Fall back to binary version when FCV is unavailable (M0/Flex by design).
    */
   const parsed = sessionSnapshot().fcvParsed;
   if (ver === false) return parsed ? verNumber(parsed) : 0;
   return verAtLeast(parsed, ver);
}

function shellVer(ver = false) {
   /*
    *  mongosh version. Predicate: shellVer(2.0). Getter uses integer minors.
    */
   const parsed = parseVer(version());
   if (ver === false) return parsed ? verNumber(parsed) : 0;
   return verAtLeast(parsed, ver);
}

function hello(refresh) {
   /*
    *  First-read topology probe ({ hello: 1 }) on the session snapshot.
    *  hello(true) re-probes and updates the cache (step-down / child session).
    *  SERVER-49989: send hello, do not wrap isMaster; replies differ
    *  (isWritablePrimary vs ismaster). hello exists on mongod >= 4.2
    *  (floor is 4.4), so there is no isMaster fallback.
    *  Never pass topologyVersion / maxAwaitTimeMS — that is awaitable
    *  hello and blocks up to heartbeatFrequencyMS (10s) on a quiet node.
    *  db.hello() stays a live shell command.
    */
   if (refresh !== true && sessionSnapshot.helloDoc) return sessionSnapshot.helloDoc;
   const doc = db.adminCommand({ "hello": 1 }) || {};
   return rememberHelloDoc(doc);
}

function hostNameFromHostPort(value) {
   /*
    *  Bare hostname from host:port, [IPv6]:port, or a bare host.
    *  serverStatus().host and hello().me are typically host:port.
    */
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
}

function hostInfo() {
   /*
    *  Forward compatibility with db.hostInfo()
    *  Hostname: hostInfo.system.hostname, else serverStatus().host (M0/Flex),
    *  else hello().me (mongod; often absent on mongos), else unknown.
    *  mongos: hello().msg === 'isdbgrid' / serverStatus().process === 'mongos';
    *  the mongos host name is OS hostname or serverStatus().host, not hello().me.
    */
   let info = {};
   try {
      info = db.hostInfo();
   } catch(_) {
      // Atlas M0/Flex, serverless, or unauthorized
   }

   const existing = (info.system && info.system.hostname) ? String(info.system.hostname) : '';
   if (existing) return info;

   let hostname = '';
   try {
      hostname = hostNameFromHostPort(serverStatus().host);
   } catch(_) { /* fall through */ }

   if (!hostname) {
      try {
         const helloDoc = hello();
         hostname = hostNameFromHostPort(helloDoc.me);
         if (!hostname && helloDoc.msg !== 'isdbgrid' && typeof helloDoc.me === 'undefined') {
            hostname = 'serverless';
         }
      } catch(_) { /* fall through */ }
   }

   if (!hostname) hostname = 'unknown';
   if (typeof info.system === 'undefined') info.system = {};
   info.system.hostname = hostname;
   return info;
}

function serverCmdLineOpts() {
   /*
    *  Forward compatibility with db.serverCmdLineOpts()
    */
   let serverCmdLineOpts = {};
   try {
      serverCmdLineOpts = db.serverCmdLineOpts();
   } catch(_) {
      // console.debug(`\x1b[31m[WARN] insufficient rights to execute db.serverCmdLineOpts()\n${error}\x1b[0m`);
      serverCmdLineOpts = { "parsed": { "storage": { "dbPath": "unknown" } } };
   }

   if (typeof serverCmdLineOpts.parsed.storage === 'undefined') {
      serverCmdLineOpts = { "parsed": { "storage": { "dbPath": "unknown" } } };
   }

   return serverCmdLineOpts;
}

function atlasDeployment(helloDoc = {}, hostInfoDoc = {}, hostInfoError = null, serverStatusDoc = {}) {
   /*
    *  Atlas platform from probes the caller already took. Does not call
    *  the server. sharedTier is M0/Flex (hostInfo AtlasError, or ok != 1).
    *  dedicatedShardedCluster / dedicatedReplicaSet need atlasVersion or a
    *  *.mongodb.net hostname. serverless is the deprecated platform string
    *  when hello().me is absent on a non-mongos.
    */
   const hello = helloDoc || {};
   const info = hostInfoDoc || {};
   const status = serverStatusDoc || {};
   const helloMsg = hello.msg;
   const isMongos = helloMsg == 'isdbgrid';
   let hostname = (info.system && info.system.hostname)
      ? String(info.system.hostname)
      : '';
   if (!hostname) hostname = hostNameFromHostPort(status.host);
   if (!hostname) {
      hostname = hostNameFromHostPort(hello.me);
      if (!hostname && helloMsg !== 'isdbgrid' && typeof hello.me === 'undefined') {
         hostname = 'serverless';
      }
   }
   if (!hostname) hostname = 'unknown';
   const isSharedTier = hostInfoError
      ? (hostInfoError.codeName == 'AtlasError')
      : (info.ok != 1);
   const atlasVersion = status.atlasVersion || false;
   const isAtlas = !!(atlasVersion || (typeof hostname === 'string' && hostname.endsWith('.mongodb.net')));
   let platform = false;
   if (isMongos && isAtlas && hostname != 'serverless') platform = 'dedicatedShardedCluster';
   else if (!isMongos && isAtlas && isSharedTier) platform = 'sharedTier';
   else if (!isMongos && isAtlas) platform = 'dedicatedReplicaSet';
   else if (hostname == 'serverless') platform = 'serverless';
   return { hostname, platform, isMongos, isAtlas, isSharedTier };
}

function sessionSnapshot() {
   /*
    *  First-read session facts: atlas platform, fCV, isSharded.
    *  hello (cached), then serverStatus({ wiredTiger: 1 }). Atlas shared-tier
    *  (atlasVersion or *.mongodb.net host, no wiredTiger, not isdbgrid)
    *  skips hostInfo / getParameter / listShards. Auto catalog still tries
    *  $listCatalog on that tier. hello() / serverVer() reuse helloDoc and
    *  serverVerParsed. serverStatus gets the read preference from that hello.
    *  A thrown hello falls through to primaryPreferred. hello msg isdbgrid
    *  still means sharded when serverStatus is {ok:0} and listShards did
    *  not return shards. proc unknown is not cached. Binary version prefers
    *  serverStatus.version then the sidecar / db.version(); fCV falls back
    *  to that binary (M0/Flex getParameter denial).
    */
   if (sessionSnapshot.cached) return sessionSnapshot.cached;

   let helloDoc = sessionSnapshot.helloDoc;
   if (!helloDoc) {
      try {
         helloDoc = hello() || {};
      } catch (_) {
         helloDoc = {};
      }
   }
   const helloMsg = helloDoc.msg || false;
   const statusReadPref = helloDoc.secondary ? 'secondaryPreferred' : 'primaryPreferred';

   const ss = serverStatus({ "wiredTiger": 1 }, statusReadPref);
   const ssHost = (ss && typeof ss.host === 'string') ? ss.host : '';
   const looksSharedTier = !!(ss && ss.ok)
      && helloMsg !== 'isdbgrid'
      && !ss.wiredTiger
      && !!(ss.atlasVersion || (ssHost.indexOf('.mongodb.net') !== -1));

   let hostInfoDoc = {};
   let hostInfoError = null;
   if (!looksSharedTier) {
      try {
         hostInfoDoc = db.hostInfo() || {};
      } catch (e) {
         hostInfoError = e;
         hostInfoDoc = {};
      }
   }

   const {
      "hostname": hostname,
      "platform": atlasPlatform
   } = atlasDeployment(helloDoc, hostInfoDoc, hostInfoError, ss);

   let serverVerParsed = sessionSnapshot.serverVerParsed
      || parseVer(ss && ss.version);
   if (!serverVerParsed) serverVerParsed = parseVer(db.version());
   rememberServerVerParsed(serverVerParsed);
   rememberServerVerString((ss && ss.version) || formatParsedVer(serverVerParsed));

   let fcvParsed = serverVerParsed;
   let shardDocs = false;
   if (!looksSharedTier) {
      let fcvCmd = {};
      try {
         fcvCmd = db.adminCommand({ "getParameter": 1, "featureCompatibilityVersion": 1 });
      } catch (_) {
         fcvCmd.ok = 0;
      }
      const raw = fcvCmd.featureCompatibilityVersion;
      const versionStr = (typeof raw === 'string') ? raw : raw && raw.version;
      fcvParsed = parseVer(versionStr) || serverVerParsed;
      try {
         shardDocs = db.adminCommand({ "listShards": 1 }).shards;
      } catch (_) {
         shardDocs = false;
      }
   }
   const shardedProc = (ss.ok) ? ss.process
                     : (shardDocs) ? 'mongos'
                     : (helloMsg == 'isdbgrid') ? 'mongos'
                     : 'unknown';
   const sharded = shardedProc === 'mongos';
   const proc = (ss.ok) ? ss.process
              : (helloMsg == 'isdbgrid') ? 'mongos'
              : (typeof helloDoc.setName !== 'undefined') ? 'mongod'
              : 'unknown';
   const shardIds = Array.isArray(shardDocs)
      ? shardDocs.map(({ _id }) => _id)
      : null;

   const snap = {
      atlasPlatform,
      fcvParsed,
      serverVerParsed,
      "serverVerString": sessionSnapshot.serverVerString || formatParsedVer(serverVerParsed),
      helloDoc,
      sharded,
      hostname,
      proc,
      shardIds
   };
   // A missed probe must not stick for the session. M0/Flex still caches:
   // proc is known and fCV falls back to the binary version.
   if (proc !== 'unknown') {
      sessionSnapshot.cached = snap;
      if (helloDoc && Object.keys(helloDoc).length) sessionSnapshot.helloDoc = helloDoc;
      ensureServerFloor();
   }
   return snap;
}

function isAtlasPlatform(type = null) {
   /*
    *  Evaluate the Atlas deployment platform type
    */
   const platform = sessionSnapshot().atlasPlatform;
   if (type == null) return platform;
   return platform == type;
}

function hidesDbStatsFreeStorage() {
   /*
    *  Atlas M0/Flex (sharedTier) and serverless omit reusable bytes on db.stats().
    *  A 0 from that command is not an empty free list. Collection $collStats may
    *  still expose WT block-manager reuse; dbstats rolls those up as a lower bound.
    */
   const platform = sessionSnapshot().atlasPlatform;
   return platform === 'sharedTier' || platform === 'serverless';
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

function serverStatus(serverStatusOptions = {}, statusReadPref) {
   /*
    *  opt-in version of db.serverStatus().
    *  Second argument:
    *    undefined — hello().secondary selects secondaryPreferred on a
    *      secondary, otherwise primaryPreferred. Not the stats readPref.
    *    string — that read preference, no extra hello().
    *    null — no read preference and no hello(); the command runs on the
    *      connected member (autoCompact's poll).
    *  A thrown command returns { ok: 0, error } and does not throw.
    *  error is the caught value. Callers that already pass a read
    *  preference are unchanged.
    */
   let commandOptions;
   if (statusReadPref !== null) {
      let readPreference = statusReadPref;
      if (typeof readPreference === 'undefined') {
         let onSecondary = false;
         try {
            onSecondary = !!(hello().secondary);
         } catch (_) {
            onSecondary = false;
         }
         readPreference = onSecondary ? 'secondaryPreferred' : 'primaryPreferred';
      }
      commandOptions = { "readPreference": readPreference };
   }

   const command = {
      "serverStatus": true,
      ...SERVER_STATUS_OPTIONS_DEFAULTS,
      ...serverStatusOptions
   };
   let serverStatusResults = {};
   try {
      serverStatusResults = commandOptions
         ? db.adminCommand(command, commandOptions)
         : db.adminCommand(command);
      absorbServerStatusKeys(serverStatusResults);
   } catch (e) {
      serverStatusResults = { "ok": 0, "error": e };
      if (e && typeof e === 'object') {
         if (e.code != null) serverStatusResults.code = e.code;
         if (e.codeName != null) serverStatusResults.codeName = e.codeName;
         if (e.errmsg != null) serverStatusResults.errmsg = e.errmsg;
         else if (e.message != null) serverStatusResults.errmsg = e.message;
      }
   }

   return serverStatusResults;
}

if (typeof bsonsize === 'undefined') {
   /*
    *  Forward compatibility with bsonsize()
    */
   bsonsize = arg => Object.getPrototypeOf(Object).bsonsize(arg);
}

if (typeof Object.getPrototypeOf(UUID()).base64 === 'undefined') {
   // Old-shell BinData.base64(); method so this is the Binary.
   Object.getPrototypeOf(UUID()).base64 = function() {
      return this.toString('base64');
   };
}

if (typeof hex_md5 === 'undefined') {
   hex_md5 = arg => crypto.createHash('md5').update(arg).digest('hex');
}

if (typeof tojson === 'undefined') {
   /*
    *  Compatibility with tojson()
    */
   tojson = arg => util.inspect(arg, { "depth": null, "colors": true });
}

/*
 *  Helper functions
 */

const K = 273.15;
const int32MinVal = -Math.pow(2, 31);
const int32MaxVal = Math.pow(2, 31) - 1;
const Uint32MaxVal = Math.pow(2, 32) - 1;
const int64MinVal = -Math.pow(2, 63);
const int64MaxVal = Math.pow(2, 63) - 1;
const dec128MinVal = -10 * Math.pow(2, 110);
const dec128MaxVal = 10 * Math.pow(2, 110) - 1;
const WIREDTIGER_MIN_ALLOC_SIZE = 4096;             // 4 KiB: WT allocation_size / empty-file floor (display, not a stored substitute)
const WIREDTIGER_MIN_RECLAIM_SIZE_V8 = 1048576;     // 1 MiB: WT skips compact when recoverable bytes are smaller (v8+)
const WIREDTIGER_MIN_RECLAIM_SIZE_LEGACY = 2097152; // 2 MiB: same floor on pre-v8

function compactionHelper(type = 'collection', storageSize, freeStorageSize) {
   /*
    *  Worth compacting? No numeric defaults: omitted storage is not the
    *  4 KiB display floor, and omitted free is unknown, not an empty list.
    */
   if (freeStorageSize == null || Number.isNaN(+freeStorageSize) || !(+storageSize > 0)) return false;
   const compactCollectionThreshold = 0.2; // 20% reusable collection bytes
   const compactIndexThreshold = 0.5;      // 50% reusable index bytes
   const minReclaimBytes = serverVer(8)
                         ? WIREDTIGER_MIN_RECLAIM_SIZE_V8
                         : WIREDTIGER_MIN_RECLAIM_SIZE_LEGACY;
   const syncThreshold = 0.5;              // 50% total dbPath reusable bytes
   // WT skips when recoverable bytes are below this floor (block_compact: "can't recover at least 1MB").
   // File size is implied: freeStorageSize ≤ storageSize, so a 1 MiB reclaim floor is also a 1 MiB file floor.
   const reclaimThreshold = +freeStorageSize > minReclaimBytes;
   const freeThreshold = freeStorageSize / storageSize;

   return (type == 'collection' && reclaimThreshold && freeThreshold > compactCollectionThreshold) ? true
        : (type == 'index'      && reclaimThreshold && freeThreshold > compactIndexThreshold)      ? true
        : (type == 'dbPath'     && reclaimThreshold && freeThreshold > syncThreshold)              ? true
        : false;
};

function $NumberLong(arg) {
   /*
    *  NumberLong() wrapper
    */
   return Long.fromNumber(arg);
}

function $NumberDecimal(arg) {
   /*
    *  NumberDecimal() wrapper
    */
   return Decimal128.fromString(arg.toString());
}

function $NumberInt(arg) {
   /*
    *  NumberInt() wrapper
    */
   return NumberInt(arg);
}

function $getRandRegex() {
   /*
    *  generate random regex
    */
   const regexes = [
      /[a-z]/,
      /[A-Z]/,
      /[0-9]/,
      /[a-z0-9]/,
      /[A-Z0-9]/,
      /[a-zA-Z0-9]/,
      /[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?/,
      /[0-9a-fA-F]{8}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{12}/
   ];

   return regexes[$getRandInt(0, regexes.length)];
}

function $getRandNum(min = 0, max = 1) {
   /*
    *  generate random number
    */
   return $rand() * (max - min) + min;
}

function $getRandExp(exponent = 0) {
   /*
    *  generate random exponential number
    */
   return $ceil($getRandNum(0, 9) * Math.pow(10, exponent));
}

function $getRandInt(min = 0, max = 1) {
   /*
    *  generate random integer
    */
   min = $ceil(min);
   max = $floor(max);

   return $floor($rand() * (max - min) + min);
}

function $getRandIntInc(min = 0, max = 1) {
   /*
    *  generate random integer inclusive of the maximum
    */
   min = $ceil(min);
   max = $floor(max);

   return $floor($rand() * (max - min + 1) + min);
}

function $getRandRatioInt(ratios = [1]) {
   /*
    *  generate ratioed random integer
    */
   const weightedIndex = [];
   ratios.forEach((ratio, idx) => {
      for (let i = 0; i < ratio; i++) {
         weightedIndex.push(idx);
      }
   });

   return weightedIndex[$floor($rand() * weightedIndex.length)];
}

function $genRandHex(len = 1) {
   /*
    *  generate random hexadecimal string
    */
   let res = '';
   for (let i = 0; i < len; i++) {
      res += ($floor($rand() * 16)).toString(16);
   }

   return res;
}

function $genRandStr(len = 1) {
   /*
    *  generate random alpha-numeric string
    */
   let res = '';
   const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
   for (let i = 0; i < len; i++) {
      res += chars.charAt($floor($rand() * chars.length));
   }

   return res;
}

const phraseDet = ['the', 'a', 'one', 'some', 'each'];
const phraseAdj = ['quiet', 'small', 'red', 'cold', 'bright', 'narrow', 'empty', 'heavy'];
const phraseNoun = ['river', 'engine', 'garden', 'stone', 'window', 'market', 'bridge', 'forest', 'signal', 'harbor'];
const phraseVerb = ['holds', 'finds', 'opens', 'leaves', 'carries', 'watches', 'follows', 'marks'];
const phrasePrep = ['in', 'on', 'under', 'near', 'with', 'beside'];
const phraseWords = phraseDet.concat(phraseAdj, phraseNoun, phraseVerb, phrasePrep);

function $genRandWord(list) {
   /*
    *  pick one built-in word, or one entry from list
    */
   const words = (Array.isArray(list) && list.length > 0) ? list : phraseWords;
   return words[$getRandInt(0, words.length)];
}

function $genRandPhrase(sentences) {
   /*
    *  one to three English sentences for a text index
    *  an explicit count is capped at 8
    */
   const n = (sentences > 0 && Number.isFinite(+sentences))
      ? Math.min($floor(+sentences), 8)
      : $getRandIntInc(1, 3);
   const out = [];
   for (let i = 0; i < n; i++) {
      const sentence = ($getRandInt(0, 2) === 0)
         ? `${$genRandWord(phraseDet)} ${$genRandWord(phraseAdj)} ${$genRandWord(phraseNoun)} ${$genRandWord(phraseVerb)} ${$genRandWord(phraseDet)} ${$genRandWord(phraseNoun)}`
         : `${$genRandWord(phraseNoun)} ${$genRandWord(phraseVerb)} ${$genRandWord(phrasePrep)} ${$genRandWord(phraseDet)} ${$genRandWord(phraseAdj)} ${$genRandWord(phraseNoun)}`;
      out.push(sentence.charAt(0).toUpperCase() + sentence.slice(1) + '.');
   }
   return out.join(' ');
}

function $geoNum(n, lo, hi) {
   /*
    *  four decimal places, clamped into the GeoJSON range
    */
   let x = Math.round(n * 10000) / 10000;
   if (x < lo)
      x = lo;
   if (x > hi)
      x = hi;
   return x;
}

function $genPoint() {
   /*
    *  one GeoJSON Point inside the longitude and latitude bounds
    */
   return {
      "type": "Point",
      "coordinates": [
         $geoNum($getRandNum(-180, 180), -180, 180),
         $geoNum($getRandNum(-90, 90), -90, 90)
      ]
   };
}

function $genLine() {
   /*
    *  a short GeoJSON LineString. Both ends share one corner.
    */
   const span = $getRandNum(0.1, 1);
   const lng = $geoNum($getRandNum(-180, 180 - span), -180, 180);
   const lat = $geoNum($getRandNum(-90, 90 - span), -90, 90);
   return {
      "type": "LineString",
      "coordinates": [
         [lng, lat],
         [
            $geoNum(lng + $getRandNum(0.05, span), -180, 180),
            $geoNum(lat + $getRandNum(0.05, span), -90, 90)
         ]
      ]
   };
}

function $genPolygon(withHole) {
   /*
    *  one GeoJSON Polygon. The shell is a counterclockwise triangle
    *  from one southwest corner. withHole adds a clockwise hole inside it.
    */
   const hole = !!withHole;
   const east = $getRandNum(hole ? 1 : 0.1, hole ? 2 : 1);
   const north = $getRandNum(hole ? 1 : 0.1, hole ? 2 : 1);
   const lng = $geoNum($getRandNum(-180, 180 - east), -180, 180);
   const lat = $geoNum($getRandNum(-90, 90 - north), -90, 90);
   const lngE = $geoNum(lng + east, -180, 180);
   const latN = $geoNum(lat + north, -90, 90);
   const shell = [[lng, lat], [lngE, lat], [lng, latN], [lng, lat]];
   const coordinates = [shell];
   if (hole) {
      const w = lngE - lng;
      const h = latN - lat;
      const a = [$geoNum(lng + w * 0.2, -180, 180), $geoNum(lat + h * 0.2, -90, 90)];
      const b = [$geoNum(lng + w * 0.2, -180, 180), $geoNum(lat + h * 0.35, -90, 90)];
      const c = [$geoNum(lng + w * 0.35, -180, 180), $geoNum(lat + h * 0.2, -90, 90)];
      coordinates.push([a, b, c, [a[0], a[1]]]);
   }
   return { "type": "Polygon", "coordinates": coordinates };
}

function $genRandAlpha(len = 1) {
   /*
    *  generate random alpha-character string
    */
   let res = '';
   const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
   for (let i = 0; i < len; i++) {
      res += chars.charAt($getRandInt(0, chars.length));
   }

   return res;
}

function $genRandSymbol() {
   /*
    *  generate random symbol
    */
   const symbol = '!#%&\'()+,-;=@[]^_`{}~¡¢£¤¥¦§¨©ª«¬­®¯°±²³´µ¶·¸¹º»¼½¾¿ÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖ×ØÙÚÛÜÝÞßàáâãäåæçèéêëìíîïðñòóôõö÷øùúûüýþÿ';

   return symbol.charAt($floor($rand() * symbol.length));
}

function $genRandCurrency() {
   /*
    *  generate random curreny symbol
    */
   const currencies = ['$', '€', '₡', '£', '₪', '₹', '¥', '₩', '₦', '₱zł', '₲', '฿', '₴', '₫'];

   return currencies[$getRandInt(0, currencies.length)];
}

function $genArrayElements(len) {
   /*
    *  generate array of random strings
    */
   const array = [];
   for (let i = 0; i < len; i++) {
      array.push($genRandStr($getRandIntInc(4, 12)));
   }

   return array;
}

function $genArrayStrings(len) {
   /*
    *  generate array of random strings
    */
   const array = [];
   for (let i = 0; i < len; i++) {
      array.push($genRandStr($getRandIntInc(6, 24)));
   }

   return array;
}

function $genArrayInts(len) {
   /*
    *  generate array of random integers
    */
   const array = [];
   for (let i = 0; i < len; i++) {
      array.push($getRandIntInc(1, 1000));
   }

   return array;
}

function $genRandIncPareto(min, alpha = 1.161) {
   /*
    *  min is the lowest possible value that can be returned
    *  alpha controls the "shape" of the distribution
    */
   const u = 1.0 - $rand();

   return min / Math.pow(u, (1.0 / alpha));
}

function $genRandIntIncPareto(min, max, alpha = 1.161) {
   /*
    *  min is the lowest possible value that can be returned
    *  alpha controls the "shape" of the distribution
    */
   const k = max * (1.0 - $rand()) + min;
   const v = Math.pow(k, alpha);

   return v + min;
}

function $genNormal(mu, sigma) {
   /*
    *  mu = mean
    *  sigma = standard deviation
    */
   const x = Math.sqrt(-2.0 * Math.log($rand())) * Math.cos(Math.PI * 2 * $rand());

   return x * sigma + mu;
}

function $genExponential(lambda = 1) {
   /*
    *  exponential distribution function
    */
   return -Math.log(1.0 - $rand()) / lambda;
}

function $genLuhnNumber(input) {
   /*
    *  generate number with Luhn check digit
    */

   // Step 1: Remove the last digit from the input
   // const inputWithoutLastDigit = input.toString().slice(0, -1);

   // Step 2: Double every second digit, starting from the right
   // const digits = inputWithoutLastDigit.split('').map(Number);
   let digits = input.split('').map(Number),
      sum = 0,
      shouldDouble = false;

   for (let i = digits.length - 1; i >= 0; i--) {
      let digit = digits[i];
      if (shouldDouble) {
         digit *= 2;
         if (digit > 9) digit -= 9;
      }
      sum += digit;
      shouldDouble = !shouldDouble;
   }

   // Step 3: Calculate the check digit
   const checkDigit = (10 - (sum % 10)) % 10;

   // Step 4: Return the input with the check digit appended
   // return inputWithoutLastDigit + checkDigit;
   return input + checkDigit;
}

function $genIin({ iin }) {
   /*
    *  basic fake IIN generator
    */

   const countryCode = $getRandCountry()['numeric code'];
   return ((iin[$getRandIntInc(0, (iin.length - 1))]).toString() + countryCode.replace(/^0+/, '') + $getRandInt(0, Math.pow(10, 6))).toString().padEnd(8, '0').substring(0, 8);
}

function $genPan() {
   /*
    *  basic fake PAN generator
    */

   return ($getRandInt(0, Math.pow(10, 7))).toString().padStart(7, '0').substring(0, 7);
}

function $genRandCardNumber(type = 'rnd', card = '') {
   /*
    *  basic fake card generator
    */

   const cards = [
      { "type": "amex", "iin": [34, 37], "digits": 15, "weight": 10 },
      { "type": "discover", "iin": [6011, ...$range(644, 649, 1), 65], "digits": 16, "weight": 5 },
      { "type": "mastercard", "iin": [...$range(51, 55, 1), ...$range(2221, 2720, 1)], "digits": 16, "weight": 25 },
      { "type": "visa", "iin": [4], "digits": 16, "weight": 50 }
   ];

   if (type == 'rnd') {
      type = ['amex', 'discover', 'mastercard', 'visa'][
         $getRandRatioInt([10, 5, 25, 50])
      ];
   }
   card = cards.find(card => card.type == type);
   // Card format = BIN prefix (IIN + country code padded to 8) + PAN (pad to card length -1) + luhn check digit

   const iin = $genIin(card);
   const pan = $genPan();
   return $genLuhnNumber(iin + pan);
}

function $range(start, stop, step) {
   /*
    *  return array of inclusive number range
    */
   return Array.from(
      { "length": (stop - start) / step + 1 },
      (_, idx) => start + idx * step
   );
};

function $getRandCountry() {
   /*
    *  return country code
    */

   const codes = [
      { "name": "Afghanistan", "alpha-2 code": "AF", "alpha-3 code": "AFG", "numeric code": "004" },
      { "name": "Albania", "alpha-2 code": "AL", "alpha-3 code": "ALB", "numeric code": "008" },
      { "name": "Antarctica", "alpha-2 code": "AQ", "alpha-3 code": "ATA", "numeric code": "010" },
      { "name": "Algeria", "alpha-2 code": "DZ", "alpha-3 code": "DZA", "numeric code": "012" },
      { "name": "American Samoa", "alpha-2 code": "AS", "alpha-3 code": "ASM", "numeric code": "016" },
      { "name": "Andorra", "alpha-2 code": "AD", "alpha-3 code": "AND", "numeric code": "020" },
      { "name": "Angola", "alpha-2 code": "AO", "alpha-3 code": "AGO", "numeric code": "024" },
      { "name": "Antigua and Barbuda", "alpha-2 code": "AG", "alpha-3 code": "ATG", "numeric code": "028" },
      { "name": "Azerbaijan", "alpha-2 code": "AZ", "alpha-3 code": "AZE", "numeric code": "031" },
      { "name": "Argentina", "alpha-2 code": "AR", "alpha-3 code": "ARG", "numeric code": "032" },
      { "name": "Australia", "alpha-2 code": "AU", "alpha-3 code": "AUS", "numeric code": "036" },
      { "name": "Austria", "alpha-2 code": "AT", "alpha-3 code": "AUT", "numeric code": "040" },
      { "name": "Bahamas", "alpha-2 code": "BS", "alpha-3 code": "BHS", "numeric code": "044" },
      { "name": "Bahrain", "alpha-2 code": "BH", "alpha-3 code": "BHR", "numeric code": "048" },
      { "name": "Bangladesh", "alpha-2 code": "BD", "alpha-3 code": "BGD", "numeric code": "050" },
      { "name": "Armenia", "alpha-2 code": "AM", "alpha-3 code": "ARM", "numeric code": "051" },
      { "name": "Barbados", "alpha-2 code": "BB", "alpha-3 code": "BRB", "numeric code": "052" },
      { "name": "Belgium", "alpha-2 code": "BE", "alpha-3 code": "BEL", "numeric code": "056" },
      { "name": "Bermuda", "alpha-2 code": "BM", "alpha-3 code": "BMU", "numeric code": "060" },
      { "name": "Bhutan", "alpha-2 code": "BT", "alpha-3 code": "BTN", "numeric code": "064" },
      { "name": "Bolivia", "alpha-2 code": "BO", "alpha-3 code": "BOL", "numeric code": "068" },
      { "name": "Bosnia and Herzegovina", "alpha-2 code": "BA", "alpha-3 code": "BIH", "numeric code": "070" },
      { "name": "Botswana", "alpha-2 code": "BW", "alpha-3 code": "BWA", "numeric code": "072" },
      { "name": "Bouvet Island", "alpha-2 code": "BV", "alpha-3 code": "BVT", "numeric code": "074" },
      { "name": "Brazil", "alpha-2 code": "BR", "alpha-3 code": "BRA", "numeric code": "076" },
      { "name": "Belize", "alpha-2 code": "BZ", "alpha-3 code": "BLZ", "numeric code": "084" },
      { "name": "British Indian Ocean Territory", "alpha-2 code": "IO", "alpha-3 code": "IOT", "numeric code": "086" },
      { "name": "Solomon Islands", "alpha-2 code": "SB", "alpha-3 code": "SLB", "numeric code": "090" },
      { "name": "Virgin Islands (British)", "alpha-2 code": "VG", "alpha-3 code": "VGB", "numeric code": "092" },
      { "name": "Brunei Darussalam", "alpha-2 code": "BN", "alpha-3 code": "BRN", "numeric code": "096" },
      { "name": "Bulgaria", "alpha-2 code": "BG", "alpha-3 code": "BGR", "numeric code": "100" },
      { "name": "Myanmar", "alpha-2 code": "MM", "alpha-3 code": "MMR", "numeric code": "104" },
      { "name": "Burundi", "alpha-2 code": "BI", "alpha-3 code": "BDI", "numeric code": "108" },
      { "name": "Belarus", "alpha-2 code": "BY", "alpha-3 code": "BLR", "numeric code": "112" },
      { "name": "Cambodia", "alpha-2 code": "KH", "alpha-3 code": "KHM", "numeric code": "116" },
      { "name": "Cameroon", "alpha-2 code": "CM", "alpha-3 code": "CMR", "numeric code": "120" },
      { "name": "Canada", "alpha-2 code": "CA", "alpha-3 code": "CAN", "numeric code": "124" },
      { "name": "Cabo Verde", "alpha-2 code": "CV", "alpha-3 code": "CPV", "numeric code": "132" },
      { "name": "Cayman Islands", "alpha-2 code": "KY", "alpha-3 code": "CYM", "numeric code": "136" },
      { "name": "Central African Republic", "alpha-2 code": "CF", "alpha-3 code": "CAF", "numeric code": "140" },
      { "name": "Sri Lanka", "alpha-2 code": "LK", "alpha-3 code": "LKA", "numeric code": "144" },
      { "name": "Chad", "alpha-2 code": "TD", "alpha-3 code": "TCD", "numeric code": "148" },
      { "name": "Chile", "alpha-2 code": "CL", "alpha-3 code": "CHL", "numeric code": "152" },
      { "name": "China", "alpha-2 code": "CN", "alpha-3 code": "CHN", "numeric code": "156" },
      { "name": "Taiwan", "alpha-2 code": "TW", "alpha-3 code": "TWN", "numeric code": "158" },
      { "name": "Christmas Island", "alpha-2 code": "CX", "alpha-3 code": "CXR", "numeric code": "162" },
      { "name": "Cocos (Keeling) Islands", "alpha-2 code": "CC", "alpha-3 code": "CCK", "numeric code": "166" },
      { "name": "Colombia", "alpha-2 code": "CO", "alpha-3 code": "COL", "numeric code": "170" },
      { "name": "Comoros", "alpha-2 code": "KM", "alpha-3 code": "COM", "numeric code": "174" },
      { "name": "Mayotte", "alpha-2 code": "YT", "alpha-3 code": "MYT", "numeric code": "175" },
      { "name": "Congo", "alpha-2 code": "CG", "alpha-3 code": "COG", "numeric code": "178" },
      { "name": "Congo, Democratic Republic of the", "alpha-2 code": "CD", "alpha-3 code": "COD", "numeric code": "180" },
      { "name": "Cook Islands", "alpha-2 code": "CK", "alpha-3 code": "COK", "numeric code": "184" },
      { "name": "Costa Rica", "alpha-2 code": "CR", "alpha-3 code": "CRI", "numeric code": "188" },
      { "name": "Croatia", "alpha-2 code": "HR", "alpha-3 code": "HRV", "numeric code": "191" },
      { "name": "Cuba", "alpha-2 code": "CU", "alpha-3 code": "CUB", "numeric code": "192" },
      { "name": "Cyprus[b]", "alpha-2 code": "CY", "alpha-3 code": "CYP", "numeric code": "196" },
      { "name": "Czechia", "alpha-2 code": "CZ", "alpha-3 code": "CZE", "numeric code": "203" },
      { "name": "Benin", "alpha-2 code": "BJ", "alpha-3 code": "BEN", "numeric code": "204" },
      { "name": "Denmark", "alpha-2 code": "DK", "alpha-3 code": "DNK", "numeric code": "208" },
      { "name": "Dominica", "alpha-2 code": "DM", "alpha-3 code": "DMA", "numeric code": "212" },
      { "name": "Dominican Republic", "alpha-2 code": "DO", "alpha-3 code": "DOM", "numeric code": "214" },
      { "name": "Ecuador", "alpha-2 code": "EC", "alpha-3 code": "ECU", "numeric code": "218" },
      { "name": "El Salvador", "alpha-2 code": "SV", "alpha-3 code": "SLV", "numeric code": "222" },
      { "name": "Equatorial Guinea", "alpha-2 code": "GQ", "alpha-3 code": "GNQ", "numeric code": "226" },
      { "name": "Ethiopia", "alpha-2 code": "ET", "alpha-3 code": "ETH", "numeric code": "231" },
      { "name": "Eritrea", "alpha-2 code": "ER", "alpha-3 code": "ERI", "numeric code": "232" },
      { "name": "Estonia", "alpha-2 code": "EE", "alpha-3 code": "EST", "numeric code": "233" },
      { "name": "Faroe Islands", "alpha-2 code": "FO", "alpha-3 code": "FRO", "numeric code": "234" },
      { "name": "Falkland Islands", "alpha-2 code": "FK", "alpha-3 code": "FLK", "numeric code": "238" },
      { "name": "South Georgia and the South Sandwich Islands", "alpha-2 code": "GS", "alpha-3 code": "SGS", "numeric code": "239" },
      { "name": "Fiji", "alpha-2 code": "FJ", "alpha-3 code": "FJI", "numeric code": "242" },
      { "name": "Finland", "alpha-2 code": "FI", "alpha-3 code": "FIN", "numeric code": "246" },
      { "name": "Åland Islands", "alpha-2 code": "AX", "alpha-3 code": "ALA", "numeric code": "248" },
      { "name": "France", "alpha-2 code": "FR", "alpha-3 code": "FRA", "numeric code": "250" },
      { "name": "French Guiana", "alpha-2 code": "GF", "alpha-3 code": "GUF", "numeric code": "254" },
      { "name": "French Polynesia", "alpha-2 code": "PF", "alpha-3 code": "PYF", "numeric code": "258" },
      { "name": "French Southern Territories", "alpha-2 code": "TF", "alpha-3 code": "ATF", "numeric code": "260" },
      { "name": "Djibouti", "alpha-2 code": "DJ", "alpha-3 code": "DJI", "numeric code": "262" },
      { "name": "Gabon", "alpha-2 code": "GA", "alpha-3 code": "GAB", "numeric code": "266" },
      { "name": "Georgia", "alpha-2 code": "GE", "alpha-3 code": "GEO", "numeric code": "268" },
      { "name": "Gambia", "alpha-2 code": "GM", "alpha-3 code": "GMB", "numeric code": "270" },
      { "name": "Palestine", "alpha-2 code": "PS", "alpha-3 code": "PSE", "numeric code": "275" },
      { "name": "Germany", "alpha-2 code": "DE", "alpha-3 code": "DEU", "numeric code": "276" },
      { "name": "Ghana", "alpha-2 code": "GH", "alpha-3 code": "GHA", "numeric code": "288" },
      { "name": "Gibraltar", "alpha-2 code": "GI", "alpha-3 code": "GIB", "numeric code": "292" },
      { "name": "Kiribati", "alpha-2 code": "KI", "alpha-3 code": "KIR", "numeric code": "296" },
      { "name": "Greece", "alpha-2 code": "GR", "alpha-3 code": "GRC", "numeric code": "300" },
      { "name": "Greenland", "alpha-2 code": "GL", "alpha-3 code": "GRL", "numeric code": "304" },
      { "name": "Grenada", "alpha-2 code": "GD", "alpha-3 code": "GRD", "numeric code": "308" },
      { "name": "Guadeloupe", "alpha-2 code": "GP", "alpha-3 code": "GLP", "numeric code": "312" },
      { "name": "Guam", "alpha-2 code": "GU", "alpha-3 code": "GUM", "numeric code": "316" },
      { "name": "Guatemala", "alpha-2 code": "GT", "alpha-3 code": "GTM", "numeric code": "320" },
      { "name": "Guinea", "alpha-2 code": "GN", "alpha-3 code": "GIN", "numeric code": "324" },
      { "name": "Guyana", "alpha-2 code": "GY", "alpha-3 code": "GUY", "numeric code": "328" },
      { "name": "Haiti", "alpha-2 code": "HT", "alpha-3 code": "HTI", "numeric code": "332" },
      { "name": "Heard Island and McDonald Islands", "alpha-2 code": "HM", "alpha-3 code": "HMD", "numeric code": "334" },
      { "name": "Holy See", "alpha-2 code": "VA", "alpha-3 code": "VAT", "numeric code": "336" },
      { "name": "Honduras", "alpha-2 code": "HN", "alpha-3 code": "HND", "numeric code": "340" },
      { "name": "Hong Kong", "alpha-2 code": "HK", "alpha-3 code": "HKG", "numeric code": "344" },
      { "name": "Hungary", "alpha-2 code": "HU", "alpha-3 code": "HUN", "numeric code": "348" },
      { "name": "Iceland", "alpha-2 code": "IS", "alpha-3 code": "ISL", "numeric code": "352" },
      { "name": "India", "alpha-2 code": "IN", "alpha-3 code": "IND", "numeric code": "356" },
      { "name": "Indonesia", "alpha-2 code": "ID", "alpha-3 code": "IDN", "numeric code": "360" },
      { "name": "Iran", "alpha-2 code": "IR", "alpha-3 code": "IRN", "numeric code": "364" },
      { "name": "Iraq", "alpha-2 code": "IQ", "alpha-3 code": "IRQ", "numeric code": "368" },
      { "name": "Ireland", "alpha-2 code": "IE", "alpha-3 code": "IRL", "numeric code": "372" },
      { "name": "Israel", "alpha-2 code": "IL", "alpha-3 code": "ISR", "numeric code": "376" },
      { "name": "Italy", "alpha-2 code": "IT", "alpha-3 code": "ITA", "numeric code": "380" },
      { "name": "Côte d'Ivoire", "alpha-2 code": "CI", "alpha-3 code": "CIV", "numeric code": "384" },
      { "name": "Jamaica", "alpha-2 code": "JM", "alpha-3 code": "JAM", "numeric code": "388" },
      { "name": "Japan", "alpha-2 code": "JP", "alpha-3 code": "JPN", "numeric code": "392" },
      { "name": "Kazakhstan", "alpha-2 code": "KZ", "alpha-3 code": "KAZ", "numeric code": "398" },
      { "name": "Jordan", "alpha-2 code": "JO", "alpha-3 code": "JOR", "numeric code": "400" },
      { "name": "Kenya", "alpha-2 code": "KE", "alpha-3 code": "KEN", "numeric code": "404" },
      { "name": "North Korea", "alpha-2 code": "KP", "alpha-3 code": "PRK", "numeric code": "408" },
      { "name": "South Korea", "alpha-2 code": "KR", "alpha-3 code": "KOR", "numeric code": "410" },
      { "name": "Kuwait", "alpha-2 code": "KW", "alpha-3 code": "KWT", "numeric code": "414" },
      { "name": "Kyrgyzstan", "alpha-2 code": "KG", "alpha-3 code": "KGZ", "numeric code": "417" },
      { "name": "Lao People's Democratic Republic", "alpha-2 code": "LA", "alpha-3 code": "LAO", "numeric code": "418" },
      { "name": "Lebanon", "alpha-2 code": "LB", "alpha-3 code": "LBN", "numeric code": "422" },
      { "name": "Lesotho", "alpha-2 code": "LS", "alpha-3 code": "LSO", "numeric code": "426" },
      { "name": "Latvia", "alpha-2 code": "LV", "alpha-3 code": "LVA", "numeric code": "428" },
      { "name": "Liberia", "alpha-2 code": "LR", "alpha-3 code": "LBR", "numeric code": "430" },
      { "name": "Libya", "alpha-2 code": "LY", "alpha-3 code": "LBY", "numeric code": "434" },
      { "name": "Liechtenstein", "alpha-2 code": "LI", "alpha-3 code": "LIE", "numeric code": "438" },
      { "name": "Lithuania", "alpha-2 code": "LT", "alpha-3 code": "LTU", "numeric code": "440" },
      { "name": "Luxembourg", "alpha-2 code": "LU", "alpha-3 code": "LUX", "numeric code": "442" },
      { "name": "Macao", "alpha-2 code": "MO", "alpha-3 code": "MAC", "numeric code": "446" },
      { "name": "Madagascar", "alpha-2 code": "MG", "alpha-3 code": "MDG", "numeric code": "450" },
      { "name": "Malawi", "alpha-2 code": "MW", "alpha-3 code": "MWI", "numeric code": "454" },
      { "name": "Malaysia", "alpha-2 code": "MY", "alpha-3 code": "MYS", "numeric code": "458" },
      { "name": "Maldives", "alpha-2 code": "MV", "alpha-3 code": "MDV", "numeric code": "462" },
      { "name": "Mali", "alpha-2 code": "ML", "alpha-3 code": "MLI", "numeric code": "466" },
      { "name": "Malta", "alpha-2 code": "MT", "alpha-3 code": "MLT", "numeric code": "470" },
      { "name": "Martinique", "alpha-2 code": "MQ", "alpha-3 code": "MTQ", "numeric code": "474" },
      { "name": "Mauritania", "alpha-2 code": "MR", "alpha-3 code": "MRT", "numeric code": "478" },
      { "name": "Mauritius", "alpha-2 code": "MU", "alpha-3 code": "MUS", "numeric code": "480" },
      { "name": "Mexico", "alpha-2 code": "MX", "alpha-3 code": "MEX", "numeric code": "484" },
      { "name": "Monaco", "alpha-2 code": "MC", "alpha-3 code": "MCO", "numeric code": "492" },
      { "name": "Mongolia", "alpha-2 code": "MN", "alpha-3 code": "MNG", "numeric code": "496" },
      { "name": "Moldova", "alpha-2 code": "MD", "alpha-3 code": "MDA", "numeric code": "498" },
      { "name": "Montenegro", "alpha-2 code": "ME", "alpha-3 code": "MNE", "numeric code": "499" },
      { "name": "Montserrat", "alpha-2 code": "MS", "alpha-3 code": "MSR", "numeric code": "500" },
      { "name": "Morocco", "alpha-2 code": "MA", "alpha-3 code": "MAR", "numeric code": "504" },
      { "name": "Mozambique", "alpha-2 code": "MZ", "alpha-3 code": "MOZ", "numeric code": "508" },
      { "name": "Oman", "alpha-2 code": "OM", "alpha-3 code": "OMN", "numeric code": "512" },
      { "name": "Namibia", "alpha-2 code": "NA", "alpha-3 code": "NAM", "numeric code": "516" },
      { "name": "Nauru", "alpha-2 code": "NR", "alpha-3 code": "NRU", "numeric code": "520" },
      { "name": "Nepal", "alpha-2 code": "NP", "alpha-3 code": "NPL", "numeric code": "524" },
      { "name": "Netherlands", "alpha-2 code": "NL", "alpha-3 code": "NLD", "numeric code": "528" },
      { "name": "Curaçao", "alpha-2 code": "CW", "alpha-3 code": "CUW", "numeric code": "531" },
      { "name": "Aruba", "alpha-2 code": "AW", "alpha-3 code": "ABW", "numeric code": "533" },
      { "name": "Sint Maarten", "alpha-2 code": "SX", "alpha-3 code": "SXM", "numeric code": "534" },
      { "name": "Bonaire, Sint Eustatius and Saba", "alpha-2 code": "BQ", "alpha-3 code": "BES", "numeric code": "535" },
      { "name": "New Caledonia", "alpha-2 code": "NC", "alpha-3 code": "NCL", "numeric code": "540" },
      { "name": "Vanuatu", "alpha-2 code": "VU", "alpha-3 code": "VUT", "numeric code": "548" },
      { "name": "New Zealand", "alpha-2 code": "NZ", "alpha-3 code": "NZL", "numeric code": "554" },
      { "name": "Nicaragua", "alpha-2 code": "NI", "alpha-3 code": "NIC", "numeric code": "558" },
      { "name": "Niger", "alpha-2 code": "NE", "alpha-3 code": "NER", "numeric code": "562" },
      { "name": "Nigeria", "alpha-2 code": "NG", "alpha-3 code": "NGA", "numeric code": "566" },
      { "name": "Niue", "alpha-2 code": "NU", "alpha-3 code": "NIU", "numeric code": "570" },
      { "name": "Norfolk Island", "alpha-2 code": "NF", "alpha-3 code": "NFK", "numeric code": "574" },
      { "name": "Norway", "alpha-2 code": "NO", "alpha-3 code": "NOR", "numeric code": "578" },
      { "name": "Northern Mariana Islands", "alpha-2 code": "MP", "alpha-3 code": "MNP", "numeric code": "580" },
      { "name": "United States Minor Outlying Islands", "alpha-2 code": "UM", "alpha-3 code": "UMI", "numeric code": "581" },
      { "name": "Micronesia", "alpha-2 code": "FM", "alpha-3 code": "FSM", "numeric code": "583" },
      { "name": "Marshall Islands", "alpha-2 code": "MH", "alpha-3 code": "MHL", "numeric code": "584" },
      { "name": "Palau", "alpha-2 code": "PW", "alpha-3 code": "PLW", "numeric code": "585" },
      { "name": "Pakistan", "alpha-2 code": "PK", "alpha-3 code": "PAK", "numeric code": "586" },
      { "name": "Panama", "alpha-2 code": "PA", "alpha-3 code": "PAN", "numeric code": "591" },
      { "name": "Papua New Guinea", "alpha-2 code": "PG", "alpha-3 code": "PNG", "numeric code": "598" },
      { "name": "Paraguay", "alpha-2 code": "PY", "alpha-3 code": "PRY", "numeric code": "600" },
      { "name": "Peru", "alpha-2 code": "PE", "alpha-3 code": "PER", "numeric code": "604" },
      { "name": "Philippines", "alpha-2 code": "PH", "alpha-3 code": "PHL", "numeric code": "608" },
      { "name": "Pitcairn", "alpha-2 code": "PN", "alpha-3 code": "PCN", "numeric code": "612" },
      { "name": "Poland", "alpha-2 code": "PL", "alpha-3 code": "POL", "numeric code": "616" },
      { "name": "Portugal", "alpha-2 code": "PT", "alpha-3 code": "PRT", "numeric code": "620" },
      { "name": "Guinea-Bissau", "alpha-2 code": "GW", "alpha-3 code": "GNB", "numeric code": "624" },
      { "name": "Timor-Leste", "alpha-2 code": "TL", "alpha-3 code": "TLS", "numeric code": "626" },
      { "name": "Puerto Rico", "alpha-2 code": "PR", "alpha-3 code": "PRI", "numeric code": "630" },
      { "name": "Qatar", "alpha-2 code": "QA", "alpha-3 code": "QAT", "numeric code": "634" },
      { "name": "Réunion", "alpha-2 code": "RE", "alpha-3 code": "REU", "numeric code": "638" },
      { "name": "Romania", "alpha-2 code": "RO", "alpha-3 code": "ROU", "numeric code": "642" },
      { "name": "Russian Federation", "alpha-2 code": "RU", "alpha-3 code": "RUS", "numeric code": "643" },
      { "name": "Rwanda", "alpha-2 code": "RW", "alpha-3 code": "RWA", "numeric code": "646" },
      { "name": "Saint Barthélemy", "alpha-2 code": "BL", "alpha-3 code": "BLM", "numeric code": "652" },
      { "name": "Saint Helena, Ascension and Tristan da Cunha", "alpha-2 code": "SH", "alpha-3 code": "SHN", "numeric code": "654" },
      { "name": "Saint Kitts and Nevis", "alpha-2 code": "KN", "alpha-3 code": "KNA", "numeric code": "659" },
      { "name": "Anguilla", "alpha-2 code": "AI", "alpha-3 code": "AIA", "numeric code": "660" },
      { "name": "Saint Lucia", "alpha-2 code": "LC", "alpha-3 code": "LCA", "numeric code": "662" },
      { "name": "Saint Martin", "alpha-2 code": "MF", "alpha-3 code": "MAF", "numeric code": "663" },
      { "name": "Saint Pierre and Miquelon", "alpha-2 code": "PM", "alpha-3 code": "SPM", "numeric code": "666" },
      { "name": "Saint Vincent and the Grenadines", "alpha-2 code": "VC", "alpha-3 code": "VCT", "numeric code": "670" },
      { "name": "San Marino", "alpha-2 code": "SM", "alpha-3 code": "SMR", "numeric code": "674" },
      { "name": "Sao Tome and Principe", "alpha-2 code": "ST", "alpha-3 code": "STP", "numeric code": "678" },
      { "name": "Saudi Arabia", "alpha-2 code": "SA", "alpha-3 code": "SAU", "numeric code": "682" },
      { "name": "Senegal", "alpha-2 code": "SN", "alpha-3 code": "SEN", "numeric code": "686" },
      { "name": "Serbia", "alpha-2 code": "RS", "alpha-3 code": "SRB", "numeric code": "688" },
      { "name": "Seychelles", "alpha-2 code": "SC", "alpha-3 code": "SYC", "numeric code": "690" },
      { "name": "Sierra Leone", "alpha-2 code": "SL", "alpha-3 code": "SLE", "numeric code": "694" },
      { "name": "Singapore", "alpha-2 code": "SG", "alpha-3 code": "SGP", "numeric code": "702" },
      { "name": "Slovakia", "alpha-2 code": "SK", "alpha-3 code": "SVK", "numeric code": "703" },
      { "name": "Viet Nam", "alpha-2 code": "VN", "alpha-3 code": "VNM", "numeric code": "704" },
      { "name": "Slovenia", "alpha-2 code": "SI", "alpha-3 code": "SVN", "numeric code": "705" },
      { "name": "Somalia", "alpha-2 code": "SO", "alpha-3 code": "SOM", "numeric code": "706" },
      { "name": "South Africa", "alpha-2 code": "ZA", "alpha-3 code": "ZAF", "numeric code": "710" },
      { "name": "Zimbabwe", "alpha-2 code": "ZW", "alpha-3 code": "ZWE", "numeric code": "716" },
      { "name": "Spain", "alpha-2 code": "ES", "alpha-3 code": "ESP", "numeric code": "724" },
      { "name": "South Sudan", "alpha-2 code": "SS", "alpha-3 code": "SSD", "numeric code": "728" },
      { "name": "Sudan", "alpha-2 code": "SD", "alpha-3 code": "SDN", "numeric code": "729" },
      { "name": "Western Sahara", "alpha-2 code": "EH", "alpha-3 code": "ESH", "numeric code": "732" },
      { "name": "Suriname", "alpha-2 code": "SR", "alpha-3 code": "SUR", "numeric code": "740" },
      { "name": "Svalbard and Jan Mayen", "alpha-2 code": "SJ", "alpha-3 code": "SJM", "numeric code": "744" },
      { "name": "Eswatini", "alpha-2 code": "SZ", "alpha-3 code": "SWZ", "numeric code": "748" },
      { "name": "Sweden", "alpha-2 code": "SE", "alpha-3 code": "SWE", "numeric code": "752" },
      { "name": "Switzerland", "alpha-2 code": "CH", "alpha-3 code": "CHE", "numeric code": "756" },
      { "name": "Syrian Arab Republic", "alpha-2 code": "SY", "alpha-3 code": "SYR", "numeric code": "760" },
      { "name": "Tajikistan", "alpha-2 code": "TJ", "alpha-3 code": "TJK", "numeric code": "762" },
      { "name": "Thailand", "alpha-2 code": "TH", "alpha-3 code": "THA", "numeric code": "764" },
      { "name": "Togo", "alpha-2 code": "TG", "alpha-3 code": "TGO", "numeric code": "768" },
      { "name": "Tokelau", "alpha-2 code": "TK", "alpha-3 code": "TKL", "numeric code": "772" },
      { "name": "Tonga", "alpha-2 code": "TO", "alpha-3 code": "TON", "numeric code": "776" },
      { "name": "Trinidad and Tobago", "alpha-2 code": "TT", "alpha-3 code": "TTO", "numeric code": "780" },
      { "name": "United Arab Emirates", "alpha-2 code": "AE", "alpha-3 code": "ARE", "numeric code": "784" },
      { "name": "Tunisia", "alpha-2 code": "TN", "alpha-3 code": "TUN", "numeric code": "788" },
      { "name": "Türkiye", "alpha-2 code": "TR", "alpha-3 code": "TUR", "numeric code": "792" },
      { "name": "Turkmenistan", "alpha-2 code": "TM", "alpha-3 code": "TKM", "numeric code": "795" },
      { "name": "Turks and Caicos Islands", "alpha-2 code": "TC", "alpha-3 code": "TCA", "numeric code": "796" },
      { "name": "Tuvalu", "alpha-2 code": "TV", "alpha-3 code": "TUV", "numeric code": "798" },
      { "name": "Uganda", "alpha-2 code": "UG", "alpha-3 code": "UGA", "numeric code": "800" },
      { "name": "Ukraine", "alpha-2 code": "UA", "alpha-3 code": "UKR", "numeric code": "804" },
      { "name": "North Macedonia", "alpha-2 code": "MK", "alpha-3 code": "MKD", "numeric code": "807" },
      { "name": "Egypt", "alpha-2 code": "EG", "alpha-3 code": "EGY", "numeric code": "818" },
      { "name": "United Kingdom of Great Britain and Northern Ireland", "alpha-2 code": "GB", "alpha-3 code": "GBR", "numeric code": "826" },
      { "name": "Guernsey", "alpha-2 code": "GG", "alpha-3 code": "GGY", "numeric code": "831" },
      { "name": "Jersey", "alpha-2 code": "JE", "alpha-3 code": "JEY", "numeric code": "832" },
      { "name": "Isle of Man", "alpha-2 code": "IM", "alpha-3 code": "IMN", "numeric code": "833" },
      { "name": "Tanzania, United Republic of", "alpha-2 code": "TZ", "alpha-3 code": "TZA", "numeric code": "834" },
      { "name": "United States of America", "alpha-2 code": "US", "alpha-3 code": "USA", "numeric code": "840" },
      { "name": "Virgin Islands (U.S.)", "alpha-2 code": "VI", "alpha-3 code": "VIR", "numeric code": "850" },
      { "name": "Burkina Faso", "alpha-2 code": "BF", "alpha-3 code": "BFA", "numeric code": "854" },
      { "name": "Uruguay", "alpha-2 code": "UY", "alpha-3 code": "URY", "numeric code": "858" },
      { "name": "Uzbekistan", "alpha-2 code": "UZ", "alpha-3 code": "UZB", "numeric code": "860" },
      { "name": "Venezuela", "alpha-2 code": "VE", "alpha-3 code": "VEN", "numeric code": "862" },
      { "name": "Wallis and Futuna", "alpha-2 code": "WF", "alpha-3 code": "WLF", "numeric code": "876" },
      { "name": "Samoa", "alpha-2 code": "WS", "alpha-3 code": "WSM", "numeric code": "882" },
      { "name": "Yemen", "alpha-2 code": "YE", "alpha-3 code": "YEM", "numeric code": "887" },
      { "name": "Zambia", "alpha-2 code": "ZM", "alpha-3 code": "ZMB", "numeric code": "894" }
   ];

   return codes[$getRandIntInc(0, codes.length - 1)];
}

function $ftoc(fahrenheit) {
   /*
    *  convert Fahrenheit to Celsius temparature unit
    */
   return (fahrenheit - 32) / 1.8;
}

function $ctof(celsius) {
   /*
    *  convert Celsius to Fahrenheit temparature unit
    */
   return celsius * 1.8 + 32;
}

function $ctok(celsius) {
   /*
    *  convert Celsius to Kelvin temparature unit
    */
   return celsius + K;
}

function $ktoc(kelvin) {
   /*
    *  convert Kelvin to Celsius temparature unit
    */
   return kelvin - K;
}

function $ftok(fahrenheit) {
   /*
    *  convert Fahrenheit to Kelvin temparature unit
    */
   return ((fahrenheit - 32) / 1.8) + K;
}

function $ktof(kelvin) {
   /*
    *  convert Kelvin to Fahrenheit temparature unit
    */
   return (kelvin - K) * 1.8 + 32;
}

function $bool(chance = 0.5) {
   /*
    *  return true/false
    */
   return $rand() < chance;
}

const benfordBins = 4096; // power of two: a uint32 maps onto the table with no modulo bias
const benfordSignificand = new Float64Array(benfordBins);
for (let benfordBin = 0; benfordBin < benfordBins; benfordBin++)
   benfordSignificand[benfordBin] = Math.pow(10, (benfordBin + 0.5) / benfordBins);

const benfordRandBuf = new Uint32Array(1024);
let benfordRandAt = benfordRandBuf.length;

function benfordUint32() {
   /*
    *  One uint32 from a refilled crypto buffer.
    */
   if (benfordRandAt >= benfordRandBuf.length) {
      crypto.webcrypto.getRandomValues(benfordRandBuf);
      benfordRandAt = 0;
   }
   return benfordRandBuf[benfordRandAt++];
}

function $benford(expMin = 0, expMax = 6) {
   /*
    *  Positive magnitude whose significand follows Benford's law.
    *  expMin and expMax are inclusive powers of ten.
    *  The draw is in [10^expMin, 10^(expMax+1)).
    *  A schema "=" expression calls this directly.
    */
   let lo = +expMin;
   let hi = +expMax;
   if (!Number.isFinite(lo)) lo = 0;
   if (!Number.isFinite(hi)) hi = 6;
   lo = $floor(lo);
   hi = $floor(hi);
   if (hi < lo) {
      const swap = lo;
      lo = hi;
      hi = swap;
   }
   // significand is in [1, 10); keep sig * 10^exp finite and normal
   if (lo < -307) lo = -307;
   if (lo > 307) lo = 307;
   if (hi > 307) hi = 307;
   if (hi < -307) hi = -307;
   if (hi < lo) hi = lo;

   const sig = benfordSignificand[benfordUint32() % benfordBins];
   const span = hi - lo + 1;
   let offset = 0;
   if (span > 1) {
      // rejection keeps the exponent uniform when span does not divide 2^32
      const limit = 0x100000000 - (0x100000000 % span);
      let unit = benfordUint32();
      while (unit >= limit)
         unit = benfordUint32();
      offset = unit % span;
   }
   return sig * Math.pow(10, lo + offset);
}

function isUnauthorizedError(e) {
   if (!e) return false;
   if (e.codeName == 'Unauthorized') return true;
   if (+e.code === 13) return true; // Unauthorized
   const msg = e.errmsg || e.message || String(e);
   return /not authorized|unauthorized/i.test(msg);
}

function commandErrorMessage(e) {
   if (!e) return 'unknown error';
   return e.codeName || e.errmsg || e.message || String(e);
}

function dbStatsErrorStub(dbName, e) {
   return {
      "name": dbName,
      "collections": 0,
      "indexes": 0,
      "nindexes": 0,
      "views": 0,
      "nviews": 0,
      "namespaces": 0,
      "objects": 0,
      "orphans": 0,
      "dataSize": 0,
      "storageSize": 0,
      "indexSize": 0,
      "freeStorageSize": null,
      "indexFreeStorageSize": null,
      "totalIndexBytesReusable": null,
      "scaleFactor": 1,
      "fsUsedSize": null,
      "fsTotalSize": null,
      "statsError": commandErrorMessage(e),
      "unauthorized": isUnauthorizedError(e)
   };
}

function dbStatsCommandSpec() {
   // MONGOSH-1108 (mongosh v1.2.0) & SERVER-62277 (mongod v5.0.6)
   return (serverVer('5.0.6') && shellVer(1.2))
      ? { "dbStats": 1, "freeStorage": 1, "scale": 1 }
      : { "dbStats": 1, "scale": 1 };
}

function $stats(dbName = db.getName()) {
   /*
    *  stats() wrapper (sync). Overlapped gathers use fetchDbStats.
    */
   let stats;
   try {
      stats = db.getSiblingDB(dbName).stats( // max precision due to SERVER-69036
         (serverVer('5.0.6') && shellVer(1.2))
         ? { "freeStorage": 1, "scale": 1 } : 1
      );
   } catch(e) {
      return dbStatsErrorStub(dbName, e);
   }
   return normalizeDbStatsDoc(stats, dbName);
}

function normalizeDbStatsDoc(stats, dbName) {
   stats = stats || {};
   stats.name = dbName;
   delete stats.db;
   // Atlas M0/Flex hide WT free-space; a 0 here is not an empty free list.
   const hideFree = hidesDbStatsFreeStorage();
   if (stats.hasOwnProperty('raw')) { // detect sharded db.stats()
      stats.collections = [];
      stats.views = [];
      stats.namespaces = [];
      stats.indexes = [];
      stats.nindexes = stats.indexes;
      let freeSum = 0, idxFreeSum = 0, sawFree = false, sawIdxFree = false;
      for (const shard in stats.raw) {
         if (stats.raw.hasOwnProperty(shard)) {
            stats.collections.push(+stats.raw[shard].collections);
            stats.views.push(+stats.raw[shard].views);
            stats.indexes.push(+stats.raw[shard].indexes);
            stats.namespaces.push(+stats.raw[shard].collections + +stats.raw[shard].views);
            if (typeof stats.raw[shard].freeStorageSize !== 'undefined') {
               freeSum += +stats.raw[shard].freeStorageSize;
               sawFree = true;
            }
            if (typeof stats.raw[shard].indexFreeStorageSize !== 'undefined') {
               idxFreeSum += +stats.raw[shard].indexFreeStorageSize;
               sawIdxFree = true;
            }
         }
      }
      stats.freeStorageSize = hideFree ? null : (sawFree ? freeSum : 0);
      stats.indexFreeStorageSize = hideFree ? null : (sawIdxFree ? idxFreeSum : 0);
      // Volume capacity is per mongod dbPath; mongos raw is not one filesystem.
      stats.fsUsedSize = null;
      stats.fsTotalSize = null;
   } else { // detect unsharded db.stats()
      stats.collections = +stats.collections;
      stats.indexes = +stats.indexes;
      stats.nindexes = stats.indexes;
      stats.views = +stats.views;
      stats.nviews = stats.views;
      stats.namespaces = stats.collections + stats.views;
      if (hideFree) {
         stats.freeStorageSize = null;
         stats.indexFreeStorageSize = null;
      } else {
         stats.freeStorageSize = (typeof stats.freeStorageSize === 'undefined') ? 0 : +stats.freeStorageSize;
         stats.indexFreeStorageSize = (typeof stats.indexFreeStorageSize === 'undefined') ? 0 : +stats.indexFreeStorageSize;
      }
   }

   stats.objects = +stats.objects;
   stats.dataSize = +stats.dataSize;
   stats.storageSize = +stats.storageSize;
   stats.indexSize = +stats.indexSize;
   stats.totalIndexBytesReusable = stats.indexFreeStorageSize;
   stats.scaleFactor = +stats.scaleFactor;
   if (!stats.hasOwnProperty('raw')) {
      stats.fsUsedSize = toNullableBytes(stats.fsUsedSize);
      stats.fsTotalSize = toNullableBytes(stats.fsTotalSize);
   }
   delete stats.fileSize;
   delete stats.totalSize;
   delete stats.totalFreeStorageSize;
   delete stats.numExtents;
   delete stats.$clusterTime;
   delete stats.operationTime;
   delete stats.ok;

   return stats;
}

let __collStatsOnMongos;

async function awaitPlain(value) {
   if (value && typeof value.then === 'function' && typeof value.close !== 'function') {
      return await value;
   }
   return value;
}

async function fetchDbStats(dbName = db.getName()) {
   /*
    *  Async $stats. runCommand + awaitPlain so mapPool overlaps.
    *  Same normalised document as $stats. $stats stays the sync helper.
    */
   try {
      const stats = await awaitPlain(
         db.getSiblingDB(dbName).runCommand(dbStatsCommandSpec())
      );
      return normalizeDbStatsDoc(stats, dbName);
   } catch (e) {
      return dbStatsErrorStub(dbName, e);
   }
}

async function collStatsOnMongos() {
   if (__collStatsOnMongos != null) return __collStatsOnMongos;
   __collStatsOnMongos = !!(await awaitPlain(isSharded()));
   return __collStatsOnMongos;
}

async function configFindOne(collName, filter) {
   return awaitPlain(db.getSiblingDB('config').getCollection(collName).findOne(filter));
}

async function configDistinct(collName, field, filter) {
   return awaitPlain(db.getSiblingDB('config').getCollection(collName).distinct(field, filter));
}

async function shardsFromConfigNs(ns) {
   const collDoc = await configFindOne('collections', {
      "$or": [{ "_id": ns }, { "ns": ns }],
      "dropped": { "$ne": true }
   });
   if (!collDoc) return [];
   const chunkFilter = collDoc.uuid ? { "uuid": collDoc.uuid } : { "ns": ns };
   const shards = await configDistinct('chunks', 'shard', chunkFilter);
   return Array.isArray(shards) ? shards.filter(s => typeof s === 'string' && s.length) : [];
}

async function collectionOwningShardIds(dbName, collName, cache) {
   /*
    *  Shards that own this NS. A non-empty catalogShards seed already in
    *  the cache wins. Otherwise config.chunks (uuid/ns), timeseries buckets,
    *  then the database primary. cache is the gather Map (one materialize
    *  or one fetchAllStats). No cache means no remembered owners.
    *  null ids = unknown placement (skip the incomplete mark).
    */
   const ns = `${dbName}.${collName}`;
   const useCache = cache instanceof Map;
   if (useCache && cache.has(ns)) return cache.get(ns);
   let ids = null;
   try {
      ids = await shardsFromConfigNs(ns);
      if (!ids.length && collName && !String(collName).startsWith('system.buckets.')) {
         ids = await shardsFromConfigNs(`${dbName}.system.buckets.${collName}`);
      }
      if (!ids.length) {
         const dbDoc = await configFindOne('databases', { "_id": dbName });
         if (dbDoc && typeof dbDoc.primary === 'string' && dbDoc.primary) ids = [dbDoc.primary];
      }
      if (!ids.length) ids = null;
   } catch(_) {
      ids = null;
   }
   if (useCache) cache.set(ns, ids);
   return ids;
}

async function markPartialShardStats(doc, dbName, collName, cache) {
   /*
    *  $group only sees shards that returned. Compare that set to the
    *  collection's owning shards, not cluster-wide listShards — a NS on a
    *  subset of shards is complete when every owner returned. Unknown
    *  placement skips this mark.
    */
   if (!doc || doc.statsError) return doc;
   const ids = Array.isArray(doc.shards)
      ? [...new Set(doc.shards.filter(s => typeof s === 'string' && s.length))]
      : [];
   if (ids.length && await collStatsOnMongos()) {
      const owning = await collectionOwningShardIds(dbName, collName, cache);
      if (Array.isArray(owning) && owning.length) {
         const got = new Set(ids);
         if (owning.some(id => !got.has(id))) {
            doc.freeStorageComplete = false;
            doc.totalIndexBytesReusableComplete = false;
            doc.statsIncomplete = true;
         }
      }
   }
   if (doc.totalIndexBytesReusableComplete === false && Array.isArray(doc.indexes)) {
      doc.indexes.forEach(idx => {
         if (idx) idx.freeStorageComplete = false;
      });
   }
   return doc;
}

async function drainAggCursor(cursor) {
   /*
    *  Drain an aggregation to an array. Do not await a live cursor (thenable
    *  drains). Driver _cursor.toArray() is a native Promise so mapPool overlaps.
    *  Shell toArray() is rewriter-unwrapped to an array.
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

function catalogAggOptions(comment) {
   return {
      "cursor": { "batchSize": 1000 },
      "readConcern": { "level": "local" },
      "readPreference": (typeof readPref !== 'undefined') ? readPref
                      : (hello().secondary) ? 'secondaryPreferred'
                      : 'primaryPreferred',
      "comment": comment || `run by ${__lib.name} catalog listing`
   };
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
    *  listCollections / $listClusterCatalog: type collection|view|timeseries.
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

function catalogOwnerShards(doc = {}) {
   /*
    *  $listClusterCatalog shards:true returns string shard ids.
    *  Absent field stays off the entry. An array is kept, including empty.
    */
   if (!Array.isArray(doc.shards)) return null;
   const ids = [];
   const seen = new Set();
   for (const id of doc.shards) {
      if (typeof id !== 'string' || !id.length || seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
   }
   return ids;
}

function normalizeCatalogEntry(doc = {}) {
   const dbName = catalogEntryDb(doc);
   const name = catalogEntryName(doc);
   if (!dbName || !name) return null;
   const entry = {
      "db": dbName,
      "name": name,
      "type": catalogEntryType(doc)
   };
   const shards = catalogOwnerShards(doc);
   if (shards) entry.shards = shards;
   return entry;
}

function dedupeCatalogEntries(entries = []) {
   const seen = new Map();
   for (const e of entries) {
      if (!e || !e.db || !e.name) continue;
      const k = `${e.db}\0${e.name}`;
      if (!seen.has(k)) seen.set(k, e);
   }
   return [...seen.values()];
}

function indexCatalogByDb(entries = []) {
   const byDb = Object.create(null);
   for (const e of entries) {
      if (!e || !e.db) continue;
      if (!byDb[e.db]) byDb[e.db] = [];
      byDb[e.db].push(e);
   }
   return byDb;
}

function normalizeCatalogMode(mode) {
   const s = String(mode == null ? 'auto' : mode).toLowerCase().replace(/^\$/, '');
   if (s === 'legacy' || s === 'listcollections' || s === 'getcollectioninfos') return 'legacy';
   if (s === 'listcatalog') return 'listCatalog';
   if (s === 'listclustercatalog') return 'listClusterCatalog';
   return 'auto';
}

function catalogSnapshotResult(builder, entries = [], fallback = false, fallbackError = null) {
   return {
      "builder": builder,
      "fallback": fallback === true,
      "fallbackError": fallbackError || null,
      "entries": entries,
      "byDb": indexCatalogByDb(entries)
   };
}

async function $listCatalog() {
   /*
    *  Collectionless $listCatalog on admin (6.0+). Best-effort; authz may deny.
    *  Returns normalised { db, name, type } rows, deduped by db+name.
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
   const docs = await drainAggCursor(
      db.getSiblingDB('admin').aggregate(pipeline, catalogAggOptions(
         `run by ${__lib.name} $listCatalog`
      ))
   );
   return dedupeCatalogEntries(docs.map(normalizeCatalogEntry).filter(Boolean));
}

async function $listClusterCatalog({ shards = false } = {}) {
   /*
    *  $listClusterCatalog on admin (8.0.10+). Unsupported/unstable; optional
    *  cluster-wide fast path. First stage; admin = all collections.
    *  shards:true adds the per-namespace owner list. Omit it otherwise.
    */
   const spec = {};
   if (shards) spec.shards = true;
   const project = {
      "ns": 1,
      "db": 1,
      "type": 1,
      "name": 1,
      "viewOn": 1,
      "options.timeseries": 1,
      "options.viewOn": 1
   };
   if (shards) project.shards = 1;
   const pipeline = [
      { "$listClusterCatalog": spec },
      { "$project": project }
   ];
   const docs = await drainAggCursor(
      db.getSiblingDB('admin').aggregate(pipeline, catalogAggOptions(
         `run by ${__lib.name} $listClusterCatalog`
      ))
   );
   return dedupeCatalogEntries(docs.map(normalizeCatalogEntry).filter(Boolean));
}

async function listCatalogSnapshot(mode = 'auto', opts = {}) {
   /*
    *  Whole-cluster namespace listing.
    *  mode: auto | legacy | listCatalog | listClusterCatalog.
    *  auto: mongos && 8.0.10+ → $listClusterCatalog; else 6.0+ → $listCatalog;
    *  else legacy. On stage failure / authz, builder is legacy and entries empty
    *  (caller lists per DB with getCollectionInfos).
    *  opts.shards asks $listClusterCatalog for owners. The caller sets it
    *  only when those ids will be consumed. opts.skipCluster skips the stage
    *  when connectionStatus already lacks clusterMonitor.
    */
   const requested = normalizeCatalogMode(mode);
   const wantShards = !!(opts && opts.shards);
   const skipCluster = !!(opts && opts.skipCluster);
   // auto still tries $listCatalog / $listClusterCatalog on shared-tier.
   // Atlas M0 denies with AtlasError 8000 today; a later allow surfaces
   // the stage. catalog:legacy is the operator A/B that skips the try.
   if (requested === 'legacy') {
      return catalogSnapshotResult('legacy', [], false);
   }
   if (skipCluster && requested === 'listClusterCatalog') {
      return catalogSnapshotResult('legacy', [], true, 'connectionStatus lacks clusterMonitor');
   }

   const tryCluster = !skipCluster && (
      requested === 'listClusterCatalog'
      || (requested === 'auto' && isSharded() && serverVer('8.0.10'))
   );
   const tryList = requested === 'listCatalog' || requested === 'auto';

   if (tryCluster) {
      try {
         if (!serverVer('8.0.10')) throw new Error('requires MongoDB 8.0.10+');
         const entries = await $listClusterCatalog({ "shards": wantShards });
         return catalogSnapshotResult('listClusterCatalog', entries, false);
      } catch(e) {
         if (requested === 'listClusterCatalog') {
            return catalogSnapshotResult('legacy', [], true, commandErrorMessage(e));
         }
      }
   }

   if (tryList && serverVer(6.0)) {
      try {
         const entries = await $listCatalog();
         return catalogSnapshotResult('listCatalog', entries, false);
      } catch(e) {
         return catalogSnapshotResult('legacy', [], true, commandErrorMessage(e));
      }
   }

   if (requested === 'listCatalog') {
      return catalogSnapshotResult('legacy', [], true, 'requires MongoDB 6.0+');
   }

   return catalogSnapshotResult('legacy', [], false);
}

async function $collStats(dbName = db.getName(), collName = '', owningShardCache = null) {
   /*
    *  $collStats wrapper. Always a Promise — await the call.
    *  Live aggregate cursors are thenable; awaiting the cursor drains it.
    *  Drain via drainAggCursor (driver _cursor.toArray()).
    */
   const namespace = db.getSiblingDB(dbName).getCollection(collName);
   const options = {
      "allowDiskUse": true,
      "cursor": { "batchSize": 1 }, // eliminates getMore roundtrip, we expect only a single document
      "readConcern": { "level": "local" },
      "readPreference": (typeof readPref !== 'undefined') ? readPref
                      : (hello().secondary) ? 'secondaryPreferred'
                      : 'primaryPreferred',
      "comment": `run by ${__lib.name} sharding compatible $collStats wrapper`
   };
   const pipeline = [
      { "$collStats": { "storageStats": { "scale": 1, "freeStorage": 1 } } },
      { "$set": {
         "storageStats.wiredTiger.creationStrings": {
            "$arrayElemAt": [{
               "$regexFindAll": {
                  "input": { "$ifNull": ["$storageStats.wiredTiger.creationString", ""] },
                  "regex": /block_compressor=(\w+).+internal_page_max=(\d+).+leaf_page_max=(\d+)/
               } },
               0
         ] },
         "storageStats.indexStats": { "$objectToArray": { "$ifNull": ["$storageStats.indexDetails", {}] } }
      } },
      { "$set": {
         "storageStats.wiredTiger.compressor": {
            "$ifNull": [{ "$arrayElemAt": ["$storageStats.wiredTiger.creationStrings.captures", 0] }, "undef"]
         },
         "storageStats.wiredTiger.internalPageSize": {
            "$multiply": [
               { "$toInt": {
                  "$ifNull": [{ "$arrayElemAt": ["$storageStats.wiredTiger.creationStrings.captures", 1] }, 4]
               } }, 1024
         ] },
         "storageStats.wiredTiger.dataPageSize": {
            "$multiply": [
               { "$toInt": {
                  "$ifNull": [{ "$arrayElemAt": ["$storageStats.wiredTiger.creationStrings.captures", 2] }, 32]
               } }, 1024
         ] },
         // WT block-manager present (even with reuse omitted as 0) is a real measurement.
         // db.stats() on Atlas M0/Flex still hides free-space; collection WT may report reuse.
         // Missing block-manager is unavailable unless official freeStorageSize > 0.
         "storageStats.reuseKnown": {
            "$or": [
               { "$ne": [{ "$type": "$storageStats.wiredTiger.block-manager" }, "missing"] },
               { "$gt": [{ "$ifNull": ["$storageStats.freeStorageSize", 0] }, 0] }
            ]
         },
         "storageStats.reuseBytes": {
            "$cond": [
               { "$ne": [{ "$type": "$storageStats.wiredTiger.block-manager.file bytes available for reuse" }, "missing"] },
               "$storageStats.wiredTiger.block-manager.file bytes available for reuse",
               { "$cond": [
                  { "$ne": [{ "$type": "$storageStats.wiredTiger.block-manager" }, "missing"] },
                  0,
                  { "$cond": [
                     { "$gt": [{ "$ifNull": ["$storageStats.freeStorageSize", 0] }, 0] },
                     "$storageStats.freeStorageSize",
                     null
                  ] }
               ] }
            ]
         },
         "storageStats.indexes": {
            "$map": {
               "input": "$storageStats.indexStats",
               "as": "indexes",
               "in": {
                  "$arrayToObject": [[
                     { "k": "name", "v": "$$indexes.k" },
                     { "k": "uri", "v": { "$ifNull": ["$$indexes.v.uri", "statistics:table:index-0-0000000000000000000"] } },
                     { "k": "file size in bytes", "v": { "$ifNull": ["$$indexes.v.block-manager.file size in bytes", 0] } },
                     { "k": "file bytes available for reuse", "v": {
                        "$cond": [
                           { "$ne": [{ "$type": "$$indexes.v.block-manager.file bytes available for reuse" }, "missing"] },
                           "$$indexes.v.block-manager.file bytes available for reuse",
                           { "$cond": [
                              { "$ne": [{ "$type": "$$indexes.v.block-manager" }, "missing"] },
                              0,
                              null
                           ] }
                        ]
                     } },
                     { "k": "file allocation unit size", "v": { "$ifNull": ["$$indexes.v.block-manager.file allocation unit size", WIREDTIGER_MIN_ALLOC_SIZE] } }
         ]] } } },
         "storageStats.indexDetails.file size in bytes": {
            "$reduce": {
               "input": "$storageStats.indexStats",
               "initialValue": 0,
               "in": { "$sum": ["$$value", { "$ifNull": ["$$this.v.block-manager.file size in bytes", 0] }] }
         } },
         "storageStats.indexDetails.file bytes available for reuse": {
            "$reduce": {
               "input": "$storageStats.indexStats",
               "initialValue": 0,
               "in": { "$sum": ["$$value", { "$ifNull": ["$$this.v.block-manager.file bytes available for reuse", 0] }] }
         } },
         "storageStats.indexDetails.reuseKnown": {
            "$cond": [
               { "$eq": [{ "$size": { "$ifNull": ["$storageStats.indexStats", []] } }, 0] },
               { "$eq": [{ "$ifNull": ["$storageStats.nindexes", 0] }, 0] },
               { "$reduce": {
                  "input": "$storageStats.indexStats",
                  "initialValue": true,
                  "in": { "$and": ["$$value", { "$ne": [{ "$type": "$$this.v.block-manager" }, "missing"] }] }
               } }
            ]
         }
      } },
      // Sum known-shard reuse as a lower bound; complete iff every returned node is known.
      { "$group": {
         "_id": null,
         "name": { "$push": "$ns" },
         "nodes": { "$sum": 1 },
         "shards": { "$push": "$shard" },
         "dataSize": { "$sum": "$storageStats.size" },
         "objects": { "$sum": "$storageStats.count" },
         "avgObjSize": { "$avg": "$storageStats.avgObjSize" },
         "orphans": { "$sum": "$storageStats.numOrphanDocs" }, // Available starting in MongoDB 6.0
         "storageSize": { "$sum": "$storageStats.storageSize" },
         "freeStorageSize": { "$sum": { "$cond": ["$storageStats.reuseKnown", { "$ifNull": ["$storageStats.reuseBytes", 0] }, 0] } },
         "freeStorageKnownCount": { "$sum": { "$cond": ["$storageStats.reuseKnown", 1, 0] } },
         "compressor": { "$push": "$storageStats.wiredTiger.compressor" },
         "internalPageSize": { "$push": "$storageStats.wiredTiger.internalPageSize" },
         "dataPageSize": { "$push": "$storageStats.wiredTiger.dataPageSize" },
         "uri": { "$push": "$storageStats.wiredTiger.uri" },
         "file allocation unit size": { "$push": { "$ifNull": ["$storageStats.wiredTiger.block-manager.file allocation unit size", "$storageStats.wiredTiger.internalPageSize"] } },
         "file bytes available for reuse": { "$push": "$storageStats.reuseBytes" },
         "file size in bytes": { "$push": { "$ifNull": ["$storageStats.wiredTiger.block-manager.file size in bytes", { "$sum": "$storageStats.storageSize" }] } },
         "nindexes": { "$sum": "$storageStats.nindexes" },
         "indexes": { "$push": "$storageStats.indexes" },
         "indexes size in bytes": { "$sum": "$storageStats.indexDetails.file size in bytes" },
         "indexes bytes available for reuse": { "$sum": { "$cond": ["$storageStats.indexDetails.reuseKnown", { "$ifNull": ["$storageStats.indexDetails.file bytes available for reuse", 0] }, 0] } },
         "indexReuseKnownCount": { "$sum": { "$cond": ["$storageStats.indexDetails.reuseKnown", 1, 0] } }
      } },
      { "$set": {
         "name": { 
            "$regexFind": {
               "input": { "$arrayElemAt": ["$name", 0] },
               "regex": /^[^.]+\.(.+)$/
         } },
         "wiredTiger": {
            "block-manager": {
               "file size in bytes": "$file size in bytes",
               "file bytes available for reuse": "$file bytes available for reuse",
               "file allocation unit size": "$file allocation unit size"
            },
            "compressor": "$compressor",
            "dataPageSize": "$dataPageSize",
            "internalPageSize": "$internalPageSize",
            "uri": "$uri",
            "indexes": "$indexes"
         },
         "totalIndexSize": "$indexes size in bytes",
         "totalIndexBytesReusable": {
            "$cond": [{ "$gt": ["$indexReuseKnownCount", 0] }, "$indexes bytes available for reuse", null]
         },
         "totalIndexBytesReusableComplete": {
            "$and": [
               { "$gt": ["$indexReuseKnownCount", 0] },
               { "$eq": ["$indexReuseKnownCount", "$nodes"] }
            ]
         },
         "freeStorageSize": {
            "$cond": [{ "$gt": ["$freeStorageKnownCount", 0] }, "$freeStorageSize", null]
         },
         "freeStorageComplete": {
            "$and": [
               { "$gt": ["$freeStorageKnownCount", 0] },
               { "$eq": ["$freeStorageKnownCount", "$nodes"] }
            ]
         }
      } },
      { "$set": {
         "name": { "$arrayElemAt": ["$name.captures", 0] },
         "dataPageSize": {
            "$reduce": {
               "input": "$wiredTiger.dataPageSize",
               "initialValue": { "$arrayElemAt": ["$wiredTiger.dataPageSize", 0] },
               "in": { "$cond": [{ "$eq": ["$$value", "$$this"] }, "$$value", "mixed"] }
         } },
         "compressor": {
            "$reduce": {
               "input": "$wiredTiger.compressor",
               "initialValue": { "$arrayElemAt": ["$wiredTiger.compressor", 0] },
               "in": { "$cond": [{ "$eq": ["$$value", "$$this"] }, "$$value", "mixed"] }
         } },
         "internalPageSize": {
            "$reduce": {
               "input": "$wiredTiger.internalPageSize",
               "initialValue": { "$arrayElemAt": ["$wiredTiger.internalPageSize", 0] },
               "in": { "$cond": [{ "$eq": ["$$value", "$$this"] }, "$$value", "mixed"] }
         } },
         "indexes": {
            "$reduce": {
               "input": {
                  "$reverseArray": {
                     "$reduce": {
                        "input": {
                           "$reduce": {
                              "input": "$indexes",
                              "initialValue": [],
                              "in": { "$concatArrays": ["$$value", "$$this"] }
                        } },
                        "initialValue": [],
                        "in": {
                           "$let": {
                              "vars": {
                                 "sorted": {
                                    "$filter": {
                                       "input": "$$value",
                                       "as": "idx",
                                       "cond": { "$lt": ["$$this", "$$idx"] }
                              } } },
                              "in": {
                                 "$concatArrays": [
                                    "$$sorted",
                                    ["$$this"],
                                    { "$setDifference": ["$$value", "$$sorted"] }
               ] } } } } } },
               "initialValue": [],
               "in": {
                  "$cond": {
                     "if": {
                        "$eq": [
                           { "$arrayElemAt": ["$$value.name", -1] },
                           "$$this.name"
                     ] },
                     "then": {
                        "$concatArrays": [
                           { "$slice": [
                              "$$value",
                              { "$subtract": [{ "$size": "$$value" }, 1] }
                           ] },
                           [{
                              "name": "$$this.name",
                              "storageSize": { "$sum": [{ "$arrayElemAt": ["$$value.file size in bytes", -1] }, "$$this.file size in bytes"] },
                              "freeStorageSize": {
                                 "$let": {
                                    "vars": {
                                       "prev": { "$ifNull": [{ "$arrayElemAt": ["$$value.freeStorageSize", -1] }, { "$arrayElemAt": ["$$value.file bytes available for reuse", -1] }] },
                                       "cur": "$$this.file bytes available for reuse"
                                    },
                                    "in": {
                                       "$cond": [
                                          { "$and": [{ "$eq": ["$$prev", null] }, { "$eq": ["$$cur", null] }] },
                                          null,
                                          { "$sum": [
                                             { "$ifNull": ["$$prev", 0] },
                                             { "$ifNull": ["$$cur", 0] }
                                          ] }
                                       ]
                                    }
                                 }
                              }
                     }]] },
                     "else": {
                        "$concatArrays": [
                           "$$value",
                           [{
                              "name": "$$this.name",
                              "storageSize": "$$this.file size in bytes",
                              "freeStorageSize": "$$this.file bytes available for reuse"
                     }]] }
         } } } }
      } },
      { "$unset": [
         "_id",
         "file allocation unit size",
         "file size in bytes",
         "file bytes available for reuse",
         "indexes.file allocation unit size",
         "indexes.uri",
         "indexes bytes available for reuse",
         "indexes size in bytes",
         "uri",
         "wiredTiger",
         "freeStorageKnownCount",
         "indexReuseKnownCount"
      ] }
   ];
   let results;

   function collStatsStub(tag, e) {
      /*
       *  Keep collName so printers are not blank when CollectionStats gets defaults.
       *  (unauthorized) = authz; (unavailable) = any other collStats failure.
       */
      return {
         "name": `${collName} (${tag})`,
         "nodes": 0,
         "shards": [],
         "dataSize": 0,
         "objects": 0,
         "avgObjSize": 0,
         "orphans": 0,
         "storageSize": 0,
         "freeStorageSize": null,
         "compressor": "",
         "internalPageSize": 0,
         "dataPageSize": 0,
         "nindexes": 0,
         "indexes": [],
         "totalIndexSize": 0,
         "totalIndexBytesReusable": null,
         "freeStorageComplete": false,
         "totalIndexBytesReusableComplete": false,
         "statsError": commandErrorMessage(e)
      };
   }

   try {
      const docs = await drainAggCursor(namespace.aggregate(pipeline, options));
      results = docs[0];
      results = await markPartialShardStats(results, dbName, collName, owningShardCache);
   } catch(e) {
      results = collStatsStub(isUnauthorizedError(e) ? 'unauthorized' : 'unavailable', e);
   }

   return results;
}

// Export for Node.js/mongosh require() usage
// exports are broken in mongosh, they initialise into a different context where the db global is not available
// we may still consider this to limited modules/helpers that don't interoperate with shell/REPL globals
// if (typeof module !== 'undefined' && module.exports) {
//    module.exports = {
//       __lib,
//       isMongosh,
//       ansiTags,
//       // Add other functions and variables as needed
//       bsonMax: (typeof bsonMax !== 'undefined') ? bsonMax : undefined,
//       maxWriteBatchSize: (typeof maxWriteBatchSize !== 'undefined') ? maxWriteBatchSize : undefined,
//       idiomas: (typeof idiomas !== 'undefined') ? idiomas : undefined,
//       pid: (typeof pid !== 'undefined') ? pid : undefined,
//       nonce: (typeof nonce !== 'undefined') ? nonce : undefined
//    };
// }

// EOF
