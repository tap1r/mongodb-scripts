/*
 *  Name: "fuzzer.js"
 *  Version = "0.2.2"
 *  Description: Generate pseudo random test data, with some fuzzing capability
 *  Authors: ["tap1r <luke.prochazka@gmail.com>"]
 */

// Usage: "mongo [connection options] --quiet fuzzer.js"

/*
 *  Load helper pcg-xsh-rr.js (https://github.com/tap1r/mongodb-scripts/blob/master/src/pcg-xsh-rr.js)
 *  Load helper mdblib.js (https://github.com/tap1r/mongodb-scripts/blob/master/src/mdblib.js)
 *  Save libs to the $MDBLIB or valid search path
 */

// load('pcg-xsh-rr.js');
if (typeof _mdblib === 'undefined') {
    let libPaths = [_getEnv('MDBLIB'), _getEnv('HOME') + '/.mongodb', '.'];
    let libName = 'mdblib.js';
    var _mdblib = libPaths.find(libPath => fileExists(libPath + '/' + libName)) + '/' + libName;
    load(_mdblib);
}

/*
 *  User defined parameters
 */

let dbName = 'database', collName = 'collection';
let compressor = (serverVer(4.2)) ? 'zstd' : 'zlib'; // ["none"|"snappy"|"zlib"|"zstd"]
let collation = {
    "locale": "simple" // ["simple"|"en"|"es"|"de"|"fr"|"zh"]
};
let wc = 1; // bulk write concern
let dropPref = true; // drop collection prior to generating data
let totalDocs = getRandomExp(4); // number of documents to generate per namespace
let fuzzer = { // preferences
    "_id": "ts", // ["ts"|"oid"]
    "range": 365.25, // date range in days
    "future": 0, // 0 - 100%, portion of date range in future
    "vary_types": false, // fuzz value types
    "nests": 0, // how many nested layers
    "distribution": "uniform", // uniform, normal, bimodal, pareto, exponential
    "entropy": 100, // 0 - 100%
    "cardinality": 1, // experimental
    "sparsity": 0, // 0 - 100%
    "weighting": 50, // 0 - 100%
    "schemas": [{}, {}, {}],
    "ratios": [1, 0, 0]
};
var sampleSize = 9, docSize = 0;
fuzzer.ratios.forEach(ratio => sampleSize += parseInt(ratio));
sampleSize *= sampleSize;
let indexes = [ // createIndexes parameters
    { "date": 1 },
    { "location": "2dsphere" },
    { "random": 1 },
    { "timestamp": 1 },
    (serverVer(4.2)) ? { "object.$**": 1 } : { "object.oid": 1 }
];
let specialIndexes = [ // unsupported by collations 
    { "2dlegacy": "2d" },
    { "string": "text" }
];

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
    print('Synthesising', totalDocs, 'total document(s)');

    // sampling
    for (let i = 0; i < sampleSize; ++i) {
        docSize += Object.bsonsize(genDocument());
    }
    
    let avgSize = (docSize / sampleSize)|0;
    print('\n');
    print('Sampling', sampleSize, 'document(s) with BSON size average:', avgSize, 'bytes');
    let batchSize = (bsonMax * 0.95 / avgSize)|0;
    print('Estimated optimal batch size capacity:', batchSize, 'documents');
    if (totalDocs < batchSize) {
        batchSize = totalDocs;
    } else {
        totalBatches += (totalDocs / batchSize)|0;
        residual = (totalDocs % batchSize)|0;
    }

    dropNS(dropPref, dbName, collName, compressor, collation);

    // generate and bulk write the docs
    print('\n');
    print('Generating', totalDocs, 'document(s) in', totalBatches, 'batch(es):');
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
        } catch (e) {
            print(e);
            print('\n');
            print('Generation failed');
        }

        print('...bulk inserting batch', i + 1, 'of', totalBatches,
              '(' + result.nInserted, 'document(s))');
    }

    print('\n');
    print('Completed generating:', totalDocs,
          'document(s) in "' + dbName + '.' + collName + '"');

    // create indexes
    print('\n');
    print('Building index(es) with collation locale "' + collation.locale + '"');
    indexes.forEach(index => printjson(index));
    db.getSiblingDB(dbName).getCollection(collName).createIndexes(
        indexes,
        { "collation": collation }
    );
    print('\n');
    print('Building index(es) with collation locale "simple"');
    specialIndexes.forEach(index => printjson(index));
    db.getSiblingDB(dbName).getCollection(collName).createIndexes(
        specialIndexes,
        { "collation": { "locale": "simple" } }
    );
    print('\n');
    print('Complete!');
    print('\n');

    return;
}

