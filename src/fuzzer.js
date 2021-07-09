/*
 *  Name: "fuzzer.js"
 *  Version = "0.2.9"
 *  Description: Generate pseudo random test data, with some fuzzing capability
 *  Authors: ["tap1r <luke.prochazka@gmail.com>"]
 */

// Usage: "mongo [connection options] --quiet fuzzer.js"

/*
 *  Load helper pcg-xsh-rr.js (https://github.com/tap1r/mongodb-scripts/blob/master/src/pcg-xsh-rr.js)
 *  Load helper mdblib.js (https://github.com/tap1r/mongodb-scripts/blob/master/src/mdblib.js)
 *  Save libs to the $MDBLIB or valid search path
 */

if (typeof _mdblib === 'undefined' && +version().match(/^[0-9]+\.[0-9]+/) >= 4.4) {
    let libPaths = [_getEnv('MDBLIB'), _getEnv('HOME') + '/.mongodb', '.'];
    let libName = 'mdblib.js';
    var _mdblib = libPaths.find(libPath => fileExists(libPath + '/' + libName)) + '/' + libName;
    load(_mdblib);
} else {
    // pre-v4.4 copy the library to the CWD
    load('mdblib.js');
}

/*
 *  User defined parameters
 */

let dbName = 'database', collName = 'collection';
let compressor = 'best'; // ["none"|"snappy"|"zlib"|"zstd"|"default"|"best"]
let idioma = 'en';
let collation = { // ["simple"|"en"|"es"|"de"|"fr"|"zh"]
    "locale": "simple"
};
let dropPref = false; // drop collection prior to generating data
let buildIndexes = true; // build index preferences
let totalDocs = getRandomExp(4); // number of documents to generate per namespace
let fuzzer = { // preferences
    "_id": "ts", // ["ts"|"oid"] - timeseries OID | client generated OID
    "range": 365.2422, // date range in days
    "offset": -300, // date offset in days from now (neg = past, pos = future)
    "distribution": "uniform", // ["uniform"|"normal"|"bimodal"|"pareto"|"exponential"]
    "polymorphic": { // experimental
        "enabled": false,
        "vary_types": false, // fuzz types
        "nests": 0, // nested subdocs
        "entropy": 100, // 0 - 100%
        "cardinality": 1, // ratio:1
        "sparsity": 0, // 0 - 100%
        "weighting": 50 // 0 - 100%
    },
    "schemas": [{}, {}, {}],
    "ratios": [7, 2, 1]
};
let wc = 1; // bulk write concern
var sampleSize = 9, docSize = 0;
fuzzer.ratios.forEach(ratio => sampleSize += parseInt(ratio));
sampleSize *= sampleSize;
let indexes = [ // index keys
    { "date": 1 },
    { "language": 1, "schema": 1 },
    { "random": 1 },
    { "string": "hashed" },
    { "array": 1 },
    { "timestamp": 1 },
    { "location": "2dsphere" },
    /*
        { "lineString": "2dsphere" },
        { "polygon": "2dsphere" },
        { "polygonMulti": "2dsphere" },
        { "multiPoint": "2dsphere" },
        { "multiLineString": "2dsphere" },
        { "multiPolygon": "2dsphere" },
        { "geoCollection": "2dsphere" },
    */
    serverVer(4.2) ? { "object.$**": 1 } : { "object.oid": 1 }
];
let indexOptions = { // createIndexes options
    "collation": collation
};
let specialIndexes = [ // index keys unsupported by collations 
    { "location.coordinates": "2d" },
    { "quote.txt": "text" }
];
let specialIndexOptions = { // exceptional index options
    "collation": { "locale": "simple" },
    "default_language": idioma
};

/*
 *  Global defaults
 */

var batch = 0, totalBatches = 1, residual = 0, doc = {};
let now = new Date().getTime();
let timestamp = (now/1000.0)|0;

