/*
 *  Name: "schema-sampler.js"
 *  Version: "0.1.1"
 *  Description: generate schema data by simulating mongosqld sampling commands
 *  Authors: ["tap1r <luke.prochazka@gmail.com>"]
 */

// Usage: "[mongo|mongosh] [connection options] --quiet schema-sampler.js"

var agg = [{ "$sample": { "size": 1 } }]; // sample size set to 1 for performance reasons, increase if required
var dbs = db.getMongo().getDBNames().filter(dbName => dbName.match(/^(?!(admin|config|local)$)/i)); // scan all non-system namespaces
// var dbs = ['namespace']; // restrict list to known namespaces
var schema = dbs.map(dbName => ({
    "db": dbName,
    "collections": db.getSiblingDB(dbName).getCollectionInfos({ "type": "collection", "name": { "$not": { "$regex": /^system\./ } } }, true, true).map(collection => ({
        "name": collection.name,
        "documents": db.getSiblingDB(dbName).getCollection(collection.name).stats().count,
        "indexes": db.getSiblingDB(dbName).getCollection(collection.name).getIndexes(),
        "$sample": db.getSiblingDB(dbName).getCollection(collection.name).aggregate(agg).toArray()
    }))[0],
    "views": db.getSiblingDB(dbName).getCollectionInfos({ "type": "view", "name": { "$not": { "$regex": /^system\./ } } }, true, true).map(view => ({
        "name": view.name,
        "options": view.options,
        "$sample": db.getSiblingDB(dbName).getCollection(view.name).aggregate(agg).toArray()
    }))[0]
}));

print(JSON.stringify(schema, null, '  '));

// EOF
