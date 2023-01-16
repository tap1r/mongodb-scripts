/*
 *  Name: "schema-sampler.js"
 *  Version: "0.2.4"
 *  Description: generate schema with simulated mongosqld sampling commands
 *  Authors: ["tap1r <luke.prochazka@gmail.com>"]
 */

// Usage: "[mongo|mongosh] [connection options] --quiet schema-sampler.js > schema.json"

let userOptions = {  // user preferences
   // "sampleSize": 1, // defaults to 1 for performance reasons, increase for sparse data
   // "dbs": ['namespace'], // restrict list to known namespaces
   // "readPreference": 'secondaryPreferred'
};

((userOptions = {}) => {
   /*
    *
    */
   const __script = { "name": "schema-sampler.js", "version": "0.2.4" };
   print(`\nRunning script ${__script.name} v${__script.version}`);
   
   function main({ sampleSize = 1, dbs = [], readPreference = 'secondaryPreferred' }) {
      /*
       *  main
       */
      db.getMongo().setReadPref(readPreference);
      // (dbs === 'undefined');
      let schema = getSchema(sampleSize);
      genReport(schema);

      return;
   }

   function getSchema(sampleSize) {
      /*
       *  generate a synthetic schema with metadata
       */
      let collectionPipeline = [{ "$sample": { "size": sampleSize } }];
      let viewPipeline = [{ "$sample": { "size": 1} }];
      // let comment = 'Executed by ' + __script.name + ' v' + __script.version;
      let listDbOpts = [{
            "listDatabases": 1,
            "filter": { "name": /(?:^(?!admin$|config$|local$)).+/ },
            "nameOnly": true,
            "authorizedDatabases": true
         },
         // comment
      ];
      // db.runCommand({ "listCollections": 1, "authorizedCollections": true, "nameOnly": true });
      let listColOpts = [{
            "type": "collection",
            "name": { "$regex": /(?!^(?:system\\.))/ }
         },
         true,
         true
      ];
      let listViewOpts = [{
            "type": "view",
            "name": { "$regex": /(?!^(?:system\\.))/ }
         },
         true,
         true
      ];
      let dbs = db.adminCommand(...listDbOpts).databases.map(dbName => dbName.name);
      return dbs.map(dbName => ({
            "db": dbName,
            "collections": db.getSiblingDB(dbName)
                             .getCollectionInfos(...listColOpts)
                             .map(collection => ({
                                 "name":         collection.name,
                                 "documents":    db.getSiblingDB(dbName)
                                                   .getCollection(collection.name)
                                                   .stats().count,
                                 "indexes":      db.getSiblingDB(dbName)
                                                   .getCollection(collection.name)
                                                   .getIndexes(),
                                 "$sample":      db.getSiblingDB(dbName)
                                                   .getCollection(collection.name)
                                                   .aggregate(collectionPipeline)
                                                   .toArray()
            })),
            "views": db.getSiblingDB(dbName)
                     .getCollectionInfos(...listViewOpts)
                     .map(view => ({
                           "name":     view.name,
                           "options":  view.options,
                           "$sample":  db.getSiblingDB(dbName)
                                         .getCollection(view.name)
                                         .aggregate(viewPipeline)
                                         .toArray()
            }))
      }))
   }

   function genReport(schema) {
      /*
       *  report
       */

      return print(`\n${JSON.stringify(schema, null, '  ')}\n`);
   }

   main(userOptions);
})(userOptions);

// EOF
