/*
 *  Name: "schema-sampler.js"
 *  Version: "0.2.12"
 *  Description: generate schema with simulated mongosqld sampling commands
 *  Disclaimer: https://raw.githubusercontent.com/tap1r/mongodb-scripts/master/DISCLAIMER.md
 *  Authors: ["tap1r <luke.prochazka@gmail.com>"]
 */

// Usage: "[mongo|mongosh] [connection options] --quiet schema-sampler.js > schema.json"

/*
 *  User defined parameters
 */

const userOptions = {
   "sampleSize": 1, // defaults to 1 for performance reasons, increase for sparse data
   // "dbs": ['namespace'], // restrict list to known namespaces
   // "readPreference": 'secondaryPreferred'
};

((userOptions = {}) => {
   /*
    *
    */
   const __script = { "name": "schema-sampler.js", "version": "0.2.12" };
   print(`\n#### Running script ${__script.name} v${__script.version}\n`);

   function main({ sampleSize = 1, dbs = [], readPreference = 'secondaryPreferred' }) {
      /*
       *  main
       */
      db.getMongo().setReadPref(readPreference);
      // (dbs === 'undefined');
      const schema = getSchema(sampleSize);
      genReport(schema);

      return;
   }

   function getSchema(sampleSize = 1) {
      /*
       *  generate a synthetic schema with metadata
       */
      const comment = `Executed by ${__script.name} v${__script.version}`;
      const collectionPipeline = [{ "$sample": { "size": sampleSize } }];
      const viewPipeline = [{ "$sample": { "size": 1 } }];
      const options = {
         "allowDiskUse": true,
         "cursor": { "batchSize": sampleSize },
         "readConcern": { "level": "local" },
         "comment": comment
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
      const collections = (dbName) => {
         return db.getSiblingDB(dbName)
           .getCollectionInfos(...listColOpts)
           .map(({ 'name': collName }) => ({
               "name":      collName,
               "documents": namespace(dbName, collName).stats().count,
               "indexes":   namespace(dbName, collName).getIndexes(),
               "$sample":   namespace(dbName, collName).aggregate(collectionPipeline, options).toArray()
            }))
      };
      const views = (dbName) => {
         return db.getSiblingDB(dbName)
           .getCollectionInfos(...listViewOpts)
           .map(({ 'name': viewName, 'options': viewOptions }) => ({
               "name":     viewName,
               "options":  viewOptions,
               "$sample":  namespace(dbName, viewName).aggregate(viewPipeline, options).toArray()
            }))
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
           : print(tojson(schema))
   }

   main(userOptions);
})(userOptions);

// EOF
