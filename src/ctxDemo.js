(async() => {
   /*
    *  Name: "ctxDemo.js"
    *  Version: "0.1.0"
    *  Description: "demonstrates db injection after load() — lexical scope vs mdblib.for(db)"
    *  Disclaimer: "https://raw.githubusercontent.com/tap1r/mongodb-scripts/master/DISCLAIMER.md"
    *  Authors: ["tap1r <luke.prochazka@gmail.com>"]
    *  Roadmap: "https://raw.githubusercontent.com/tap1r/mongodb-scripts/master/ROADMAP.md" (required context)
    *
    *  Legacy archive line: v0.1.0 in legacy/mongo-shell is the frozen sketch
    *  (it still falls back to isMaster). This live file continues that sketch
    *  on the mongosh line. The version string stays 0.1.0 until a bump is
    *  requested. See ROADMAP.md → ctxDemo.js.
    *
    *  Notes:
    *  - mongosh only
    *  - does not load mdblib.js; a tiny stand-in library is defined in this file
    *  - hello() only. No isMaster fallback (SERVER-49989; replies differ)
    *  - uses getSiblingDB() handles (same Mongo client, different Database)
    *    and connect() (a second client) so you can see which object helpers talk to
    *
    *  Usage:
    *    mongosh [connection options] [--quiet] [-f|--file] </path/to/>ctxDemo.js
    */

   /*
    *  Stand-in for mdblib.js
    *
    *  load() would evaluate this in the shell global. Function bodies that
    *  mention `db` as a free identifier therefore always resolve to
    *  globalThis.db — the session's *current* database — not a local
    *  `const db` at the call site.
    */

   function identityFromGlobalDb() {
      /*
       *  How mdblib helpers look today: free `db`, no parameter.
       */
      return describe('globalThis.db', db);
   }

   function identityFrom(db) {
      /*
       *  Internal helper: Database is always an argument.
       */
      return describe('injected', db);
   }

   function createLib(db) {
      /*
       *  Bound facade. Nested calls close over THIS db, not the shell current db.
       */
      return {
         db,
         identity: () => identityFrom(db),
         hello: () => db.hello(),
         name: () => db.getName()
      };
   }

   const mdblib = {
      for: createLib,
      identity: identityFrom
   };

   function describe(label, handle) {
      let hello = {};
      try {
         hello = handle.hello();
      } catch(e) {
         hello = { "ok": 0, "error": e.errmsg ?? e.message ?? String(e) };
      }
      const parentMongo = globalThis.db.getMongo();
      return {
         "label": label,
         "dbName": handle.getName(),
         "me": hello.me ?? null,
         "msg": hello.msg ?? null,
         "sameMongoAsParent": handle.getMongo() === parentMongo
      };
   }

   function banner(title) {
      console.log(`\n==== ${title} ====`);
   }

   function show(step, value) {
      console.log(`\n${step}`);
      console.log(value);
   }

   /*
    *  Handles under test
    */
   const parent = db;                      // shell current Database
   const admin = db.getSiblingDB('admin'); // same Mongo client, different db name
   const configDb = db.getSiblingDB('config');
   const parentUri = db.getMongo().getURI();

   banner('0. Shell current db (baseline)');
   show('parent (global db)', describe('parent', parent));
   show('admin sibling', describe('admin sibling', admin));
   show('config sibling', describe('config sibling', configDb));
   console.log('\nSibling handles share the Mongo client with the parent.');
   console.log('If injection works, dbName changes; me / sameMongoAsParent stay put.');

   banner('1. The trap: a local `const db` does not rebind loaded helpers');
   console.log(`
   function identityFromGlobalDb() { return db.getName(); } // defined at load() / top level

   const db = admin;       // local, shadows nothing inside the helper
   identityFromGlobalDb(); // still reads globalThis.db
   `);
   (function callSiteShadow() {
      const db = admin;
      void db; // deliberately unused: this is the trap
      show(
         'called with local `const db = admin` in the caller — helper still sees parent',
         identityFromGlobalDb()
      );
   })();
   console.log('\nExpected: dbName is still the parent, not "admin".');
   console.log('Lexical scope is fixed where the function was defined (the global file).');

   banner('2. Explicit parameter');
   show('mdblib.identity(parent)', mdblib.identity(parent));
   show('mdblib.identity(admin)  ← dbName should be "admin"', mdblib.identity(admin));
   show('mdblib.identity(configDb) ← dbName should be "config"', mdblib.identity(configDb));

   banner('3. mdblib.for(db) — contextualise once per scope');
   const mParent = mdblib.for(parent);
   const mAdmin = mdblib.for(admin);
   show('mdblib.for(parent).identity()', mParent.identity());
   show('mdblib.for(admin).identity()  ← nested hello() uses admin, not global db', mAdmin.identity());
   console.log(`\nmAdmin.name() => ${mAdmin.name()}`);
   console.log('Discovery-style: const m = mdblib.for(node); then m.hello() / m.stats()');

   banner('4. Second Mongo client via connect() (discovery.js pattern)');
   let node;
   try {
      node = connect(parentUri);
   } catch(e) {
      console.log(`connect(parent URI) failed: ${e.errmsg ?? e.message ?? String(e)}`);
      node = null;
   }
   if (node) {
      const mNode = mdblib.for(node);
      show('mdblib.for(node).identity() after connect(parentUri)', mNode.identity());
      console.log('\nsameMongoAsParent should be false: this is a distinct client.');
      console.log('Cache keys must be db.getMongo() (WeakMap), not a module-level let.');
      console.log('Do not assign `db = node` — parallel cmdFns would race the global.');
   }

   banner('5. Parallel tasks each bind their own facade');
   const results = await Promise.all(
      [admin, configDb].map(async handle => mdblib.for(handle).identity())
   );
   show('Promise.all of mdblib.for(admin|config).identity()', results);
   console.log('\nEach result keeps the dbName from its own handle.');
   console.log('That only works because `db` was captured by for(); a global cache would collapse them.');

   banner('6. Hello cache: one module-level let vs WeakMap keyed by getMongo()');
   console.log(`
   A Mongo-keyed cache is shared by sibling databases on that client.
   It must not be shared with a second connect() client.
   The Database name still comes from the handle passed in, not from the cache.
   `);

   let moduleHello = null;
   function helloViaModuleLet(handle) {
      /*
       *  One cache for the whole load(). The first caller stamps it.
       *  A later client reuses that stamp. mdblib withChildSession swaps
       *  this kind of cache serially; it does not key by Mongo client.
       *  cachedMongoIsHandle is the proof: db names can match across clients.
       */
      const mongo = handle.getMongo();
      const hit = moduleHello !== null;
      if (!moduleHello) {
         const doc = handle.hello();
         moduleHello = {
            "mongo": mongo,
            "owner": handle.getName(),
            "me": doc.me ?? null
         };
      }
      return {
         "cache": "module-let",
         "hit": hit,
         "asked": handle.getName(),
         "owner": moduleHello.owner,
         "cachedMongoIsHandle": moduleHello.mongo === mongo,
         "me": moduleHello.me
      };
   }

   const helloByMongo = new WeakMap();
   function helloViaWeakMap(handle) {
      const mongo = handle.getMongo();
      let entry = helloByMongo.get(mongo);
      const hit = !!entry;
      if (!entry) {
         const doc = handle.hello();
         entry = {
            "mongo": mongo,
            "owner": handle.getName(),
            "me": doc.me ?? null
         };
         helloByMongo.set(mongo, entry);
      }
      return {
         "cache": "weakmap",
         "hit": hit,
         "asked": handle.getName(),
         "owner": entry.owner,
         "cachedMongoIsHandle": entry.mongo === mongo,
         "me": entry.me,
         "sameMongoAsParent": mongo === parent.getMongo()
      };
   }

   show('module-let filled by parent', helloViaModuleLet(parent));
   show(
      'module-let asked for admin — owner stays the parent (same client, so this one is harmless)',
      helloViaModuleLet(admin)
   );
   show('weakmap filled by parent', helloViaWeakMap(parent));
   show(
      'weakmap asked for admin — hit, sameMongoAsParent true, owner stays the parent',
      helloViaWeakMap(admin)
   );
   if (node) {
      show(
         'module-let asked for the second client — hit, cachedMongoIsHandle false',
         helloViaModuleLet(node)
      );
      show(
         'weakmap asked for the second client — miss, cachedMongoIsHandle true',
         helloViaWeakMap(node)
      );
   } else {
      console.log('\nSecond client was not connected, so the cross-client miss is skipped.');
   }
   console.log('\nfor() still separates db names. The WeakMap only separates Mongo clients.');

   banner('7. Assigning the global db races; for() does not');
   console.log(`
   Both tasks assign global db, then wait until both assignments have happened,
   then read. The last assignment wins for every reader.
   Section 5 kept both names because each facade closed over its handle.
   `);
   const savedDb = db;
   try {
      let arrived = 0;
      let release;
      const bothAssigned = new Promise(resolve => { release = resolve; });
      const raced = await Promise.all([admin, configDb].map(async handle => {
         db = handle;
         arrived++;
         if (arrived === 2) release();
         await bothAssigned;
         return {
            "asked": handle.getName(),
            "seen": identityFromGlobalDb().dbName
         };
      }));
      show('both tasks read global db after both assignments', raced);
      console.log('\nExpected: both seen values are "config" (the later assignment).');
   } finally {
      db = savedDb;
   }

   if (node && node.getMongo() !== parent.getMongo()) {
      try { node.getMongo().close(); }
      catch(e) { console.log(`close(second client) failed: ${e.errmsg ?? e.message ?? String(e)}`); }
   }

   banner('done');
})();

// EOF
