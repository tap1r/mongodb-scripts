/*
 *  Name: "fuzzer.js"
 *  Version: "1.1.0"
 *  Description: "pseudorandom data generator, with some fuzzing capability"
 *  Disclaimer: "https://raw.githubusercontent.com/tap1r/mongodb-scripts/master/DISCLAIMER.md"
 *  Authors: ["tap1r <luke.prochazka@gmail.com>"]
 *  Roadmap: "https://raw.githubusercontent.com/tap1r/mongodb-scripts/master/ROADMAP.md" (required context)
 *
 *  Dual-shell snapshot: legacy/mongo-shell (v0.6.43). This file is mongosh-only.
 */

// Usage: mongosh [connection options] [--quiet] [-f|--file] </path/to/>fuzzer.js
// Overlay: fuzzer-options.jsonc in the working directory, beside this script, under $MDBLIB, or ~/.mongodb
// Sample schemas: schema-a.jsonc, schema-b.jsonc, schema-c.jsonc

/*
 *  Load helper mdblib.js (https://github.com/tap1r/mongodb-scripts/blob/master/src/mdblib.js)
 *  Save libs to the $MDBLIB or other valid search path
 */

(() => {
   const __script = { "name": "fuzzer.js", "version": "1.1.0" };
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
   console.log(`\n\n[yellow]${__comment}[/]`);
})();

