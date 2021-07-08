/*
 *  Name: "compact.js"
 *  Version = "0.1.1"
 *  Description: schrödinger's page reproduction
 *  Authors: ["tap1r <luke.prochazka@gmail.com>"]
 */

var dbName = 'database', collName = 'collection';
var n = 75;
var deleteFilter = {
    "$expr": {
        "$gt": [n / 100, { "$rand": {} }]
    }
};

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

var unsetOptions = [{ "$unset": "__$$compaction" }];

for (let i = 1; i < 4; ++i) {
    /*
     *  generate dataset with increased entropy
     */
    print('Round', i);
    print('Generating data');
    load('fuzzer.js');
    print('Pruning data');
    try { // delete n% of existing documents
        db.getSiblingDB(dbName).getCollection(collName).deleteMany(deleteFilter);
    } catch (e) {
        print (e);
    }
}

// "touch" documents to force page re-writes

print('Setting');
try {
    db.getSiblingDB(dbName).getCollection(collName).updateMany(updateFilter, setOptions);
  } catch (e) {
    print(e);
}

print('Unsetting');
try {
    db.getSiblingDB(dbName).getCollection(collName).updateMany(updateFilter, unsetOptions);
  } catch (e) {
    print(e);
}

// compact()
print('Compacting collection');
db.getSiblingDB(dbName).runCommand({ "compact": collName });

// EOF