function main() {
    /*
     *  main
     */
    print('\n');
    print('Fuzzer script synthesising', totalDocs, 'document' + ((totalDocs === 1) ? '' : 's'));

    // sampling synthethic documents and estimating batch size
    for (let i = 0; i < sampleSize; ++i) {
        docSize += Object.bsonsize(genDocument());
    }

    let avgSize = (docSize / sampleSize)|0;
    if (avgSize > bsonMax * 0.95) {
        print('\n');
        print('Warning: The average document size of', avgSize,
              'bytes approaches or exceeeds the BSON max size of', bsonMax, 'bytes');
    }

    print('\n');
    print('Sampling', sampleSize,
          'document' + ((sampleSize === 1) ? '' : 's'), 'with BSON size averaging', avgSize, 'byte' + ((avgSize === 1) ? '' : 's'));
    let batchSize = (bsonMax * 0.95 / avgSize)|0;
    print('Estimated optimal batch capacity', batchSize, 'document' + ((batchSize === 1) ? '' : 's'));
    if (totalDocs < batchSize) {
        batchSize = totalDocs;
    } else {
        totalBatches += (totalDocs / batchSize)|0;
        residual = (totalDocs % batchSize)|0;
    }

    // recreate the namespace
    dropNS(dropPref, dbName, collName, compressor, collation);

    // generate and bulk write the documents
    print('\n');
    print('Specified timeseries date range:');
    print('\tfrom:\t\t', new Date(now + fuzzer.offset * 86400000).toISOString());
    print('\tto:\t\t', new Date(now + (fuzzer.offset + fuzzer.range) * 86400000).toISOString());
    print('\tdistribution:\t', fuzzer.distribution);
    print('\n');
    print('Generating', totalDocs, 'document' + ((totalDocs === 1) ? '' : 's'),
          'in', totalBatches, 'batch' + ((totalBatches === 1) ? '' : 'es') + ':');
    for (let i = 0; i < totalBatches; ++i) {
        if (i === totalBatches - 1 && residual > 0) {
            batchSize = residual;
        }

        var bulk = db.getSiblingDB(dbName).getCollection(collName).initializeUnorderedBulkOp();
        for (let batch = 0; batch < batchSize; ++batch) {
            doc = genDocument();
            bulk.insert(doc);
        }

        try {
            var result = bulk.execute({ "w": wc });
            print('\tbulk inserting', result.nInserted,
                  'document' + ((result.nInserted === 1) ? '' : 's'), 'in batch', 1 + i,
                  'of', totalBatches);
        } catch (e) {
            print('\n');
            print('Generation failed:', e);
        }
    }

    print('Generation completed.');

    // create indexes
    print('\n');
    if (buildIndexes) {
        if (indexes.length > 0) {
            print('Building index' + ((indexes.length === 1) ? '' : 'es'), 'with collation locale "' + collation.locale + '":');
            indexes.forEach(index => {
                for (let [key, value] of Object.entries(index)) {
                    print('\tkey:', key, '/', value);
                }
            });
            var result = db.getSiblingDB(dbName).getCollection(collName).createIndexes(
                            indexes, indexOptions
                        );
            result.ok ? print('Indexing completed.') : print('Indexing failed:', result.msg);
        } else {
            print('No regular indexes specified to build.');
        }

        print('\n');
        if (specialIndexes.length > 0) {
            print('Building exceptional index' + ((indexes.length === 1) ? '' : 'es'), 'without collation support:');
            specialIndexes.forEach(index => {
                for (let [key, value] of Object.entries(index)) {
                    print('\tkey:', key, '/', (value === 'text') ? value + ' / ' + idioma : value);
                }
            });
            var result = db.getSiblingDB(dbName).getCollection(collName).createIndexes(
                            specialIndexes, specialIndexOptions
                         );
            result.ok ? print('Special indexing completed.') : print('Special indexing failed:', result.msg);
        } else {
            print('No special indexes specified to build.');
        }
    } else {
        print('Building indexes: "false"');
    }

    // end
    print('\nFuzzing completed!\n\n')

    return;
}

