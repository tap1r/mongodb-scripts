/*
 *  Name: "fuzzer.js"
 *  Version: "0.4.2"
 *  Description: pseudorandom data generator, with some fuzzing capability
 *  Authors: ["tap1r <luke.prochazka@gmail.com>"]
 */

// Usage: "[mongo|mongosh] [connection options] --quiet fuzzer.js"

/*
 *  Load helper pcg-xsh-rr.js (https://github.com/tap1r/mongodb-scripts/blob/master/src/pcg-xsh-rr.js)
 *  Load helper mdblib.js (https://github.com/tap1r/mongodb-scripts/blob/master/src/mdblib.js)
 *  Save libs to the $MDBLIB or other valid search path
 */

const __script = { "name": "fuzzer.js", "version": "0.4.2" };
let __comment = '\n Running script ' + __script.name + ' v' + __script.version;
if (typeof __lib === 'undefined') {
    /*
     *  Load helper library mdblib.js
     */
    let __lib = { "name": "mdblib.js", "paths": null, "path": null };
    if (typeof _getEnv !== 'undefined') { // newer legacy shell _getEnv() method
        __lib.paths = [_getEnv('MDBLIB'), _getEnv('HOME') + '/.mongodb', '.'];
        __lib.path = __lib.paths.find(path => fileExists(path + '/' + __lib.name)) + '/' + __lib.name;
    } else if (typeof process !== 'undefined') { // mongosh process.env[] method
        __lib.paths = [process.env.MDBLIB, process.env.HOME + '/.mongodb', '.'];
        __lib.path = __lib.paths.find(path => fs.existsSync(path + '/' + __lib.name)) + '/' + __lib.name;
    } else {
        print('\n\t[WARN] Legacy shell methods detected, must load', __lib.name, 'from the current working directory');
        __lib.path = __lib.name;
    }

    load(__lib.path);
}

__comment += ' with ' + __lib.name + ' v' + __lib.version;
print(__comment);

/*
 *  User defined parameters
 */

let dbName = 'database',            // database name
    collName = 'collection',        // collection name
    totalDocs = $getRandomExp(4),   // number of documents to generate per namespace
    dropPref = false,               // drop collection prior to generating data
    compressor = 'best',            // ["none"|"snappy"|"zlib"|"zstd"|"default"|"best"]
    // compressionOptions = -1,     // compression level
    idioma = 'en',                  // ["en"|"es"|"de"|"fr"|"zh"]
    collation = {   /* colleation options */
        "locale": "simple",          // ["simple"|"en"|"es"|"de"|"fr"|"zh"]
        // caseLevel: <boolean>,
        // caseFirst: <string>,
        // strength: <int>,
        // numericOrdering: <boolean>,
        // alternate: <string>,
        // maxVariable: <string>,
        // backwards: <boolean>
    },
    writeConcern = (isReplSet())
               ? { "w": "majority", "j": true }
               : { "w": 1, "j": true },
    indexPrefs = {  /* build index preferences */
        "build": true,              // [true|false]
        "order": "post",            // [pre|post] collection population
        "commitQuorum": (writeConcern.w === 0)
                      ? 1
                      : writeConcern.w
    },
    timeSeries = false,             // build time series collection type
    tsOptions = {
        "timeField": "timestamp",
        "metaField": "data",
        "granularity": "hours"
    },
    expireAfterSeconds = 0,         // TTL and time series options
    fuzzer = {  /* preferences */
        "_id": "ts",                // ["ts"|"oid"] - timeseries OID | client generated OID
        "range": 365.2422,          // date range in days
        "offset": -300,             // date offset in days from now() (neg = past, pos = future)
        "distribution": "uniform",  // ["uniform"|"normal"|"bimodal"|"pareto"|"exponential"]
        "polymorphic": { /* experimental */
            "enabled": false,
            // "varyTypes": false,     // fuzz types
            // "nests": 0,             // nested subdocs
            // "entropy": 100,         // 0 - 100%
            // "cardinality": 1,       // ratio:1
            // "sparsity": 0,          // 0 - 100%
            // "weighting": 50         // 0 - 100%
        },
        "schemas": [],
        "ratios": [7, 2, 1]
    },
    namespace = db.getSiblingDB(dbName).getCollection(collName),
    sampleSize = 9,
    docSize = 0;

