/*
 *  fuzzer.js
 *  Description: Generate pseudo random test data, with some fuzzing capability
 *  Created by: luke.prochazka@mongodb.com
 */

// Usage: "mongo [connection options] --quiet fuzzer.js"

/*
 *  user defined parameters
 */

let dbName = 'database', collName = 'collection';
var batchSize = 1000;
let dropPref = true; // drop collection prior to generating data
let exponent = 4; // number of doc by order of magnitude
let totalDocs = Math.ceil(genRandomNumber(1, 10) * 10 ** exponent);
let days = 365.25; // date range
var fuzzer = { // not in use
    _id: '', // default to server generation
    vary_types: false, // fuzz value types
    nests: 0, // how many nested layers
    distribution: "uniform", // uniform, normal, bimodal, pareto, exponent
    range: "max", // min, max, %
    cardinality: 1, //
    sparsity: 0, // 0 - 100%
    weighting: 50 // 0 - 100%
};
var indexes = [ // createIndex options document
    // { "oid": { unique: true } },
    { "date": 1 },
    { "location": "2dsphere" },
    { "random": 1 },
    { "timestamp": 1 }
];

/*
 *  global defaults
 */

var iter = 0, batch = 0, totalBatches = 0, batchBsonSize = 0, wc = 1, doc = {};
let now = new Date().getTime();
let timestamp = Math.floor(now/1000.0);
if (totalDocs < batchSize) {
    var iter = 1;
    var batchSize = totalDocs;
} else {
    var iter = Math.floor(totalDocs / batchSize);
}

let residual = Math.floor(totalDocs % batchSize);

/*
 *  main
 */

function dropNS(dropPref) {
    /*
     *  
     */
    if (dropPref) {
        print('\n');
        print('Dropping namespace:', dbName + '.' + collName);
        db.getSiblingDB(dbName).getCollection(collName).drop();
        return;
    } else {
        print('\n');
        print('Not dropping namespace:', dbName + '.' + collName);
        return;
    }
}

function genRandomNumber(min, max) {
    /*
     *  
     */
    return Math.random() * (max - min) + min;
}

function genRandomInteger(min, max) {
    /*
     *  
     */
    min = Math.ceil(min);
    max = Math.floor(max);

    return Math.floor(Math.random() * (max - min) + min);
}

function genHexString(len) {
    /*
     *  
     */
    let res = '';
    for (let i = 0; i < len; ++i) {
        res += (Math.floor(Math.random() * 16)).toString(16);
    }

    return res;
}

function genRandomString(len) {
    /*
     *  
     */
    let res = '';
    let chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    for (let i = 0; i < len; ++i) {
       res += chars.charAt(Math.floor(Math.random() * chars.length));
    }

    return res;
}

function genRandomAlpha(len) {
    /*
     *  
     */
    let res = '';
    let chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
    for (let i = 0; i < len; ++i) {
       res += chars.charAt(Math.floor(Math.random() * chars.length));
    }

    return res;
}

function genRandomSymbol() {
    /*
     *  
     */
    let symbol = '!#%&\'()+,-;=@[]^_`{}~¡¢£¤¥¦§¨©ª«¬­®¯°±²³´µ¶·¸¹º»¼½¾¿ÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖ×ØÙÚÛÜÝÞßàáâãäåæçèéêëìíîïðñòóôõö÷øùúûüýþÿ';

    return symbol.charAt(Math.floor(Math.random() * symbol.length));
}

function genRandomCurrency() {
    /*
     *  
     */
    let symbol = ['$', '€', '₡', '£', '₪', '₹', '¥', '₩', '₦', '₱zł', '₲', '฿', '₴', '₫'];

    return symbol[(Math.floor(Math.random() * symbol.length))];
}

function genArrayElements(len) {
    /*
     *  
     */
    let array = [];
    for (let i = 0; i < len; ++i) {
        array.push(genRandomString(genRandomInteger(6, 24)));
    }

    return array;
}

function genRandomInclusivePareto(min, alpha = 1.161) {
    /*
     *  min is the lowest possible value that can be returned
     *  alpha controls the “shape” of the distribution
     */
    let u = 1.0 - Math.random();

    return min / Math.pow(u, 1.0 / alpha);
}

