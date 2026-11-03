/*
 *  Name: "fuzzer.js"
 *  Version: "1.12.0"
 *  Description: "pseudorandom data generator, with some fuzzing capability"
 *  Disclaimer: "https://raw.githubusercontent.com/tap1r/mongodb-scripts/master/DISCLAIMER.md"
 *  Authors: ["tap1r <luke.prochazka@gmail.com>"]
 *  Roadmap: "https://raw.githubusercontent.com/tap1r/mongodb-scripts/master/ROADMAP.md" (required context)
 *
 *  Dual-shell snapshot: legacy/mongo-shell (v0.6.43). This file is mongosh-only.
 */

// Usage: mongosh [connection options] [--quiet] [--eval 'var options = {...};'] [-f|--file] </path/to/>fuzzer.js
// Overlay: fuzzer-options.jsonc (cwd, --file dir, $MDBLIB, ~/.mongodb) then var options. Missing default is silent.
// optionsVersion must match OPTIONS_VERSION. A mismatch or an unknown key warns. The run continues.
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
   const __script = { "name": "fuzzer.js", "version": "1.12.0" };
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

   const OPTIONS_VERSION = 1;
   const optionDefaults = {
      "optionsVersion": OPTIONS_VERSION, // a loaded file must match. A mismatch warns.
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
      // Omitted create keys are not sent. A view creates and does not insert.
      // "create": {
      //    "clusteredIndex": { "key": { "_id": 1 }, "unique": true }, // fCV 5.3+
      //    "changeStreamPreAndPostImages": { "enabled": false },      // fCV 6.0+
      //    "validator": { "$jsonSchema": { "bsonType": "object" } },
      //    "validationLevel": "strict",   // ["off"|"strict"|"moderate"|"constraint"]
      //    "validationAction": "error",   // ["error"|"warn"|"errorAndLog"]
      //    "indexOptionDefaults": {}
      //    // "viewOn": "source",
      //    // "pipeline": []
      // },
      "fuzzer": { /* preferences */
         "id": "ts",                    // ["ts"|"oid"] - timeseries OID | client generated OID
         "range": 365.2422,             // date range in days
         "offset": -300,                // date offset in days from now() (negative = past, positive = future)
         // offset and range may also be set on distributionParams. Omitted, they use the values above.
         // uniform fills [offset, offset + range].
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
         // Omitted when presplitHashedZones applies the zones below.
         "numInitialChunksPerShard": 2,
         // "presplitHashedZones": false, // empty collection; zones required
         // Hashed prefix: one zone from MinKey to MaxKey. Shards in that zone share the chunks.
         // Hashed field after a prefix: lower prefix is not MinKey or MaxKey, hashed lower bound is MinKey.
         // Ranges are [min, max). The next zone starts at the previous max.
         // "zones": [
         //    { "min": { "date": MinKey }, "max": { "date": MaxKey }, "zone": "all" }
         // ],
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
         // { "multiPolygonHole": "2dsphere" },
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
      overlay,
      "optionsVersion": OPTIONS_VERSION,
      "contract": deepMergeOptions(optionDefaults, {
         "totalDocs": 0,
         "writeConcern": { "w": 1, "wtimeout": 0 },
         "collation": {
            "caseLevel": false,
            "caseFirst": "off",
            "strength": 3,
            "numericOrdering": false,
            "alternate": "non-ignorable",
            "maxVariable": "punct",
            "backwards": false
         },
         "indexPrefs": { "commitQuorum": 1 },
         "create": {
            "clusteredIndex": { "key": {}, "unique": true, "name": "" },
            "changeStreamPreAndPostImages": { "enabled": false },
            "validator": {},
            "validationLevel": "off",
            "validationAction": "error",
            "indexOptionDefaults": {},
            "viewOn": "",
            "pipeline": []
         },
         "fuzzer": {
            "distributionParams": {
               "offset": 0,
               "range": 1,
               "mu": 0,
               "sigma": 1,
               "mix": 0.5,
               "mu1": 0,
               "sigma1": 1,
               "mu2": 0,
               "sigma2": 1,
               "alpha": 1.161,
               "scale": 1,
               "origin": "start",
               "lambda": 1,
               "mean": 1
            }
         },
         "shardedOptions": {
            "presplitHashedZones": false,
            "zones": []
         }
      }),
      "open": [
         "shardedOptions.key",
         "indexOptions",
         "hashedIndexOptions",
         "indexes2dOptions",
         "textIndexOptions",
         "create.validator",
         "create.indexOptionDefaults",
         "create.clusteredIndex.key"
      ]
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
   // A merged key keeps the default field order and appends new fields.
   // The shard key is ordered, so a layer that sets key replaces it whole.
   if (isPlainObject(shardedOptions)) {
      if (resolved.source.file) {
         try {
            const fromFile = shardKeyFromLayer(readJsonc(resolved.source.file));
            if (fromFile)
               shardedOptions.key = fromFile;
         } catch(e) {
            // resolveOptions already reported a bad options file.
         }
      }
      const fromOverlay = shardKeyFromLayer(overlay);
      if (fromOverlay)
         shardedOptions.key = fromOverlay;
   }
   // Remember this before the copy. Afterwards every plain indexOptions has a collation.
   const indexCollationSpecified = isPlainObject(indexOptions) && hasOwn(indexOptions, 'collation');
   if (isPlainObject(indexOptions) && !indexCollationSpecified)
      indexOptions.collation = collation;
   // One list feeds the HUD, the plan, and createIndexes.
   const INDEX_GROUPS = [
      { "keys": indexes, "options": indexOptions, "hudLabel": "index", "planLabel": "indexes", "language": false },
      { "keys": hashedIndexes, "options": hashedIndexOptions, "hudLabel": "hashed", "planLabel": "hashedIndexes", "language": false },
      { "keys": indexes2d, "options": indexes2dOptions, "hudLabel": "2d", "planLabel": "indexes2d", "language": true },
      { "keys": textIndexes, "options": textIndexOptions, "hudLabel": "text", "planLabel": "textIndexes", "language": true }
   ];
   INDEX_GROUPS.forEach(group => {
      if (group.language && isPlainObject(group.options) && !hasOwn(group.options, 'default_language'))
         group.options.default_language = idioma;
   });
   if (idxCompressor != 'default') {
      const configString = `block_compressor=${parseCompressor(idxCompressor)[0]}`;
      INDEX_GROUPS.forEach(group => {
         if (isPlainObject(group.options))
            group.options.storageEngine = { "wiredTiger": { "configString": configString } };
      });
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
   const DAY_SECONDS = 86400;

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

   // Days from now. The draw is a mdblib helper. offset, range, and origin stay
   // this window. uniform fills it. normal and bimodal are not cut; their ts
   // ObjectId span is 8 sigma. pareto is a truncated Lomax and exponential is
   // truncated; both are cut to the window. poisson is a whole-number count and
   // is not cut; its span is the counts it can draw. $genNormal stays the raw
   // normal. $genRandIncPareto and $genExponential stay unused.
   const DISTRIBUTION_NAMES = ['uniform', 'normal', 'bimodal', 'pareto', 'exponential', 'poisson'];
   const DISTRIBUTION_KEYS = {
      uniform: ['offset', 'range'],
      normal: ['mu', 'sigma', 'offset', 'range'],
      bimodal: ['mix', 'mu1', 'sigma1', 'mu2', 'sigma2', 'sigma', 'offset', 'range'],
      pareto: ['alpha', 'scale', 'origin', 'offset', 'range'],
      exponential: ['lambda', 'mean', 'origin', 'offset', 'range'],
      poisson: ['lambda', 'mean', 'origin', 'offset', 'range']
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

   function resolveDistribution(prefs) {
      const unusable = (errors, requested) => ({
         requested: requested || '',
         name: 'uniform',
         unbounded: false,
         errors,
         rows: [],
         offset: 0,
         range: 0,
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
      const rawParams = prefs.distributionParams;
      const errors = [];
      if (folded && !DISTRIBUTION_NAMES.includes(folded))
         errors.push(`unsupported distribution type "${requested}". Use uniform, normal, bimodal, pareto, exponential, or poisson`);
      if (rawParams != null && !isPlainObject(rawParams))
         errors.push('fuzzer.distributionParams must be an object');

      const params = isPlainObject(rawParams) ? rawParams : {};
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

      // Exponential inverts mean into a daily rate. Poisson keeps mean as the day count.
      function readLambdaOrMean(fallback, invertMean) {
         const lambdaValue = readNumber('lambda');
         const meanValue = readNumber('mean');
         if (lambdaValue !== undefined && meanValue !== undefined) {
            errors.push('fuzzer.distributionParams accepts lambda or mean, not both');
            return undefined;
         }
         if (lambdaValue !== undefined) {
            if (!(lambdaValue > 0))
               errors.push('fuzzer.distributionParams.lambda must be greater than 0');
            return lambdaValue;
         }
         if (meanValue !== undefined) {
            if (!(meanValue > 0)) {
               errors.push('fuzzer.distributionParams.mean must be greater than 0');
               return undefined;
            }
            return invertMean ? 1 / meanValue : meanValue;
         }
         return fallback;
      }

      // distributionParams wins. Omitted keys use fuzzer.offset and fuzzer.range.
      let offset;
      if (given('offset')) {
         offset = readNumber('offset');
         if (offset === undefined)
            offset = NaN;
      } else {
         offset = +prefs.offset;
         if (!Number.isFinite(offset))
            errors.push('fuzzer.offset must be a finite number of days');
      }
      let range;
      if (given('range')) {
         range = readNumber('range');
         if (range === undefined)
            range = NaN;
         else if (!(range > 0)) {
            errors.push('fuzzer.distributionParams.range must be greater than 0');
            range = NaN;
         }
      } else {
         range = +prefs.range;
         if (!Number.isFinite(range) || !(range > 0))
            errors.push('fuzzer.range must be a finite number of days greater than 0');
      }
      const windowOk = Number.isFinite(offset) && Number.isFinite(range) && range > 0;
      const lo = windowOk ? offset : 0;
      const hi = windowOk ? offset + range : 0;

      let draw = () => $genUniform(lo, hi);
      let low = lo;
      let high = hi;
      let unbounded = false;
      const rows = [];
      if (windowOk) {
         rows.push(
            ['offset', statText(lo, 'days')],
            ['range', statText(range, 'days')]
         );
      }

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
            draw = () => $genNormalDraw(mean, width);
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
            draw = () => $genBimodal(mix, mean1, width1, mean2, width2);
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
            draw = () => $genTruncatedLomax(alpha, scale, range, origin, lo, hi);
            rows.push(
               ['alpha', statText(alpha)],
               ['scale', statText(scale, 'days')],
               ['origin', `[blue]${origin}[/]`]
            );
         }
      } else if (known && name === 'exponential') {
         const lambda = readLambdaOrMean(range > 0 ? 1 / range : undefined, true);
         const origin = readOrigin();
         if (windowOk && lambda > 0) {
            draw = () => $genTruncatedExponential(lambda, range, origin, lo, hi);
            rows.push(
               ['lambda', statText(lambda, 'per day')],
               ['mean', `${statText(1 / lambda, 'days')} [dim](untruncated)[/]`],
               ['origin', `[blue]${origin}[/]`]
            );
         }
      } else if (known && name === 'poisson') {
         const lambda = readLambdaOrMean(range > 0 ? range : undefined, false);
         const origin = readOrigin();
         if (windowOk && lambda > 0) {
            const sampler = $poissonSampler(lambda);
            unbounded = true;
            if (origin === 'end') {
               low = hi - sampler.highK;
               high = hi - sampler.lowK;
            } else {
               low = lo + sampler.lowK;
               high = lo + sampler.highK;
            }
            draw = () => $genPoisson(lambda, origin, lo, hi);
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
         offset: lo,
         range,
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
      if (isViewRun())
         return '[dim]omitted[/]  [dim](view)[/]';
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

   function collectionRows() {
      const rows = [
         ['compressor', compressorText()],
         ['collation', String(collation && collation.locale)],
         ['write concern', writeConcernText()],
         ['time series', timeSeriesText()],
         ['capped', cappedText()]
      ];
      createHudRows().forEach(row => rows.push(row));
      rows.push(['sharding', shardingText()]);
      return rows;
   }

   function shardingText() {
      if (cappedThisRun() && sharding && isSharded())
         return '[yellow]skipped[/]  [dim](capped)[/]';
      if (!sharding || !isSharded())
         return '[dim]off[/]';
      let text = oneLine(shardedOptions.key);
      const zones = zoneRanges();
      if (zones)
         text += `  [dim]zones[/] [blue]${zones.length}[/]`;
      if (presplitHashedZonesActive())
         text += '  [green]presplit[/]';
      return text;
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

   let hudLabelW = 0;
   let hudValueW = 0;

   function printHud() {
      const ratios = Array.isArray(fuzzer.ratios) ? fuzzer.ratios : [1];
      const windowSpec = distributionSpec();
      const from = new Date(now + windowSpec.offset * DAY_SECONDS * 1000).toISOString();
      const to = new Date(now + (windowSpec.offset + windowSpec.range) * DAY_SECONDS * 1000).toISOString();
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
         INDEX_GROUPS.forEach(group => {
            const keys = group.keys;
            if (!keys || !keys.length) {
               indexRows.push([group.hudLabel, '[dim]none[/]']);
               return;
            }
            if (group.hudLabel === 'index')
               indexRows.push(['collation', indexCollationNote()]);
            const lang = group.language ? languageNote(group.options) : '';
            keys.forEach(spec => indexRows.push([group.hudLabel, `${oneLine(spec)}${lang}`]));
         });
      }
      const sections = [
         ['run', [
            ['namespace', namespaceText()],
            ['documents', isViewRun() ? '[dim]skipped[/]' : `[blue]${grouped(totalDocs)}[/]`],
            ['writer concurrency', `[blue]${writerConcurrency}[/]`]
         ]],
         ['window', [
            ['distribution', distributionText()],
            ...windowSpec.rows,
            ['from', from],
            ['to', to]
         ]],
         ['collection', collectionRows()],
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
      resolved.warnings.forEach(warning => {
         console.log(`\n[red][WARN] [yellow]${warning.message}[/]`);
      });
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

      const orderName = indexOrderText();
      if (orderName !== String((indexPrefs && indexPrefs.order) || '').toLowerCase())
         console.log(`\nUnsupported index build preference "${indexPrefs.order}": defaulting to "post"`);

      printHud();

      // A view is created and the run stops. No pack, insert, index, or shard.
      if (isViewRun()) {
         dropNS();
         if (!(await createNS()))
            return;
         console.log('\n [green]Fuzzing completed![/]\n');
         return;
      }

      // Drop finishes before create. createNS is async so the rewriter can
      // yield on createCollection while the first batch is packed.
      dropNS();
      let createFailed = null;
      const creating = createNS().catch(err => {
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
      switch (orderName) {
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
      // low and high already include the 8-sigma tails of an unbounded draw.
      const reasons = [];
      const minSeconds = timestamp + spec.low * DAY_SECONDS;
      const maxSeconds = timestamp + spec.high * DAY_SECONDS;
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

   // Key order is the expression-cache key: oid, date, ts, idioma, totalDocs.
   function schemaScope({ oid = null, date = null, ts = null } = {}) {
      return { oid, date, ts, idioma, totalDocs };
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
      const secondsOffset = $floor(distributionSpec().draw() * DAY_SECONDS);
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
      return realiseSchema(sample.spec, schemaScope({ oid, date, ts }), sample.file);
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
   // shard key starts with a hashed field. presplitHashedZones covers a hashed
   // field anywhere in the key once shardedOptions.zones is set.
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
      // Zone ranges replace the even hashed split.
      if (presplitHashedZonesRequested() || zoneRanges())
         return false;
      return shardKeyHashedPrefix(shardedOptions.key)
         && (!namespace.exists() || namespaceIsEmpty());
   }

   function createSpec() {
      return isPlainObject(opt.create) ? opt.create : null;
   }

   function isViewRun() {
      const spec = createSpec();
      if (!spec)
         return false;
      if (typeof spec.viewOn === 'string' && spec.viewOn !== '')
         return true;
      return Array.isArray(spec.pipeline);
   }

   function shardKeyFromLayer(layer) {
      if (!isPlainObject(layer) || !isPlainObject(layer.shardedOptions))
         return null;
      if (!hasOwn(layer.shardedOptions, 'key') || !isPlainObject(layer.shardedOptions.key))
         return null;
      return layer.shardedOptions.key;
   }

   function isMinKey(value) {
      if (value == null)
         return false;
      if (typeof MinKey === 'function' && (value === MinKey || value instanceof MinKey))
         return true;
      return value._bsontype === 'MinKey';
   }

   function isMaxKey(value) {
      if (value == null)
         return false;
      if (typeof MaxKey === 'function' && (value === MaxKey || value instanceof MaxKey))
         return true;
      return value._bsontype === 'MaxKey';
   }

   function zoneRanges() {
      if (!isPlainObject(shardedOptions) || !hasOwn(shardedOptions, 'zones'))
         return null;
      const zones = shardedOptions.zones;
      if (!Array.isArray(zones) || zones.length === 0)
         return null;
      return zones;
   }

   function presplitHashedZonesRequested() {
      return !!(isPlainObject(shardedOptions) && shardedOptions.presplitHashedZones === true);
   }

   // Zones on a hashed key set the flag. numInitialChunks has no effect once zones exist.
   function presplitHashedZonesActive() {
      return !!(zoneRanges() && isPlainObject(shardedOptions) && shardKeyUsesHash(shardedOptions.key));
   }

   function clusteredKeyOk(spec) {
      if (!isPlainObject(spec) || !isPlainObject(spec.key))
         return false;
      const fields = Object.keys(spec.key);
      return fields.length === 1 && fields[0] === '_id' && spec.key._id === 1;
   }

   function objectHasKeys(value) {
      return isPlainObject(value) && Object.keys(value).length > 0;
   }

   function zoneShapeProblem(zone, key) {
      if (!isPlainObject(zone))
         return 'must be a document';
      if (!isPlainObject(zone.min) || !isPlainObject(zone.max))
         return 'min and max must be documents';
      if (!hasOwn(zone, 'zone') || (zone.zone != null && typeof zone.zone !== 'string'))
         return 'zone must be a string or null';
      if (!isPlainObject(key))
         return 'needs a shard key';
      const fields = Object.keys(key);
      const minFields = Object.keys(zone.min);
      const maxFields = Object.keys(zone.max);
      if (minFields.join('\0') !== fields.join('\0') || maxFields.join('\0') !== fields.join('\0'))
         return 'min and max must use the shard key fields in order';
      return null;
   }

   function applyZoneRanges() {
      const zones = zoneRanges();
      if (!zones)
         return true;
      const ns = `${dbName}.${collName}`;
      try {
         zones.forEach(range => {
            sh.updateZoneKeyRange(ns, range.min, range.max, range.zone);
         });
         return true;
      } catch(e) {
         console.log('[red][ERROR] Sharding namespace failed:[/]', errText(e));
         return false;
      }
   }

   function applyCreateSlots(createOptions) {
      const spec = createSpec();
      if (!spec)
         return;
      if (isViewRun()) {
         createOptions.viewOn = spec.viewOn;
         createOptions.pipeline = Array.isArray(spec.pipeline) ? spec.pipeline : [];
         return;
      }
      if (isPlainObject(spec.clusteredIndex)) {
         const src = spec.clusteredIndex;
         const clustered = { "key": src.key };
         clustered.unique = hasOwn(src, 'unique') ? src.unique : true;
         if (typeof src.name === 'string' && src.name !== '')
            clustered.name = src.name;
         createOptions.clusteredIndex = clustered;
      }
      if (isPlainObject(spec.changeStreamPreAndPostImages)) {
         createOptions.changeStreamPreAndPostImages = {
            "enabled": spec.changeStreamPreAndPostImages.enabled
         };
      }
      if (objectHasKeys(spec.validator))
         createOptions.validator = spec.validator;
      if (typeof spec.validationLevel === 'string')
         createOptions.validationLevel = spec.validationLevel;
      if (typeof spec.validationAction === 'string')
         createOptions.validationAction = spec.validationAction;
      if (objectHasKeys(spec.indexOptionDefaults))
         createOptions.indexOptionDefaults = spec.indexOptionDefaults;
   }

   function createHudRows() {
      const spec = createSpec();
      const rows = [];
      if (!spec)
         return rows;
      if (isViewRun())
         rows.push(['view', `[green]${spec.viewOn}[/]`]);
      if (hasOwn(spec, 'clusteredIndex'))
         rows.push(['clustered', '[green]_id[/]']);
      if (isPlainObject(spec.changeStreamPreAndPostImages)) {
         const on = spec.changeStreamPreAndPostImages.enabled === true;
         rows.push(['images', on ? '[green]pre/post[/]' : '[dim]off[/]']);
      }
      if (objectHasKeys(spec.validator) || hasOwn(spec, 'validationLevel') || hasOwn(spec, 'validationAction')) {
         const level = (typeof spec.validationLevel === 'string') ? spec.validationLevel : 'strict';
         const action = (typeof spec.validationAction === 'string') ? spec.validationAction : 'error';
         rows.push(['validator', `[blue]${level}[/]  [dim]/[/]  [blue]${action}[/]`]);
      }
      if (objectHasKeys(spec.indexOptionDefaults))
         rows.push(['index defaults', '[green]set[/]']);
      return rows;
   }

   function zoneSlotProblems(willShard) {
      const reasons = [];
      if (!isPlainObject(shardedOptions) || !hasOwn(shardedOptions, 'zones'))
         return reasons;
      const zones = shardedOptions.zones;
      if (!Array.isArray(zones)) {
         reasons.push('shardedOptions.zones must be an array');
         return reasons;
      }
      if (zones.length === 0)
         return reasons;
      if (!willShard)
         reasons.push('shardedOptions.zones require sharding this run');
      zones.forEach((zone, i) => {
         const why = zoneShapeProblem(zone, shardedOptions.key);
         if (why)
            reasons.push(`shardedOptions.zones[${i}] ${why}`);
      });
      return reasons;
   }

   function presplitSlotProblems(willShard) {
      const reasons = [];
      if (!isPlainObject(shardedOptions))
         return reasons;
      if (hasOwn(shardedOptions, 'presplitHashedZones') && typeof shardedOptions.presplitHashedZones !== 'boolean') {
         reasons.push('presplitHashedZones must be a boolean');
         return reasons;
      }
      const requested = shardedOptions.presplitHashedZones === true;
      const implied = presplitHashedZonesActive();
      if (!requested && !implied)
         return reasons;
      if (!fCV(5.0))
         reasons.push('presplitHashedZones requires fCV 5.0 or newer');
      if (requested && !willShard)
         reasons.push('presplitHashedZones requires sharding this run');
      if (requested && !shardKeyUsesHash(shardedOptions.key))
         reasons.push('presplitHashedZones requires a hashed field in the shard key');
      if (requested && !zoneRanges())
         reasons.push('presplitHashedZones requires shardedOptions.zones');
      if ((requested || implied) && zoneRanges()) {
         const why = presplitZoneProblem(shardedOptions.key, zoneRanges());
         if (why)
            reasons.push(why);
      }
      // dropNamespace removes the collection before create, so that run is empty.
      // Read the namespace only when this run would presplit an existing one.
      if ((requested || implied) && willShard && !dropNamespace) {
         try {
            if (namespace.exists() && !namespaceIsEmpty())
               reasons.push('presplitHashedZones requires an empty collection');
         } catch(e) {
            reasons.push(`namespace is unreadable: ${errText(e)}`);
         }
      }
      return reasons;
   }

   // A hashed prefix can presplit only one zone, and that zone is the whole key.
   // A hashed field later in the key presplits on the prefix: the lower prefix is a
   // real value, and the hashed field's lower bound is MinKey. Ranges are [min, max).
   function presplitZoneProblem(key, zones) {
      if (!isPlainObject(key) || !Array.isArray(zones))
         return null;
      const fields = Object.keys(key);
      let hashAt = -1;
      for (let i = 0; i < fields.length; i++) {
         if (key[fields[i]] === 'hashed') {
            hashAt = i;
            break;
         }
      }
      if (hashAt < 0)
         return null;
      if (hashAt === 0) {
         const zone = zones[0];
         let covers = zones.length === 1
            && isPlainObject(zone)
            && isPlainObject(zone.min)
            && isPlainObject(zone.max);
         if (covers) {
            for (let i = 0; i < fields.length; i++) {
               if (!isMinKey(zone.min[fields[i]]) || !isMaxKey(zone.max[fields[i]]))
                  covers = false;
            }
         }
         return covers ? null : 'presplitHashedZones with a hashed prefix needs one zone from MinKey to MaxKey';
      }
      for (let z = 0; z < zones.length; z++) {
         const zone = zones[z];
         if (!isPlainObject(zone) || !isPlainObject(zone.min) || !isPlainObject(zone.max))
            continue;
         for (let i = 0; i < hashAt; i++) {
            const low = zone.min[fields[i]];
            if (isMinKey(low) || isMaxKey(low))
               return `presplitHashedZones zones[${z}] prefix lower bound cannot be MinKey or MaxKey`;
         }
         for (let i = hashAt; i < fields.length; i++) {
            if (!isMinKey(zone.min[fields[i]]))
               return `presplitHashedZones zones[${z}] lower bound from the hashed field must be MinKey`;
         }
         let differs = false;
         for (let i = 0; i < hashAt; i++) {
            if (tojson(zone.min[fields[i]]) !== tojson(zone.max[fields[i]]))
               differs = true;
         }
         if (!differs)
            return `presplitHashedZones zones[${z}] upper prefix must differ from the lower prefix`;
      }
      return null;
   }

   function shardSlotProblems(willShard) {
      const reasons = [];
      zoneSlotProblems(willShard).forEach(reason => reasons.push(reason));
      presplitSlotProblems(willShard).forEach(reason => reasons.push(reason));
      return reasons;
   }

   // checkShard is false while a time series run may still replace the shard key.
   function createAndShardSlotProblems(willShard, checkShard = true) {
      const reasons = [];
      if (hasOwn(opt, 'create') && !isPlainObject(opt.create))
         reasons.push('create must be a document');
      const spec = createSpec();
      const viewOnSet = !!(spec && typeof spec.viewOn === 'string' && spec.viewOn !== '');
      const view = isViewRun();
      if (spec && hasOwn(spec, 'viewOn') && !viewOnSet)
         reasons.push('create.viewOn must be a non-empty string');
      if (spec && hasOwn(spec, 'pipeline') && !Array.isArray(spec.pipeline))
         reasons.push('create.pipeline must be an array');
      if (spec && Array.isArray(spec.pipeline) && !viewOnSet)
         reasons.push('create.pipeline requires create.viewOn');
      if (spec && Array.isArray(spec.pipeline)) {
         spec.pipeline.forEach((stage, i) => {
            if (!isPlainObject(stage))
               reasons.push(`create.pipeline[${i}] must be a document`);
         });
      }
      if (viewOnSet && spec.viewOn === collName)
         reasons.push('create.viewOn must name a different collection');
      if (view && spec) {
         if (capped)
            reasons.push('a view cannot be capped');
         if (timeSeries)
            reasons.push('a view cannot be a time series');
         if (willShard)
            reasons.push('a view cannot be sharded');
         if (hasOwn(spec, 'clusteredIndex'))
            reasons.push('a view cannot set clusteredIndex');
         if (hasOwn(spec, 'changeStreamPreAndPostImages'))
            reasons.push('a view cannot set changeStreamPreAndPostImages');
         if (objectHasKeys(spec.validator))
            reasons.push('a view cannot set a validator');
         if (hasOwn(spec, 'validationLevel') || hasOwn(spec, 'validationAction'))
            reasons.push('a view cannot set validationLevel or validationAction');
         if (objectHasKeys(spec.indexOptionDefaults))
            reasons.push('a view cannot set indexOptionDefaults');
      }
      if (spec && hasOwn(spec, 'clusteredIndex') && !view) {
         const clustered = spec.clusteredIndex;
         if (!fCV(5.3))
            reasons.push('clusteredIndex requires fCV 5.3 or newer');
         if (!clusteredKeyOk(clustered))
            reasons.push('clusteredIndex key must be { _id: 1 }');
         else if (hasOwn(clustered, 'unique') && clustered.unique !== true)
            reasons.push('clusteredIndex unique must be true');
         if (isPlainObject(clustered) && hasOwn(clustered, 'name') && (typeof clustered.name !== 'string' || clustered.name === ''))
            reasons.push('clusteredIndex name must be a non-empty string');
         if (cappedThisRun())
            reasons.push('a clustered collection cannot be capped');
         if (timeSeries)
            reasons.push('a time series collection cannot set clusteredIndex');
         if (willShard && !clusteredKeyOk({ "key": shardedOptions.key }))
            reasons.push('a clustered collection shards only on { _id: 1 }');
      }
      if (spec && hasOwn(spec, 'changeStreamPreAndPostImages') && !view) {
         const images = spec.changeStreamPreAndPostImages;
         const keys = isPlainObject(images) ? Object.keys(images) : [];
         if (!fCV(6.0))
            reasons.push('changeStreamPreAndPostImages requires fCV 6.0 or newer');
         if (keys.length !== 1 || keys[0] !== 'enabled' || typeof images.enabled !== 'boolean')
            reasons.push('changeStreamPreAndPostImages must be { enabled: <boolean> }');
         if (timeSeries)
            reasons.push('a time series collection cannot set changeStreamPreAndPostImages');
      }
      if (spec && hasOwn(spec, 'validator') && !isPlainObject(spec.validator))
         reasons.push('create.validator must be a document');
      if (spec && hasOwn(spec, 'validationLevel') && !view) {
         const level = spec.validationLevel;
         const known = level === 'off' || level === 'strict' || level === 'moderate' || level === 'constraint';
         if (typeof level !== 'string' || !known)
            reasons.push('validationLevel must be off, strict, moderate, or constraint');
         else if (level === 'constraint' && !fCV(8.0))
            reasons.push('validationLevel constraint requires fCV 8.0 or newer');
      }
      if (spec && hasOwn(spec, 'validationAction') && !view) {
         const action = spec.validationAction;
         const known = action === 'error' || action === 'warn' || action === 'errorAndLog';
         if (typeof action !== 'string' || !known)
            reasons.push('validationAction must be error, warn, or errorAndLog');
         else if (action === 'errorAndLog' && !fCV(8.0))
            reasons.push('validationAction errorAndLog requires fCV 8.0 or newer');
      }
      if (spec && spec.validationLevel === 'constraint' && !view) {
         const action = hasOwn(spec, 'validationAction') ? spec.validationAction : 'error';
         if (action !== 'error' && action !== 'errorAndLog')
            reasons.push('validationLevel constraint requires validationAction error or errorAndLog');
      }
      if (spec && hasOwn(spec, 'indexOptionDefaults') && !isPlainObject(spec.indexOptionDefaults))
         reasons.push('create.indexOptionDefaults must be a document');
      if (checkShard)
         shardSlotProblems(willShard).forEach(reason => reasons.push(reason));
      return reasons;
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
      const zones = zoneRanges();
      const presplitZones = presplitHashedZonesActive();
      if (presplitZones)
         console.log(`with presplitHashedZones and ${zones.length} zone ${plural(zones.length, 'range', 'ranges')}`);
      else if (zones)
         console.log(`with ${zones.length} zone ${plural(zones.length, 'range', 'ranges')}`);
      else if (numInitialChunks >= 1)
         console.log(`with initial chunks: ${numInitialChunks}`);
      else if (!shardKeyHashedPrefix(shardedOptions.key))
         console.log('without initial chunks: shard key has no hashed prefix');
      else
         console.log('without initial chunks: the collection is not empty');
      if (!applyZoneRanges())
         return false;
      const shardOptions = { "collation": collation };
      if (presplitZones)
         shardOptions.presplitHashedZones = true;
      else if (numInitialChunks >= 1)
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
      try {
         const key = catalogShardKey();
         if (key)
            return shardKeysMatch(key, shardedOptions.key);
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
            ...(zoneRanges() && { "zones": zoneRanges() }),
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
         const got = evalSchemaExpr(value.slice(1), schemaScope({ "date": new Date(0) }));
         return got instanceof Date;
      } catch(e) {
         return false;
      }
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
      INDEX_GROUPS.forEach(group => {
         const list = group.keys;
         if (!Array.isArray(list)) {
            reasons.push(`time series ${group.planLabel} must be an array`);
            return;
         }
         list.forEach(key => {
            const why = timeSeriesIndexKeyProblem(key, metaField);
            if (why)
               reasons.push(`time series ${group.planLabel} key ${tojson(key)}: ${why}`);
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
      if (spec.low * DAY_SECONDS + expireAfterSeconds > 0)
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
      // Zone checks wait until a time series run has replaced the shard key.
      createAndShardSlotProblems(willShard, !timeSeries).forEach(reason => reasons.push(reason));
      if (timeSeries && !fCV(5.0))
         reasons.push('time series requires fCV 5.0 or newer');
      if (timeSeries && isAtlasPlatform('serverless'))
         reasons.push('time series is not available on serverless');
      if (reasons.length)
         return reasons;
      if (timeSeries) {
         timeSeriesSelection(willShard).forEach(reason => reasons.push(reason));
         const expireProblem = timeSeriesExpireProblem();
         if (expireProblem)
            reasons.push(expireProblem);
         if (isPlainObject(indexPrefs) && indexPrefs.build)
            timeSeriesIndexProblems(tsOptions && tsOptions.metaField).forEach(reason => reasons.push(reason));
      }
      if (willShard && shardKeyUsesHash(shardedOptions.key) && collation.locale !== 'simple')
         reasons.push('a non-simple collation on the hashed shard key conflicts with the simple hashed index');
      if (timeSeries)
         shardSlotProblems(willShard).forEach(reason => reasons.push(reason));
      if (willShard) {
         let presplit = false;
         try {
            presplit = mayPresplitChunks();
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

   async function createNS() {
      if (namespace.exists()) {
         if (!shardThisRun() || isViewRun())
            return true;
         return shardPreservedNamespace();
      }
      const createOptions = {
         "collation": collation,
         "writeConcern": writeConcern
      };
      if (!isViewRun()) {
         let [blockCompressor] = parseCompressor(compressor);
         createOptions.storageEngine = (isAtlasPlatform('sharedTier'))
            ? undefined
            : { "wiredTiger": { "configString": `block_compressor=${blockCompressor}` } };
         if (cappedThisRun()) {
            createOptions.capped = true;
            createOptions.size = cappedOptions.size;
            createOptions.max = cappedOptions.max;
         }
         if (timeSeries && fCV(5.0) && !isAtlasPlatform('serverless')) {
            // Command field is timeseries. The option flag stays timeSeries.
            createOptions.timeseries = tsOptions;
            // 0 means omit. A positive number is seconds after timeField.
            if (typeof expireAfterSeconds === 'number' && expireAfterSeconds > 0)
               createOptions.expireAfterSeconds = expireAfterSeconds;
         }
      }
      applyCreateSlots(createOptions);

      try {
         database.createCollection(collName, createOptions);
      } catch(e) {
         console.log('\n[red][ERROR] Namespace creation failed:[/]', errText(e));
         return false;
      }

      if (!shardThisRun() || isViewRun())
         return true;
      return shardNewNamespace();
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
      INDEX_GROUPS.forEach(group => {
         if (group.keys && group.keys.length)
            built.push(createIndexSet(group.keys, group.options, group.hudLabel));
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
   // Acknowledged documents over wall time since the inserts started.
   let progressStartedAt = 0;

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

   function progressEta(inserted, total) {
      if (!(progressStartedAt > 0) || !(inserted > 0))
         return '--';
      if (!(total > inserted))
         return formatHudTime(0);
      const elapsed = (Date.now() - progressStartedAt) / 1000;
      const remain = (elapsed / inserted) * (total - inserted);
      if (remain > 0 && remain < 1)
         return '<1s';
      return formatHudTime(remain);
   }

   function progressText(inserted, bytes, batchNo, final = false) {
      const total = totalDocs;
      const frac = total > 0 ? Math.min(1, inserted / total) : 1;
      const pct = (total > 0 && inserted >= total) ? 100 : Math.floor(frac * 100);
      const batch = (!final && batchNo > 0)
         ? `, batch [blue]${batchNo}[/], ETA [blue]${progressEta(inserted, total)}[/]`
         : '';
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
      progressStartedAt = Date.now();
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
