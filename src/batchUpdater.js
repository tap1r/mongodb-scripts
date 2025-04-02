/*
 *  Name: "batchUpdater.js"
 *  Version: "0.1.6"
 *  Description: batch updater with ranged based pagination
 *  Disclaimer: https://raw.githubusercontent.com/tap1r/mongodb-scripts/master/DISCLAIMER.md
 *  Authors: ["tap1r <luke.prochazka@gmail.com>"]
 */

// Usage: "mongosh [connection options] --quiet batchUpdater.js"

const __script = { "name": "batchUpdater.js", "version": "0.1.6" };

// user defined variables
const dbName = 'database',
   collName = 'collection',
   batchSize = 10000,
   sleepIntervalMS = 5000,
   update = [{ "$set": { "x": { "$toInt": "$x" } } }],
   comment = `run by script ${__script.name} v${__script.version}`;

const namespace = db.getSiblingDB(dbName).getCollection(collName);

// script variables
const sort = { "_id": 1 },
   options = {
      "upsert": false,
      "writeConcern": { "w": "majority", "j": false }
   },
   readPref = 'primary',
   readConcern = 'local';
let currentKey = MinKey();

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

   let updateFilter = {
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

async function batchUpdate() {
    while (currentKey !== null) {
        currentKey = await updateStrings(currentKey, batchSize);
        console.log(`Sleeping for ${sleepIntervalMS}ms\n`);
        sleep(sleepIntervalMS);
    }
}

console.log(`\nBatch ${batchSize} updates on ${namespace} at ${sleepIntervalMS}ms intervals\n`);
batchUpdate();