function randomIntInclusivePareto(min, max, alpha = 1.161) {
    /*
     *  min is the lowest possible value that can be returned
     *  alpha controls the “shape” of the distribution
     */
    let probabilities = [];
    for (var k = min; k <= max; ++k) {
        probabilities.push(1.0 / Math.pow(k, alpha));
    }

    var disc = SJS.Discrete(probabilities); // discrete sampler, returns value in the [0...probabilities.length-1] range

    return disc.draw() + min; // back to [min...max] interval
}

function normalDistribution(mu, sigma) {
    /*
     *  mu = mean
     *  sigma = standard deviation
     */
    let u = Math.random();
    let v = Math.random();
    let x = Math.sqrt(-2.0 * Math.log(u)) * Math.cos(Math.PI*2 * v);
    // let y = Math.sqrt(-2.0 * Math.log(u)) * Math.sin(Math.PI*2 * v);

    return x * sigma + mu;
}

function expoDistribution(lambda) {
    /*
     *  exponential distribution function
     */
    return -Math.log(1.0 - Math.random()) / lambda;
}

function genDocument() {
    /*
     *  generate pseudo-random key values
     */
    return {
        // "_id": new ObjectId(),
        "string": genRandomString(genRandomInteger(6, 24)),
        "object": {
            "oid": ObjectId(),
            "str": genRandomAlpha(genRandomInteger(8, 16)),
            "num": +genRandomNumber(-1 * 2 ** 12, 2 ** 12).toFixed(4)
        },
        "array": genArrayElements(genRandomInteger(0, 10)),
        "boolean": Math.random() < 0.5,
        "date": new Date(now - (Math.random() * days * 24 * 60 * 60 * 1000)),
        "timestamp": new Timestamp(timestamp - (Math.random() * days * 24 * 60 * 60), 1),
        "null": null,
        "int32": NumberInt(genRandomInteger(-1 * (2 ** 31) - 1, (2 ** 31) - 1)),
        "int64": NumberLong(genRandomInteger(-1 * (2 ** 63) - 1, (2 ** 63) - 1)),
        "double": genRandomNumber(-1 * 2 ** 12, 2 ** 12),
        "decimal128": NumberDecimal(genRandomNumber(-1 * (10 ** 127) - 1, (10 ** 127) -1)),
        "regex": /\/[0-9a-z]*\//,
        "bin": BinData(0, UUID().base64()),
        "uuid": UUID(),
        "md5": MD5(genHexString(32)),
        "fle": BinData(6, UUID().base64()),
        "location": {
            "type": "Point",
                "coordinates": [
                    +genRandomNumber(-180, 180).toFixed(4),
                    +genRandomNumber(-90, 90).toFixed(4)
                ]
        },
        "random": +genRandomNumber(0, totalDocs).toFixed(4),
        "symbol": genRandomSymbol(),
        "unit": +genRandomNumber(0, 10 ** 6).toFixed(2),
        "qty": NumberInt(genRandomInteger(0, 10 ** 4)),
        "currency": genRandomCurrency(),
        "price": +genRandomNumber(0, 10 ** 4).toFixed(2),
        // "temperature": "-40oC"
    };
}

dropNS(dropPref);

// generate and bulk write the docs
residual > 0 ? totalBatches = iter + 1: totalBatches = iter;
print('\n');
print('Generating', totalDocs, 'documents in', totalBatches, 'batches');
for (let i = 0; i < (iter + 1); ++i) {
    if (i === iter && residual > 0) {
        batchSize = residual;
    }
    var bulk = db.getSiblingDB(dbName).getCollection(collName).initializeUnorderedBulkOp();
    batchBsonSize = 0;
    for (let batch = 0; batch < batchSize; ++batch) {
        doc = genDocument();
        batchBsonSize += Object.bsonsize(doc);
        bulk.insert(doc);
    }

    var result = bulk.execute({ w: wc });
    print('...processing batch', i + 1, 'of', totalBatches, '(' + result.nInserted, 'documents bulk inserted with', batchBsonSize, 'BSON bytes)');
}

// create indexes
print('\nBuilding indexes');
indexes.forEach((index) => {
    printjson(index);
    db.getSiblingDB(dbName).getCollection(collName).createIndex(index);
})
print('\n');
print('Completed generating:', totalDocs, 'documents in "' + dbName + '.' + collName + '"');
print('\n');

// EOF
