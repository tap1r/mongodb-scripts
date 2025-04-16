/*
 *  Name: "fuzzer.js"
 *  Version: "0.6.29"
 *  Description: "pseudorandom data generator, with some fuzzing capability"
 *  Disclaimer: "https://raw.githubusercontent.com/tap1r/mongodb-scripts/master/DISCLAIMER.md"
 *  Authors: ["tap1r <luke.prochazka@gmail.com>"]
 */

// Usage: [mongo|mongosh] [connection options] --quiet fuzzer.js

/*
 *  Load helper mdblib.js (https://github.com/tap1r/mongodb-scripts/blob/master/src/mdblib.js)
 *  Save libs to the $MDBLIB or other valid search path
 */

(() => {
   const __script = { "name": "fuzzer.js", "version": "0.6.29" };
   if (typeof __lib === 'undefined') {
      /*
       *  Load helper library mdblib.js
       */
      let __lib = { "name": "mdblib.js", "paths": null, "path": null };
      if (typeof _getEnv !== 'undefined') { // newer legacy shell _getEnv() method
         __lib.paths = [_getEnv('MDBLIB'), `${_getEnv('HOME')}/.mongodb`, '.'];
         __lib.path = `${__lib.paths.find(path => fileExists(`${path}/${__lib.name}`))}/${__lib.name}`;
      } else if (typeof process !== 'undefined') { // mongosh process.env attribute
         __lib.paths = [process.env.MDBLIB, `${process.env.HOME}/.mongodb`, '.'];
         __lib.path = `${__lib.paths.find(path => fs.existsSync(`${path}/${__lib.name}`))}/${__lib.name}`;
      } else {
         print(`[WARN] Legacy shell methods detected, must load ${__lib.name} from the current working directory`);
         __lib.path = __lib.name;
      }
      load(__lib.path);
   }
   let __comment = `#### Running script ${__script.name} v${__script.version}`;
   __comment += ` with ${__lib.name} v${__lib.version}`;
   __comment += ` on shell v${version()}`;
   console.log(`\n\n[yellow]${__comment}[/]`);
   if (shellVer() < serverVer() && typeof process === 'undefined') console.log(`\n[red][WARN] Possibly incompatible legacy shell version detected: ${version()}[/]`);
   if (shellVer() < 1.0 && typeof process !== 'undefined') console.log(`\n[red][WARN] Possible incompatible non-GA shell version detected: ${version()}[/]`);
   if (serverVer() < 4.2) console.log(`\n[red][ERROR] Unsupported mongod/s version detected: ${db.version()}[/]`);
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
         "unique": false,
         "numInitialChunksPerShard": 1,
         // "collation": collation,  // inherit from collection options
         // "timeseries": tsOptions, // not required after initial collection creation
         "reShard": true
      };
   const indexes = [ /* index definitions */
         { "date": -1 },
         { "language": 1, "schema": 1 },
         { "random": 1 },
         { "string": "hashed" },
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
      ];
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
      specialIndexes = [ /* index types unsupported by collations */
         { "location.coordinates": "2d" },
         { "quote.txt": "text" }
      ],
      specialIndexOptions = { /* exceptional index options */
         // "background": fCV(4.0) ? true : false,
         // "background": true,
         // "unique": false,
         // "partialFilterExpression": { "$exists": true },
         // "sparse": true,
         // "expireAfterSeconds": expireAfterSeconds,
         // "hidden": hidden,
         "collation": { "locale": "simple" },
         "default_language": idioma
      };
      if (idxCompressor != 'default') {
         indexOptions.storageEngine = { "wiredTiger": { "configString": `block_compressor=${parseCompressor(idxCompressor)[0]}` } };
         specialIndexOptions.storageEngine = { "wiredTiger": { "configString": `block_compressor=${parseCompressor(idxCompressor)[0]}` } };
      }

   /*
    *  Global defaults
    */

   const namespace = db.getSiblingDB(dbName).getCollection(collName);
   const now = new Date().getTime();
   const timestamp = $floor(now / 1000.0);
   let sampleSize = 8, docSize = 0, totalBatches = 1, residual = 0;

   fuzzer.ratios.forEach(ratio => sampleSize += parseInt(ratio));
   sampleSize *= sampleSize;

   async function main() {
      /*
       *  main
       */
      db.getMongo().setReadPref('primary');
      console.log(`\nSynthesising ${totalDocs} document${(totalDocs === 1) ? '' : 's'}`);

      // sampling synthetic documents and estimating batch size
      for (let i = 0; i < sampleSize; ++i)
         docSize += bsonsize(genDocument(fuzzer, timestamp));

      const avgSize = $floor(docSize / sampleSize);
      if (avgSize > bsonMax * 0.95)
         console.log(`\n[Warning] The average document size of ${avgSize} bytes approaches or exceeeds the BSON max size of ${bsonMax} bytes`);
      console.log(`\nSampling ${sampleSize} document${(sampleSize === 1) ? '' : 's'} each with BSON size averaging ${avgSize} byte${(avgSize === 1) ? '' : 's'}`);
      let batchSize = (() => {
         const sampledSize = $floor(bsonMax * 0.95 / avgSize);
         // return (maxWriteBatchSize < sampledSize) ? maxWriteBatchSize : sampledSize;
         return (1000 < sampledSize) ? 1000 : sampledSize;
      })();
      console.log(`Estimated optimal capacity of ${batchSize} document${(batchSize === 1) ? '' : 's'} per batch`);
      if (totalDocs <= batchSize)
         batchSize = totalDocs;
      else {
         totalBatches += $floor(totalDocs / batchSize);
         residual = $floor(totalDocs % batchSize);
      }

      // (re)create the namespace
      dropNS(dropNamespace, dbName, collName);
      createNS(dbName, collName, compressor, expireAfterSeconds, collation, writeConcern, tsOptions, sharding, shardedOptions, capped, cappedOptions);

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
      if (isSharded() && (shardedOptions.reShard) && fCV(5.0)) {
         const resharding = async() => {
            const numInitialChunks = shardedOptions.numInitialChunksPerShard * db.getSiblingDB('config').getCollection('shards').countDocuments();
            await db.adminCommand({
               "reshardCollection": `${dbName}.${collName}`,
               // The new shard key cannot have a uniqueness constraint
               "key": shardedOptions.key,
               // Resharding a collection that has a uniqueness constraint is not supported
               "unique": shardedOptions.unique,
               "numInitialChunks": numInitialChunks,
               "collation": collation
               // writeConcernMajorityJournalDefault must be true
            });
         };
         const rebalancingOps = () => {
            return db.getSiblingDB('admin').aggregate([
               { "$currentOp": {} },
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
                           "regex": /^(ReshardingDonorService|ReshardingRecipientService) ([0-9a-fA-F]{8}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{12})$/
                        } },
                        0]
               } } } ,
               { "$set": {
                  "migrationService": { "$arrayElemAt": ["$migration.captures", 0] },
                  "migrationId": { "$arrayElemAt": ["$migration.captures", -1] }
               } },
               { "$group": {
                  "_id": {
                     "migrationId": "$migrationId",
                     "namespace": "$ns"
                  },
                  "shards": {
                     "$push": {
                        "shard": "$shard",
                        "migrationService": "$migrationService",
                        "recipientState": "$recipientState",
                        "donorState": "$donorState",
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
                        "cond": { "$eq": ["$$shard.migrationService", "ReshardingDonorService"] }
               } } } },
               { "$set": {
                  "recipients": {
                     "$filter": {
                        "input": "$shards",
                        "as": "shard",
                        "cond": { "$eq": ["$$shard.migrationService", "ReshardingRecipientService"] }
               } } } },
               { "$unset": ["_id", "shards"] }
            ],
            { "comment": "Monitoring resharding progress by fuzzer.js" }).toArray();
         }
         console.log('\nResharding activated...');
         if (typeof process !== 'undefined') {
            resharding();
            sleep(500);
            res = rebalancingOps();
            while (res.length > 0) {
               console.clear();
               console.log(`\nMonitoring resharding operations:\n`);
               if (res.length > 0) printjson(...res);
               sleep(500);
               res = rebalancingOps();
            }
         } else {
            console.log(`\nMonitoring of resharding (via async) operations are not supported in the legacy shell\n`);
            resharding();
         }
         console.log(`\nResharding complete.`);
      }
      else if (isSharded() && (shardedOptions.reShard) && !fCV(5.0)) {
         console.log('\x1b[31m[WARN] \x1b[33mreshardCollection() \x1b[31mrequires v5.0+\x1b[0m');
      }

      return console.log('\n \x1b[32mFuzzing completed!\x1b[0m\n');
   }

   function genDocument({
         id = 'ts', range = 365.2422, offset = -300, interval = 7,
         distribution = 'uniform', schemas = [], ratios = [1] } = {},
         timestamp) {
      /*
       *  generate pseudo-random key values
       */
      let secondsOffset;
      switch (distribution.toLowerCase()) {
         case 'uniform':
            secondsOffset = $floor($getRandNum(offset, offset + range) * 86400);
            break;
         case 'normal': // genNormal(mu, sigma)
            secondsOffset = $floor($genNormal(offset + (range / 2), range / 2) * 86400);
            break;
         case 'bimodal': // not implemented yet
            // secondsOffset = $floor($getRandNum(offset, offset + range) * 86400);
            // break;
         case 'pareto': // not implemented yet
            // $genRandIncPareto(min, alpha = 1.161) {}
            // secondsOffset = $floor($genRandIncPareto(offset + range) * 86400);
            // break;
         case 'exponential': // not implemented yet
            // $getRandExp();
            // secondsOffset = $floor($getRandExp(offset, offset + range, 128) * 86400);
            // break;
         default:
            console.log(`\nUnsupported distribution type: ${distribution}\nDefaulting to "uniform"`);
            secondsOffset = +$floor($getRandNum(offset, offset + range) * 86400);
      }
      let oid;
      switch (id.toLowerCase()) {
         case 'oid':
            oid = new ObjectId();
            break;
         default: // the 'ts' option
            oid = new ObjectId( // employ native mongosh method
               Math.floor(timestamp + secondsOffset).toString(16) +
               $genRandHex(16)
            );
      }
      const date = new Date(now + secondsOffset * 1000);
      const ts = (typeof process !== 'undefined') // MONGOSH-930
             ? new Timestamp({ "t": timestamp + secondsOffset, "i": 0 })
             : new Timestamp(timestamp + secondsOffset, 0);
      schemas = new Array();
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
            //    for (let line = 0; line < lines; ++line) {
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
         /* "columnStore": fCV(5.2)
                         ? BinData(7, $getRandIntInc(0, Math.pow(10, 4)),
                           {
                              "unit": +$getRandNum(0, Math.pow(10, 6)).toFixed(2),
                              "qty": $getRandIntInc(0, Math.pow(10, 4)),
                              "price": [
                                 +$getRandNum(0, Math.pow(10, 4)).toFixed(2),
                                 $genRandCurrency()
                              ]
                           })
                         : 'requires v5.2+', */
         /* "sensitive": fCV(7.0)
                         ? BinData(8, await window.crypto.subtle.generateKey(
                           {
                              "name": "HMAC",
                              "hash": { "name": "SHA-512" },
                           },
                           true,
                           ["sign", "verify"],
                           ))
                         : 'requires v7.0+', */
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

   function dropNS(dropNamespace = false, dbName = false, collName = false, msg = '') {
      /*
       *  drop target namespace
       */
      if (dropNamespace && !!dbName && !!collName) {
         msg = `\nDropping namespace "${dbName}.${collName}"\n`;
         db.getSiblingDB(dbName).getCollection(collName).drop();
      } else if (!dropNamespace && !namespace.exists()) {
         msg = `\nNominated namespace "${dbName}.${collName}" does not exist\n`;
      } else
         msg = `\nPreserving existing namespace "${dbName}.${collName}"`;

      return console.log(msg);
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

   function createNS(
         dbName = false, collName = false,
         compressor = 'best', expireAfterSeconds = 0,
         collation = { "locale": "simple" }, writeConcern,
         tsOptions = {
            "timeField": "timestamp",
            "metaField": "data",
            "granularity": "hours"
         },
         sharding = false,
         shardedOptions = {
            "key": {},
            "unique": false,
            "numInitialChunksPerShard": 1,
            // "timeseries": {},
            "reshard": false
         },
         capped = false, cappedOptions = {},
         msg = ''
      ) {
      if (db.getSiblingDB(dbName).getCollection(collName).exists()) {
         console.log(`\nNamespace "${dbName}.${collName}" exists`);
      } else {
         [compressor, msg] = parseCompressor(compressor);
         console.log(`Creating namespace "${dbName}.${collName}"`);
         console.log(`\twith block compressor:\t"${compressor}" ${msg}`);
         console.log(`\twith collation locale:\t"${collation.locale}"`);
         let options = {
            "storageEngine": {
               "wiredTiger": {
                  "configString": `block_compressor=${compressor}`
            } },
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
            db.getSiblingDB(dbName).createCollection(collName, options);
         } catch(e) {
            console.log('\nNamespace creation failed:', e);
         }

         if (sharding && isSharded() && db.getSiblingDB(dbName).getCollection(collName).exists()) {
            console.log(`\nSharding namespace with options: ${tojson(shardedOptions)}`);
            const numInitialChunks = shardedOptions.numInitialChunksPerShard * db.getSiblingDB('config').getCollection('shards').countDocuments({});
            console.log(`with initial chunks: ${numInitialChunks}`);
            try {
               (serverVer() < 6.0) && (sh.enableSharding(dbName).ok);
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
               // console.log(`enable balancing`);
               sh.enableBalancing(`${dbName}.${collName}`);
               (serverVer() < 6.0) && (sh.enableAutoSplit());
               sh.startBalancer();
            }
            catch(e) {
               console.log('Sharding namespace failed:', e);
            }
         }
      }

      return;
   }

   function buildIndexes() {
      if (dropIndexes) {
         console.log('\nDropping all existing indexes:');
         namespace.dropIndexes();
      }
      if (indexPrefs.build) {
         if (indexes.length > 0) {
            console.log(`\nBuilding index${(indexes.length === 1) ? '' : 'es'} with collation locale "${collation.locale}" with commit quorum "${(fCV(4.4) && (isReplSet() || isSharded())) ? indexPrefs.commitQuorum : 'disabled'}":`);
            indexes.forEach(index => console.log(`\tkey: ${tojson(index)}`));
            const indexing = () => {
               const options = (fCV(4.4) && (isReplSet() || isSharded()))
                             ? [indexes, indexOptions, indexPrefs.commitQuorum]
                             : [indexes, indexOptions];

               return namespace.createIndexes(...options);
            }
            const idxResult = indexing();
            const idxMsg = () => {
               if (typeof idxResult.errmsg !== 'undefined')
                  return `Indexing operation failed: ${idxResult.errmsg}`;
               else if (typeof idxResult.note !== 'undefined') 
                  return `Indexing completed with note: ${idxResult.note} with ${idxResult.numIndexesAfter - idxResult.numIndexesBefore} index changes.`;
               else if (typeof idxResult.ok !== 'undefined')
                  return 'Indexing completed!';
               else if (typeof idxResult.msg !== 'undefined')
                  return `Indexing build failed with message: ${idxResult.msg}`;
               else
                  return `Indexing completed with results:\t${idxResult}`;
            }
            console.log(idxMsg());
         } else
            console.log('No regular index builds specified.');
         if (specialIndexes.length > 0) {
            console.log(`\nBuilding exceptional index${(specialIndexes.length === 1) ? '' : 'es'} (no collation support) with commit quorum "${(fCV(4.4) && (isReplSet() || isSharded())) ? indexPrefs.commitQuorum : 'disabled'}":`);
            specialIndexes.forEach(index => console.log(`\tkey: ${tojson(index)}`));
            const sIndexing = () => {
               const sOptions = (fCV(4.4) && (isReplSet() || isSharded()))
                            ? [specialIndexes, specialIndexOptions, indexPrefs.commitQuorum]
                            : [specialIndexes, specialIndexOptions];

               return namespace.createIndexes(...sOptions);
            }
            const sIdxResult = sIndexing();
            const sidxMsg = () => {
               if (typeof sIdxResult.errmsg !== 'undefined')
                  return `Special indexing operation failed: ${sIdxResult.errmsg}`;
               else if (typeof sIdxResult.note !== 'undefined')
                  return `Special indexing completed with note: ${sIdxResult.note} with ${sIdxResult.numIndexesAfter - sIdxResult.numIndexesBefore} index changes.`;
               else if (typeof sIdxResult.ok !== 'undefined')
                  return 'Special indexing completed!';
               else if (typeof sIdxResult.msg !== 'undefined')
                  return `Special indexing build failed with message: ${sIdxResult.msg}`;
               else
                  return `Special indexing completed with results:\t${sIdxResult}`;
            }
            console.log(sidxMsg());
         } else
            console.log('\nNo special index builds specified.');
      } else
         console.log('\nBuilding indexes: "false"');

      return;
   }

   function genBulk(batchSize) {
      console.log(`\nSpecified date range time series:\n\tfrom:\t\t${new Date(now + fuzzer.offset * 86400000).toISOString()}\n\tto:\t\t${new Date(now + (fuzzer.offset + fuzzer.range) * 86400000).toISOString()}\n\tdistribution:\t${fuzzer.distribution}\n\nGenerating ${totalDocs} document${(totalDocs === 1) ? '' : 's'} in ${totalBatches} batch${(totalBatches === 1) ? '' : 'es'}:`);
      for (let i = 0; i < totalBatches; ++i) {
         if (i == totalBatches - 1 && residual > 0) batchSize = residual;
         const bulk = namespace.initializeUnorderedBulkOp();
         for (let batch = 0; batch < batchSize; ++batch) bulk.insert(genDocument(fuzzer, timestamp))
         const result = bulk.execute(writeConcern);
         const bInserted = (typeof process !== 'undefined') ? result.insertedCount : result.nInserted;
         console.log(`\t[Batch ${1 + i}/${totalBatches}] bulk inserted ${bInserted} document${(bInserted === 1) ? '' : 's'}`);
      }

      return console.log('Generation completed.');
   }

   await main();
})();

// EOF
