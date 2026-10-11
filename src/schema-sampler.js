/*
 *  Name: "schema-sampler.js"
 *  Version: "0.4.0"
 *  Description: generate schema with simulated mongosqld sampling commands
 *  Disclaimer: https://raw.githubusercontent.com/tap1r/mongodb-scripts/master/DISCLAIMER.md
 *  Authors: ["tap1r <luke.prochazka@gmail.com>"]
 *  Roadmap: "https://raw.githubusercontent.com/tap1r/mongodb-scripts/master/ROADMAP.md" (required context)
 *
 *  Dual-shell snapshot: legacy/mongo-shell (v0.2.16). This file is mongosh-only.
 *
 *  Notes:
 *  - Do not Mongo.setReadPref(): mongosh reconnects. $sample uses per-command RP.
 *  - filter.db / filter.collection drive listDatabases and getCollectionInfos
 *    (RegExp, string, or array of names). Catalog results are also matched
 *    client-side so a server that ignores listDatabases.filter still honours them.
 *  - --eval var options overlays optionDefaults. Do not declare options in this file.
 */

// Usage: mongosh [connection options] [--quiet] [--eval 'var options = {...};'] [-f|--file] </path/to/>schema-sampler.js > schema.json
// Overlay: in-file optionDefaults then var options. Do not declare options in this file.
//
//    mongosh --quiet --eval 'var options = { "sampleSize": 100, "filter": { "db": "app" } };' -f schema-sampler.js

/*
 *  In-file defaults. --eval var options overlays these (filter keys merge).
 */

const optionDefaults = {
   "sampleSize": 1, // defaults to 1 for performance reasons, increase for sparse data
   "filter": {
      "db": /^(?!admin$|config$|local$).+/, // or ['app', 'analytics', 'foo', 'bar']
      "collection": /^(?!system\.)/
   },
   "readPreference": "secondaryPreferred"
};

(() => {
   const __script = { "name": "schema-sampler.js", "version": "0.4.0" };
   print(`\n#### Running script ${__script.name} v${__script.version}\n`);

   function isPlainObject(value) {
      return !!value && typeof value === 'object' && !Array.isArray(value);
   }

   function hasOwn(obj, key) {
      return !!obj && Object.prototype.hasOwnProperty.call(obj, key);
   }

   // Caller: var options = { ... } (--eval or REPL). Do not declare or assign it in this file.
   const overlay = (typeof options !== 'undefined' && options) ? options : null;
   const filterOver = (overlay && isPlainObject(overlay.filter)) ? overlay.filter : {};
   const resolved = {
      "sampleSize": (overlay && overlay.sampleSize != null)
         ? overlay.sampleSize
         : optionDefaults.sampleSize,
      "readPreference": (overlay && overlay.readPreference != null)
         ? overlay.readPreference
         : optionDefaults.readPreference,
      "filter": {
         "db": hasOwn(filterOver, 'db') ? filterOver.db : optionDefaults.filter.db,
         "collection": hasOwn(filterOver, 'collection')
            ? filterOver.collection
            : optionDefaults.filter.collection
      }
   };

   function catalogNameQuery(spec) {
      if (spec == null || spec === '') return null;
      if (spec instanceof RegExp || typeof spec === 'string') return spec;
      if (Array.isArray(spec)) return { "$in": spec };
      return spec;
   }

   function nameAccepted(name, spec) {
      if (spec == null || spec === '') return true;
      if (spec instanceof RegExp) return spec.test(name);
      if (typeof spec === 'string') return name === spec;
      if (Array.isArray(spec)) return spec.includes(name);
      if (spec && Array.isArray(spec.$in)) return spec.$in.includes(name);
      return true;
   }

   function main({
      sampleSize = 1,
      filter: {
         db: filterDb = /^(?!admin$|config$|local$).+/,
         collection: filterCollection = /^(?!system\.)/
      } = {},
      readPreference = 'secondaryPreferred'
   } = {}) {
      // Do not Mongo.setReadPref(): mongosh reconnects and closes the client.
      const schema = getSchema(sampleSize, readPreference, {
         "db": filterDb,
         "collection": filterCollection
      });
      genReport(schema);
   }

   function getSchema(sampleSize = 1, readPreference = 'secondaryPreferred', filter = {}) {
      const comment = `Executed by ${__script.name} v${__script.version}`;
      const collectionPipeline = [{ "$sample": { "size": sampleSize } }];
      const viewPipeline = [{ "$sample": { "size": 1 } }];
      const aggOptions = {
         "allowDiskUse": false,
         "cursor": { "batchSize": sampleSize },
         "readConcern": { "level": "local" },
         "comment": comment
      };
      aggOptions.readPreference = { "mode": readPreference };
      const sampleAgg = (coll, pipeline) => coll.aggregate(pipeline, aggOptions).toArray();
      const listOptions = { "nameOnly": true, "authorizedCollections": true };
      const collectionNameQuery = catalogNameQuery(filter.collection);
      const listColFilter = { "type": "collection" };
      const listViewFilter = { "type": "view" };
      if (collectionNameQuery != null) {
         listColFilter.name = collectionNameQuery;
         listViewFilter.name = collectionNameQuery;
      }

      function listDatabaseNames() {
         const cmd = {
            "listDatabases": 1,
            "nameOnly": true,
            "authorizedDatabases": true
         };
         const dbNameQuery = catalogNameQuery(filter.db);
         if (dbNameQuery != null)
            cmd.filter = { "name": dbNameQuery };
         const exec = document => db.getSiblingDB('admin').runCommand(
            document,
            { "readPreference": { "mode": readPreference } }
         );
         let result;
         try {
            result = exec(cmd);
         } catch (e) {
            if (!cmd.filter) throw e;
            delete cmd.filter;
            result = exec(cmd);
         }
         if (result && result.ok === 0 && cmd.filter) {
            delete cmd.filter;
            result = exec(cmd);
         }
         return (result && result.databases || [])
            .map(entry => entry.name)
            .filter(name => nameAccepted(name, filter.db));
      }

      const namespace = (dbName, collName) => db.getSiblingDB(dbName).getCollection(collName);
      const collections = dbName => {
         return db.getSiblingDB(dbName)
            .getCollectionInfos(listColFilter, listOptions)
            .filter(({ name }) => nameAccepted(name, filter.collection))
            .map(({ 'name': collName }) => ({
               "name":      collName,
               "documents": namespace(dbName, collName).estimatedDocumentCount(),
               "indexes":   namespace(dbName, collName).getIndexes(),
               "$sample":   sampleAgg(namespace(dbName, collName), collectionPipeline)
            }));
      };
      const views = dbName => {
         return db.getSiblingDB(dbName)
            .getCollectionInfos(listViewFilter, listOptions)
            .filter(({ name }) => nameAccepted(name, filter.collection))
            .map(({ 'name': viewName, 'options': viewOptions }) => ({
               "name":     viewName,
               "options":  viewOptions,
               "$sample":  sampleAgg(namespace(dbName, viewName), viewPipeline)
            }));
      };
      return listDatabaseNames().map(dbName => ({
         "db": dbName,
         "collections": collections(dbName),
         "views": views(dbName)
      }));
   }

   function genReport(schema) {
      return console.log(util.inspect(schema, { "depth": null, "colors": true }));
   }

   main(resolved);
})();

// EOF
