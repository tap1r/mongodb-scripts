/*
 *  Aggregation templates
 */

(() => {
   /*
    *  Aggregation template with extended options
    */
   const dbName = 'database', collName = 'collection', readPref = 'primary';
   const namespace = db.getSiblingDB(dbName).getCollection(collName);
   const options = {
         "allowDiskUse": true,
         "cursor": { "batchSize": 0 },
         // "maxTimeMS": 0,
         // "bypassDocumentValidation": false,
         "readConcern": { "level": "local" },
         // "collation": { "locale": "simple" },
         // "hint": { "_id": 1 },
         "comment": "My aggregation query",
         "writeConcern": {
            "w": "majority",
            // "j": true,
            // "wtimeout": 10000
         },
         // "let": { } // Added in MongoDB v5.0
      },
      pipeline = [
         {
            // aggregation stage operators
         }
      ];

   db.getMongo().setReadPref(readPref);
   namespace.aggregate(pipeline, options).forEach(printjson);
})();

(() => {
   /*
    *  Aggregation template with explain options
    */
   const dbName = 'database', collName = 'collection', readPref = 'primary';
   const namespace = db.getSiblingDB(dbName).getCollection(collName);
   const explainPlan = 'executionStats', // ['queryPlanner'|'executionStats'|'allPlansExecution']
      options = {
         "allowDiskUse": true,
         "cursor": { "batchSize": 0 },
         // "maxTimeMS": 0,
         // "bypassDocumentValidation": false,
         "readConcern": { "level": "local" },
         // "collation": { "locale": "simple" },
         // "hint": { "_id": 1 },
         "comment": "Explain my aggregation query",
         "writeConcern": {
            "w": "majority",
            // "j": true,
            // "wtimeout": 10000
         },
         // "let": { } // Added in MongoDB v5.0
      },
      pipeline = [
         {
            // aggregation stage operators
         }
      ];

   db.getMongo().setReadPref(readPref);
   printjson(namespace.explain(explainPlan).aggregate(pipeline, options));
})();

(() => {
   /*
    *  Aggregation template for $sql queries
    */
   const dbName = 'database', collName = 'collection';
   const namespace = db.getSiblingDB(dbName).getCollection(collName);
   const options = { "comment": "My $sql query" },
      sql = `
         SELECT *
         FROM ${collName}
         LIMIT 1;
      `,
      pipeline = [{
         "$sql": {
            "statement": sql,
            "format": "jdbc",
            "formatVersion": 1,
            "dialect": "mongosql"
      } }];

   db.getMongo().setReadPref(readPref);
   namespace.aggregate(pipeline, options).forEach(printjson);
})();

(() => {
   /*
    *  Aggregation template for $currentOp
    */
   const options = {
         "cursor": { "batchSize": 0 },
         "comment": "$currentOp template",
         // "let": { } // v5.0+ only
      },
      pipeline = [
         { "$currentOp": {  // default values
            "allUsers": false,
            "idleConnections": false,
            "idleCursors": false,
            "idleSessions": true,
            "localOps": false, // mongos only
            "backtrace": false
         } },
         { "$match": {
            "active": true,
            // "op": "command",
            // "ns": { "$regex": '^' + dbName + '.' },
            // "command.validate": { "$exists": true }
         } },
         // { "$group": { "_id": null } },
         // { "$project": { "_id": 1 } }
      ];

   db.getSiblingDB('admin').aggregate(pipeline, options).forEach(printjson);
})();

(() => {
   /*
    *  Aggregation template with $documents pipeline (req v5.1)
    */
   const dbName = '$';
   const namespace = db.getSiblingDB(dbName);
   const options = {
         // "allowDiskUse": true,
         "cursor": { "batchSize": 0 },
         // "maxTimeMS": 0,
         // "bypassDocumentValidation": false,
         "readConcern": { "level": "local" },
         // "collation": { "locale": "simple" },
         // "hint": { "_id": 1 },
         "comment": "My aggregation query",
         // "let": { } // Added in MongoDB v5.0
      },
      pipeline = [
         { "$documents": [
            { "document": 1 },
            { "document": 2 },
            { "document": 3 }
         ] },
         {
            // aggregation stage operators
         }
      ];

   namespace.aggregate(pipeline, options).forEach(printjson);
})();
