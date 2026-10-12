(async() => {
   /*
    *  Name: "ctxDemo.js"
    *  Version: "0.2.0"
    *  Description: "demonstrates db injection after load() — lexical scope vs mdblib.for(db)"
    *  Disclaimer: "https://raw.githubusercontent.com/tap1r/mongodb-scripts/master/DISCLAIMER.md"
    *  Authors: ["tap1r <luke.prochazka@gmail.com>"]
    *  Roadmap: "https://raw.githubusercontent.com/tap1r/mongodb-scripts/master/ROADMAP.md" (required context)
    *
    *  Legacy archive line: v0.1.0 in legacy/mongo-shell is the frozen sketch
    *  (it still falls back to isMaster). This live file is v0.2.0 on the
    *  mongosh line. See ROADMAP.md → ctxDemo.js.
    *
    *  Notes:
    *  - mongosh only
    *  - does not load mdblib.js; a tiny stand-in library is defined in this file
    *  - hello() only. No isMaster fallback (SERVER-49989; replies differ)
    *  - sibling getSiblingDB() handles share one Mongo client
    *  - a targeted context is a directConnection client to one hello.hosts
    *    member (primary and the other members). connect(parent URI) is not
    *    that: server selection can land on the same member again
    *  - snapshot() awaits the driver client's command({ hello: 1 }). Shell
    *    hello() and runCommand() return on the current turn, so Promise.all
    *    of those does not overlap. The WeakMap stores that promise
    *  - never prints a URI
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
    *
    *  for(db) closes over the Database (name, stats). A hello snapshot is
    *  keyed by getMongo(). Sibling databases share that snapshot. Two
    *  members do not.
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

   const snapshotByMongo = new WeakMap();
   const flight = { "started": 0, "returned": 0, "maxInFlight": 0 };
   const clockOrigin = process.hrtime.bigint();

   function elapsedMs() {
      return Math.round(Number(process.hrtime.bigint() - clockOrigin) / 1e4) / 100;
   }

   function isThenable(value) {
      return !!(value && typeof value.then === 'function' && typeof value.close !== 'function');
   }

   async function awaitPlain(value) {
      if (isThenable(value)) return await value;
      return value;
   }

   /*
    *  Shell Database.runCommand() / hello() return the document on this turn.
    *  The driver MongoClient.command() returns a Promise, which is what lets
    *  Promise.all keep one hello in flight per member.
    */
   function commandAsync(handle, command) {
      const mongo = handle.getMongo();
      const client = mongo && mongo._serviceProvider && mongo._serviceProvider.mongoClient;
      if (client && typeof client.db === 'function') {
         return client.db(handle.getName()).command(command);
      }
      return handle.runCommand(command);
   }

   function readHello(handle) {
      const doc = handle.hello();
      return {
         "me": doc.me ?? null,
         "msg": doc.msg ?? null,
         "setName": doc.setName ?? null,
         "writable": doc.isWritablePrimary === true,
         "secondary": doc.secondary === true
      };
   }

   async function readHelloAsync(handle) {
      /*
       *  One-shot hello. No topologyVersion and no maxAwaitTimeMS.
       */
      const startedMs = elapsedMs();
      const pending = commandAsync(handle, { "hello": 1 });
      const asyncCommand = isThenable(pending);
      if (asyncCommand) {
         flight.started++;
         const inFlight = flight.started - flight.returned;
         if (inFlight > flight.maxInFlight) flight.maxInFlight = inFlight;
      }
      let doc;
      try {
         doc = await awaitPlain(pending) || {};
      } finally {
         if (asyncCommand) flight.returned++;
      }
      return {
         "me": doc.me ?? null,
         "msg": doc.msg ?? null,
         "setName": doc.setName ?? null,
         "writable": doc.isWritablePrimary === true,
         "secondary": doc.secondary === true,
         "startedMs": startedMs,
         "returnedMs": elapsedMs(),
         "asyncCommand": asyncCommand
      };
   }

   async function snapshotOf(handle) {
      /*
       *  Per Mongo client. Store the promise before awaiting so a second
       *  caller on this client shares the command already in flight.
       *  A sibling database hits. A direct client to another member misses.
       */
      const mongo = handle.getMongo();
      let pending = snapshotByMongo.get(mongo);
      const hit = !!pending;
      if (!pending) {
         pending = readHelloAsync(handle);
         snapshotByMongo.set(mongo, pending);
      }
      const hello = await pending;
      return {
         "cache": "weakmap",
         "hit": hit,
         "dbName": handle.getName(),
         "me": hello.me,
         "setName": hello.setName,
         "writable": hello.writable,
         "secondary": hello.secondary,
         "cachedMongoIsHandle": true,
         "startedMs": hello.startedMs,
         "returnedMs": hello.returnedMs,
         "asyncCommand": hello.asyncCommand === true
      };
   }

   function dbScope(handle) {
      /*
       *  Database-scoped. Not stored on the Mongo snapshot.
       */
      try {
         const stats = handle.stats();
         return {
            "dbName": handle.getName(),
            "collections": stats.collections,
            "objects": stats.objects
         };
      } catch(e) {
         return { "dbName": handle.getName(), "error": scrub(e.errmsg ?? e.message ?? e) };
      }
   }

   function createLib(db) {
      /*
       *  Bound facade. Nested calls close over THIS db, not the shell current db.
       */
      return {
         db,
         identity: () => identityFrom(db),
         hello: () => db.hello(),
         name: () => db.getName(),
         snapshot: () => snapshotOf(db),
         scope: () => dbScope(db)
      };
   }

   const mdblib = {
      for: createLib,
      identity: identityFrom
   };

   function describe(label, handle) {
      let hello = {};
      try {
         hello = readHello(handle);
      } catch(e) {
         hello = { "ok": 0, "error": scrub(e.errmsg ?? e.message ?? e) };
      }
      const parentMongo = globalThis.db.getMongo();
      return {
         "label": label,
         "dbName": handle.getName(),
         "me": hello.me ?? null,
         "msg": hello.msg ?? null,
         "writable": hello.writable === true,
         "secondary": hello.secondary === true,
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

   function scrub(value) {
      return String(value).replace(/mongodb(\+srv)?:\/\/\S+/gi, 'mongodb://…');
   }

   /*
    *  One hello.hosts entry, pinned. Copies parent userinfo. Does not log the URI.
    *  Drops replicaSet so the driver cannot select a different member.
    */
   function directMemberUri(host) {
      const raw = parent.getMongo().getURI();
      if (!raw || typeof raw !== 'string') throw new Error('missing parent URI');
      const isSrv = /^mongodb\+srv:/i.test(raw);
      const withoutScheme = raw.replace(/^mongodb(\+srv)?:\/\//i, '');
      const authEnd = withoutScheme.search(/[/?]/);
      const authority = authEnd >= 0 ? withoutScheme.slice(0, authEnd) : withoutScheme;
      const at = authority.lastIndexOf('@');
      const userinfo = at >= 0 ? authority.slice(0, at) : '';
      const listed = at >= 0 ? authority.slice(at + 1) : authority;
      const rest = authEnd >= 0 ? withoutScheme.slice(authEnd) : '/';
      const firstHost = (listed.split(',')[0] || 'localhost').trim() || 'localhost';
      let url;
      try {
         url = new URL(`mongodb://${userinfo ? `${userinfo}@` : ''}${firstHost}${rest || '/'}`);
      } catch(e) {
         throw new Error(`directMemberUri: cannot parse parent URI (${scrub(e.message)})`);
      }
      const params = new URLSearchParams(url.searchParams);
      params.delete('replicaSet');
      params.delete('loadBalanced');
      params.delete('readPreference');
      params.delete('readPreferenceTags');
      params.delete('tags');
      params.set('directConnection', 'true');
      params.set('readPreference', 'primaryPreferred');
      params.set('serverSelectionTimeoutMS', '5000');
      params.set('connectTimeoutMS', '5000');
      if (isSrv && !params.has('tls') && !params.has('ssl')) params.set('tls', 'true');
      params.sort();
      const encodePart = (value) => {
         let decoded = String(value);
         try { decoded = decodeURIComponent(decoded); } catch(_) { /* keep raw */ }
         return encodeURIComponent(decoded);
      };
      let auth = '';
      if (url.username) {
         auth = encodePart(url.username);
         if (url.password) auth += `:${encodePart(url.password)}`;
         auth += '@';
      }
      const path = url.pathname && url.pathname.length ? url.pathname : '/';
      const q = params.toString();
      return `mongodb://${auth}${host}${path}${q ? `?${q}` : ''}`;
   }

   const children = [];

   function openDirect(host) {
      let handle;
      try {
         handle = connect(directMemberUri(host));
      } catch(e) {
         console.log(`direct connect to ${host} failed: ${scrub(e.errmsg ?? e.message ?? e)}`);
         return null;
      }
      if (handle && handle.getMongo() !== parent.getMongo()) children.push(handle);
      return handle;
   }

   function closeChildren() {
      for (const handle of children) {
         try { handle.getMongo().close(); }
         catch(e) { console.log(`close failed: ${scrub(e.errmsg ?? e.message ?? e)}`); }
      }
   }

   /*
    *  Handles under test
    */
   const parent = db;                      // shell current Database
   const admin = db.getSiblingDB('admin'); // same Mongo client, different db name
   const configDb = db.getSiblingDB('config');

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
   console.log('Same client, so for(admin).snapshot() hits the snapshot for(parent) just filled.');
   show('mdblib.for(parent).snapshot()', await mParent.snapshot());
   show('mdblib.for(admin).snapshot()', await mAdmin.snapshot());

   const savedDb = db;
   try {
      banner('4. Targeted member contexts (directConnection to each hello.hosts entry)');
      console.log(`
   connect(parent URI) opens a second client and can select the same member.
   A targeted context replaces the host and sets directConnection=true.
   pinned is hello.me === the host that context asked for.
   `);
      const topo = readHello(parent);
      const helloDoc = parent.hello();
      const hosts = Array.isArray(helloDoc.hosts) ? helloDoc.hosts.filter(Boolean) : [];
      const primaryHost = helloDoc.primary || helloDoc.me || null;
      show('parent topology', {
         "me": topo.me,
         "setName": topo.setName,
         "primary": primaryHost,
         "hosts": hosts,
         "writable": topo.writable,
         "secondary": topo.secondary
      });

      const members = [];
      if (!primaryHost || hosts.length < 2) {
         console.log('\nTargeted contexts need a replica set hello with a primary and another host.');
      } else {
         const ordered = [primaryHost, ...hosts.filter(host => host !== primaryHost)];
         for (const host of ordered) {
            const handle = openDirect(host);
            if (!handle) continue;
            const live = describe(host, handle);
            members.push({
               "host": host,
               "handle": handle,
               "role": host === primaryHost ? 'primary' : 'secondary'
            });
            show(`direct ${host === primaryHost ? 'primary' : 'secondary'} ${host}`, {
               ...live,
               "askedHost": host,
               "pinned": live.me === host
            });
         }
      }

      const primaryMember = members.find(member => member.role === 'primary') || null;
      const secondaries = members.filter(member => member.role === 'secondary');

      if (!primaryMember || !secondaries.length) {
         console.log('\nCould not pin both a primary and a secondary. Later sections stay on the shell client.');
      } else {
         banner('5. Parallel facades each read their own member snapshot');
         console.log(`
   snapshot() awaits driver command({ hello: 1 }) and stores that promise
   on the Mongo client before the await. maxInFlight counts commands whose
   start happened before an earlier command returned.
   `);
         flight.started = 0;
         flight.returned = 0;
         flight.maxInFlight = 0;
         const parallel = await Promise.all(members.map(async member => {
            const snap = await mdblib.for(member.handle).snapshot();
            return {
               "askedHost": member.host,
               "role": member.role,
               "dbName": snap.dbName,
               "me": snap.me,
               "writable": snap.writable,
               "secondary": snap.secondary,
               "hit": snap.hit,
               "asyncCommand": snap.asyncCommand,
               "startedMs": snap.startedMs,
               "returnedMs": snap.returnedMs
            };
         }));
         show('Promise.all of mdblib.for(member).snapshot()', parallel);
         const overlapped = parallel.length > 1
            && parallel.every(row => row.asyncCommand)
            && flight.maxInFlight === parallel.length;
         console.log(`\nmaxInFlight ${flight.maxInFlight} of ${parallel.length}. overlapped=${overlapped}.`);
         console.log('Expected: one row per host, me matches askedHost, one writable and the rest secondary.');

         banner('6. One module-level snapshot vs a WeakMap, and db scope on one client');
         console.log(`
   Fill the module-level snapshot from the direct primary.
   Asking it for a secondary must still return the primary me.
   A fresh WeakMap misses on that secondary and stores that member.
   admin on the primary client hits the primary snapshot; scope().dbName is admin.
   `);

         let moduleSnap = null;
         function snapshotViaModuleLet(handle) {
            const mongo = handle.getMongo();
            const hit = moduleSnap !== null;
            if (!moduleSnap) {
               moduleSnap = { "mongo": mongo, ...readHello(handle) };
            }
            return {
               "cache": "module-let",
               "hit": hit,
               "askedHost": handle.hello().me ?? null,
               "me": moduleSnap.me,
               "writable": moduleSnap.writable,
               "secondary": moduleSnap.secondary,
               "cachedMongoIsHandle": moduleSnap.mongo === mongo
            };
         }

         const freshByMongo = new WeakMap();
         function snapshotViaFreshWeakMap(handle) {
            const mongo = handle.getMongo();
            let entry = freshByMongo.get(mongo);
            const hit = !!entry;
            if (!entry) {
               entry = { "mongo": mongo, ...readHello(handle) };
               freshByMongo.set(mongo, entry);
            }
            return {
               "cache": "weakmap",
               "hit": hit,
               "dbName": handle.getName(),
               "me": entry.me,
               "writable": entry.writable,
               "secondary": entry.secondary,
               "cachedMongoIsHandle": entry.mongo === mongo
            };
         }

         show('module-let filled by direct primary', snapshotViaModuleLet(primaryMember.handle));
         show('fresh WeakMap filled by direct primary', snapshotViaFreshWeakMap(primaryMember.handle));
         for (const member of secondaries) {
            show(
               `module-let asked for ${member.host} — hit, me stays the primary, cachedMongoIsHandle false`,
               snapshotViaModuleLet(member.handle)
            );
            show(
               `fresh WeakMap asked for ${member.host} — miss, me is that host`,
               snapshotViaFreshWeakMap(member.handle)
            );
         }
         const primaryAdmin = primaryMember.handle.getSiblingDB('admin');
         show(
            'fresh WeakMap asked for admin on the primary client — hit, me stays the primary, dbName is admin',
            snapshotViaFreshWeakMap(primaryAdmin)
         );
         show('for(primary).scope()', mdblib.for(primaryMember.handle).scope());
         show('for(primary admin).scope()  ← dbName is admin, same Mongo snapshot', mdblib.for(primaryAdmin).scope());
         show('for(primary admin).name()', mdblib.for(primaryAdmin).name());

         banner('7. Assigning the global db collapses the member; for() does not');
         console.log(`
   Each task records its own hello.me, assigns the global db, then waits
   until every assignment has happened. The last assignment wins for every reader.
   Section 5 kept every member because each facade closed over its handle.
   `);
         let arrived = 0;
         let release;
         const bothAssigned = new Promise(resolve => { release = resolve; });
         const raced = await Promise.all(members.map(async member => {
            const askedMe = member.handle.hello().me ?? null;
            db = member.handle;
            arrived++;
            if (arrived === members.length) release();
            await bothAssigned;
            const seen = identityFromGlobalDb();
            return {
               "askedHost": member.host,
               "askedMe": askedMe,
               "seenMe": seen.me,
               "seenDb": seen.dbName
            };
         }));
         show('both tasks read global db after every assignment', raced);
         const last = members[members.length - 1];
         console.log(`\nExpected: every seenMe is ${last.host} (the later assignment).`);
      }
   } finally {
      db = savedDb;
      closeChildren();
   }

   banner('done');
})();

// EOF
