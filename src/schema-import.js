/*
 *  Name: "schema-import.js"
 *  Version: "0.1.2"
 *  Description: import schema generated by schema-sampler.js
 *  Authors: ["tap1r <luke.prochazka@gmail.com>"]
 */

// Usage: "mongosh [connection options] --quiet schema-import.js"

let __script = { "name": "schema-import.js", "version": "0.1.2" };
print(`\n---> Running script ${__script.name} v${__script.version}\n`);

let userOptions = {
   /*
    *  user preferences
    */
   "schemaFile": "schema.json",
   // "readPreference": "primaryPreferred"
}

((userOptions = {}) => {
   function main({ schemaFile = 'schema.json', readPreference = 'primaryPreferred' }) {
      /*
       *  main
       */
      db.getMongo().setReadPref(readPreference);
      let schema = loadSchemaFile(schemaFile);
      let dbs = listDBs(schema);
      // pretty(dbs);
      // parse and create DB namespaces
      // parse and create collections with data
      // parse and create indexes
      // parse and create views

      return;
   }

   function loadSchemaFile(file) {
      try {
         return JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch(e) {
         console.dir(e.stack);
      }

      return;
   }

   function listDBs(schema) {
      let dbNames = [];
      for (let i = 0; i < schema.length; ++i) {
         console.log(schema[i].db);
      }

      return dbNames;
   }

   function pretty(json) {
      /*
       *  report
       */
      console.log(`\n`);
      // console.log(JSON.stringify(schema, null, '  '));
      console.dir(json);
      console.log(`\n`);

      return;
   }

   main(userOptions);
})(userOptions);

// EOF