fuzzer.ratios.forEach(ratio => sampleSize += parseInt(ratio));
sampleSize *= sampleSize;
let indexes = [ /* index definitions */
    { "date": 1 },
    { "language": 1, "schema": 1 },
    { "random": 1 },
    { "string": "hashed" },
    { "array": 1 },
    { "timestamp": 1 },
    { "location": "2dsphere" },
    { "lineString": "2dsphere" },
    { "polygon": "2dsphere" },
    { "polygonMulti": "2dsphere" },
    { "multiPoint": "2dsphere" },
    { "multiLineString": "2dsphere" },
    { "multiPolygon": "2dsphere" },
    { "geoCollection": "2dsphere" },
    fCV(4.2) ? { "object.$**": 1 } : { "object.oid": 1 }
];
let indexOptions = {    /* createIndexes options */
    "background": fCV(4.0) ? true : false,
    // "unique": false,
    // "partialFilterExpression": { "$exists": true },
    // "sparse": true,
    // "expireAfterSeconds": expireAfterSeconds,
    // "hidden": hidden,
    "collation": collation
};
let specialIndexes = [  /* index types unsupported by collations */
    { "location.coordinates": "2d" },
    { "quote.txt": "text" }
];
let specialIndexOptions = { /* exceptional index options */
    "background": fCV(4.0) ? true : false,
    // "unique": false,
    // "partialFilterExpression": { "$exists": true },
    // "sparse": true,
    // "expireAfterSeconds": expireAfterSeconds,
    // "hidden": hidden,
    "collation": { "locale": "simple" },
    "default_language": idioma
};

/*
 *  Global defaults
 */

if (typeof readPref === 'undefined') var readPref = 'primary';
let batch = 0, totalBatches = 1, residual = 0,
    now = new Date().getTime(),
    timestamp = (now/1000.0)|0;

function main() {
    /*
     *  main
     */
    db.getMongo().setReadPref(readPref);
    print('\nSynthesising', totalDocs,
          'document' + ((totalDocs === 1) ? '' : 's')
    );

    // sampling synthethic documents and estimating batch size
    for (let i = 0; i < sampleSize; ++i)
        docSize += bsonsize(genDocument())

    let avgSize = (docSize / sampleSize)|0;
    if (avgSize > bsonMax * 0.95) {
        print('\nWarning: The average document size of', avgSize,
              'bytes approaches or exceeeds the BSON max size of',
              bsonMax, 'bytes'
        )
    }

    print('\nSampling', sampleSize,
          'document' + ((sampleSize === 1) ? '' : 's'),
          'each with BSON size averaging', avgSize,
          'byte' + ((avgSize === 1) ? '' : 's')
    );
    let batchSize = (() => {
        let sampledSize = (bsonMax * 0.95 / avgSize)|0;
        return (maxWriteBatchSize < sampledSize) ? maxWriteBatchSize : sampledSize;
    })()
    print('Estimated optimal batch capacity of', batchSize,
          'document' + ((batchSize === 1) ? '' : 's')
    );
    if (totalDocs < batchSize)
        batchSize = totalDocs
    else {
        totalBatches += (totalDocs / batchSize)|0;
        residual = (totalDocs % batchSize)|0;
    }

    // (re)create the namespace
    dropNS(dropPref, dbName, collName, compressor, collation, tsOptions);

    // set collection/index build order, generate and bulk write the documents, create indexes
    print('\nIndex build order preference:', indexPrefs.order);
    switch (indexPrefs.order.toLowerCase()) {
        case 'pre':
            print('Building indexing metadata first');
            buildIndexes();
            genBulk(batchSize);
            break;
        case 'post':
            print('Populating collection first');
            genBulk(batchSize);
            buildIndexes();
            break;
        default:
            print('Unsupported index build preference:', indexPrefs.order,
                  '- Defaulting to "post"'
            );
            genBulk(batchSize);
            buildIndexes();
    }

    print('\n Fuzzing completed!\n');

    return;
}

