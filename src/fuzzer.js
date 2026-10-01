/*
 *  Name: "fuzzer.js"
 *  Version: "0.13.1"
 *  Description: "pseudorandom data generator, with some fuzzing capability"
 *  Disclaimer: "https://raw.githubusercontent.com/tap1r/mongodb-scripts/master/DISCLAIMER.md"
 *  Authors: ["tap1r <luke.prochazka@gmail.com>"]
 *
 *  Dual-shell snapshot: legacy/mongo-shell (v0.6.43). This file is mongosh-only.
 */

// Usage: mongosh [connection options] [--quiet] [-f|--file] </path/to/>fuzzer.js

/*
 *  Load helper mdblib.js (https://github.com/tap1r/mongodb-scripts/blob/master/src/mdblib.js)
 *  Save libs to the $MDBLIB or other valid search path
 */

(() => {
   const __script = { "name": "fuzzer.js", "version": "0.13.1" };
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
    *  User defined parameters
    */

   const dbName = 'database',       // database name
      collName = 'collection',      // collection name
      totalDocs = $getRandExp(3.5), // number of documents to generate per namespace
      dropNamespace = false,        // drop collection prior to generating data
      dropIndexes = false,          // recreate indexes to update creation options
      compressor = 'best',          // collection block compressor ['none'|'snappy'|'zlib'|'zstd'|'default'|'best']
      idxCompressor = 'default',    // index prefix compressor ['none'|'snappy'|'zlib'|'zstd'|'default'|'best']
      // compressionOptions = -1,   // [-1|0|1|2|3|4|5|6|7|8] compression level
      idioma = 'en',                // ['en'|'es'|'de'|'fr'|'zh']
      collation = { /* collation options */
         "locale": "simple",        // ["simple"|"en"|"es"|"de"|"fr"|"zh"]
         // caseLevel: <boolean>,
         // caseFirst: <string>,
         // strength: <int>,
         // numericOrdering: <boolean>,
         // alternate: <string>,
         // maxVariable: <string>,
         // backwards: <boolean>
      },
      writeConcern = {
         "w": (isReplSet() || isSharded()) ? "majority" : 1,
         "j": false
      };
   const indexPrefs = { /* build index preferences */
         "build": true,   // [true|false]
         "order": "post", // ["pre"|"post"] collection population
         "commitQuorum": (writeConcern.w == 0) ? 1 : writeConcern.w
      },
      timeSeries = false, // build timeseries collection type
      tsOptions = {
         "timeField": "timestamp",
         "metaField": "data",
         "granularity": "hours"
      },
      capped = false, // build capped collection type
      cappedOptions = {
         "size": Math.pow(2, 27),
         "max": Math.pow(2, 27) / Math.pow(2, 12)
      },
      expireAfterSeconds = 0,        // TTL and time series options
      fuzzer = { /* preferences */
         "id": "ts",                // ["ts"|"oid"] - timeseries OID | client generated OID
         "range": 365.2422,         // date range in days
         "offset": -300,            // date offset in days from now() (negative = past, positive = future)
         "interval": 7,             // date interval in days
         "distribution": "uniform", // ["uniform"|"normal"|"bimodal"|"pareto"|"exponential"]
         // "polymorphic": { /* experimental */
            // "enabled": false,
            // "varyTypes": false,    // fuzz BSON types
            // "nests": 0,            // nested subdocs
            // "entropy": 100,        // 0-100%
            // "cardinality": 1,      // ratio:1
            // "sparsity": 0,         // 0-100%
            // "weighting": 50        // 0-100%
         // },
         "schemas": [],
         "ratios": [7, 2, 1]
      };
   const sharding = true,
      shardedOptions = {
         "key": {
            "string": "hashed"
            // "date": 1
         },
         "unique": false, // resharding a collection that has a uniqueness constraint is not supported
         "numInitialChunksPerShard": 2,
         // "collation": collation,  // inherit from collection options
         // "timeseries": tsOptions, // not required after initial collection creation
         "reShard": true
      };
   const indexes = [ /* index definitions */
         { "date": -1 },
         { "language": 1, "schema": 1 },
         { "random": 1 },
         { "array": 1 },
         { "timestamp": -1 },
         { "location": "2dsphere" },
         // { "lineString": "2dsphere" },
         // { "polygon": "2dsphere" },
         // { "polygonMulti": "2dsphere" },
         // { "multiPoint": "2dsphere" },
         // { "multiLineString": "2dsphere" },
         // { "multiPolygon": "2dsphere" },
         // { "geoCollection": "2dsphere" },
         fCV(4.2) ? { "object.$**": 1 } : { "object.oid": 1 }
      ],
      indexOptions = { /* createIndexes options */
         // "background": fCV(4.0) ? true : false,
         // "background": true,
         // "unique": false,
         // "partialFilterExpression": { "$exists": true },
         // "sparse": true,
         // "expireAfterSeconds": expireAfterSeconds,
         // "hidden": hidden,
         "collation": collation
      },
      hashedIndexes = [
         { "string": "hashed" }
      ],
      hashedIndexOptions = { /* hashed accepts simple collation only */
         // "background": fCV(4.0) ? true : false,
         // "background": true,
         // "unique": false,
         // "partialFilterExpression": { "$exists": true },
         // "sparse": true,
         // "expireAfterSeconds": expireAfterSeconds,
         // "hidden": hidden,
         "collation": { "locale": "simple" }
      },
      indexes2d = [
         { "location.coordinates": "2d" }
      ],
      indexes2dOptions = { /* 2d rejects a collation field */
         // "background": fCV(4.0) ? true : false,
         // "background": true,
         // "unique": false,
         // "partialFilterExpression": { "$exists": true },
         // "sparse": true,
         // "expireAfterSeconds": expireAfterSeconds,
         // "hidden": hidden,
         // Kept so a re-run matches the 2d index built when one options
         // document was copied onto every special key.
         "default_language": idioma
      },
      textIndexes = [
         { "quote.txt": "text" }
      ],
      textIndexOptions = { /* text rejects a collation field */
         // "background": fCV(4.0) ? true : false,
         // "background": true,
         // "unique": false,
         // "partialFilterExpression": { "$exists": true },
         // "sparse": true,
         // "expireAfterSeconds": expireAfterSeconds,
         // "hidden": hidden,
         "default_language": idioma
      };
   if (idxCompressor != 'default') {
      const configString = `block_compressor=${parseCompressor(idxCompressor)[0]}`;
      indexOptions.storageEngine = { "wiredTiger": { "configString": configString } };
      hashedIndexOptions.storageEngine = { "wiredTiger": { "configString": configString } };
      indexes2dOptions.storageEngine = { "wiredTiger": { "configString": configString } };
      textIndexOptions.storageEngine = { "wiredTiger": { "configString": configString } };
   }

   /*
    *  Global defaults
    */

   const database = db.getSiblingDB(dbName);
   const namespace = database.getCollection(collName);
   const now = new Date().getTime();
   const timestamp = $floor(now / 1000);
   const ratioSum = fuzzer.ratios.reduce((n, ratio) => n + parseInt(ratio), 0);
   const sampleSize = (8 + ratioSum) ** 2;

   function plural(n, one, many) {
      return (n === 1) ? one : many;
   }

   function errText(e) {
      return e.errmsg || e.message || String(e);
   }

   async function main() {
      /*
       *  main
       */
      // Do not Mongo.setReadPref(): mongosh reconnects and the next
      // DB call (exists/drop/create) hangs or rejects on a local RS.
      const plan = collectionPlan();
      if (plan.length > 0) {
         plan.forEach(reason => console.log(`\n[red][ERROR][/] ${reason}`));
         return;
      }

      console.log(`\nSynthesising ${totalDocs} ${plural(totalDocs, 'document', 'documents')}`);

      // sampling synthetic documents and estimating batch size
      let docSize = 0, maxSize = 0;
      for (let i = 0; i < sampleSize; i++) {
         const size = bsonsize(genDocument(fuzzer, timestamp));
         docSize += size;
         if (size > maxSize)
            maxSize = size;
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

      // (re)create the namespace
      dropNS();
      if (!createNS())
         return;

      dropExistingIndexes();

      // set collection/index build order, generate and bulk write the documents, create indexes
      console.log(`\nIndex build order preference "${indexPrefs.order}"`);
      switch (indexPrefs.order.toLowerCase()) {
         case 'pre':
            console.log('Building indexing metadata first');
            buildIndexes();
            genBulk(batchSize);
            break;
         case 'post':
            console.log('Populating collection first');
            genBulk(batchSize);
            buildIndexes();
            break;
         default:
            console.log(`Unsupported index build preference "${indexPrefs.order}": defaulting to "post"`);
            genBulk(batchSize);
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

   function genDocument({
         id = 'ts', range = 365.2422, offset = -300, interval = 7,
         distribution = 'uniform', /* schemas = [], */ ratios = [1] } = {},
         timestamp) {
      /*
       *  generate pseudo-random key values
       */
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
         default:
            console.log(`\nUnsupported distribution type: ${distribution}\nDefaulting to "uniform"`);
            secondsOffset = +$floor($getRandNum(offset, offset + range) * day);
      }
      let oid;
      switch (id.toLowerCase()) {
         case 'oid':
            oid = new ObjectId();
            break;
         default: // the 'ts' option
            oid = new ObjectId( // employ native mongosh method
               $floor(timestamp + secondsOffset).toString(16) +
               $genRandHex(16)
            );
      }
      const date = new Date(now + secondsOffset * 1000);
      const ts = new Timestamp({ "t": timestamp + secondsOffset, "i": 0 });
      let schemas = new Array();
      schemas.push({
         "_id": oid,
         "schema": {
            "type": "A",
            "version": 1.0,
            "comment": "General purpose schema"
         },
         "language": idioma,
         "string": $genRandStr($getRandIntInc(6, 24)), // hashed shard key
         "quote": {
            "language": idiomas[
               $getRandRatioInt([80, 0, 0, 5, 0, 3, 2])
            ],
            // "txt": (() => {
            //    const lines = $getRandIntInc(2, 512);
            //    let string = '';
            //    for (let line = 0; line < lines; line++) {
            //       string += `${$genRandStr($getRandIntInc(8, 24)) + $genRandSymbol()}`;
            //    }
            //    return string;
            // })()
         },
         "object": {
            "oid": oid,
            "str": $genRandAlpha($getRandIntInc(8, 16)),
            "num": +$getRandNum(
               -Math.pow(2, 12),
               Math.pow(2, 12)
            ).toFixed(4),
            "nestedArray": [$genArrayElements($getRandIntInc(0, 10))]
         },
         "array": $genArrayElements($getRandIntInc(0, 10)),
         // "objectArray": [
         //    { "nestedArray": $genArrayElements($getRandIntInc(0, 10)) }
         // ],
         // "1dArray": [
         //    { "2dArray": $genArrayElements($getRandIntInc(1, 10)) }
         // ],
         "boolean": $bool(),
         // "code": Code('() => {}'),
         // "codeScoped": Code('() => {}', {}),
         "date": date,
         "dateString": date.toISOString(),
         "timestamp": ts,
         "null": null,
         "int32": $NumberInt(
            $getRandIntInc(int32MinVal, int32MaxVal)
         ),
         "int64": $NumberLong(
            $getRandIntInc(int64MinVal, int64MaxVal)
         ),
         "double": $getRandNum(
            -Math.pow(2, 12), Math.pow(2, 12)
         ),
         "decimal128": $NumberDecimal(
            $getRandNum(dec128MinVal, dec128MaxVal)
         ),
         "regex": $getRandRegex(),
         "bin": BinData(0, UUID().base64()),
         "uuid": UUID(),
         "md5": MD5($genRandHex(32)),
         "fle": BinData(6, UUID().base64()),
         // "columnStore": fCV(5.2)
         //              ? BinData(7, $getRandIntInc(0, Math.pow(10, 4)),
         //                {
         //                   "unit": +$getRandNum(0, Math.pow(10, 6)).toFixed(2),
         //                   "qty": $getRandIntInc(0, Math.pow(10, 4)),
         //                   "price": [
         //                      +$getRandNum(0, Math.pow(10, 4)).toFixed(2),
         //                      $genRandCurrency()
         //                   ]
         //                })
         //              : 'requires v5.2+',
         // "sensitive": fCV(7.0)
         //            ? BinData(8, window.crypto.subtle.generateKey(
         //                {
         //                   "name": "HMAC",
         //                   "hash": { "name": "SHA-512" },
         //                },
         //                true,
         //                ["sign", "verify"],
         //                ))
         //            : 'requires v7.0+',
         "random": +$getRandNum(0, totalDocs).toFixed(4),
         "symbol": $genRandSymbol(),
         "credit card": $genRandCardNumber()
      });
      schemas.push({
         "_id": oid,
         "schema": {
            "type": "B",
            "version": 1.0,
            "comment": "Time series schema"
         },
         "language": idioma,
         "string": $genRandStr($getRandIntInc(6, 24)), // hashed shard key
         "timeField": date,
         "metaField": [
            'Series 1',
            'Series 2',
            'Series 3'
         ][$getRandRatioInt([70, 20, 10])],
         "granularity": "hours",
         "unit": +$getRandNum(0, Math.pow(10, 6)).toFixed(2),
         "qty": $getRandIntInc(0, Math.pow(10, 4)),
         "price": [
            +$getRandNum(0, Math.pow(10, 4)).toFixed(2),
            $genRandCurrency()
         ]
      });
      schemas.push({
         "_id": oid,
         "schema": {
            "type": "C",
            "version": 1.0,
            "comment": "GeoJSON schema"
         },
         "language": idioma,
         "string": $genRandStr($getRandIntInc(6, 24)), // hashed shard key
         "temperature": [
            +$genNormal(15, 10).toFixed(1),
            ['K', '°F', '°C'][$getRandIntInc(0, 2)]
         ],
         "dB": +$genNormal(20, 10).toFixed(3),
         "status": [
            'Active',
            'Inactive',
            null
         ][$getRandRatioInt([80, 20, 1])],
         "locality": $getRandCountry()['alpha-3 code'],
         "location": { // GeoJSON Point
            "type": "Point",
            "coordinates": [
               +$getRandNum(-180, 180).toFixed(4),
               +$getRandNum(-90, 90).toFixed(4)
         ] },
         "lineString": { // GeoJSON LineString
            "type": "LineString",
            "coordinates": [[
                  +$getRandNum(-180, 180).toFixed(4),
                  +$getRandNum(-90, 90).toFixed(4)
               ],[
                  +$getRandNum(-180, 180).toFixed(4),
                  +$getRandNum(-90, 90).toFixed(4)
            ]]
         },
         "polygon": { // polygon with a single ring
            "type": "Polygon",
            "coordinates": [[
               [0, 0],
               [$getRandIntInc(0, 10), $getRandIntInc(0, 10)],
               [$getRandIntInc(0, 10), $getRandIntInc(0, 10)],
               [0, 0]
            ]]
         },
         "polygonMulti": { // polygons with multiple rings
            "type": "Polygon",
            "coordinates": [[
                  [0, 0],
                  [$getRandIntInc(0, 10), $getRandIntInc(0, 10)],
                  [$getRandIntInc(0, 10), $getRandIntInc(0, 10)],
                  [0, 0]
               ],[
                  [4, 4],
                  [$getRandIntInc(0, 10), $getRandIntInc(0, 10)],
                  [$getRandIntInc(0, 10), $getRandIntInc(0, 10)],
                  [4, 4]
            ]]
         },
         "multiPoint": { // GeoJSON MultiPoint
            "type": "MultiPoint",
            "coordinates": [
               [-73.9580, 40.8003],
               [-73.9498, 40.7968],
               [-73.9737, 40.7648],
               [-73.9814, 40.7681]
            ]
         },
         "multiLineString": { // GeoJSON MultiLineString
            "type": "MultiLineString",
            "coordinates": [[
                  [-73.96943, 40.78519],
                  [-73.96082, 40.78095]
               ],[
                  [-73.96415, 40.79229],
                  [-73.95544, 40.78854]
               ],[
                  [-73.97162, 40.78205],
                  [-73.96374, 40.77715]
               ],[
                  [-73.97880, 40.77247],
                  [-73.97036, 40.76811]
            ]]
         },
         "multiPolygon": { // GeoJSON MultiPolygon
            "type": "MultiPolygon",
            "coordinates": [[[
                  [-73.958, 40.8003],
                  [-73.9498, 40.7968],
                  [-73.9737, 40.7648],
                  [-73.9814, 40.7681],
                  [-73.958, 40.8003]
               ]],
               [[
                  [-73.958, 40.8003],
                  [-73.9498, 40.7968],
                  [-73.9737, 40.7648],
                  [-73.958, 40.8003]
            ]]]
         },
         "geoCollection": { // GeoJSON GeometryCollection
            "type": "GeometryCollection",
            "geometries": [{
               "type": "MultiPoint",
               "coordinates": [
                  [-73.9580, 40.8003],
                  [-73.9498, 40.7968],
                  [-73.9737, 40.7648],
                  [-73.9814, 40.7681]
               ]
            },{
               "type": "MultiLineString",
               "coordinates": [[
                     [-73.9694, 40.7851],
                     [-73.9608, 40.7809]
                  ],[
                     [-73.9641, 40.7922],
                     [-73.9554, 40.7885]
                  ],[
                     [-73.9716, 40.7820],
                     [-73.9637, 40.7771]
                  ],[
                     [-73.9788, 40.7724],
                     [-73.9703, 40.7681]
               ]]
            }]
         }
      });

      return schemas[$getRandRatioInt(ratios)];
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
   const reshardServiceDesc = /^Resharding\w+(Donor|Recipient)Service ([0-9a-fA-F]{8}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{12})$/;

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
      if (!isSharded() || !shardedOptions.reShard)
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
                     "migrationService": { "$arrayElemAt": ["$migration.captures", 0] },
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
      const reshardPromise = resharding().finally(() => { done = true; });
      sleep(3 * pollIntervalMS); // allow $currentOp to publish the initial donor/recipient ops
      while (!done) {
         const ops = rebalancingOps();
         if (ops.length > 0) {
            console.clear();
            console.log(`\nMonitoring resharding operations:\n`);
            printjson(...ops);
         }
         sleep(pollIntervalMS);
      }
      await reshardPromise;
      if (reshardOk)
         console.log(`\nResharding complete.`);
   }

   function shardKeyHasMetaField() {
      const meta = tsOptions.metaField;
      return Object.keys(shardedOptions.key).some(field =>
         field === meta || field.startsWith(`${meta}.`)
      );
   }

   function collectionPlan() {
      const mongos = isSharded();
      const reasons = [];
      if (capped && timeSeries)
         reasons.push('capped and time series cannot be combined');
      if (capped && sharding)
         reasons.push('capped and sharding cannot be combined');
      if (timeSeries && sharding && !shardKeyHasMetaField())
         reasons.push(`time series shard key must include metaField "${tsOptions.metaField}"`);
      if (timeSeries)
         reasons.push(`time series requires timeField "${tsOptions.timeField}" as a Date and metaField "${tsOptions.metaField}"; the generated schemas do not provide them`);
      if (sharding && mongos && collation.locale !== 'simple')
         reasons.push('a non-simple collation on the hashed shard key conflicts with the simple hashed index');
      if (sharding && mongos) {
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
         if (!(sharding && isSharded()))
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
         if (capped) {
            options.capped = capped;
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

         if (!(sharding && isSharded()))
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

   function genBulk(batchSize) {
      if (!(batchSize >= 1)) {
         console.log(`\n[Warning] Batch size ${batchSize} is below 1. Skipping bulk insert.`);
         return;
      }
      const batches = $ceil(totalDocs / batchSize);
      console.log(`\nSpecified date range time series:\n\tfrom:\t\t${new Date(now + fuzzer.offset * 86400000).toISOString()}\n\tto:\t\t${new Date(now + (fuzzer.offset + fuzzer.range) * 86400000).toISOString()}\n\tdistribution:\t${fuzzer.distribution}\n\nGenerating ${totalDocs} ${plural(totalDocs, 'document', 'documents')} in ${batches} ${plural(batches, 'batch', 'batches')}:`);
      let remaining = totalDocs;
      for (let i = 0; remaining > 0; i++) {
         const n = Math.min(batchSize, remaining);
         remaining -= n;
         const docs = [];
         for (let batch = 0; batch < n; batch++)
            docs.push(genDocument(fuzzer, timestamp));
         // mongosh Bulk.execute ignores its writeConcern argument.
         const result = namespace.insertMany(docs, {
            "ordered": false,
            "writeConcern": writeConcern
         });
         const bInserted = Object.keys(result.insertedIds || {}).length;
         console.log(`\t[Batch ${1 + i}/${batches}] bulk inserted ${bInserted} ${plural(bInserted, 'document', 'documents')}`);
      }

      console.log('Generation completed.');
      return;
   }

   try {
      await main();
   } catch(e) {
      console.log('[red][ERROR][/]', errText(e));
      throw e;
   }
})();

// EOF
