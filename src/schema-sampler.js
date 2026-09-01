/*
 *  Name: "schema-sampler.js"
 *  Version: "0.2.16"
 *  Description: generate schema with simulated mongosqld sampling commands
 *  Disclaimer: https://raw.githubusercontent.com/tap1r/mongodb-scripts/master/DISCLAIMER.md
 *  Authors: ["tap1r <luke.prochazka@gmail.com>"]
 *
 *  Legacy archive line: v0.2.16 is the snapshot for this script. Dual-shell
 *  lite (no mdblib; mongosh via `process` / `util.inspect`, mongo via
 *  `print`/`tojson`). Further feature work (mdblib, filter.db overlay,
 *  --eval) targets mongosh; see ROADMAP.md → Legacy mongo shell retirement.
 *
 *  Notes:
 *  - Do not Mongo.setReadPref(): mongosh reconnects. $sample uses per-command
 *    RP (mongosh options.readPreference; legacy mongo cursor.readPref).
 */

// Usage: "[mongo|mongosh] [connection options] [--quiet] [-f|--file] </path/to/>schema-sampler.js > schema.json"

/*
 *  User defined parameters
 */

const userOptions = {
   "sampleSize": 1, // defaults to 1 for performance reasons, increase for sparse data
   "filter": {
      "db": /^(?!admin$|config$|local$).+/, // or ['app', 'analytics', 'foo', 'bar']
      "collection": /^(?!system\.)/
   },
   "readPreference": "secondaryPreferred"
};

((userOptions = {}) => {
   /*
    *
    */
   const __script = { "name": "schema-sampler.js", "version": "0.2.16" };
   print(`\n#### Running script ${__script.name} v${__script.version}\n`);

   function main({ sampleSize = 1, dbs = [], readPreference = 'secondaryPreferred' }) {
      /*
       *  main
       */
      // Do not Mongo.setReadPref(): mongosh reconnects and closes the client.
      const schema = getSchema(sampleSize, readPreference);
      genReport(schema);

      return;
   }

   function getSchema(sampleSize = 1, readPreference = 'secondaryPreferred') {
      /*
       *  generate a synthetic schema with metadata
       */
      const comment = `Executed by ${__script.name} v${__script.version}`;
      const collectionPipeline = [{ "$sample": { "size": sampleSize } }];
      const viewPipeline = [{ "$sample": { "size": 1 } }];
      const options = {
         "allowDiskUse": false,
         "cursor": { "batchSize": sampleSize },
         "readConcern": { "level": "local" },
         "comment": comment
      };
      // Per-command RP on $sample. Legacy mongo rejects readPreference on
      // aggregate options — use cursor.readPref() there.
      const isMongosh = typeof process !== 'undefined';
      if (isMongosh)
         options.readPreference = { "mode": readPreference };
      const sampleAgg = (coll, pipeline) => {
         const cursor = coll.aggregate(pipeline, options);
         if (!isMongosh && typeof cursor.readPref === 'function')
            cursor.readPref(readPreference);
         return cursor.toArray();
      };
      const listDbOpts = [{
         "listDatabases": 1,
         "filter": { "name": /(?:^(?!(admin|config|local)$).+)/ },
         "nameOnly": true,
         "authorizedDatabases": true
      }];
      // db.runCommand({ "listCollections": 1, "authorizedCollections": true, "nameOnly": true });
      const listColOpts = [{
            "type": "collection",
            "name": /(?:^(?!system\..+$).+)/
         },
         true, true
      ];
      const listViewOpts = [{
            "type": "view",
            "name": /(?:^(?!system\..+$).+)/
         },
         true, true
      ];
      const dbs = () => db.adminCommand(...listDbOpts).databases.map(dbName => dbName.name);
      const namespace = (dbName, collName) => db.getSiblingDB(dbName).getCollection(collName);
      const collections = dbName => {
         return db.getSiblingDB(dbName)
            .getCollectionInfos(...listColOpts)
            .map(({ 'name': collName }) => ({
               "name":      collName,
               "documents": namespace(dbName, collName).estimatedDocumentCount(),
               "indexes":   namespace(dbName, collName).getIndexes(),
               "$sample":   sampleAgg(namespace(dbName, collName), collectionPipeline)
            }));
      };
      const views = dbName => {
         return db.getSiblingDB(dbName)
            .getCollectionInfos(...listViewOpts)
            .map(({ 'name': viewName, 'options': viewOptions }) => ({
               "name":     viewName,
               "options":  viewOptions,
               "$sample":  sampleAgg(namespace(dbName, viewName), viewPipeline)
            }));
      };
      return dbs().map(dbName => ({
         "db": dbName,
         "collections": collections(dbName),
         "views": views(dbName)
      }));
   }

   function genReport(schema) {
      /*
       *  report
       */
      return (typeof process !== 'undefined')
           ? console.log(util.inspect(schema, { "depth": null, "colors": true }))
           : print(tojson(schema));
   }

   main(userOptions);
})(userOptions);

// EOF
