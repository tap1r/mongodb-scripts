/*
 *  Name: "fuzzer.js"
 *  Version: "1.8.6"
 *  Description: "pseudorandom data generator, with some fuzzing capability"
 *  Disclaimer: "https://raw.githubusercontent.com/tap1r/mongodb-scripts/master/DISCLAIMER.md"
 *  Authors: ["tap1r <luke.prochazka@gmail.com>"]
 *  Roadmap: "https://raw.githubusercontent.com/tap1r/mongodb-scripts/master/ROADMAP.md" (required context)
 *
 *  Dual-shell snapshot: legacy/mongo-shell (v0.6.43). This file is mongosh-only.
 */

// Usage: mongosh [connection options] [--quiet] [--eval 'var options = {...};'] [-f|--file] </path/to/>fuzzer.js
// Overlay: fuzzer-options.jsonc (cwd, --file dir, $MDBLIB, ~/.mongodb) then var options. Missing default is silent.
// Explicit path: var optionsFile = "PATH". --eval var options overlays the file.
// JSONC parse/search lives in mdblib resolveOptions.
// Sample schemas: schema-a.jsonc, schema-b.jsonc, schema-c.jsonc
//
//    mongosh --quiet --eval 'var options = { "totalDocs": 1000, "dropNamespace": true };' -f fuzzer.js
//    mongosh --quiet --eval 'var optionsFile = "/path/to/fuzzer-options.jsonc"' -f fuzzer.js

/*
 *  Load helper mdblib.js (https://github.com/tap1r/mongodb-scripts/blob/master/src/mdblib.js)
 *  Save libs to the $MDBLIB or other valid search path
 */

