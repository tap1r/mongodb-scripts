/*
 *  Name: "oidFunction.js"
 *  Version: "0.1.2"
 *  Description: aggregation based OID "view function" reproduction (requires v5.0+)
 *  Disclaimer: https://raw.githubusercontent.com/tap1r/mongodb-scripts/master/DISCLAIMER.md
 *  Authors: ["tap1r <luke.prochazka@gmail.com>"]
 */

let dbName = 'database', collName = 'collection', oidView = '_oidGenerator', nonceName = '_nonceGenerator';

let db = db.getSiblingDB(dbName);
let namespace = db.getCollection(collName);
let view = db.getCollection(oidView);
let nonceGenerator = db.getCollection(nonceName);

let nonce = (+((+db.adminCommand({ "features": 1 }).oidMachine).toString() + (+db.serverStatus().pid).toString())).toString(16).substring(0, 10);

// nonceGenerator.drop();
nonceGenerator.updateOne(
   { "_id": 1 },
   { "$set": { "nonce": nonce } },
   { "upsert": true }
);

let oidPipeline = [
   { "$collStats": {} },
   // 4-byte epoch timestamp
   { "$set": {
      "_epoch": {
         "$convert": {
            "input": {
               "$divide": [
                  { "$trunc": [
                     { "$convert": { "input": "$$NOW", "to": "long" } },
                     -3
                  ] },
                  1000
               ] },
            "to": "int"
   } } } },
   { "$set": {
      "_epoch": {
         "$reduce": {
            "input": { "$range": [0, { "$ceil": { "$log": [{ "$add": ["$_epoch", 1] }, 16] } }]}, // scale
            "initialValue": {
               "quotient": { "$floor": { "$divide": ["$_epoch", 16] } },
               "remainder": { "$mod": ["$_epoch", 16] },
               "hexArray": []
            },
            "in": {
               "quotient": { "$floor": { "$divide": ["$$value.quotient", 16] } },
               "remainder": { "$mod": ["$$value.quotient", 16] },
               "hexArray": { "$concatArrays": ["$$value.hexArray", [{ "$floor": "$$value.remainder" }]] }
   } } } } },
   { "$set": {
      "_epoch": {
         "$first": {
            "$map": {
               "input": [ {
                  "$reduce": {
                     "input": {
                        "$map": {
                           "input": { "$reverseArray": "$_epoch.hexArray" },
                           "in": { 
                              "$switch": {
                                 "branches": [
                                    { "case": { "$eq": ["$$this", 10] }, "then": "a" },
                                    { "case": { "$eq": ["$$this", 11] }, "then": "b" },
                                    { "case": { "$eq": ["$$this", 12] }, "then": "c" },
                                    { "case": { "$eq": ["$$this", 13] }, "then": "d" },
                                    { "case": { "$eq": ["$$this", 14] }, "then": "e" },
                                    { "case": { "$eq": ["$$this", 15] }, "then": "f" }
                                 ],
                                 "default": { "$toString": "$$this" }
                     } } } },
                     "initialValue": "",
                     "in": { "$concat": ["$$value", "$$this"] }
               } }],
               "as": "epoch",
               "in": { 
                  "$switch": {
                     "branches": [
                        { "case": { "$eq": [{ "$strLenCP": "$$epoch" }, 7] }, "then": { "$concat": ["0", "$$epoch"] } },
                        { "case": { "$eq": [{ "$strLenCP": "$$epoch" }, 6] }, "then": { "$concat": ["00", "$$epoch"] } },
                        { "case": { "$eq": [{ "$strLenCP": "$$epoch" }, 5] }, "then": { "$concat": ["000", "$$epoch"] } },
                        { "case": { "$eq": [{ "$strLenCP": "$$epoch" }, 4] }, "then": { "$concat": ["0000", "$$epoch"] } },
                        { "case": { "$eq": [{ "$strLenCP": "$$epoch" }, 3] }, "then": { "$concat": ["00000", "$$epoch"] } },
                        { "case": { "$eq": [{ "$strLenCP": "$$epoch" }, 2] }, "then": { "$concat": ["000000", "$$epoch"] } },
                        { "case": { "$eq": [{ "$strLenCP": "$$epoch" }, 1] }, "then": { "$concat": ["0000000", "$$epoch"] } },
                        { "case": { "$eq": [{ "$strLenCP": "$$epoch" }, 0] }, "then": "00000000" }
                     ],
                     "default": "$$epoch"
   } } } } } } },
   // 5-byte machine nonce
   { "$lookup": { "from": "_nonceGenerator", "pipeline": [], "as": "_nonce" } },
   { "$set": { "_nonce": { "$first": "$_nonce.nonce" } } },
   // { "$set": { "_nonce": nonce } }, // optionally directly set the nonce
   // 3-byte randomly initialised 'counter'
   { "$set": { "_counter": { "$floor": { "$multiply": [{ "$rand": {} }, { "$pow": [2, 24] }] } } } },
   { "$set": {
      "_counter": {
         "$reduce": {
            "input": { "$range": [0, { "$ceil": { "$log": [{ "$add": ["$_counter", 1] }, 16] } }]}, // scale
            "initialValue": {
               "quotient": { "$floor": { "$divide": ["$_counter", 16] } },
               "remainder": { "$mod": ["$_counter", 16] },
               "hexArray": []
            },
            "in": {
               "quotient": { "$floor": { "$divide": ["$$value.quotient", 16] } },
               "remainder": { "$mod": ["$$value.quotient", 16] },
               "hexArray": { "$concatArrays": ["$$value.hexArray", [{ "$floor": "$$value.remainder" }]] }
   } } } } },
   { "$set": {
      "_counter": {
         "$first": {
            "$map": {
               "input": [{
                  "$reduce": {
                     "input": {
                        "$map": {
                           "input": { "$reverseArray": "$_counter.hexArray" },
                           "in": { 
                              "$switch": {
                                 "branches": [
                                    { "case": { "$eq": ["$$this", 10] }, "then": "a" },
                                    { "case": { "$eq": ["$$this", 11] }, "then": "b" },
                                    { "case": { "$eq": ["$$this", 12] }, "then": "c" },
                                    { "case": { "$eq": ["$$this", 13] }, "then": "d" },
                                    { "case": { "$eq": ["$$this", 14] }, "then": "e" },
                                    { "case": { "$eq": ["$$this", 15] }, "then": "f" }
                                 ],
                                 "default": { "$toString": "$$this" }
                     } } } },
                     "initialValue": "",
                     "in": { "$concat": ["$$value", "$$this"] }
               } }],
               "in": { 
                  "$switch": {
                     "branches": [
                        { "case": { "$eq": [{ "$strLenCP": "$$this" }, 5] }, "then": { "$concat": ["0", "$$this"] } },
                        { "case": { "$eq": [{ "$strLenCP": "$$this" }, 4] }, "then": { "$concat": ["00", "$$this"] } },
                        { "case": { "$eq": [{ "$strLenCP": "$$this" }, 3] }, "then": { "$concat": ["000", "$$this"] } },
                        { "case": { "$eq": [{ "$strLenCP": "$$this" }, 2] }, "then": { "$concat": ["0000", "$$this"] } },
                        { "case": { "$eq": [{ "$strLenCP": "$$this" }, 1] }, "then": { "$concat": ["00000", "$$this"] } },
                        { "case": { "$eq": [{ "$strLenCP": "$$this" }, 0] }, "then": "000000" }
                     ],
                     "default": "$$this"
   } } } } } } },
   { "$project": {
      "_id": 0,
      "oid": { "$convert": { "input": { "$concat": ["$_epoch", "$_nonce", "$_counter"] }, "to": "objectId" } }
   } }
];

view.drop();
db.createView(oidView, 'any', oidPipeline);
// db.getCollectionInfos();
// view.find({});

/*
 *  Usage demonstration
 */

let pipeline = [
   { "$documents": [ // sample documents for update
      { "_id": new ObjectId(), "name": "Bob", "activity": { "date": "$$NOW" } },
      { "_id": new ObjectId(), "name": "Alice", "activity": { "date": "$$NOW" } },
      { "_id": new ObjectId(), "name": "Eve", "activity": { "date": "$$NOW" } }
   ] },
   { "$lookup": { "from": "_oidGenerator", "pipeline": [], "as": "_oid" } },
   { "$set": { "activity._id": { "$first": "$_oid.oid" } } }, // apply the OID to the new field of choice
   { "$unset": "_oid" } // remove transient field
];
db.aggregate(pipeline);