function genDocument() {
    /*
     *  generate pseudo-random key values
     */
    let secondsOffset;
    switch (fuzzer.distribution.toLowerCase()) {
        case 'uniform':
            secondsOffset = +($getRandomNumber(fuzzer.offset, fuzzer.offset + fuzzer.range) * 86400)|0;
            break;
        case 'normal': // genNormal(mu, sigma)
            secondsOffset = +($genNormal(fuzzer.offset + fuzzer.range/2, fuzzer.range/2) * 86400)|0;
            break;
        case 'bimodal': // not implemented yet
            // secondsOffset = +($getRandomNumber(fuzzer.offset, fuzzer.offset + fuzzer.range) * 86400)|0;
            // break;
        case 'pareto': // not implemented yet
            // $genRandomInclusivePareto(min, alpha = 1.161) {
            // secondsOffset = +($genRandomInclusivePareto(fuzzer.offset + fuzzer.range) * 86400)|0;
            // break;
        case 'exponential': // not implemented yet
            // $getRandomExp()
            // secondsOffset = +($getRandomExp(fuzzer.offset, fuzzer.offset + fuzzer.range, 128) * 86400)|0;
            // break;
        default:
            print('\nUnsupported distribution type:', fuzzer.distribution,
                  '\nDefaulting to "uniform"'
            );
            secondsOffset = +($getRandomNumber(fuzzer.offset, fuzzer.offset + fuzzer.range) * 86400)|0;
    }

    let oid;
    switch (fuzzer._id.toLowerCase()) {
        case 'oid':
            oid = new ObjectId();
            break;
        default: // the 'ts' option
            oid = new ObjectId(
                Math.floor(timestamp + secondsOffset).toString(16) +
                $genRandomHex(16)
                // employ native mongosh method
            );
    }

    let date = new Date(now + (secondsOffset * 1000));
    let ts = (typeof process !== 'undefined') // MONGOSH-930
        ? new Timestamp({ "t": timestamp + secondsOffset, "i": 0 })
        : new Timestamp(timestamp + secondsOffset, 0);
    fuzzer.schemas = new Array();
    fuzzer.schemas.push({
        "_id": oid,
        "schema": "A",
        "comment": "General purpose schema shape",
        "language": idioma,
        "string": $genRandomString($getRandomIntInclusive(6, 24)),
        "quote": {
            "language": idiomas[
                $getRandomRatioInt([80, 0, 0, 5, 0, 3, 2])
            ],
            "txt": $genRandomString($getRandomIntInclusive(6, 24)),
        },
        "object": {
            "oid": oid,
            "str": $genRandomAlpha($getRandomIntInclusive(8, 16)),
            "num": +$getRandomNumber(
                        -Math.pow(2, 12),
                        Math.pow(2, 12)
                   ).toFixed(4)
        },
        "array": $genArrayElements($getRandomIntInclusive(0, 10)),
        "boolean": $bool(),
        "code": Code('() => {}'),
        "codeScoped": Code('() => {}', {}),
        "date": date,
        "dateString": date.toString(),
        "timestamp": ts,
        "null": null,
        "int32": NumberInt(
                    $getRandomIntInclusive(
                        -(Math.pow(2, 31) - 1),
                        Math.pow(2, 31) - 1)),
        "int64": $NumberLong(
                    $getRandomIntInclusive(
                        -(Math.pow(2, 63) - 1),
                        Math.pow(2, 63) - 1)),
        "double": $getRandomNumber(
                    -Math.pow(2, 12),
                    Math.pow(2, 12)),
        "decimal128": $NumberDecimal(
                        $getRandomNumber(
                            -(Math.pow(10, 127) - 1),
                            Math.pow(10, 127) -1)),
        "regex": $getRandomRegex(),
        "bin": BinData(0, UUID().base64()),
        "uuid": UUID(),
        "md5": MD5($genRandomHex(32)),
        "fle": BinData(6, UUID().base64()),
        /* "columnStore": fCV(5.2)
                     ? BinData(7, NumberInt($getRandomIntInclusive(0, Math.pow(10, 4))),
                        {
                            "unit": +$getRandomNumber(0, Math.pow(10, 6)).toFixed(2),
                            "qty": NumberInt($getRandomIntInclusive(0, Math.pow(10, 4))),
                            "price": [
                                +$getRandomNumber(0, Math.pow(10, 4)).toFixed(2),
                                $genRandomCurrency()
                            ]
                        }
                       )
                     : 'requires v5.2+', */
        "random": +$getRandomNumber(0, totalDocs).toFixed(4),
        "symbol": $genRandomSymbol()
    });
    fuzzer.schemas.push({
        "_id": oid,
        "schema": "B",
        "comment": "Time series schema example",
        "language": idioma,
        "timeField": date,
        "metaField": [
                'Series 1',
                'Series 2',
                'Series 3'
            ][$getRandomRatioInt([70, 20, 10])],
        "granularity": "hours",
        "unit": +$getRandomNumber(0, Math.pow(10, 6)).toFixed(2),
        "qty": NumberInt($getRandomIntInclusive(0, Math.pow(10, 4))),
        "price": [
            +$getRandomNumber(0, Math.pow(10, 4)).toFixed(2),
            $genRandomCurrency()
    ] });
    fuzzer.schemas.push({
        "_id": oid,
        "schema": "C",
        "comment": "GeoJSON schema examples",
        "language": idioma,
        "temperature": [
            +$genNormal(15, 10).toFixed(1),
            ['K', '°F', '°C'][$getRandomIntInclusive(0, 2)]
        ],
        "dB": +$genNormal(20, 10).toFixed(3),
        "status": [
            'Active',
            'Inactive',
            null
            ][$getRandomRatioInt([80, 20, 1])],
        "location": { // GeoJSON Point
            "type": "Point",
            "coordinates": [
                +$getRandomNumber(-180, 180).toFixed(4),
                +$getRandomNumber(-90, 90).toFixed(4)
        ] },
        "lineString": { // GeoJSON LineString
            "type": "LineString",
            "coordinates": [
                [
                    +$getRandomNumber(-180, 180).toFixed(4),
                    +$getRandomNumber(-90, 90).toFixed(4)
                ],[
                    +$getRandomNumber(-180, 180).toFixed(4),
                    +$getRandomNumber(-90, 90).toFixed(4)
        ]] },
        "polygon": { // polygon with a single ring
            "type": "Polygon",
            "coordinates": [
                [
                    [0, 0],
                    [3, 6],
                    [6, 1],
                    [0, 0]]
        ] },
        "polygonMulti": { // polygons with multiple rings
            "type": "Polygon",
            "coordinates": [
                [
                    [0, 0],
                    [3, 6],
                    [6, 1],
                    [0, 0]
                ],[
                    [2, 2],
                    [3, 3],
                    [4, 2],
                    [2, 2]
        ]] },
        "multiPoint": { // GeoJSON MultiPoint
            "type": "MultiPoint",
            "coordinates": [
                [-73.9580, 40.8003],
                [-73.9498, 40.7968],
                [-73.9737, 40.7648],
                [-73.9814, 40.7681]
        ] },
        "multiLineString": { // GeoJSON MultiLineString
            "type": "MultiLineString",
            "coordinates": [
                [
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
        ]] },
        "multiPolygon": { // GeoJSON MultiPolygon
            "type": "MultiPolygon",
            "coordinates": [
                [
                    [
                        [-73.958, 40.8003],
                        [-73.9498, 40.7968],
                        [-73.9737, 40.7648],
                        [-73.9814, 40.7681],
                        [-73.958, 40.8003]
                    ]
                ],[
                    [
                        [-73.958, 40.8003],
                        [-73.9498, 40.7968],
                        [-73.9737, 40.7648],
                        [-73.958, 40.8003]
        ]]] },
        "geoCollection": { // GeoJSON GeometryCollection
            "type": "GeometryCollection",
            "geometries": [{
                "type": "MultiPoint",
                "coordinates": [
                    [-73.9580, 40.8003],
                    [-73.9498, 40.7968],
                    [-73.9737, 40.7648],
                    [-73.9814, 40.7681]
            ] },
            {
                "type": "MultiLineString",
                "coordinates": [
                    [
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
        ]] }] }
    });

    return fuzzer.schemas[$getRandomRatioInt(fuzzer.ratios)];
}