(() => {
   const __script = { "name": "fuzzer.js", "version": "1.8.6" };
   if (typeof __lib === 'undefined') {
      /*
       *  Load helper library mdblib.js
       */
      let __lib = { "name": "mdblib.js", "paths": null, "path": null };
      __lib.paths = [process.env.MDBLIB, `${process.env.HOME}/.mongodb`, '.'];
      __lib.path = `${__lib.paths.find(path => fs.existsSync(`${path}/${__lib.name}`))}/${__lib.name}`;
      load(__lib.path);
   }
   let __comment = `#### Running script ${__script.name} v${__script.version}`;
   __comment += ` with ${__lib.name} v${__lib.version}`;
   __comment += ` on shell v${version()}`;
   function isFuzzerCliFile() {
      /*
       *  mongosh --file/-f (or positional *.js) targeting this script.
       *  load() from a REPL or another --file is quiet. mdblib still loads.
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
      return files.some(f => /(^|[\\/])fuzzer\.js$/i.test(String(f)));
   }
   if (isFuzzerCliFile()) console.log(`\n\n[yellow]${__comment}[/]`);
})();

(async() => {
   /*
    *  Config files. resolveOptions overlays defaults → fuzzer-options.jsonc
    *  → var options. Search order for a relative path: the options file's
    *  directory, the working directory, this script's directory, $MDBLIB,
    *  ~/.mongodb. Caller: var options / var optionsFile. Do not declare
    *  those names in this file.
    */

   const OPTIONS_FILE = 'fuzzer-options.jsonc';

   function isPlainObject(value) {
      return !!value && typeof value === 'object' && !Array.isArray(value);
   }

   function hasOwn(obj, key) {
      return !!obj && Object.prototype.hasOwnProperty.call(obj, key);
   }

   function withObjectIndex(list) {
      const specs = Array.isArray(list) ? list.slice() : [];
      const present = specs.some(spec =>
         isPlainObject(spec)
         && (hasOwn(spec, 'object.$**') || hasOwn(spec, 'object.oid')));
      if (!present)
         specs.push(fCV(4.2) ? { "object.$**": 1 } : { "object.oid": 1 });
      return specs;
   }

   function loadSchemaSamples(names, anchorDir) {
      if (names == null)
         return { "samples": [], "errors": [] };
      if (!Array.isArray(names))
         return { "samples": [], "errors": ['fuzzer.schemas must be an array of file names'] };
      const samples = [];
      const errors = [];
      names.forEach(name => {
         if (typeof name !== 'string' || name.length === 0) {
            errors.push(`schema entry ${tojson(name)} is not a file name`);
            return;
         }
         const filePath = resolveConfigFile(name, anchorDir);
         if (!filePath) {
            errors.push(`schema file "${name}" was not found (beside the options file, then the working directory, this script, $MDBLIB, or ~/.mongodb)`);
            return;
         }
         try {
            const spec = readJsonc(filePath);
            if (!isPlainObject(spec))
               errors.push(`schema file "${filePath}" must contain an object`);
            else
               samples.push({ "file": name, "path": filePath, "spec": spec });
         } catch(e) {
            errors.push(`schema file "${filePath}": ${errText(e)}`);
         }
      });
      return { "samples": samples, "errors": errors };
   }

   /*
    *  User defined parameters.
    *  fuzzer-options.jsonc then var options overlay these defaults.
    *  fuzzer.schemas points at the sample plug-ins genDocument realises.
    */

   const optionDefaults = {
      "dbName": 'database',             // database name
      "collName": 'collection',         // collection name
      "totalDocsExp": 3.5,              // totalDocs = $getRandExp(totalDocsExp) unless the overlay sets totalDocs
      "dropNamespace": false,           // drop collection prior to generating data
      "dropIndexes": false,             // recreate indexes to update creation options
      "compressor": 'best',             // collection block compressor ['none'|'snappy'|'zlib'|'zstd'|'default'|'best']
      "idxCompressor": 'default',       // index prefix compressor ['none'|'snappy'|'zlib'|'zstd'|'default'|'best']
      // "compressionOptions": -1,      // [-1|0|1|2|3|4|5|6|7|8] compression level
      "idioma": 'en',                   // ['en'|'es'|'de'|'fr'|'zh']
      "collation": { /* collation options */
         "locale": "simple",            // ["simple"|"en"|"es"|"de"|"fr"|"zh"]
         // caseLevel: <boolean>,
         // caseFirst: <string>,
         // strength: <int>,
         // numericOrdering: <boolean>,
         // alternate: <string>,
         // maxVariable: <string>,
         // backwards: <boolean>
      },
      "writeConcern": {
         "j": false
         // w is majority on a replica set or mongos, otherwise 1, unless the overlay sets it.
         // wtimeout is 10000 ms when w waits past the primary, unless the overlay sets it.
         // wtimeout 0 waits without a limit.
      },
      // Inserts in flight. 1 waits for each insert before the next batch is packed.
      // Above 1 the shell also keeps the batch it is packing.
      "writerConcurrency": 2,
      "indexPrefs": { /* build index preferences */
         "build": true,                 // [true|false]
         "order": "post"                // ["pre"|"post"] collection population
      },
      "timeSeries": false,              // build timeseries collection type
      // Schemas that miss a Date at timeField are omitted from the draw.
      // On a mongos, schemas that miss metaField are omitted and the shard key becomes ranged metaField.
      // An index key the server rejects stops the plan. The lists stay as set.
      "tsOptions": {
         "timeField": "timestamp",
         "metaField": "data",
         "granularity": "hours"
      },
      "capped": false,                  // build capped collection type
      // Not applied when timeSeries is set. A capped collection is not sharded.
      "cappedOptions": {
         "size": Math.pow(2, 27),
         "max": Math.pow(2, 27) / Math.pow(2, 12)
      },
      "expireAfterSeconds": 0,          // 0 omits collection TTL. A positive number is seconds after timeField.
      "fuzzer": { /* preferences */
         "id": "ts",                    // ["ts"|"oid"] - timeseries OID | client generated OID
         "range": 365.2422,             // date range in days
         "offset": -300,                // date offset in days from now() (negative = past, positive = future)
         "interval": 7,                 // date interval in days
         // uniform fills [offset, offset + range] and takes no parameters.
         // normal: mu, sigma (days). Defaults are the window center and range/2. Tails are not cut.
         // bimodal: mix, mu1, sigma1, mu2, sigma2. sigma fills a width that was omitted.
         //   Defaults are the quartiles, range/8, and mix 0.5. Tails are not cut.
         // pareto: Lomax, cut to the window. alpha (1.161), scale (range), origin ("start"|"end").
         // exponential: cut to the window. lambda (per day, default 1/range) or mean, and origin.
         // poisson: frequency draw. Whole days from origin. lambda is the mean count (default range), or mean.
         //   Tails are not cut. "start" counts forward from offset.
         // A name outside this list stops the plan. 8 sigma is the ts ObjectId span for the unbounded draws.
         "distribution": "uniform",     // ["uniform"|"normal"|"bimodal"|"pareto"|"exponential"|"poisson"]
         // "distributionParams": { "mu": 0, "sigma": 30 },
         // "polymorphic": { /* experimental */
            // "enabled": false,
            // "varyTypes": false,       // fuzz BSON types
            // "nests": 0,               // nested subdocs
            // "entropy": 100,           // 0-100%
            // "cardinality": 1,         // ratio:1
            // "sparsity": 0,            // 0-100%
            // "weighting": 50           // 0-100%
         // },
         "schemas": [
            "schema-a.jsonc",
            "schema-b.jsonc",
            "schema-c.jsonc"
         ],
         // Weights may be fractional. A non-array is treated as [1].
         // Weight 0 omits that schema.
         "ratios": [7, 2, 1]
      },
      "sharding": true,
      "shardedOptions": {
         "key": {
            "date": 1
            // "string": "hashed"
         },
         "unique": false,               // resharding a collection that has a uniqueness constraint is not supported
         // Sent to shardCollection only when the collection is empty and the key starts with "hashed".
         "numInitialChunksPerShard": 2,
         // "collation": collation,     // inherit from collection options
         // "timeseries": tsOptions,    // not required after initial collection creation
         "reShard": true
      },
      "indexes": [ /* index definitions */
         { "date": -1 },
         { "language": 1, "schema": 1 },
         { "random": 1 },
         { "array": 1 },
         { "timestamp": -1 },
         { "location": "2dsphere" }
         // { "lineString": "2dsphere" },
         // { "polygon": "2dsphere" },
         // { "polygonMulti": "2dsphere" },
         // { "multiPoint": "2dsphere" },
         // { "multiLineString": "2dsphere" },
         // { "multiPolygon": "2dsphere" },
         // { "geoCollection": "2dsphere" }
         // object.$** (fCV 4.2+) or object.oid is appended when neither key is listed
      ],
      "indexOptions": { /* createIndexes options */
         // "background": fCV(4.0) ? true : false,
         // "background": true,
         // "unique": false,
         // "partialFilterExpression": { "$exists": true },
         // "sparse": true,
         // "expireAfterSeconds": expireAfterSeconds,
         // "hidden": hidden
         // collation follows the collection collation unless the overlay sets it
      },
      "hashedIndexes": [
         { "language": "hashed" }
      ],
      "hashedIndexOptions": { /* hashed accepts simple collation only */
         // "background": fCV(4.0) ? true : false,
         // "background": true,
         // "unique": false,
         // "partialFilterExpression": { "$exists": true },
         // "sparse": true,
         // "expireAfterSeconds": expireAfterSeconds,
         // "hidden": hidden,
         "collation": { "locale": "simple" }
      },
      "indexes2d": [
         { "location.coordinates": "2d" }
      ],
      "indexes2dOptions": { /* 2d rejects a collation field */
         // "background": fCV(4.0) ? true : false,
         // "background": true,
         // "unique": false,
         // "partialFilterExpression": { "$exists": true },
         // "sparse": true,
         // "expireAfterSeconds": expireAfterSeconds,
         // "hidden": hidden
         // default_language follows idioma unless the overlay sets it.
         // Kept so a re-run matches the 2d index built when one options
         // document was copied onto every special key.
      },
      "textIndexes": [
         { "quote.txt": "text" }
      ],
      "textIndexOptions": { /* text rejects a collation field */
         // "background": fCV(4.0) ? true : false,
         // "background": true,
         // "unique": false,
         // "partialFilterExpression": { "$exists": true },
         // "sparse": true,
         // "expireAfterSeconds": expireAfterSeconds,
         // "hidden": hidden
         // default_language follows idioma unless the overlay sets it
      }
   };

   // Caller: var options = { ... } (--eval or REPL). Optional var optionsFile.
   // Do not declare or assign those names in this file.
   const overlay = (typeof options !== 'undefined' && options) ? options : null;
   const explicitFile = (typeof optionsFile !== 'undefined') ? optionsFile : null;
   const resolved = resolveOptions({
      "defaults": optionDefaults,
      "file": OPTIONS_FILE,
      "optionsFile": explicitFile,
      overlay
   });
   const opt = resolved.options;
   const wc = isPlainObject(opt.writeConcern) ? opt.writeConcern : {};
   const dbName = opt.dbName,
      collName = opt.collName,
      totalDocs = hasOwn(opt, 'totalDocs') ? opt.totalDocs : $getRandExp(opt.totalDocsExp),
      dropNamespace = opt.dropNamespace,
      dropIndexes = opt.dropIndexes,
      compressor = opt.compressor,
      idxCompressor = opt.idxCompressor,
      idioma = opt.idioma,
      collation = opt.collation,
      writeConcern = {
         "w": hasOwn(wc, 'w')
            ? wc.w
            : ((isReplSet() || isSharded()) ? "majority" : 1),
         "j": hasOwn(wc, 'j') ? wc.j : false
      },
      writerConcurrency = opt.writerConcurrency,
      indexPrefs = opt.indexPrefs,
      timeSeries = opt.timeSeries,
      tsOptions = opt.tsOptions,
      capped = opt.capped,
      cappedOptions = opt.cappedOptions,
      expireAfterSeconds = opt.expireAfterSeconds,
      fuzzer = opt.fuzzer,
      sharding = opt.sharding,
      shardedOptions = opt.shardedOptions,
      indexes = withObjectIndex(opt.indexes),
      indexOptions = opt.indexOptions,
      hashedIndexes = opt.hashedIndexes,
      hashedIndexOptions = opt.hashedIndexOptions,
      indexes2d = opt.indexes2d,
      indexes2dOptions = opt.indexes2dOptions,
      textIndexes = opt.textIndexes,
      textIndexOptions = opt.textIndexOptions;
   const WRITE_CONCERN_WTIMEOUT_MS = 10000;
   if (!hasOwn(wc, 'wtimeout')) {
      const wtimeout = defaultWriteConcernTimeout(writeConcern.w);
      if (wtimeout != null)
         writeConcern.wtimeout = wtimeout;
   } else
      writeConcern.wtimeout = wc.wtimeout;
   if (isPlainObject(fuzzer) && !Array.isArray(fuzzer.ratios))
      fuzzer.ratios = [1];
   if (isPlainObject(indexPrefs) && !hasOwn(indexPrefs, 'commitQuorum'))
      indexPrefs.commitQuorum = (writeConcern.w == 0) ? 1 : writeConcern.w;
   // Remember this before the copy. Afterwards every plain indexOptions has a collation.
   const indexCollationSpecified = isPlainObject(indexOptions) && hasOwn(indexOptions, 'collation');
   if (isPlainObject(indexOptions) && !indexCollationSpecified)
      indexOptions.collation = collation;
   if (isPlainObject(indexes2dOptions) && !hasOwn(indexes2dOptions, 'default_language'))
      indexes2dOptions.default_language = idioma;
   if (isPlainObject(textIndexOptions) && !hasOwn(textIndexOptions, 'default_language'))
      textIndexOptions.default_language = idioma;
   if (idxCompressor != 'default') {
      const configString = `block_compressor=${parseCompressor(idxCompressor)[0]}`;
      if (isPlainObject(indexOptions))
         indexOptions.storageEngine = { "wiredTiger": { "configString": configString } };
      if (isPlainObject(hashedIndexOptions))
         hashedIndexOptions.storageEngine = { "wiredTiger": { "configString": configString } };
      if (isPlainObject(indexes2dOptions))
         indexes2dOptions.storageEngine = { "wiredTiger": { "configString": configString } };
      if (isPlainObject(textIndexOptions))
         textIndexOptions.storageEngine = { "wiredTiger": { "configString": configString } };
   }
   const schemaAnchor = resolved.source.file ? optionsDirOf(resolved.source.file) : null;
   const schemaLoad = resolved.ok
      ? loadSchemaSamples(isPlainObject(fuzzer) ? fuzzer.schemas : null, schemaAnchor)
      : { "samples": [], "errors": [] };
   const schemaSamples = schemaLoad.samples;
   const schemaFileErrors = schemaLoad.errors;

   /*
    *  Global defaults
    */

   const database = db.getSiblingDB(dbName);
   const namespace = database.getCollection(collName);
   const now = new Date().getTime();
   const timestamp = $floor(now / 1000);

   function plural(n, one, many) {
      return (n === 1) ? one : many;
   }

   function errText(e) {
      return e.errmsg || e.message || String(e);
   }

   // setImmediate reaches the poll phase, so an in-flight driver call can finish
   // during generation. sleep() blocks the thread. A bare Promise.resolve() does not poll.
   // Yield every 32 documents or 8 ms. A turn after every document dominates a small batch.
   const YIELD_DOC_INTERVAL = 32;
   const YIELD_MS_INTERVAL = 8;
   const yieldNow = () => new Promise(resolve => setImmediate(resolve));
   const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
   let docsSinceYield = 0;
   let lastYieldAt = Date.now();

   async function yieldSometimes() {
      docsSinceYield++;
      if (docsSinceYield < YIELD_DOC_INTERVAL && (Date.now() - lastYieldAt) < YIELD_MS_INTERVAL)
         return;
      docsSinceYield = 0;
      await yieldNow();
      lastYieldAt = Date.now();
   }

   function oneLine(value) {
      return tojson(value).replace(/\s+/g, ' ');
   }

   // Days from now. uniform fills the window. normal and bimodal are not cut;
   // their ts ObjectId span is 8 sigma. pareto and exponential are cut to the window.
   // poisson is a day count and is not cut; its span is the counts it can actually draw.
   // The untruncated mdblib pareto and exponential helpers stay unused: a date draw
   // has to stay inside the ObjectId years when id is ts.
   const DISTRIBUTION_NAMES = ['uniform', 'normal', 'bimodal', 'pareto', 'exponential', 'poisson'];
   const DISTRIBUTION_KEYS = {
      uniform: [],
      normal: ['mu', 'sigma'],
      bimodal: ['mix', 'mu1', 'sigma1', 'mu2', 'sigma2', 'sigma'],
      pareto: ['alpha', 'scale', 'origin'],
      exponential: ['lambda', 'mean', 'origin'],
      poisson: ['lambda', 'mean', 'origin']
   };
   let distributionResolved = null;

   function formatStat(n) {
      if (!Number.isFinite(n))
         return String(n);
      const abs = Math.abs(n);
      if (abs !== 0 && abs < 1e-4)
         return n.toExponential(2);
      const places = abs >= 1 ? 3 : 6;
      let text = n.toFixed(places).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
      if (text === '-0')
         text = '0';
      return text;
   }

   function statText(n, unit) {
      const value = `[blue]${formatStat(n)}[/]`;
      return unit ? `${value} [dim]${unit}[/]` : value;
   }

   function drawNormal(mu, sigma) {
      for (let attempt = 0; attempt < 4; attempt++) {
         const x = $genNormal(mu, sigma);
         if (Number.isFinite(x))
            return x;
      }
      throw new Error('normal draw was not finite');
   }

   // Exponential rate lambda, conditioned on falling inside [0, span].
   function truncatedExponential(lambda, span) {
      const covered = -Math.expm1(-lambda * span);
      const portion = $rand() * covered;
      if (!(portion < 1))
         return span;
      const x = -Math.log1p(-portion) / lambda;
      if (!(x > 0))
         return 0;
      return x < span ? x : span;
   }

   // Lomax (Pareto II) shape alpha and scale, conditioned on [0, span].
   function truncatedLomax(alpha, scale, span) {
      const spanSurvival = Math.pow(1 + span / scale, -alpha);
      const survival = 1 - $rand() * (1 - (Number.isFinite(spanSurvival) ? spanSurvival : 0));
      if (!(survival > 0))
         return span;
      const x = scale * (Math.pow(survival, -1 / alpha) - 1);
      if (!(x > 0))
         return 0;
      return x < span ? x : span;
   }

   // Whole-day Poisson count. The table is the practical support: weights more than
   // e^-40 below the mode are dropped. A huge mean uses the normal limit instead of a table.
   function poissonSampler(lambda) {
      const sd = Math.sqrt(lambda);
      if (sd > 20000) {
         const lowK = Math.max(0, Math.floor(lambda - 8 * sd));
         const highK = Math.ceil(lambda + 8 * sd);
         return {
            lowK,
            highK,
            draw() {
               const k = Math.round(drawNormal(lambda, sd));
               return k > 0 ? k : 0;
            }
         };
      }
      const mode = Math.floor(lambda);
      const logCut = -40;
      const right = [0];
      let logW = 0;
      let k = mode;
      while (right.length < 250000) {
         const next = logW + Math.log(lambda) - Math.log(k + 1);
         if (!(next > logCut))
            break;
         logW = next;
         k++;
         right.push(logW);
      }
      const left = [];
      logW = 0;
      k = mode;
      while (k > 0 && left.length < 250000) {
         const next = logW + Math.log(k) - Math.log(lambda);
         if (!(next > logCut))
            break;
         logW = next;
         k--;
         left.push(logW);
      }
      const below = left.length;
      const logWeights = left.reverse().concat(right);
      let sum = 0;
      const weights = logWeights.map(lw => {
         const w = Math.exp(lw);
         sum += w;
         return w;
      });
      const cdf = new Float64Array(weights.length);
      let acc = 0;
      for (let i = 0; i < weights.length; i++) {
         acc += weights[i] / sum;
         cdf[i] = acc;
      }
      cdf[cdf.length - 1] = 1;
      const lowK = mode - below;
      const highK = lowK + cdf.length - 1;
      return {
         lowK,
         highK,
         draw() {
            const u = $rand();
            let lo = 0;
            let hi = cdf.length - 1;
            while (lo < hi) {
               const mid = (lo + hi) >> 1;
               if (u < cdf[mid])
                  hi = mid;
               else
                  lo = mid + 1;
            }
            return lowK + lo;
         }
      };
   }

   function resolveDistribution(prefs) {
      const unusable = (errors, requested) => ({
         requested: requested || '',
         name: 'uniform',
         unbounded: false,
         errors,
         rows: [],
         low: 0,
         high: 0,
         draw: () => { throw new Error(errors[0] || 'distribution is not usable'); }
      });
      if (!isPlainObject(prefs))
         return unusable(['fuzzer must be an object'], '');

      const requested = prefs.distribution != null ? String(prefs.distribution) : '';
      const folded = requested.toLowerCase();
      const known = !folded || DISTRIBUTION_NAMES.includes(folded);
      const name = known ? (folded || 'uniform') : 'uniform';
      const offset = +prefs.offset;
      const range = +prefs.range;
      const rawParams = prefs.distributionParams;
      const errors = [];
      if (folded && !DISTRIBUTION_NAMES.includes(folded))
         errors.push(`unsupported distribution type "${requested}". Use uniform, normal, bimodal, pareto, exponential, or poisson`);
      if (!Number.isFinite(offset))
         errors.push('fuzzer.offset must be a finite number of days');
      if (!Number.isFinite(range) || !(range > 0))
         errors.push('fuzzer.range must be a finite number of days greater than 0');
      if (rawParams != null && !isPlainObject(rawParams))
         errors.push('fuzzer.distributionParams must be an object');

      const params = isPlainObject(rawParams) ? rawParams : {};
      const windowOk = Number.isFinite(offset) && Number.isFinite(range) && range > 0;
      const lo = windowOk ? offset : 0;
      const hi = windowOk ? offset + range : 0;
      if (known && isPlainObject(rawParams)) {
         Object.keys(params).forEach(key => {
            if (!DISTRIBUTION_KEYS[name].includes(key))
               errors.push(`fuzzer.distributionParams.${key} does not apply to ${name}`);
         });
      }

      function given(key) {
         if (!hasOwn(params, key))
            return false;
         const value = params[key];
         return value != null && value !== '';
      }

      function readNumber(key) {
         if (!given(key))
            return undefined;
         const n = +params[key];
         if (!Number.isFinite(n)) {
            errors.push(`fuzzer.distributionParams.${key} must be a finite number`);
            return undefined;
         }
         return n;
      }

      function readOrigin() {
         if (!given('origin'))
            return 'start';
         const word = String(params.origin).toLowerCase();
         if (word !== 'start' && word !== 'end') {
            errors.push('fuzzer.distributionParams.origin must be "start" or "end"');
            return 'start';
         }
         return word;
      }

      // An omitted key keeps fallback. A present value has to be greater than 0.
      function positive(key, value, fallback) {
         if (value === undefined)
            return fallback;
         if (!(value > 0))
            errors.push(`fuzzer.distributionParams.${key} must be greater than 0`);
         return value;
      }

      let draw = () => $getRandNum(lo, hi);
      let low = lo;
      let high = hi;
      let unbounded = false;
      const rows = [];

      if (known && name === 'normal') {
         const mu = readNumber('mu');
         const sigma = readNumber('sigma');
         const mean = mu === undefined ? lo + range / 2 : mu;
         const width = positive('sigma', sigma, range / 2);
         if (windowOk && Number.isFinite(mean) && width > 0) {
            const span = 8 * width;
            low = Math.min(lo, mean - span);
            high = Math.max(hi, mean + span);
            unbounded = true;
            draw = () => drawNormal(mean, width);
            rows.push(['mu', statText(mean, 'days')], ['sigma', statText(width, 'days')]);
         }
      } else if (known && name === 'bimodal') {
         const mixValue = readNumber('mix');
         const mix = mixValue === undefined ? 0.5 : mixValue;
         if (mixValue !== undefined && !(mix > 0 && mix < 1))
            errors.push('fuzzer.distributionParams.mix must be greater than 0 and less than 1');
         const shared = readNumber('sigma');
         if (shared !== undefined && !(shared > 0))
            errors.push('fuzzer.distributionParams.sigma must be greater than 0');
         const mu1 = readNumber('mu1');
         const mu2 = readNumber('mu2');
         const mean1 = mu1 === undefined ? lo + range / 4 : mu1;
         const mean2 = mu2 === undefined ? lo + (3 * range) / 4 : mu2;
         const widthFallback = shared !== undefined ? shared : range / 8;
         const width1 = positive('sigma1', readNumber('sigma1'), widthFallback);
         const width2 = positive('sigma2', readNumber('sigma2'), widthFallback);
         if (windowOk && mix > 0 && mix < 1 && width1 > 0 && width2 > 0 && Number.isFinite(mean1) && Number.isFinite(mean2)) {
            low = Math.min(lo, mean1 - 8 * width1, mean2 - 8 * width2);
            high = Math.max(hi, mean1 + 8 * width1, mean2 + 8 * width2);
            unbounded = true;
            draw = () => ($rand() < mix) ? drawNormal(mean1, width1) : drawNormal(mean2, width2);
            rows.push(
               ['mix', statText(mix)],
               ['mu1', statText(mean1, 'days')],
               ['sigma1', statText(width1, 'days')],
               ['mu2', statText(mean2, 'days')],
               ['sigma2', statText(width2, 'days')]
            );
         }
      } else if (known && name === 'pareto') {
         const alpha = positive('alpha', readNumber('alpha'), 1.161);
         const scale = positive('scale', readNumber('scale'), range);
         const origin = readOrigin();
         if (windowOk && alpha > 0 && scale > 0) {
            draw = () => {
               const x = truncatedLomax(alpha, scale, range);
               return origin === 'end' ? hi - x : lo + x;
            };
            rows.push(
               ['alpha', statText(alpha)],
               ['scale', statText(scale, 'days')],
               ['origin', `[blue]${origin}[/]`]
            );
         }
      } else if (known && name === 'exponential') {
         const lambdaValue = readNumber('lambda');
         const meanValue = readNumber('mean');
         let lambda;
         if (lambdaValue !== undefined && meanValue !== undefined) {
            errors.push('fuzzer.distributionParams accepts lambda or mean, not both');
         } else if (lambdaValue !== undefined) {
            lambda = lambdaValue;
            if (!(lambda > 0))
               errors.push('fuzzer.distributionParams.lambda must be greater than 0');
         } else if (meanValue !== undefined) {
            if (!(meanValue > 0))
               errors.push('fuzzer.distributionParams.mean must be greater than 0');
            else
               lambda = 1 / meanValue;
         } else if (range > 0) {
            lambda = 1 / range;
         }
         const origin = readOrigin();
         if (windowOk && lambda > 0) {
            draw = () => {
               const x = truncatedExponential(lambda, range);
               return origin === 'end' ? hi - x : lo + x;
            };
            rows.push(
               ['lambda', statText(lambda, 'per day')],
               ['mean', `${statText(1 / lambda, 'days')} [dim](untruncated)[/]`],
               ['origin', `[blue]${origin}[/]`]
            );
         }
      } else if (known && name === 'poisson') {
         const lambdaValue = readNumber('lambda');
         const meanValue = readNumber('mean');
         let lambda;
         if (lambdaValue !== undefined && meanValue !== undefined) {
            errors.push('fuzzer.distributionParams accepts lambda or mean, not both');
         } else if (lambdaValue !== undefined) {
            lambda = lambdaValue;
         } else if (meanValue !== undefined) {
            lambda = meanValue;
         } else if (range > 0) {
            lambda = range;
         }
         if (lambda !== undefined && !(lambda > 0)) {
            const key = lambdaValue === undefined ? 'mean' : 'lambda';
            errors.push(`fuzzer.distributionParams.${key} must be greater than 0`);
         }
         const origin = readOrigin();
         if (windowOk && lambda > 0) {
            const sampler = poissonSampler(lambda);
            unbounded = true;
            if (origin === 'end') {
               low = hi - sampler.highK;
               high = hi - sampler.lowK;
               draw = () => hi - sampler.draw();
            } else {
               low = lo + sampler.lowK;
               high = lo + sampler.highK;
               draw = () => lo + sampler.draw();
            }
            rows.push(
               ['lambda', `${statText(lambda, 'days')} [dim](mean)[/]`],
               ['origin', `[blue]${origin}[/]`]
            );
         }
      }

      if (errors.length)
         return unusable(errors, requested || name);
      return {
         requested: requested || name,
         name,
         unbounded,
         errors: [],
         rows,
         low,
         high,
         draw
      };
   }

   function distributionSpec() {
      if (!distributionResolved)
         distributionResolved = resolveDistribution(fuzzer);
      return distributionResolved;
   }

   function distributionText() {
      const spec = distributionSpec();
      const tail = spec.unbounded ? '  [dim]unbounded[/]' : '';
      return `[green]${spec.name}[/]${tail}`;
   }

   function namespaceText() {
      const ns = `${dbName}.${collName}`;
      if (dropNamespace)
         return `${ns}  [yellow]drop[/]`;
      if (namespace.exists())
         return `${ns}  [green]keep[/]`;
      return `${ns}  [green]create[/]`;
   }

   function compressorText() {
      if (isAtlasPlatform('sharedTier'))
         return '[yellow]omitted[/]  [dim](shared tier)[/]';
      const [name, msg] = parseCompressor(compressor);
      return msg ? `[green]${name}[/]  [yellow]${msg}[/]` : `[green]${name}[/]`;
   }

   function writeConcernText() {
      const parts = [
         `[dim]w=[/][blue]${writeConcern.w}[/]`,
         `[dim]j=[/][blue]${writeConcern.j}[/]`
      ];
      if (hasOwn(writeConcern, 'wtimeout'))
         parts.push(`[dim]wtimeout=[/][blue]${writeConcern.wtimeout}[/]`);
      return parts.join('  ');
   }

   function timeSeriesText() {
      if (!timeSeries)
         return '[dim]off[/]';
      const ttl = (typeof expireAfterSeconds === 'number' && expireAfterSeconds > 0)
         ? `  [dim]ttl[/] [blue]${expireAfterSeconds}s[/]`
         : '';
      return `[green]${tsOptions.timeField}[/] [dim]/[/] [green]${tsOptions.metaField}[/] [dim]/[/] [green]${tsOptions.granularity}[/]${ttl}`;
   }

   function cappedText() {
      if (!cappedThisRun())
         return '[dim]off[/]';
      return `[dim]size[/] [blue]${cappedOptions.size}[/]  [dim]max[/] [blue]${cappedOptions.max}[/]`;
   }

   function indexOrderText() {
      const order = String((indexPrefs && indexPrefs.order) || '').toLowerCase();
      if (order === 'pre' || order === 'post')
         return order;
      return 'post';
   }

   function indexesText() {
      if (!isPlainObject(indexPrefs) || !indexPrefs.build)
         return '[dim]off[/]';
      return `[green]${indexOrderText()}[/]  [dim]quorum[/] [blue]${indexPrefs.commitQuorum}[/]`;
   }

   function collationLocale(spec) {
      if (!isPlainObject(spec) || spec.locale == null || spec.locale === '')
         return '';
      return String(spec.locale);
   }

   // Regular indexes share indexOptions.collation. Inherited follows the collection.
   function indexCollationNote() {
      const word = indexCollationSpecified ? '[green]specified[/]' : '[dim]inherited[/]';
      const spec = indexCollationSpecified && isPlainObject(indexOptions)
         ? indexOptions.collation
         : collation;
      const locale = collationLocale(spec);
      return locale ? `${word}  [blue]${locale}[/]` : word;
   }

   function languageNote(options) {
      if (!isPlainObject(options) || options.default_language == null || options.default_language === '')
         return '';
      return `  [dim]lang[/] [blue]${options.default_language}[/]`;
   }

   function grouped(n) {
      return Number(n).toLocaleString('en-US');
   }

   function shardingText() {
      if (cappedThisRun() && sharding && isSharded())
         return '[yellow]skipped[/]  [dim](capped)[/]';
      if (!sharding || !isSharded())
         return '[dim]off[/]';
      return oneLine(shardedOptions.key);
   }

   function optionsText() {
      const file = resolved.source.file;
      if (!file)
         return '[dim]defaults[/]';
      const slash = Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\'));
      if (slash < 0)
         return file;
      return `[dim]${file.slice(0, slash + 1)}[/]${file.slice(slash + 1)}`;
   }

   function schemaDetail(sample) {
      const meta = isPlainObject(sample.spec.schema) ? sample.spec.schema : {};
      return [meta.type, meta.comment].filter(Boolean).join(': ');
   }

   function visibleLength(text) {
      return stripAnsiMarkup(String(text)).length;
   }

   function padVisible(text, width) {
      const gap = width - visibleLength(text);
      return gap > 0 ? text + ' '.repeat(gap) : text;
   }

   // Colour tags set a new SGR code. They do not nest, so a title sits between dim segments.
   function paintRule(left, mid, right, title, leftSpan, rightSpan) {
      const rightBody = '─'.repeat(rightSpan);
      if (!title)
         return `[dim]${left}${'─'.repeat(leftSpan)}${mid}${rightBody}${right}[/]`;
      const stamp = `─ ${title} `;
      if (stamp.length >= leftSpan) {
         const cut = Math.max(0, leftSpan - 2);
         return `[dim]${left}─ [/][yellow]${title.slice(0, cut)}[/][dim]${mid}${rightBody}${right}[/]`;
      }
      const rest = '─'.repeat(leftSpan - stamp.length);
      return `[dim]${left}─ [/][yellow]${title}[/][dim] ${rest}${mid}${rightBody}${right}[/]`;
   }

   function paintRow(label, value, labelW, valueW) {
      return `[dim]│[/] ${padVisible(`[cyan]${label}[/]`, labelW)} [dim]│[/] ${padVisible(value, valueW)} [dim]│[/]`;
   }

   function printHud() {
      const ratios = Array.isArray(fuzzer.ratios) ? fuzzer.ratios : [1];
      const from = new Date(now + fuzzer.offset * 86400000).toISOString();
      const to = new Date(now + (fuzzer.offset + fuzzer.range) * 86400000).toISOString();
      const windowSpec = distributionSpec();
      const schemaRows = schemaSamples.map((sample, i) => {
         const weight = ratioWeight(ratios[i]);
         const detail = schemaDetail(sample);
         const weightText = weight > 0 ? `[blue]${weight}[/]` : '[dim]0[/]';
         const omitted = weight > 0 ? '' : '  [dim]omitted[/]';
         const detailText = detail
            ? (weight > 0 ? `  ${detail}` : `  [dim]${detail}[/]`)
            : '';
         return [sample.file, `${weightText}${omitted}${detailText}`];
      });
      const indexRows = [
         ['build', indexesText()],
         ['existing', dropIndexes ? '[yellow]drop[/]' : '[dim]keep[/]']
      ];
      if (isPlainObject(indexPrefs) && indexPrefs.build) {
         const groups = [
            ['index', indexes, null],
            ['hashed', hashedIndexes, null],
            ['2d', indexes2d, indexes2dOptions],
            ['text', textIndexes, textIndexOptions]
         ];
         groups.forEach(([label, keys, langOptions]) => {
            if (!keys || !keys.length) {
               indexRows.push([label, '[dim]none[/]']);
               return;
            }
            if (label === 'index')
               indexRows.push(['collation', indexCollationNote()]);
            const lang = langOptions ? languageNote(langOptions) : '';
            keys.forEach(spec => indexRows.push([label, `${oneLine(spec)}${lang}`]));
         });
      }
      const sections = [
         ['run', [
            ['namespace', namespaceText()],
            ['documents', `[blue]${grouped(totalDocs)}[/]`],
            ['writer concurrency', `[blue]${writerConcurrency}[/]`]
         ]],
         ['window', [
            ['distribution', distributionText()],
            ...windowSpec.rows,
            ['from', from],
            ['to', to]
         ]],
         ['collection', [
            ['compressor', compressorText()],
            ['collation', String(collation && collation.locale)],
            ['write concern', writeConcernText()],
            ['time series', timeSeriesText()],
            ['capped', cappedText()],
            ['sharding', shardingText()]
         ]],
         ['schemas', schemaRows],
         ['indexes', indexRows]
      ];
      let labelW = 0;
      let valueW = 0;
      sections.forEach(([, rows]) => {
         rows.forEach(([label, value]) => {
            labelW = Math.max(labelW, String(label).length);
            valueW = Math.max(valueW, visibleLength(value));
         });
      });
      hudLabelW = labelW;
      hudValueW = Math.max(valueW, 24);
      const file = resolved.source.file;
      const optionLines = file ? wrapPlain(file, hudValueW) : ['defaults'];
      const base = file ? file.slice(Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\')) + 1) : '';
      optionLines.forEach((chunk, i) => {
         let value = '[dim]defaults[/]';
         if (file) {
            const at = base ? chunk.lastIndexOf(base) : -1;
            value = at < 0
               ? `[dim]${chunk}[/]`
               : `[dim]${chunk.slice(0, at)}[/]${chunk.slice(at)}`;
         }
         sections[0][1].push([i === 0 ? 'options' : '', value]);
      });
      const leftSpan = hudLabelW + 2;
      const rightSpan = hudValueW + 2;
      sections.forEach(([title, rows], i) => {
         const rule = i === 0
            ? paintRule('┌', '┬', '┐', title, leftSpan, rightSpan)
            : paintRule('├', '┼', '┤', title, leftSpan, rightSpan);
         console.log((i === 0 ? '\n' : '') + rule);
         rows.forEach(([label, value]) => console.log(paintRow(label, value, hudLabelW, hudValueW)));
      });
      console.log(paintRule('└', '┴', '┘', '', leftSpan, rightSpan));
   }

   let hudLabelW = 0;
   let hudValueW = 0;

   function wrapPlain(text, width) {
      const limit = Math.max(8, width);
      const lines = [];
      let rest = String(text);
      while (rest.length > limit) {
         let cut = rest.lastIndexOf('/', limit);
         if (cut < Math.floor(limit / 2))
            cut = limit;
         else
            cut += 1;
         lines.push(rest.slice(0, cut));
         rest = rest.slice(cut);
      }
      if (rest)
         lines.push(rest);
      return lines.length ? lines : [''];
   }

   function wrapCell(text, width) {
      const limit = Math.max(8, width);
      const value = String(text);
      if (value.length <= limit)
         return [value];
      if (!value.includes(', '))
         return wrapPlain(value, limit);
      const items = value.split(', ');
      const lines = [];
      let cur = '';
      items.forEach((item, n) => {
         const piece = n < items.length - 1 ? `${item},` : item;
         const next = cur ? `${cur} ${piece}` : piece;
         if (cur && next.length > limit) {
            lines.push(cur);
            cur = piece;
         } else
            cur = next;
      });
      if (cur)
         lines.push(cur);
      return lines.length ? lines : [''];
   }

   function printBuilt(rows) {
      if (!rows || !rows.length)
         return;
      if (progressLive) {
         batchHud.clear();
         progressLive = false;
      }
      const leftSpan = hudLabelW + 2;
      const rightSpan = hudValueW + 2;
      console.log('\n' + paintRule('┌', '┬', '┐', 'built', leftSpan, rightSpan));
      rows.forEach(([label, value]) => {
         const failed = String(value).startsWith('[red]');
         const plain = failed ? stripAnsiMarkup(value) : String(value);
         const colour = failed ? 'red' : 'blue';
         wrapCell(plain, hudValueW).forEach((chunk, i) => {
            console.log(paintRow(i === 0 ? label : '', `[${colour}]${chunk}[/]`, hudLabelW, hudValueW));
         });
      });
      console.log(paintRule('└', '┴', '┘', '', leftSpan, rightSpan));
   }

   async function main() {
      /*
       *  main
       */
      // Do not Mongo.setReadPref(): mongosh reconnects and the next
      // DB call (exists/drop/create) hangs or rejects on a local RS.
      if (!resolved.ok) {
         const msg = (resolved.warnings[0] && resolved.warnings[0].message)
            || resolved.error
            || 'options file failed';
         console.log(`\n[red][ERROR][/] ${msg}`);
         return;
      }
      if (schemaFileErrors.length > 0) {
         schemaFileErrors.forEach(reason => console.log(`\n[red][ERROR][/] ${reason}`));
         return;
      }
      if (schemaSamples.length === 0) {
         console.log('\n[red][ERROR][/] fuzzer.schemas is empty');
         return;
      }
      const ratioProblem = schemaRatioProblem(fuzzer.ratios, schemaSamples.length);
      if (ratioProblem) {
         console.log(`\n[red][ERROR][/] ${ratioProblem}`);
         return;
      }
      // Printed before the plan so a later time-series error is not read as a capped failure.
      if (capped && timeSeries)
         console.log('\n[red][WARN] [yellow]capped[red] is not applied because a time series collection cannot be capped[/]');
      const plan = collectionPlan();
      if (plan.length > 0) {
         plan.forEach(reason => console.log(`\n[red][ERROR][/] ${reason}`));
         return;
      }
      if (timeSeries) {
         const expiryWarning = timeSeriesExpiryWarning();
         if (expiryWarning)
            console.log(`\n[red][WARN] [yellow]time series TTL[red] ${expiryWarning}[/]`);
      }
      const oidWindow = tsObjectIdWindow();
      if (oidWindow.length > 0) {
         oidWindow.forEach(reason => console.log(`\n[red][ERROR][/] ${reason}`));
         return;
      }
      if (cappedThisRun() && sharding && isSharded())
         console.log('\n[red][WARN] [yellow]sharding[red] is skipped because a capped collection cannot be sharded[/]');

      const orderName = String((indexPrefs && indexPrefs.order) || '').toLowerCase();
      if (orderName !== 'pre' && orderName !== 'post')
         console.log(`\nUnsupported index build preference "${indexPrefs.order}": defaulting to "post"`);

      printHud();

      // Drop finishes before create. The first batch is built while create runs.
      async function beginCreateNS() {
         return createNS();
      }
      dropNS();
      let createFailed = null;
      const creating = beginCreateNS().catch(err => {
         createFailed = err;
         return false;
      });
      let packError = null;
      const packing = takePackedBatch().catch(err => {
         packError = err;
         return null;
      });
      await Promise.all([creating, packing]);
      if (createFailed)
         throw createFailed;
      if (packError)
         throw packError;
      if (!(await creating))
         return;
      const firstBatch = await packing;

      dropExistingIndexes();

      // Index order is a HUD row. pre builds before the inserts. Anything else inserts first.
      switch (indexOrderText()) {
         case 'pre':
            printBuilt(buildIndexes());
            if ((await genBulk(firstBatch)) === false)
               return;
            break;
         default:
            if ((await genBulk(firstBatch)) === false)
               return;
            printBuilt(buildIndexes());
      }

      // redistribute chunks if required
      const reshard = reshardDecision();
      if (reshard.action === 'call')
         await reshardNamespace(reshard.sameKey);
      else if (reshard.action === 'warn')
         console.log(reshard.message);

      console.log('\n [green]Fuzzing completed![/]\n');
      return;
   }

   // ObjectId time is 4 bytes: 8 hex digits, 1970-01-01 through 2106-02-07T06:28:15Z.
   const OID_SECONDS_MAX = 0xffffffff;

   function objectIdTimePrefix(seconds) {
      const whole = $floor(seconds);
      if (!(whole >= 0) || whole > OID_SECONDS_MAX)
         return null;
      return whole.toString(16).padStart(8, '0');
   }

   function isoSeconds(seconds) {
      const ms = seconds * 1000;
      if (!Number.isFinite(ms) || ms > 8.64e15 || ms < -8.64e15)
         return String(seconds);
      return new Date(ms).toISOString();
   }

   function tsObjectIdWindow() {
      if (String(fuzzer.id || 'ts').toLowerCase() === 'oid')
         return [];
      const spec = distributionSpec();
      if (spec.errors.length)
         return [];
      const day = 86400;
      // low and high already include the 8-sigma tails of an unbounded draw.
      const reasons = [];
      const minSeconds = timestamp + spec.low * day;
      const maxSeconds = timestamp + spec.high * day;
      if (minSeconds < 0)
         reasons.push(`the 'ts' ObjectId time starts at ${isoSeconds(minSeconds)}, before 1970`);
      if (maxSeconds > OID_SECONDS_MAX)
         reasons.push(`the 'ts' ObjectId time ends at ${isoSeconds(maxSeconds)}, after 2106-02-07T06:28:15.000Z`);
      return reasons;
   }

   function defaultWriteConcernTimeout(w) {
      // w <= 1 returns from the primary. wtimeout applies once more members must ack.
      if (typeof w === 'number')
         return w > 1 ? WRITE_CONCERN_WTIMEOUT_MS : null;
      if (typeof w === 'string' && w !== '0' && w !== '1')
         return WRITE_CONCERN_WTIMEOUT_MS;
      return null;
   }

   function ratioWeight(value) {
      const n = +value;
      return (n > 0 && Number.isFinite(n)) ? n : 0;
   }

   function ratioTotal(ratios) {
      const weights = Array.isArray(ratios) ? ratios : [1];
      let total = 0;
      for (let i = 0; i < weights.length; i++)
         total += ratioWeight(weights[i]);
      return total;
   }

   function ratioIndex(ratios) {
      const weights = Array.isArray(ratios) ? ratios : [1];
      const total = ratioTotal(weights);
      if (!(total > 0))
         return undefined;
      let draw = $rand() * total;
      let last = 0;
      for (let i = 0; i < weights.length; i++) {
         const weight = ratioWeight(weights[i]);
         if (!(weight > 0))
            continue;
         last = i;
         draw -= weight;
         if (draw < 0)
            return i;
      }
      return last;
   }

   function schemaRatioProblem(ratios, count) {
      const weights = Array.isArray(ratios) ? ratios : [1];
      if (weights.length === 0)
         return 'fuzzer.ratios must list a weight for each schema';
      let slots = 0;
      for (let idx = 0; idx < weights.length; idx++) {
         const n = +weights[idx];
         if (!(n > 0))
            continue;
         if (!Number.isFinite(n))
            return `fuzzer.ratios weight at ${idx} is not finite`;
         slots++;
         if (idx >= count)
            return `fuzzer.ratios can select schema ${idx} but only ${count} ${plural(count, 'schema file is', 'schema files are')} loaded`;
      }
      if (slots === 0)
         return 'fuzzer.ratios are all zero';
      return null;
   }

   // One compiled function per expression. The scope names stay oid, date, ts, idioma, totalDocs.
   const schemaExprCache = new Map();

   function evalSchemaExpr(expr, scope) {
      const names = Object.keys(scope);
      const key = `${names.join('\0')}\0${expr}`;
      let fn = schemaExprCache.get(key);
      if (!fn) {
         fn = new Function(...names, `"use strict"; return (${expr});`);
         schemaExprCache.set(key, fn);
      }
      return fn(...names.map(name => scope[name]));
   }

   // Arrays and plain objects only. ObjectId, Date, and BinData are leaves.
   function isNestedValue(value) {
      if (Array.isArray(value))
         return true;
      if (!value || typeof value !== 'object')
         return false;
      const proto = Object.getPrototypeOf(value);
      return proto === Object.prototype || proto === null;
   }

   function documentDepth(node) {
      if (!isNestedValue(node))
         return 0;
      let max = 0;
      const stack = [node];
      const depths = [1];
      const seen = new Set();
      while (stack.length) {
         const cur = stack.pop();
         const depth = depths.pop();
         if (seen.has(cur))
            continue;
         seen.add(cur);
         if (depth > max)
            max = depth;
         const children = Array.isArray(cur) ? cur : Object.keys(cur).map(key => cur[key]);
         for (let i = 0; i < children.length; i++) {
            const child = children[i];
            if (isNestedValue(child)) {
               stack.push(child);
               depths.push(depth + 1);
            }
         }
      }
      return max;
   }

   function realiseSchema(node, scope, path) {
      if (Array.isArray(node))
         return node.map((item, i) => realiseSchema(item, scope, `${path}[${i}]`));
      if (isPlainObject(node)) {
         const out = {};
         Object.keys(node).forEach(key => {
            out[key] = realiseSchema(node[key], scope, path ? `${path}.${key}` : key);
         });
         return out;
      }
      if (typeof node === 'string' && node.startsWith('=')) {
         const expr = node.slice(1);
         try {
            return evalSchemaExpr(expr, scope);
         } catch(e) {
            throw new Error(`schema field ${path}: ${expr}: ${errText(e)}`);
         }
      }
      return node;
   }

   function genDocument({ id = 'ts', ratios = [1] } = {}, timestamp) {
      /*
       *  Pick one loaded schema by its weight, then build only that document.
       *  A string that starts with "=" is an expression.
       *  The timestamp comes from fuzzer.distribution.
       */
      const index = ratioIndex(ratios);
      const sample = schemaSamples[index];
      if (!sample)
         throw new Error(`schema ratio index ${index} but only ${schemaSamples.length} ${plural(schemaSamples.length, 'schema file is', 'schema files are')} loaded`);
      const day = 86400;
      const secondsOffset = $floor(distributionSpec().draw() * day);
      let oid;
      switch (id.toLowerCase()) {
         case 'oid':
            oid = new ObjectId();
            break;
         default: { // the 'ts' option
            const prefix = objectIdTimePrefix(timestamp + secondsOffset);
            if (prefix === null)
               throw new Error(`the 'ts' ObjectId time ${isoSeconds(timestamp + secondsOffset)} is outside 1970 through 2106-02-07T06:28:15.000Z`);
            oid = new ObjectId(prefix + $genRandHex(16));
         }
      }
      const date = new Date(now + secondsOffset * 1000);
      const ts = new Timestamp({ "t": timestamp + secondsOffset, "i": 0 });
      return realiseSchema(sample.spec, {
         oid, date, ts, idioma, totalDocs
      }, sample.file);
   }

   function dropNS() {
      /*
       *  drop target namespace
       */
      if (dropNamespace && !!dbName && !!collName)
         namespace.drop();
   }

   function parseCompressor(compressor = '', msg = '') {
      switch(compressor.toLowerCase()) {
         case 'best':
            compressor = fCV(4.2) ? 'zstd' : 'zlib';
            break;
         case 'none':
            compressor = 'none';
            break;
         case 'snappy':
            compressor = 'snappy';
            break;
         case 'zlib':
            compressor = 'zlib';
            break;
         case 'zstd':
            if (fCV(4.2))
               compressor = 'zstd';
            else {
               compressor = 'zlib';
               msg = '("zstd" requires mongod fCV 4.2)';
            }
            break;
         default:
            msg = `("${compressor}" not recognised)`;
            compressor = 'snappy';
      }

      return [compressor, msg];
   }

   function initialChunkCount() {
      return shardedOptions.numInitialChunksPerShard
         * db.getSiblingDB('config').getCollection('shards').countDocuments({});
   }

   let shardedThisRun = false;

   function catalogShardKey() {
      const ns = `${dbName}.${collName}`;
      const doc = db.getSiblingDB('config').getCollection('collections').findOne({ _id: ns });
      return (doc && doc.key) ? doc.key : null;
   }

   // shardCollection accepts numInitialChunks only for an empty collection whose
   // shard key starts with a hashed field. A hashed field later in the key needs
   // zones (presplitHashedZones), which this script does not set.
   function shardKeyHashedPrefix(key) {
      if (!key || typeof key !== 'object' || Array.isArray(key))
         return false;
      const field = Object.keys(key)[0];
      return field != null && key[field] === 'hashed';
   }

   function namespaceIsEmpty() {
      return !namespace.find({}, { "_id": 1 }).limit(1).hasNext();
   }

   function mayPresplitChunks() {
      return shardKeyHashedPrefix(shardedOptions.key)
         && (!namespace.exists() || namespaceIsEmpty());
   }

   function shardNewNamespace() {
      // A non-mongos connection skips sharding and the load continues.
      if (!isSharded())
         return true;
      if (!(sharding && namespace.exists())) {
         console.log('[red][ERROR] Sharding namespace failed:[/] the namespace does not exist');
         return false;
      }

      let numInitialChunks = null;
      try {
         if (mayPresplitChunks())
            numInitialChunks = initialChunkCount();
      } catch(e) {
         console.log('[red][ERROR] Sharding namespace failed:[/]', errText(e));
         return false;
      }
      if (numInitialChunks != null && !(numInitialChunks >= 1)) {
         console.log(`[red][ERROR] Sharding namespace failed:[/] initial chunk count is ${numInitialChunks}`);
         return false;
      }

      console.log(`\nSharding namespace with options: ${tojson(shardedOptions)}`);
      if (numInitialChunks >= 1)
         console.log(`with initial chunks: ${numInitialChunks}`);
      else if (!shardKeyHashedPrefix(shardedOptions.key))
         console.log('without initial chunks: shard key has no hashed prefix');
      else
         console.log('without initial chunks: the collection is not empty');
      const shardOptions = { "collation": collation };
      if (numInitialChunks >= 1)
         shardOptions.numInitialChunks = numInitialChunks;
      try {
         (!serverVer(6.0)) && (sh.enableSharding(dbName).ok);
         sh.shardCollection(
            `${dbName}.${collName}`,
            shardedOptions.key,
            shardedOptions.unique,
            shardOptions
         );
         shardedThisRun = true;
         // console.log(`enable balancing`);
         sh.enableBalancing(`${dbName}.${collName}`);
         (!serverVer(6.0)) && (sh.enableAutoSplit());
         sh.startBalancer();
         return true;
      }
      catch(e) {
         const text = errText(e);
         // A preserved collection can already be sharded when config.collections
         // is keyed by UUID and the namespace lookup misses.
         if (/already sharded|sharding already enabled/i.test(text)) {
            console.log(`\nNamespace "${dbName}.${collName}" is already sharded`);
            return true;
         }
         console.log('[red][ERROR] Sharding namespace failed:[/]', text);
         return false;
      }
   }

   function shardPreservedNamespace() {
      try {
         if (catalogShardKey()) {
            console.log(`\nNamespace "${dbName}.${collName}" is already sharded`);
            return true;
         }
      } catch(e) {
         console.log('[red][ERROR] Sharding namespace failed:[/]', errText(e));
         return false;
      }
      return shardNewNamespace();
   }

   // cater for $currentOp sharding schema change in v7
   // Documented since 5.0: "ReshardingDonorService <uuid>" / "ReshardingRecipientService <uuid>".
   // The optional word keeps a longer service name in the same capture groups.
   const reshardServiceDesc = /^Resharding(?:\w+)?(Donor|Recipient)Service ([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/;

   function shardKeysMatch(current, requested) {
      const currentFields = Object.keys(current);
      const requestedFields = Object.keys(requested);
      if (currentFields.length !== requestedFields.length)
         return false;
      return currentFields.every((field, i) =>
         field === requestedFields[i] && current[field] === requested[field]
      );
   }

   function isSameShardKey() {
      const ns = `${dbName}.${collName}`;
      try {
         const doc = db.getSiblingDB('config').getCollection('collections').findOne({ _id: ns });
         if (doc && doc.key)
            return shardKeysMatch(doc.key, shardedOptions.key);
      } catch(e) {
         // Catalog unreadable. Fall through to this run's shard attempt.
      }
      return shardedThisRun;
   }

   function reshardDecision() {
      // A capped collection is left unsharded, so reshardCollection does not apply.
      if (!isSharded() || !shardedOptions.reShard || cappedThisRun())
         return { action: 'off' };
      if (!fCV(5.0))
         return {
            action: 'warn',
            message: '[red][WARN] [yellow]reshardCollection() [red]requires v5.0+[/]'
         };
      if (shardedOptions.unique)
         return {
            action: 'warn',
            message: '[red][WARN] [yellow]reshardCollection() [red]with a uniqueness constraint is not supported[/]'
         };
      const sameKey = isSameShardKey();
      if (sameKey && !fCV(8.0))
         return {
            action: 'warn',
            message: '[red][WARN] [yellow]reshardCollection() [red]with the same shard key requires v8.0+[/]'
         };
      return { action: 'call', sameKey };
   }

   async function reshardNamespace(sameKey) {
      let reshardOk = false;
      const resharding = async() => {
         const numInitialChunks = initialChunkCount();
         const cmd = () => db.adminCommand({
            "reshardCollection": `${dbName}.${collName}`,
            // The new shard key cannot have a uniqueness constraint
            "key": shardedOptions.key,
            // Resharding a collection that has a uniqueness constraint is not supported
            "unique": shardedOptions.unique,
            "numInitialChunks": numInitialChunks,
            "collation": collation,
            // "zones": [
            //       {
            //          "min": { "<document with same shape as shardkey>" },
            //          "max": { "<document with same shape as shardkey>" },
            //          "zone": null // <string> | null
            //       }
            // ],
            ...(sameKey && fCV(8.0) && { "forceRedistribution": true })
         });
         try {
            await cmd();
            reshardOk = true;
         } catch(e) {
            console.log('Resharding attempt:', errText(e));
         }
      };
      const rebalancingOps = () => {
         return db.getSiblingDB('admin').aggregate([
            { "$currentOp": { "allUsers": true, "localOps": false } },
            { "$match": {
               "type": "op",
               "originatingCommand.reshardCollection": `${dbName}.${collName}`
            } },
            { "$sort": { "shard": 1 } },
            { "$set": {
               "migration": {
                  "$arrayElemAt": [
                     { "$regexFindAll": {
                        "input": "$desc",
                        "regex": reshardServiceDesc
                     } },
                     0
                  ]
            } } },
            { "$group": {
               "_id": {
                  "migrationId": { "$arrayElemAt": ["$migration.captures", -1] },
                  "namespace": "$ns"
               },
               "shards": {
                  "$push": {
                     "shard": "$shard",
                     "migrationService": {
                        "$ifNull": [
                           { "$arrayElemAt": ["$migration.captures", 0] },
                           {
                              "$switch": {
                                 "branches": [
                                    { "case": { "$ne": [{ "$type": "$donorState" }, "missing"] }, "then": "Donor" },
                                    { "case": { "$ne": [{ "$type": "$recipientState" }, "missing"] }, "then": "Recipient" }
                                 ],
                                 "default": "$$REMOVE"
                              }
                           }
                        ]
                     },
                     "state": { "$ifNull": ["$donorState", "$recipientState"] },
                     "approxDocumentsToCopy":{ "$ifNull": [{ "$toInt": "$approxDocumentsToCopy" }, "$$REMOVE"] },
                     "documentsCopied": { "$ifNull": [{ "$toInt": "$documentsCopied" }, "$$REMOVE"] },
                     "approxBytesToCopy": { "$ifNull": [{ "$toInt": "$approxBytesToCopy" }, "$$REMOVE"] },
                     "bytesCopied": { "$ifNull": [{ "$toInt": "$bytesCopied" }, "$$REMOVE"] },
                     "totalOperationTimeElapsedSecs": { "$toInt": "$totalOperationTimeElapsedSecs" },
                     "remainingOperationTimeEstimatedSecs": { "$ifNull": [{ "$toInt": "$remainingOperationTimeEstimatedSecs" }, "$$REMOVE"] }
            } } } },
            { "$set": {
               "migrationId": "$_id.migrationId",
               "namespace": "$_id.namespace"
            } },
            { "$set": {
               "donors": {
                  "$filter": {
                     "input": "$shards",
                     "as": "shard",
                     "cond": { "$eq": ["$$shard.migrationService", "Donor"] }
            } } } },
            { "$set": {
               "recipients": {
                  "$filter": {
                     "input": "$shards",
                     "as": "shard",
                     "cond": { "$eq": ["$$shard.migrationService", "Recipient"] }
            } } } },
            { "$unset": ["_id", "shards", "donors.migrationService", "recipients.migrationService"] }
         ],
         { "comment": "Monitoring resharding progress by fuzzer.js" }).toArray();
      };
      console.log('\nResharding activated...');
      const pollIntervalMS = 500;
      let done = false;
      // Hold the issuing command Promise so mongosh does not exit (and abort resharding) early.
      // User-defined async functions are not auto-awaited by the mongosh rewriter.
      // sleep() would block the thread and stall this response. Race the timer with the command.
      const reshardPromise = resharding().finally(() => { done = true; });
      const pause = ms => Promise.race([
         delay(ms),
         reshardPromise.catch(() => {})
      ]);
      await pause(3 * pollIntervalMS); // allow $currentOp to publish the initial donor/recipient ops
      let monitorFailed = false;
      while (!done) {
         try {
            const ops = rebalancingOps();
            monitorFailed = false;
            if (ops.length > 0) {
               console.clear();
               console.log(`\nMonitoring resharding operations:\n`);
               ops.forEach(op => printjson(op));
            }
         } catch(e) {
            if (!monitorFailed)
               console.log('Resharding monitor:', errText(e));
            monitorFailed = true;
         }
         if (!done)
            await pause(pollIntervalMS);
      }
      try {
         await reshardPromise;
      } catch(e) {
         console.log('Resharding attempt:', errText(e));
      }
      if (reshardOk)
         console.log(`\nResharding complete.`);
   }

   function shardKeyUsesHash(key) {
      return !!key && Object.keys(key).some(field => key[field] === 'hashed');
   }

   // metaField may be hashed or ranged. timeField must be ranged and last.
   // Any other field is rejected by shardCollection. timeField in the key is deprecated from 8.0.
   function timeSeriesShardKeyProblem(key, metaField, timeField) {
      if (!key || typeof key !== 'object' || Array.isArray(key))
         return 'missing';
      const fields = Object.keys(key);
      if (fields.length === 0)
         return 'empty';
      let sawMeta = false;
      for (let i = 0; i < fields.length; i++) {
         const field = fields[i];
         const onMeta = !!(metaField && (field === metaField || field.startsWith(`${metaField}.`)));
         const onTime = field === timeField;
         if (!onMeta && !onTime)
            return 'field';
         if (onMeta)
            sawMeta = true;
         if (onTime && (key[field] === 'hashed' || i !== fields.length - 1))
            return 'time';
      }
      if (metaField && !sawMeta)
         return 'meta';
      return null;
   }

   // Zero the weight of schemas that cannot be time series documents, and point the shard key at metaField.
   // A legal key the overlay already set is left as it is.
   function timeSeriesSelection(willShard) {
      const timeField = tsOptions && tsOptions.timeField;
      const metaField = tsOptions && tsOptions.metaField;
      if (!timeField)
         return ['time series requires tsOptions.timeField'];
      const ratios = (Array.isArray(fuzzer.ratios) ? fuzzer.ratios : [1]).slice();
      const omitted = [];
      let kept = 0;
      for (let i = 0; i < schemaSamples.length; i++) {
         if (!(ratioWeight(ratios[i]) > 0))
            continue;
         const sample = schemaSamples[i];
         const why = [];
         if (!timeFieldIsDate(sample.spec[timeField]))
            why.push(`timeField "${timeField}" is not a Date`);
         if (willShard && metaField && !hasOwn(sample.spec, metaField))
            why.push(`metaField "${metaField}" is absent`);
         if (why.length) {
            ratios[i] = 0;
            omitted.push(`${sample.file} (${why.join('; ')})`);
         } else
            kept++;
      }
      if (kept === 0) {
         const detail = omitted.length ? `: ${omitted.join(', ')}` : '';
         return [`time series schema selection is empty${detail}`];
      }
      fuzzer.ratios = ratios;
      if (omitted.length)
         console.log(`\n[red][WARN] [yellow]time series[red] omitted ${omitted.join(', ')}[/]`);
      if (willShard && timeSeriesShardKeyProblem(shardedOptions.key, metaField, timeField)) {
         // Ranged, so the sample can keep a hashed index on another field.
         const next = {};
         next[metaField || timeField] = 1;
         console.log(`\n[red][WARN] [yellow]time series shard key[red] ${tojson(shardedOptions.key)} is replaced with ${tojson(next)}[/]`);
         shardedOptions.key = next;
      }
      return [];
   }

   function timeFieldIsDate(value) {
      if (value instanceof Date)
         return true;
      if (typeof value !== 'string' || !value.startsWith('='))
         return false;
      try {
         const got = evalSchemaExpr(value.slice(1), {
            oid: null,
            date: new Date(0),
            ts: null,
            idioma,
            totalDocs
         });
         return got instanceof Date;
      } catch(e) {
         return false;
      }
   }

   function selectedSchemaSamples() {
      const ratios = Array.isArray(fuzzer.ratios) ? fuzzer.ratios : [1];
      const selected = [];
      for (let i = 0; i < schemaSamples.length; i++) {
         if (ratioWeight(ratios[i]) > 0)
            selected.push(schemaSamples[i]);
      }
      return selected;
   }

   function timeSeriesSchemaProblems(willShard) {
      const timeField = tsOptions && tsOptions.timeField;
      const metaField = tsOptions && tsOptions.metaField;
      const reasons = [];
      if (!timeField) {
         reasons.push('time series requires tsOptions.timeField');
         return reasons;
      }
      selectedSchemaSamples().forEach(sample => {
         if (!timeFieldIsDate(sample.spec[timeField]))
            reasons.push(`time series timeField "${timeField}" must be a Date in ${sample.file}`);
         if (willShard && metaField && !hasOwn(sample.spec, metaField))
            reasons.push(`time series metaField "${metaField}" must be present in ${sample.file}`);
      });
      return reasons;
   }

   // Text and wildcard indexes are never legal. Any other type besides 1, -1,
   // and 2dsphere is legal only on the metaField. The option lists are not rewritten.
   function timeSeriesIndexKeyProblem(key, metaField) {
      if (!isPlainObject(key))
         return 'index key must be an object';
      const fields = Object.keys(key);
      if (fields.length === 0)
         return 'index key is empty';
      const problems = [];
      fields.forEach(field => {
         const type = key[field];
         if (String(field).includes('$**')) {
            problems.push('wildcard indexes are not supported');
            return;
         }
         if (type === 'text') {
            problems.push('text indexes are not supported');
            return;
         }
         if (type === 1 || type === -1 || type === '2dsphere')
            return;
         if (metaField && field === metaField)
            return;
         problems.push(`"${field}" must be ascending, descending, or 2dsphere unless it is the metaField`);
      });
      return problems.length ? problems.join('; ') : null;
   }

   function timeSeriesIndexProblems(metaField) {
      const reasons = [];
      [
         ['indexes', indexes],
         ['hashedIndexes', hashedIndexes],
         ['indexes2d', indexes2d],
         ['textIndexes', textIndexes]
      ].forEach(([label, list]) => {
         if (!Array.isArray(list)) {
            reasons.push(`time series ${label} must be an array`);
            return;
         }
         list.forEach(key => {
            const why = timeSeriesIndexKeyProblem(key, metaField);
            if (why)
               reasons.push(`time series ${label} key ${tojson(key)}: ${why}`);
         });
      });
      return reasons;
   }

   function timeSeriesExpireProblem() {
      const n = expireAfterSeconds;
      if (typeof n === 'number' && Number.isFinite(n) && n >= 0)
         return null;
      return `time series expireAfterSeconds ${tojson(n)} must be a non-negative number`;
   }

   // The earliest draw is distributionSpec().low. Unbounded draws use the 8-sigma edge.
   function timeSeriesExpiryWarning() {
      if (!(typeof expireAfterSeconds === 'number' && expireAfterSeconds > 0))
         return null;
      const spec = distributionSpec();
      if (spec.errors.length || !Number.isFinite(spec.low))
         return null;
      const day = 86400;
      if (spec.low * day + expireAfterSeconds > 0)
         return null;
      const field = (tsOptions && tsOptions.timeField) || 'timeField';
      return `expireAfterSeconds ${expireAfterSeconds} already covers the start of the "${field}" window`;
   }

   // A time series collection cannot be capped. Time series keeps its own checks.
   // A capped collection cannot be sharded, so this run leaves it unsharded.
   function cappedThisRun() {
      return !!(capped && !timeSeries);
   }

   function shardThisRun() {
      return sharding && isSharded() && !cappedThisRun();
   }

   function writerConcurrencyProblem() {
      const n = writerConcurrency;
      if (typeof n === 'number' && Number.isSafeInteger(n) && n >= 1)
         return null;
      return `writerConcurrency ${tojson(n)} must be an integer of at least 1`;
   }

   function collectionPlan() {
      const willShard = shardThisRun();
      const reasons = [];
      const concurrencyProblem = writerConcurrencyProblem();
      if (concurrencyProblem)
         reasons.push(concurrencyProblem);
      distributionSpec().errors.forEach(reason => reasons.push(reason));
      if (timeSeries && !fCV(5.0))
         reasons.push('time series requires fCV 5.0 or newer');
      if (timeSeries && isAtlasPlatform('serverless'))
         reasons.push('time series is not available on serverless');
      if (reasons.length)
         return reasons;
      if (timeSeries) {
         const fit = timeSeriesSelection(willShard);
         if (fit.length)
            fit.forEach(reason => reasons.push(reason));
         else {
            timeSeriesSchemaProblems(willShard).forEach(reason => reasons.push(reason));
            if (willShard && timeSeriesShardKeyProblem(shardedOptions.key, tsOptions && tsOptions.metaField, tsOptions && tsOptions.timeField))
               reasons.push(`time series shard key ${tojson(shardedOptions.key)} is not usable`);
         }
         const expireProblem = timeSeriesExpireProblem();
         if (expireProblem)
            reasons.push(expireProblem);
         if (isPlainObject(indexPrefs) && indexPrefs.build)
            timeSeriesIndexProblems(tsOptions && tsOptions.metaField).forEach(reason => reasons.push(reason));
      }
      if (willShard && shardKeyUsesHash(shardedOptions.key) && collation.locale !== 'simple')
         reasons.push('a non-simple collation on the hashed shard key conflicts with the simple hashed index');
      if (willShard && shardKeyHashedPrefix(shardedOptions.key)) {
         let presplit = false;
         try {
            presplit = !namespace.exists() || namespaceIsEmpty();
         } catch(e) {
            reasons.push(`namespace is unreadable: ${errText(e)}`);
         }
         if (presplit) {
            try {
               const chunks = initialChunkCount();
               if (!(chunks >= 1))
                  reasons.push(`initial chunk count is ${chunks}`);
            } catch(e) {
               reasons.push(`config.shards is unreadable: ${errText(e)}`);
            }
         }
      }
      return reasons;
   }

   function createNS() {
      if (namespace.exists()) {
         if (!shardThisRun())
            return true;
         return shardPreservedNamespace();
      } else {
         let [blockCompressor] = parseCompressor(compressor);
         let options = {
            "storageEngine": (isAtlasPlatform('sharedTier'))
                           ? undefined
                           : { "wiredTiger": { "configString": `block_compressor=${blockCompressor}` } },
            "collation": collation,
            "writeConcern": writeConcern,
            // fCV(5.3) && "clusteredIndex": {},
            // fCV(6.0) && "changeStreamPreAndPostImages": {},
            // "validator": {},
            // "validationLevel": <string>,
            // "validationAction": <string>,
            // "indexOptionDefaults": {},
            // "viewOn": <string>,
            // "pipeline": []
         };
         if (cappedThisRun()) {
            options.capped = true;
            options.size = cappedOptions.size;
            options.max = cappedOptions.max;
         }
         if (timeSeries && fCV(5.0) && !isAtlasPlatform('serverless')) {
            // Command field is timeseries. The option flag stays timeSeries.
            options.timeseries = tsOptions;
            // 0 means omit. A positive number is seconds after timeField.
            if (typeof expireAfterSeconds === 'number' && expireAfterSeconds > 0)
               options.expireAfterSeconds = expireAfterSeconds;
         }

         try {
            database.createCollection(collName, options);
         } catch(e) {
            console.log('\n[red][ERROR] Namespace creation failed:[/]', errText(e));
            return false;
         }

         if (!shardThisRun())
            return true;
         return shardNewNamespace();
      }
   }

   function createIndexSet(keys, options, label) {
      const useCommitQuorum = fCV(4.4) && (isReplSet() || isSharded());
      const args = useCommitQuorum
         ? [keys, options, indexPrefs.commitQuorum]
         : [keys, options];
      try {
         const names = namespace.createIndexes(...args);
         const text = Array.isArray(names) ? names.join(', ') : String(names);
         return [label, text];
      } catch(e) {
         return [label, `[red]${errText(e)}[/]`];
      }
   }

   function dropExistingIndexes() {
      if (!dropIndexes || !namespace.exists())
         return;
      const secondary = namespace.getIndexes().filter(index => index.name !== '_id_');
      if (secondary.length === 0)
         return;
      namespace.dropIndexes();
   }

   function buildIndexes() {
      const built = [];
      if (!indexPrefs.build)
         return built;
      if (indexes.length > 0)
         built.push(createIndexSet(indexes, indexOptions, 'index'));
      [
         [hashedIndexes, hashedIndexOptions, 'hashed'],
         [indexes2d, indexes2dOptions, '2d'],
         [textIndexes, textIndexOptions, 'text']
      ].forEach(([keys, options, label]) => {
         if (keys && keys.length)
            built.push(createIndexSet(keys, options, label));
      });
      return built;
   }

   function insertedFromWrite(value) {
      if (!value || typeof value !== 'object')
         return 0;
      const ids = value.insertedIds;
      if (ids && typeof ids === 'object') {
         const n = Object.keys(ids).length;
         if (n > 0)
            return n;
      }
      if (typeof value.insertedCount === 'number')
         return value.insertedCount;
      if (value.result && value.result !== value)
         return insertedFromWrite(value.result);
      return 0;
   }

   // User async: the rewriter does not await this at the call. genBulk keeps the
   // promise and may launch a second insert before this one settles.
   async function insertBatch(docs) {
      // mongosh Bulk.execute ignores its writeConcern argument.
      return namespace.insertMany(docs, {
         "ordered": false,
         "writeConcern": writeConcern
      });
   }

   // The insert command wrapper sits above the document bytes. 32 KiB leaves
   // room for it. A legal document that does not fit is held for the next batch.
   const MESSAGE_RESERVE_BYTES = 32 * 1024;
   const batchHud = new MiniHud({ "enabled": true, "throttleMs": 0 });
   let ackedBytes = 0;
   let progressInserted = 0;
   let progressBatch = 0;
   let progressShown = false;
   let progressLive = false;

   function insertBar(inserted, total, width = 24) {
      const n = Math.max(1, width);
      const frac = total > 0 ? Math.min(1, inserted / total) : 1;
      let filled = frac >= 1 ? n : Math.floor(frac * n);
      if (inserted > 0 && filled === 0)
         filled = 1;
      if (frac < 1)
         filled = Math.min(filled, n - 1);
      return '█'.repeat(filled) + '░'.repeat(n - filled);
   }

   function progressText(inserted, bytes, batchNo, final = false) {
      const total = totalDocs;
      const frac = total > 0 ? Math.min(1, inserted / total) : 1;
      const pct = (total > 0 && inserted >= total) ? 100 : Math.floor(frac * 100);
      const batch = (!final && batchNo > 0) ? `, batch [blue]${batchNo}[/]` : '';
      const shownBytes = grouped(bytes);
      return `[yellow]insert[/]  [blue]${inserted}[/]/[blue]${total}[/]  ${insertBar(inserted, total)}  [blue]${pct}[/]%, [blue]${shownBytes}[/] ${plural(bytes, 'byte', 'bytes')}${batch}`;
   }

   function showProgress(inserted, bytes, batchNo, final = false) {
      progressInserted = inserted;
      progressBatch = batchNo;
      const line = progressText(inserted, bytes, batchNo, final);
      if (batchHud.enabled && !final) {
         batchHud.render(line, { "force": true });
         progressShown = true;
         progressLive = true;
         return;
      }
      if (final && !batchHud.enabled && progressShown)
         return;
      const lead = progressShown ? '' : '\n';
      batchHud.clear();
      console.log(lead + line);
      progressShown = true;
      progressLive = false;
   }

   function logLine(...args) {
      const restore = progressLive;
      batchHud.clear();
      progressLive = false;
      console.log(...args);
      if (!restore)
         return;
      batchHud.render(progressText(progressInserted, ackedBytes, progressBatch), { "force": true });
      progressLive = true;
   }
   let packGenerated = 0;
   let packHeld = null;
   let packSkipped = 0;
   let packDepthWarned = false;
   let bulkStop = false;

   async function takePackedBatch() {
      if (bulkStop)
         return null;
      const countCap = Math.min(1000, maxWriteBatchSize);
      const messageBudget = Math.max(1, maxMessageSizeBytes - MESSAGE_RESERVE_BYTES);
      const docs = [];
      let bytes = 0;
      if (packHeld) {
         docs.push(packHeld.doc);
         bytes = packHeld.size;
         packHeld = null;
      }
      while (docs.length < countCap && packGenerated < totalDocs) {
         if (bulkStop)
            return null;
         packGenerated++;
         const doc = genDocument(fuzzer, timestamp);
         const size = bsonsize(doc);
         if (!packDepthWarned) {
            const depth = documentDepth(doc);
            if (depth > 64) {
               packDepthWarned = true;
               logLine(`\n[Warning] A document is nested ${depth} levels, past 64. The run continues.`);
            }
         }
         await yieldSometimes();
         if (size > bsonMax) {
            packSkipped++;
            logLine(`\n[Warning] A document of ${size} bytes exceeds the BSON max of ${bsonMax} bytes. It is not inserted.`);
            continue;
         }
         if (docs.length > 0 && (bytes + size) > messageBudget) {
            packHeld = { doc, size };
            break;
         }
         docs.push(doc);
         bytes += size;
      }
      if (docs.length === 0)
         return null;
      return { docs, bytes, n: docs.length };
   }

   async function genBulk(prepared) {
      // writerConcurrency inserts may be in flight. The packer waits while every
      // slot is full. At 1 it waits before packing the next batch.
      let inserted = 0;
      let batchNo = 0;
      let failed = false;
      const slots = new Set();

      function account(info) {
         const bInserted = info.writeError
            ? insertedFromWrite(info.writeError)
            : Object.keys((info.result && info.result.insertedIds) || {}).length;
         inserted += bInserted;
         if (!(info.writeError || bInserted < info.n))
            ackedBytes += info.bytes;
         showProgress(inserted, ackedBytes, info.no);
         if (info.writeError || bInserted < info.n) {
            failed = true;
            bulkStop = true;
            if (info.writeError)
               logLine(errText(info.writeError));
            return false;
         }
         return true;
      }

      function launch(batch) {
         const job = {
            no: ++batchNo,
            n: batch.n,
            bytes: batch.bytes,
            result: null,
            writeError: null
         };
         job.promise = insertBatch(batch.docs).catch(err => {
            job.writeError = err;
            bulkStop = true;
            return null;
         }).then(result => {
            job.result = result;
            return job;
         });
         slots.add(job.promise);
      }

      async function settleOne() {
         const job = await Promise.race(slots);
         slots.delete(job.promise);
         return account(job);
      }

      async function drainSlots() {
         while (slots.size > 0) {
            await settleOne();
         }
      }

      try {
         while (prepared && !bulkStop) {
            launch(prepared);
            prepared = null;
            if (slots.size >= writerConcurrency && !(await settleOne()))
               break;
            if (bulkStop)
               break;
            prepared = await takePackedBatch();
         }
      } catch(e) {
         bulkStop = true;
         await drainSlots();
         throw e;
      }
      await drainSlots();
      showProgress(inserted, ackedBytes, progressBatch, true);
      if (failed) {
         const shortfall = totalDocs - inserted;
         logLine(`\n[red][ERROR][/] Bulk insert stopped after ${inserted} of ${totalDocs} documents (${shortfall} short)`);
         return false;
      }
      if (packSkipped > 0)
         logLine(`\n${packSkipped} ${plural(packSkipped, 'document', 'documents')} over the BSON max ${plural(packSkipped, 'was', 'were')} not inserted.`);
      return true;
   }

   try {
      await main();
   } catch(e) {
      console.log('[red][ERROR][/]', errText(e));
      throw e;
   }
})();

// EOF