function genDocument() {
    /*
     *  generate pseudo-random key values
     */
    let dateOffset = rand() * fuzzer.range * 24 * 60 * 60;
    switch (fuzzer._id) {
        case 'oid':
            var oid = new ObjectId();
            break;
        default: // the 'ts' option
            var oid = new ObjectId(
                Math.floor(timestamp - dateOffset).toString(16) +
                genRandomHex(16)
            );
    }

    let date = new Date(now - (dateOffset * 1000));
    let ts = new Timestamp(timestamp - (dateOffset), 1);
    let schemaA = {
        //"_id": oid,
        "schema": "Shape A",
        "string": genRandomString(getRandomIntInclusive(6, 24)),
        "object": {
            "oid": oid,
            "str": genRandomAlpha(getRandomIntInclusive(8, 16)),
            "num": +getRandomNumber(-1 * Math.pow(2, 12), Math.pow(2, 12)).toFixed(4)
        },
        "array": genArrayElements(getRandomIntInclusive(0, 10)),
        "boolean": rand() < 0.5,
        "date": date,
        "timestamp": ts,
        "null": null,
        "int32": NumberInt(getRandomIntInclusive(-1 * Math.pow(2, 31) - 1, Math.pow(2, 31) - 1)),
        "int64": NumberLong(getRandomIntInclusive(-1 * Math.pow(2, 63) - 1, Math.pow(2, 63) - 1)),
        "double": getRandomNumber(-1 * Math.pow(2, 12), Math.pow(2, 12)),
        "decimal128": NumberDecimal(getRandomNumber(-1 * Math.pow(10, 127) - 1, Math.pow(10, 127) -1)),
        "regex": /\/[A-Z0-9a-z]*\//,
        "bin": BinData(0, UUID().base64()),
        "uuid": UUID(),
        "md5": MD5(genRandomHex(32)),
        "fle": BinData(6, UUID().base64()),
        "2dlegacy": [
            +getRandomNumber(-180, 180).toFixed(8),
            +getRandomNumber(-90, 90).toFixed(8)
        ],
        "location": {
            "type": "Point",
            "coordinates": [
                +getRandomNumber(-180, 180).toFixed(8),
                +getRandomNumber(-90, 90).toFixed(8)
            ]
        },
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
            ['°C', '°F', 'K'][getRandomIntInclusive(0, 2)]
        ],
        "dB": +genNormal(20, 10).toFixed(3),
        "status": ['Active', 'Inactive', null][getRandomRatioInt([80, 20, 1])]
    };
    let schemaB = {
        // "_id": oid,
        "schema": "Shape B",
        "random": +getRandomNumber(0, totalDocs).toFixed(4)
    };
    let schemaC = {
        // "_id": oid,
        "schema": "Shape C",
        "random": +getRandomNumber(0, totalDocs).toFixed(4)
    };
    fuzzer.schemas[0] = schemaA;
    fuzzer.schemas[1] = schemaB;
    fuzzer.schemas[2] = schemaC;

    return fuzzer.schemas[getRandomRatioInt(fuzzer.ratios)];
}

function dropNS(dropPref = false, dbName = false, collName = false,
                compressor = (serverVer(4.2)) ? 'zstd' : 'zlib',
                collation = { "locale": "simple" }) {
    /*
     *  drop and recreate target namespace
     */
    if (dropPref) {
        print('\n');
        print('Dropping namespace "' + dbName + '.' + collName + '"');
        db.getSiblingDB(dbName).getCollection(collName).drop();
        print('Creating namespace "' + dbName + '.' + collName + '"',
              'with block compression "' + compressor + '"',
              'and collation locale "' + collation.locale + '"'
        );
        db.getSiblingDB(dbName).createCollection(collName,
            {
                "storageEngine": { "wiredTiger": { "configString": "block_compressor=" + compressor } },
                "collation": collation
            }
        )
    } else {
        print('\n');
        print('Not dropping namespace "' + dbName + '.' + collName + '"');
    }

    return;
}

main();

// EOF