function genDocument() {
    /*
     *  generate pseudo-random key values
     */
    switch (fuzzer.distribution) {
        case 'uniform':
            var dateOffset = rand() * fuzzer.range * 86400 + fuzzer.offset * 86400;
            break;
        default:
            print('\n');
            print('Unsupported distribution type:', fuzzer.distribution);
            print('Defaulting to "uniform"');
            var dateOffset = rand() * fuzzer.range * 86400 + fuzzer.offset * 86400;
    }

    switch (fuzzer._id) {
        case 'oid':
            var oid = new ObjectId();
            break;
        default: // the 'ts' option
            var oid = new ObjectId(
                Math.floor(timestamp + dateOffset).toString(16) +
                genRandomHex(16)
            );
    }

    let date = new Date(now + dateOffset * 1000);
    let ts = new Timestamp(timestamp + dateOffset, 1);
    let schemaA = {
        "_id": oid,
        "schema": "Shape-A",
        "language": idioma,
        "string": genRandomString(getRandomIntInclusive(6, 24)),
        "quote": {
            "language": idiomas[
                getRandomRatioInt([80, 0, 0, 5, 0, 3, 2])
            ],
            "txt": genRandomString(getRandomIntInclusive(6, 24)),
        },
        "object": {
            "oid": oid,
            "str": genRandomAlpha(getRandomIntInclusive(8, 16)),
            "num": +getRandomNumber(
                        -Math.pow(2, 12),
                        Math.pow(2, 12)
                   ).toFixed(4)
        },
        "array": genArrayElements(getRandomIntInclusive(0, 10)),
        "boolean": bool(),
        "date": date,
        "timestamp": ts,
        "null": null,
        "int32": NumberInt(
                    getRandomIntInclusive(
                        -(Math.pow(2, 31) - 1),
                        Math.pow(2, 31) - 1)),
        "int64": NumberLong(
                    getRandomIntInclusive(
                        -(Math.pow(2, 63) - 1),
                        Math.pow(2, 63) - 1)),
        "double": getRandomNumber(
                    -Math.pow(2, 12),
                    Math.pow(2, 12)),
        "decimal128": NumberDecimal(
                        getRandomNumber(
                            -(Math.pow(10, 127) - 1),
                            Math.pow(10, 127) -1)),
        "regex": /\/[A-Z0-9a-z]*\/g/,
        "bin": BinData(0, UUID().base64()),
        "uuid": UUID(),
        "md5": MD5(genRandomHex(32)),
        "fle": BinData(6, UUID().base64()),
        "random": +getRandomNumber(0, totalDocs).toFixed(4),
        "symbol": genRandomSymbol(),
        "unit": +getRandomNumber(0, Math.pow(10, 6)).toFixed(2),
        "qty": NumberInt(getRandomIntInclusive(0, Math.pow(10, 4))),
        "price": [
            +getRandomNumber(0, Math.pow(10, 4)).toFixed(2),
            genRandomCurrency()
        ],
        "temperature": [
            +genNormal(15, 10).toFixed(1),
            ['K', '°F', '°C'][getRandomIntInclusive(0, 2)]
        ],
        "dB": +genNormal(20, 10).toFixed(3),
        "status": [
            'Active',
            'Inactive',
            null
            ][getRandomRatioInt([80, 20, 1])],
        "location": { // GeoJSON Point
            "type": "Point",
            "coordinates": [
                +getRandomNumber(-180, 180).toFixed(4),
                +getRandomNumber(-90, 90).toFixed(4)
            ]
        },
        "lineString": { // GeoJSON LineString
            "type": "LineString",
            "coordinates": [
                [
                    +getRandomNumber(-180, 180).toFixed(4),
                    +getRandomNumber(-90, 90).toFixed(4)
                ],[
                    +getRandomNumber(-180, 180).toFixed(4),
                    +getRandomNumber(-90, 90).toFixed(4)
                ]
            ]
        },
        "polygon": { // polygon with a single ring
            "type": "Polygon",
            "coordinates": [
                [
                    [0, 0],
                    [3, 6],
                    [6, 1],
                    [0, 0]]
            ]
        },
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
                ]
            ]
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
                ]
            ]
        },
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
                    ]
                ]
            ]
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
                    ]
                ]
            }]
        }
    };
    let schemaB = {
        "_id": oid,
        "schema": "Shape-B",
        "language": idioma,
        "random": +getRandomNumber(0, totalDocs).toFixed(4)
    };
    let schemaC = {
        "_id": oid,
        "schema": "Shape-C",
        "language": idioma,
        "random": +getRandomNumber(0, totalDocs).toFixed(4)
    };
    fuzzer.schemas[0] = schemaA;
    fuzzer.schemas[1] = schemaB;
    fuzzer.schemas[2] = schemaC;

    return fuzzer.schemas[getRandomRatioInt(fuzzer.ratios)];
}

function dropNS(dropPref = false, dbName = false, collName = false,
                compressor = 'best', collation = { "locale": "simple" }) {
    /*
     *  drop and recreate target namespace
     */
    var msg = '';
    switch(compressor.toLowerCase()) {
        case 'best':
            compressor = serverVer(4.2) ? 'zstd' : 'zlib';
            break;
        case 'none':
            compressor = 'none';
            break;
        case 'zlib':
            compressor = 'zlib';
            break;
        case 'zstd':
            if (serverVer(4.2)) {
                compressor = 'zstd';
            } else {
                compressor = 'zlib';
                var msg = '("zstd" requires mongod v4.2+)';
            }

            break;
        default:
            compressor = 'snappy';
    }

    print('\n');
    if (dropPref && !!dbName && !!collName) {
        print('Dropping namespace "' + dbName + '.' + collName + '"');
        db.getSiblingDB(dbName).getCollection(collName).drop();
        print('\n');
        createNS();
    } else if (!dropPref && !db.getSiblingDB(dbName).getCollection(collName).exists()) {
        print('Nominated namespace "' + dbName + '.' + collName + '" does not exist');
        print('\n');
        createNS();
    } else {
        print('Preserving existing namespace "' + dbName + '.' + collName + '"');
    }

    function createNS() {
        print('Creating namespace "' + dbName + '.' + collName + '"');
        print('\twith block compression:\t"' + compressor + '"', msg);
        print('\tand collation locale:\t"' + collation.locale + '"');
        db.getSiblingDB(dbName).createCollection(
            collName,
            {
                "storageEngine": {
                    "wiredTiger": {
                        "configString": "block_compressor=" + compressor } },
                "collation": collation
            }
        );
    }

    return;
}

main();

// EOF
