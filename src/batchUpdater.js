/*
 *  Name: "batchUpdater.js"
 *  Version: "0.1.2"
 *  Description: batch updater with ranged based pagination
 *  Authors: ["tap1r <luke.prochazka@gmail.com>"]
 */

// Usage: "mongosh [connection options] --quiet batchUpdater.js"

// user defined variables
var dbName = 'database',
    collName = 'collection',
    batchSize = 10000,
    sleepIntervalMS = 5000,
    update = [{ "$set": { "x": { "$toInt": "$x" } } }],
    comment = 'run by script batchUpdater.js';

let namespace = db.getSiblingDB(dbName).getCollection(collName);

// script variables
var sort = { "_id": 1 },
    options = {
        "upsert": false,
        "writeConcern": { "w": "majority", "j": true }
    },
    currentKey = MinKey,
    readPref = 'primary',
    readConcern = 'local';

db.getMongo().setReadPref(readPref);

async function updateStrings(startValue, nPerPage) {
    console.log(`Finding batch of ${batchSize} documents from OID ${startValue.toString()}`);
    let endValue = null,
        findFilter = {
            "_id": { "$gt": startValue },
            "x": { "$type": "string" }
        };

    await namespace.find(findFilter)
                   .sort(sort)
                   .limit(nPerPage)
                   .readConcern(readConcern)
                   .comment(comment)
                   .returnKey()
                   .forEach(doc => endValue = doc._id);
    updateFilter = {
        "$and": [
            { "_id": { "$gt": startValue, "$lte": endValue } },
            { "$expr": { "x": { "$type": "string" } } }
        ]
    };
    console.log(`UpdateMany from _id: ${startValue.toString()} to ${endValue.toString()}`);
    try {
        let result = await namespace.updateMany(updateFilter, update, options);
        console.log(`UpdateMany results: ${JSON.stringify(result, null, '\t')}`);
    } catch(e) { console.log(`Update failed with: ${e}`) }

    return endValue;
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function batchUpdate() {
    while (currentKey !== null) {
        currentKey = await updateStrings(currentKey, batchSize);
        console.log(`Sleeping ${sleepIntervalMS}ms\n`);
        await sleep(sleepIntervalMS);
    }
}

console.log(`\nBatch ${batchSize} updates on ${dbName}.${collName} at ${sleepIntervalMS}ms intervals\n`);
batchUpdate();
