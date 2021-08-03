/*
 *  Name: "schema-sampler.js"
 *  Version: "0.1.2"
 *  Description: generate schema with simulated mongosqld sampling commands
 *  Authors: ["tap1r <luke.prochazka@gmail.com>"]
 */

// Usage: "[mongo|mongosh] [connection options] --quiet schema-sampler.js > schema.json"

__script = {
    "name": "schema-sampler.js",
    "version": "0.1.2"
};
print('\n', 'Running script', __script.name, ' v' + __script.version, '\n');

var userOptions = {
    /*
     *  User preferences
     */
    readPreference: 'primaryPreferred',
    sampleSize: 1    // defaults to 1 for performance reasons, increase for sparse data
}

db.getMongo().setReadPref(userOptions.readPreference);
var agg = [{ "$sample": { "size": userOptions.sampleSize } }];
var dbs = db.adminCommand({ "listDatabases": 1, "nameOnly": true, "filter": { "name": /^(?!(admin|config|local)$)/i }, "authorizedDatabases": true }).databases.map(dbName => dbName.name);
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