function dropNS(dropPref = false, dbName = false, collName = false,
                compressor = 'best', collation = { "locale": "simple" },
                tsOptions) {
    /*
     *  drop and recreate target namespace
     */
    let msg = '';
    switch(compressor.toLowerCase()) {
        case 'best':
            compressor = fCV(4.2) ? 'zstd' : 'zlib';
            break;
        case 'none':
            compressor = 'none';
            break;
        case 'zlib':
            compressor = 'zlib';
            break;
        case 'zstd':
            if (fCV(4.2)) {
                compressor = 'zstd';
            } else {
                compressor = 'zlib';
                msg = '("zstd" requires mongod v4.2+)';
            }
            break;
        default:
            compressor = 'snappy';
    }

    if (dropPref && !!dbName && !!collName) {
        print('\nDropping namespace "' + dbName + '.' + collName + '"\n');
        namespace.drop();
        createNS(dbName, collName, msg, compressor,
                 expireAfterSeconds, collation, tsOptions
        );
    } else if (!dropPref && !namespace.exists()) {
        print('\nNominated namespace "' + dbName + '.' + collName + '" does not exist\n');
        createNS(dbName, collName, msg, compressor,
                 expireAfterSeconds, collation, tsOptions
        );
    } else
        print('\nPreserving existing namespace "' + dbName + '.' + collName + '"')

    return;
}

