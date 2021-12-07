/*
 *  Aggregation template with extended options
 */

var dbName = 'database', collName = 'collection',
    readPref = 'primary',
    // explainPlan = 'executionStats', // ['queryPlanner'|'executionStats'|'allPlansExecution']
    options = {
        "allowDiskUse": true,
        "cursor": { "batchSize": 0 },
        // "maxTimeMS": 0,
        // "bypassDocumentValidation": false,
        "readConcern": { "level": "local" },
        // "collation": { "locale": "simple" },
        // "hint": { "_id": 1 },
        "comment": "My aggregation query",
        "writeConcern": { "w": "majority"/*, "j": true, "wtimeout": 10000 */ },
        // "let": { } // Added in MongoDB v5.0
    },
    pipeline = [
        {
            // aggregation stage operators
        }
    ];

db.getMongo().setReadPref(readPref);
db.getSiblingDB(dbName).getCollection(collName).aggregate(pipeline, options).forEach(printjson);
// db.getSiblingDB(dbName).getCollection(collName).explain(explainPlan).aggregate(pipeline, options);

/*
 *  Aggregation template for ADL SQL queries
 */

var dbName = 'database', collName = 'collection',
    options = { "comment": "My ADL $sql query" },
    sql = `
        SELECT *
        FROM ${collName}
        LIMIT 1
    `,
    pipeline = [{
        "$sql": {
            "statement": sql,
            "format": "jdbc",
            "formatVersion": 1,
            "dialect": "mongosql",
        }
    }];

db.getSiblingDB(dbName).aggregate(pipeline, options).forEach(printjson);
