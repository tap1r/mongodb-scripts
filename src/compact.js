/*
 *  Name: "compact.js"
 *  Version = "0.1.0"
 *  Description: schrödinger's page reproduction
 *  Authors: ["tap1r <luke.prochazka@gmail.com>"]
 */

var dbName = 'database', collName = 'collection';

// create dataset
// load('fuzzer.js');

// delete n% of existing documents
var n = 80;
var deleteFilter = {
    "$expr": {
        "$gt": [n / 100, { "$rand": {} }]
    }
};

try {
    db.getSiblingDB(dbName).getCollection(collName).deleteMany(deleteFilter);
} catch (e) {
    print (e);
}

// "touch" documents to force page re-writes
var updateFilter = {}; // all docs
var setOptions = [{
    "$set": {
        "__$$compaction": {
            "status": "Modified",
            "lastModified": "$$NOW",
            "comment": "added by compact.js"
        }
    }
}];

try {
    db.getSiblingDB(dbName).getCollection(collName).updateMany(updateFilter, setOptions);
  } catch (e) {
    print(e);
}

var unsetOptions = [{ "$unset": "__$$compaction" }];

try {
    db.getSiblingDB(dbName).getCollection(collName).updateMany(updateFilter, unsetOptions);
  } catch (e) {
    print(e);
}

// compact()
db.getSiblingDB(dbName).runCommand({ "compact": collName });

// EOF