function createNS(dbName = false, collName = false, msg = '',
                  compressor = 'best', expireAfterSeconds = 0,
                  collation = { "locale": "simple" },
                  tsOptions = { "timeField": "timestamp",
                                "metaField": "data",
                                "granularity": "hours" }) {
    print('Creating namespace "' + dbName + '.' + collName + '"',
          '\n\twith block compression:\t"' + compressor + '"', msg,
          '\n\tand collation locale:\t"' + collation.locale + '"'
    );
    let options = {
        "storageEngine": {
            "wiredTiger": {
                "configString": "block_compressor=" + compressor
        } },
        "collation": collation,
        "writeConcern": writeConcern
    };
    if (timeSeries && fCV(5.0) && !isAtlasPlatform('serverless')) {
        options.timeSeries = tsOptions;
        options.expireAfterSeconds = expireAfterSeconds;
        print('\tand time series options:',
              JSON.stringify(options, null, '\t')
        );
    }

    try { db.getSiblingDB(dbName).createCollection(collName, options) }
    catch(e) { print('\nNamespace creation failed:', e) }

    return;
}

function buildIndexes() {
    if (indexPrefs.build) {
        if (indexes.length > 0) {
            print('\nBuilding index' + ((indexes.length === 1) ? '' : 'es'),
                  'with collation locale "' + collation.locale + '"',
                  'with commit quorum "' + ((isReplSet() && serverVer(4.4)) ? indexPrefs.commitQuorum : 'disabled')
                  + '":'
            );
            indexes.forEach(index => {
                for (let [key, value] of Object.entries(index)) {
                    print('\tkey:', key, '/', value);
                }
            });
            let indexing = () => {
                let options = (isReplSet() && serverVer(4.4))
                            ? [indexes, indexOptions, indexPrefs.commitQuorum]
                            : [indexes, indexOptions];

                return namespace.createIndexes(...options);
            }

            let idxResult = indexing();
            let idxMsg = () => {
                if (typeof idxResult.errmsg !== 'undefined')
                    return 'Indexing operation failed: ' + idxResult.errmsg
                else if (typeof idxResult.note !== 'undefined') {
                    let diff = idxResult.numIndexesAfter - idxResult.numIndexesBefore
                    return 'Indexing completed with note: ' + idxResult.note +
                           ' with ' + diff + ' index changes.' }
                else if (typeof idxResult.ok !== 'undefined')
                    return 'Indexing completed!'
                else if (typeof idxResult.msg !== 'undefined')
                    return 'Indexing build failed with message: ' + idxResult.msg
                else
                    return 'Indexing completed with results:\t' + idxResult
            }

            print(idxMsg());
        } else {
            print('No regular index builds specified.')
        }

        if (specialIndexes.length > 0) {
            print('\nBuilding exceptional index' + ((specialIndexes.length === 1) ? '' : 'es'),
                  '(no collation support) with commit quorum "' +
                  ((isReplSet() && serverVer(4.4)) ? indexPrefs.commitQuorum : 'disabled') + '":'
            );
            specialIndexes.forEach(index => {
                for (let [key, value] of Object.entries(index)) {
                    print('\tkey:', key, '/',
                          (value === 'text') ? value + ' / ' + idioma : value
                    )
                }
            });
            let sIndexing = () => {
                let sOptions = (isReplSet() && serverVer(4.4))
                           ? [specialIndexes, specialIndexOptions, indexPrefs.commitQuorum]
                           : [specialIndexes, specialIndexOptions];

                return namespace.createIndexes(...sOptions);
            }

            let sIdxResult = sIndexing();
            let sidxMsg = () => {
                if (typeof sIdxResult.errmsg !== 'undefined')
                    return 'Special indexing operation failed: ' + sIdxResult.errmsg
                else if (typeof sIdxResult.note !== 'undefined') {
                    let diff = sIdxResult.numIndexesAfter - sIdxResult.numIndexesBefore
                    return 'Special indexing completed with note: ' + sIdxResult.note +
                           ' with ' + diff + ' index changes.' }
                else if (typeof sIdxResult.ok !== 'undefined')
                    return 'Special indexing completed!'
                else if (typeof sIdxResult.msg !== 'undefined')
                    return 'Special indexing build failed with message: ' + sIdxResult.msg
                else
                    return 'Special indexing completed with results:\t' + sIdxResult
            }

            print(sidxMsg());
        } else
            print('\nNo special index builds specified.')

    } else
        print('\nBuilding indexes: "false"')

    return;
}