(async() => {
   /*
    *  Config files. fuzzer-options.jsonc overlays the defaults below.
    *  Search order for a relative path: the options file's directory,
    *  the working directory, this script's directory, $MDBLIB, ~/.mongodb.
    */

   const OPTIONS_FILE = 'fuzzer-options.jsonc';

   function isPlainObject(value) {
      return !!value && typeof value === 'object' && !Array.isArray(value);
   }

   function hasOwn(obj, key) {
      return !!obj && Object.prototype.hasOwnProperty.call(obj, key);
   }

   function dirOf(file) {
      const slash = String(file).lastIndexOf('/');
      if (slash < 0)
         return '.';
      if (slash === 0)
         return '/';
      return file.slice(0, slash);
   }

   function configDirs(anchorDir) {
      const dirs = [];
      const add = (dir) => {
         if (typeof dir === 'string' && dir.length > 0 && !dirs.includes(dir))
            dirs.push(dir);
      };
      add(anchorDir);
      add('.');
      if (typeof __dirname === 'string')
         add(__dirname);
      add(process.env.MDBLIB);
      if (process.env.HOME)
         add(`${process.env.HOME}/.mongodb`);
      return dirs;
   }

   function resolveConfigFile(name, anchorDir) {
      if (typeof name !== 'string' || name.length === 0)
         return null;
      if (name.startsWith('/') || /^[A-Za-z]:[\\/]/.test(name))
         return fs.existsSync(name) ? name : null;
      let found = null;
      configDirs(anchorDir).some(dir => {
         const full = `${dir.replace(/\/$/, '')}/${name}`;
         if (!fs.existsSync(full))
            return false;
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
               if (s === '"')
                  break;
            }
            continue;
         }
         if (c === '/' && source[i + 1] === '/') {
            i += 2;
            while (i < n && source[i] !== '\n')
               i++;
            continue;
         }
         if (c === '/' && source[i + 1] === '*') {
            i += 2;
            while (i < n && !(source[i] === '*' && source[i + 1] === '/'))
               i++;
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
               if (s === '"')
                  break;
            }
            continue;
         }
         if (c === ',') {
            let j = i + 1;
            while (j < m && (stripped[j] === ' ' || stripped[j] === '\t' || stripped[j] === '\n' || stripped[j] === '\r'))
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

   function mergeOptions(base, over) {
      if (!isPlainObject(over))
         return base;
      const out = isPlainObject(base) ? { ...base } : {};
      Object.keys(over).forEach(key => {
         if (isPlainObject(over[key]) && isPlainObject(out[key]))
            out[key] = mergeOptions(out[key], over[key]);
         else
            out[key] = over[key];
      });
      return out;
   }

   function loadOptionsFile() {
      const filePath = resolveConfigFile(OPTIONS_FILE, null);
      if (!filePath)
         return { "path": null, "value": null, "error": null };
      try {
         const value = readJsonc(filePath);
         if (!isPlainObject(value))
            return { "path": filePath, "value": null, "error": 'must contain an object' };
         return { "path": filePath, "value": value, "error": null };
      } catch(e) {
         return { "path": filePath, "value": null, "error": errText(e) };
      }
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
    *  fuzzer-options.jsonc overlays these defaults.
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
      "indexPrefs": { /* build index preferences */
         "build": true,                 // [true|false]
         "order": "post"                // ["pre"|"post"] collection population
      },
      "timeSeries": false,              // build timeseries collection type
      // Each selected schema must store a Date at timeField.
      // On a mongos the shard key must include metaField.
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
      "expireAfterSeconds": 0,          // TTL and time series options
      "fuzzer": { /* preferences */
         "id": "ts",                    // ["ts"|"oid"] - timeseries OID | client generated OID
         "range": 365.2422,             // date range in days
         "offset": -300,                // date offset in days from now() (negative = past, positive = future)
         "interval": 7,                 // date interval in days
         "distribution": "uniform",     // ["uniform"|"normal"|"bimodal"|"pareto"|"exponential"]
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
            "string": "hashed"
            // "date": 1
         },
         "unique": false,               // resharding a collection that has a uniqueness constraint is not supported
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
         { "string": "hashed" }
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

   const optionsFile = loadOptionsFile();
   const loaded = optionsFile.value;
   const opt = mergeOptions(optionDefaults, loaded);
   const dbName = opt.dbName,
      collName = opt.collName,
      totalDocs = hasOwn(loaded, 'totalDocs') ? loaded.totalDocs : $getRandExp(opt.totalDocsExp),
      dropNamespace = opt.dropNamespace,
      dropIndexes = opt.dropIndexes,
      compressor = opt.compressor,
      idxCompressor = opt.idxCompressor,
      idioma = opt.idioma,
      collation = opt.collation,
      writeConcern = {
         "w": (hasOwn(loaded, 'writeConcern') && hasOwn(loaded.writeConcern, 'w'))
            ? loaded.writeConcern.w
            : ((isReplSet() || isSharded()) ? "majority" : 1),
         "j": hasOwn(opt.writeConcern, 'j') ? opt.writeConcern.j : false
      },
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
   if (!(hasOwn(loaded, 'writeConcern') && hasOwn(loaded.writeConcern, 'wtimeout'))) {
      const wtimeout = defaultWriteConcernTimeout(writeConcern.w);
      if (wtimeout != null)
         writeConcern.wtimeout = wtimeout;
   } else
      writeConcern.wtimeout = loaded.writeConcern.wtimeout;
   if (isPlainObject(fuzzer) && !Array.isArray(fuzzer.ratios))
      fuzzer.ratios = [1];
   if (isPlainObject(indexPrefs)
      && !(hasOwn(loaded, 'indexPrefs') && hasOwn(loaded.indexPrefs, 'commitQuorum')))
      indexPrefs.commitQuorum = (writeConcern.w == 0) ? 1 : writeConcern.w;
   if (isPlainObject(indexOptions)
      && !(hasOwn(loaded, 'indexOptions') && hasOwn(loaded.indexOptions, 'collation')))
      indexOptions.collation = collation;
   if (isPlainObject(indexes2dOptions)
      && !(hasOwn(loaded, 'indexes2dOptions') && hasOwn(loaded.indexes2dOptions, 'default_language')))
      indexes2dOptions.default_language = idioma;
   if (isPlainObject(textIndexOptions)
      && !(hasOwn(loaded, 'textIndexOptions') && hasOwn(loaded.textIndexOptions, 'default_language')))
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
   const schemaAnchor = optionsFile.path ? dirOf(optionsFile.path) : null;
   const schemaLoad = optionsFile.error
      ? { "samples": [], "errors": [] }
      : loadSchemaSamples(isPlainObject(fuzzer) ? fuzzer.schemas : null, schemaAnchor);
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
   const yieldNow = () => new Promise(resolve => setImmediate(resolve));
   const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

   async function main() {
      /*
       *  main
       */
      // Do not Mongo.setReadPref(): mongosh reconnects and the next
      // DB call (exists/drop/create) hangs or rejects on a local RS.
      if (optionsFile.error) {
         console.log(`\n[red][ERROR][/] Options file "${optionsFile.path}": ${optionsFile.error}`);
         return;
      }
      if (optionsFile.path)
         console.log(`\nOptions file "${optionsFile.path}"`);
      if (schemaFileErrors.length > 0) {
         schemaFileErrors.forEach(reason => console.log(`\n[red][ERROR][/] ${reason}`));
         return;
      }
      schemaSamples.forEach(sample => {
         const meta = isPlainObject(sample.spec.schema) ? sample.spec.schema : {};
         const detail = [meta.type, meta.comment].filter(Boolean).join(': ');
         console.log(detail
            ? `Schema sample ${sample.file} (${detail})`
            : `Schema sample ${sample.file}`);
      });
      if (schemaSamples.length === 0) {
         console.log('\n[red][ERROR][/] fuzzer.schemas is empty');
         return;
      }
      const ratioProblem = schemaRatioProblem(fuzzer.ratios, schemaSamples.length);
      if (ratioProblem) {
         console.log(`\n[red][ERROR][/] ${ratioProblem}`);
         return;
      }
      const ratioSum = ratioTotal(fuzzer.ratios);
      const sampleSize = $floor((8 + ratioSum) ** 2);
      // Printed before the plan so a later time-series error is not read as a capped failure.
      if (capped && timeSeries)
         console.log('\n[red][WARN] [yellow]capped[red] is not applied because a time series collection cannot be capped[/]');
      const plan = collectionPlan();
      if (plan.length > 0) {
         plan.forEach(reason => console.log(`\n[red][ERROR][/] ${reason}`));
         return;
      }
      const oidWindow = tsObjectIdWindow();
      if (oidWindow.length > 0) {
         oidWindow.forEach(reason => console.log(`\n[red][ERROR][/] ${reason}`));
         return;
      }
      if (cappedThisRun() && sharding && isSharded())
         console.log('\n[red][WARN] [yellow]sharding[red] is skipped because a capped collection cannot be sharded[/]');

      console.log(`\nSynthesising ${totalDocs} ${plural(totalDocs, 'document', 'documents')}`);

      const distributionName = String(fuzzer.distribution || '').toLowerCase();
      if (distributionName !== 'uniform' && distributionName !== 'normal')
         console.log(`\nUnsupported distribution type: ${fuzzer.distribution}\nDefaulting to "uniform"`);

      // Drop finishes before create. createNS runs while the size sample is drawn.
      async function beginCreateNS() {
         return createNS();
      }
      dropNS();
      let createFailed = null;
      const creating = beginCreateNS().catch(err => {
         createFailed = err;
         return false;
      });

      // sampling synthetic documents and estimating batch size
      let docSize = 0, maxSize = 0;
      try {
         for (let i = 0; i < sampleSize; i++) {
            const size = bsonsize(genDocument(fuzzer, timestamp));
            docSize += size;
            if (size > maxSize)
               maxSize = size;
            await yieldNow();
         }
      } catch(e) {
         await creating;
         throw e;
      }

      const avgSize = $floor(docSize / sampleSize);
      if (maxSize > bsonMax * 0.95)
         console.log(`\n[Warning] The largest sample document of ${maxSize} bytes approaches or exceeds the BSON max size of ${bsonMax} bytes`);
      else if (avgSize > bsonMax * 0.95)
         console.log(`\n[Warning] The average document size of ${avgSize} bytes approaches or exceeds the BSON max size of ${bsonMax} bytes`);
      console.log(`\nSampling ${sampleSize} ${plural(sampleSize, 'document', 'documents')} each with BSON size averaging ${avgSize} ${plural(avgSize, 'byte', 'bytes')}, largest ${maxSize} ${plural(maxSize, 'byte', 'bytes')}`);
      // Size from the largest sample so a batch of heavy documents stays under the BSON max.
      const basis = (maxSize >= 1) ? maxSize : avgSize;
      const sampledSize = $floor(bsonMax * 0.95 / basis);
      const batchCap = 1000;
      // return (maxWriteBatchSize < sampledSize) ? maxWriteBatchSize : sampledSize;
      const batchSize = Math.min(batchCap, sampledSize);
      console.log(`Estimated optimal capacity of ${batchSize} ${plural(batchSize, 'document', 'documents')} per batch`);

      if (createFailed)
         throw createFailed;
      if (!(await creating))
         return;

      dropExistingIndexes();

      // set collection/index build order, generate and bulk write the documents, create indexes
      console.log(`\nIndex build order preference "${indexPrefs.order}"`);
      switch (indexPrefs.order.toLowerCase()) {
         case 'pre':
            console.log('Building indexing metadata first');
            buildIndexes();
            if ((await genBulk(batchSize)) === false)
               return;
            break;
         case 'post':
            console.log('Populating collection first');
            if ((await genBulk(batchSize)) === false)
               return;
            buildIndexes();
            break;
         default:
            console.log(`Unsupported index build preference "${indexPrefs.order}": defaulting to "post"`);
            if ((await genBulk(batchSize)) === false)
               return;
            buildIndexes();
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
      const day = 86400;
      let lo = fuzzer.offset;
      let hi = fuzzer.offset + fuzzer.range;
      // normal is unbounded. 8 sigma is past any draw this run will produce.
      if (String(fuzzer.distribution || '').toLowerCase() === 'normal') {
         const mu = fuzzer.offset + (fuzzer.range / 2);
         const span = 8 * (fuzzer.range / 2);
         lo = Math.min(lo, mu - span);
         hi = Math.max(hi, mu + span);
      }
      const reasons = [];
      const minSeconds = timestamp + lo * day;
      const maxSeconds = timestamp + hi * day;
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

   function evalSchemaExpr(expr, scope) {
      const names = Object.keys(scope);
      const fn = new Function(...names, `"use strict"; return (${expr});`);
      return fn(...names.map(name => scope[name]));
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

   function genDocument({
         id = 'ts', range = 365.2422, offset = -300, interval = 7,
         distribution = 'uniform', ratios = [1] } = {},
         timestamp) {
      /*
       *  Pick one loaded schema, then build only that document.
       *  A string that starts with "=" is an expression.
       */
      const index = ratioIndex(ratios);
      const sample = schemaSamples[index];
      if (!sample)
         throw new Error(`schema ratio index ${index} but only ${schemaSamples.length} ${plural(schemaSamples.length, 'schema file is', 'schema files are')} loaded`);
      const day = 86400;
      let secondsOffset;
      switch (distribution.toLowerCase()) {
         case 'uniform':
            secondsOffset = $floor($getRandNum(offset, offset + range) * day);
            break;
         case 'normal': // genNormal(mu, sigma)
            secondsOffset = $floor($genNormal(offset + (range / 2), range / 2) * day);
            break;
         case 'bimodal': // not implemented yet
            // secondsOffset = $floor($getRandNum(offset, offset + range) * day);
            // break;
         case 'pareto': // not implemented yet
            // $genRandIncPareto(min, alpha = 1.161) {}
            // secondsOffset = $floor($genRandIncPareto(offset + range) * day);
            // break;
         case 'exponential': // not implemented yet
            // $getRandExp();
            // secondsOffset = $floor($getRandExp(offset, offset + range, 128) * day);
            // break;
         default: // bimodal, pareto, and exponential stay unimplemented
            secondsOffset = +$floor($getRandNum(offset, offset + range) * day);
      }
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
      if (dropNamespace && !!dbName && !!collName) {
         console.log(`\nDropping namespace "${dbName}.${collName}"\n`);
         namespace.drop();
         return;
      }
      let msg;
      if (!dropNamespace && !namespace.exists())
         msg = `\nNominated namespace "${dbName}.${collName}" does not exist\n`;
      else
         msg = `\nPreserving existing namespace "${dbName}.${collName}"`;

      console.log(msg);
      return;
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

   function shardNewNamespace() {
      // A non-mongos connection skips sharding and the load continues.
      if (!isSharded())
         return true;
      if (!(sharding && namespace.exists())) {
         console.log('[red][ERROR] Sharding namespace failed:[/] the namespace does not exist');
         return false;
      }

      let numInitialChunks;
      try {
         numInitialChunks = initialChunkCount();
      } catch(e) {
         console.log('[red][ERROR] Sharding namespace failed:[/]', errText(e));
         return false;
      }
      if (!(numInitialChunks >= 1)) {
         console.log(`[red][ERROR] Sharding namespace failed:[/] initial chunk count is ${numInitialChunks}`);
         return false;
      }

      console.log(`\nSharding namespace with options: ${tojson(shardedOptions)}`);
      console.log(`with initial chunks: ${numInitialChunks}`);
      try {
         (!serverVer(6.0)) && (sh.enableSharding(dbName).ok);
         sh.shardCollection(
            `${dbName}.${collName}`,
            shardedOptions.key,
            shardedOptions.unique,
            {
               "numInitialChunks": numInitialChunks,
               "collation": collation,
               // "timeseries": {}
            }
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

   function shardKeyHasMetaField() {
      const meta = tsOptions.metaField;
      return Object.keys(shardedOptions.key).some(field =>
         field === meta || field.startsWith(`${meta}.`)
      );
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

   // A time series collection cannot be capped. Time series keeps its own checks.
   // A capped collection cannot be sharded, so this run leaves it unsharded.
   function cappedThisRun() {
      return !!(capped && !timeSeries);
   }

   function shardThisRun() {
      return sharding && isSharded() && !cappedThisRun();
   }

   function collectionPlan() {
      const willShard = shardThisRun();
      const reasons = [];
      if (timeSeries && !fCV(5.0))
         reasons.push('time series requires fCV 5.0 or newer');
      if (timeSeries && isAtlasPlatform('serverless'))
         reasons.push('time series is not available on serverless');
      if (timeSeries)
         timeSeriesSchemaProblems(willShard).forEach(reason => reasons.push(reason));
      if (timeSeries && willShard && tsOptions.metaField && !shardKeyHasMetaField())
         reasons.push(`time series shard key must include metaField "${tsOptions.metaField}"`);
      if (willShard && collation.locale !== 'simple')
         reasons.push('a non-simple collation on the hashed shard key conflicts with the simple hashed index');
      if (willShard) {
         try {
            const chunks = initialChunkCount();
            if (!(chunks >= 1))
               reasons.push(`initial chunk count is ${chunks}`);
         } catch(e) {
            reasons.push(`config.shards is unreadable: ${errText(e)}`);
         }
      }
      return reasons;
   }

   function createNS() {
      if (namespace.exists()) {
         console.log(`\nNamespace "${dbName}.${collName}" exists`);
         if (!shardThisRun())
            return true;
         return shardPreservedNamespace();
      } else {
         let [blockCompressor, msg] = parseCompressor(compressor);
         console.log(`Creating namespace "${dbName}.${collName}"`);
         console.log(`\twith block compressor:\t"${blockCompressor}" ${msg}`);
         console.log(`\twith collation locale:\t"${collation.locale}"`);
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
            console.log(`\twith capped options:\t"${tojson(cappedOptions)}"`);
         }
         if (timeSeries && fCV(5.0) && !isAtlasPlatform('serverless')) {
            options.timeSeries = tsOptions;
            console.log(`\twith time series options: ${tojson(tsOptions)}`);
            options.expireAfterSeconds = expireAfterSeconds;
            console.log(`\twith TTL options:\t"${expireAfterSeconds}"`);
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

   function indexBuildMessage(result, label) {
      // mongosh createIndexes resolves to the index names. A failure throws.
      const names = Array.isArray(result) ? result.join(',') : result;
      return `${label} completed with results:\t${names}`;
   }

   function createIndexSet(keys, options, label, heading) {
      const useCommitQuorum = fCV(4.4) && (isReplSet() || isSharded());
      const quorum = useCommitQuorum ? indexPrefs.commitQuorum : 'disabled';
      console.log(heading(quorum));
      keys.forEach(index => console.log(`\tkey: ${tojson(index)}`));
      const args = useCommitQuorum
         ? [keys, options, indexPrefs.commitQuorum]
         : [keys, options];
      try {
         console.log(indexBuildMessage(namespace.createIndexes(...args), label));
      } catch(e) {
         console.log(`[red][ERROR][/] ${label} operation failed:`, errText(e));
      }
   }

   function dropExistingIndexes() {
      if (!dropIndexes || !namespace.exists())
         return;
      const secondary = namespace.getIndexes().filter(index => index.name !== '_id_');
      if (secondary.length === 0)
         return;
      console.log('\nDropping all existing indexes:');
      namespace.dropIndexes();
   }

   function buildIndexes() {
      if (indexPrefs.build) {
         if (indexes.length > 0) {
            createIndexSet(indexes, indexOptions, 'Indexing', (quorum) =>
               `\nBuilding ${plural(indexes.length, 'index', 'indexes')} with collation locale "${collation.locale}" with commit quorum "${quorum}":`
            );
         } else
            console.log('No regular index builds specified.');

         const specialSets = [
            [hashedIndexes, hashedIndexOptions, (quorum) =>
               `\nBuilding hashed ${plural(hashedIndexes.length, 'index', 'indexes')} with collation locale "simple" with commit quorum "${quorum}":`],
            [indexes2d, indexes2dOptions, (quorum) =>
               `\nBuilding 2d ${plural(indexes2d.length, 'index', 'indexes')} with default language "${idioma}" with commit quorum "${quorum}":`],
            [textIndexes, textIndexOptions, (quorum) =>
               `\nBuilding text ${plural(textIndexes.length, 'index', 'indexes')} with default language "${idioma}" with commit quorum "${quorum}":`]
         ].filter(([keys]) => keys.length > 0);
         if (specialSets.length > 0) {
            specialSets.forEach(([keys, options, heading]) => {
               createIndexSet(keys, options, 'Special indexing', heading);
            });
         } else
            console.log('\nNo special index builds specified.');

      } else
         console.log('\nBuilding indexes: "false"');

      return;
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

   // User async: the rewriter does not await this at the call, so the next batch
   // can be built while this insert is in flight. A short batch is awaited first.
   async function insertBatch(docs) {
      // mongosh Bulk.execute ignores its writeConcern argument.
      return namespace.insertMany(docs, {
         "ordered": false,
         "writeConcern": writeConcern
      });
   }

   async function takeBatch(n, overlap) {
      const docs = [];
      for (let i = 0; i < n; i++) {
         docs.push(genDocument(fuzzer, timestamp));
         if (overlap)
            await yieldNow();
      }
      return docs;
   }

   async function genBulk(batchSize) {
      if (!(batchSize >= 1)) {
         console.log(`\n[Warning] Batch size ${batchSize} is below 1. Skipping bulk insert.`);
         return true;
      }
      const batches = $ceil(totalDocs / batchSize);
      console.log(`\nSpecified date range time series:\n\tfrom:\t\t${new Date(now + fuzzer.offset * 86400000).toISOString()}\n\tto:\t\t${new Date(now + (fuzzer.offset + fuzzer.range) * 86400000).toISOString()}\n\tdistribution:\t${fuzzer.distribution}\n\nGenerating ${totalDocs} ${plural(totalDocs, 'document', 'documents')} in ${batches} ${plural(batches, 'batch', 'batches')}:`);
      let inserted = 0;
      let remaining = totalDocs;
      let batchNo = 0;
      const nextBatch = async overlap => {
         if (!(remaining > 0))
            return null;
         const n = Math.min(batchSize, remaining);
         remaining -= n;
         return { n, docs: await takeBatch(n, overlap) };
      };

      let prepared = await nextBatch(false);
      while (prepared) {
         // Catch immediately so a rejection during the next batch is not unhandled.
         let writeError = null;
         const inflight = insertBatch(prepared.docs).catch(err => {
            writeError = err;
            return null;
         });
         const n = prepared.n;
         batchNo++;
         try {
            prepared = await nextBatch(true);
         } catch(e) {
            await inflight;
            throw e;
         }
         const result = await inflight;
         const bInserted = writeError
            ? insertedFromWrite(writeError)
            : Object.keys((result && result.insertedIds) || {}).length;
         inserted += bInserted;
         console.log(`\t[Batch ${batchNo}/${batches}] bulk inserted ${bInserted} ${plural(bInserted, 'document', 'documents')}`);
         if (writeError || bInserted < n) {
            const shortfall = totalDocs - inserted;
            console.log(`\n[red][ERROR][/] Bulk insert stopped after ${inserted} of ${totalDocs} documents (${shortfall} short)`);
            if (writeError)
               console.log(errText(writeError));
            return false;
         }
      }

      console.log('Generation completed.');
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