function genBulk(batchSize) {
    print('\nSpecified date range time series:',
        '\n\tfrom:\t\t',
        new Date(now + fuzzer.offset * 86400000).toISOString(),
        '\n\tto:\t\t',
        new Date(now + (fuzzer.offset + fuzzer.range) * 86400000).toISOString(),
        '\n\tdistribution:\t', fuzzer.distribution,
        '\n\nGenerating', totalDocs, 'document' + ((totalDocs === 1) ? '' : 's'),
        'in', totalBatches, 'batch' + ((totalBatches === 1) ? '' : 'es') + ':'
    );
    for (let i = 0; i < totalBatches; ++i) {
        if (i === totalBatches - 1 && residual > 0) batchSize = residual;
        let bulk = namespace.initializeUnorderedBulkOp();
        for (let batch = 0; batch < batchSize; ++batch) bulk.insert(genDocument());

        try {
            let result = bulk.execute(writeConcern);
            let bInserted = (typeof process !== 'undefined') ? result.insertedCount : result.nInserted;
            print('\tbulk inserted', bInserted,
                    'document' + ((bInserted === 1) ? '' : 's'),
                    'in batch', 1 + i, 'of', totalBatches
            );
        } catch(e) {
            print('Generation failed with:', e);
        }
    }

    print('Generation completed.');

    return;
}

main();

// EOF
