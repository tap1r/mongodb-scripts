(async() => {
   /*
    *  Name: "ctxDemo.js"
    *  Version: "0.2.2"
    *  Description: "demonstrates db injection after load() — lexical scope vs mdblib.for(db)"
    *  Disclaimer: "https://raw.githubusercontent.com/tap1r/mongodb-scripts/master/DISCLAIMER.md"
    *  Authors: ["tap1r <luke.prochazka@gmail.com>"]
    *  Roadmap: "https://raw.githubusercontent.com/tap1r/mongodb-scripts/master/ROADMAP.md" (required context)
    *
    *  Legacy archive line: v0.1.0 in legacy/mongo-shell is the frozen sketch
    *  (it still falls back to isMaster). This live file is v0.2.2 on the
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
    *  - identity(), hello(), snapshot(), and scope() await the driver
    *    client's command(). Shell hello(), runCommand(), and stats() return
    *    on the current turn, so Promise.all of those does not overlap.
    *    snapshot() stores the in-flight hello promise on the Mongo client.
    *    Section 6 still awaits, but it stores the resolved hello in one let
    *  - never prints a URI
    *  - walkthrough, not a smoke test. Each section prints the use case,
    *    the restriction, and the values to read. It does not assert.
    *    A pass/fail check waits until mdblib.for() exists and can be loaded
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

   async function identityFromGlobalDb() {
      /*
       *  How mdblib helpers look today: free `db`, no parameter.
       *  The read is awaited. The handle is still the shell's current db.
       */
      return describe('globalThis.db', db);
   }

   async function identityFrom(db) {
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
         "hosts": Array.isArray(doc.hosts) ? doc.hosts.filter(Boolean) : [],
         "primary": doc.primary || doc.me || null,
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

   async function dbScope(handle) {
      /*
       *  Database-scoped. Not stored on the Mongo snapshot.
       *  Same async command path as fetchDbStats. scale 1 keeps the reply small.
       */
      try {
         const stats = await awaitPlain(commandAsync(handle, { "dbStats": 1, "scale": 1 })) || {};
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
       *  name() is local. The commands return promises.
       */
      return {
         db,
         identity: () => identityFrom(db),
         hello: () => readHelloAsync(db),
         name: () => db.getName(),
         snapshot: () => snapshotOf(db),
         scope: () => dbScope(db)
      };
   }

   const mdblib = {
      for: createLib,
      identity: identityFrom
   };

   async function describe(label, handle) {
      let hello = {};
      try {
         hello = await readHelloAsync(handle);
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

   function explain(text) {
      /*
       *  Printed use-case note. Kept next to the banner so a run documents
       *  itself without a second file.
       */
      const body = String(text).replace(/^[ \t]+/gm, '').trim();
      console.log(`\n${body}`);
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
    *  Handles under test.
    *  parent is the shell's current Database. admin and config are sibling
    *  databases on that same Mongo client. They are not targeted members.
    */
   const parent = db;
   const admin = db.getSiblingDB('admin');
   const configDb = db.getSiblingDB('config');

   explain(`
   Walkthrough of a stand-in library. This file does not load mdblib.js and it does not pass or fail.
   Each section prints the use case, the restriction, and the values to read.
   A smoke test waits until mdblib.for() exists and these calls can be made against the real helpers.
   `);

   /*
    *  Use case 0 — baseline siblings on the shell client.
    *  getSiblingDB() changes the database name only. sameMongoAsParent stays
    *  true and me stays the member the shell selected. This is the control
    *  for later sections: a name change is not a new client.
    */
   banner('0. Shell current db (baseline)');
   explain(`
   Use case: three Database handles on the shell's current Mongo client.
   Read dbName, me, and sameMongoAsParent. admin and config must change dbName
   and leave me and sameMongoAsParent put. Restriction: these handles cannot
   stand in for a direct member. Discovery's local const db is a different
   binding from this client.
   `);
   show('parent (global db)', await describe('parent', parent));
   show('admin sibling', await describe('admin sibling', admin));
   show('config sibling', await describe('config sibling', configDb));

   /*
    *  Use case 1 — lexical trap.
    *  A const db in the caller does not rebind a helper defined at load time.
    *  That is why load('mdblib.js') inside a discovery block cannot aim the
    *  library at that block's node.
    */
   banner('1. The trap: a local `const db` does not rebind loaded helpers');
   explain(`
   Use case: the caller shadows db with const db = admin, then calls a helper
   that was defined at the top of the file and reads free db.
   Read dbName. It must stay the parent, not "admin".
   Restriction: functions have to be written to take the handle. A local const
   in connectAndExec does not reach helpers that load() already defined.
   `);
   await (async function callSiteShadow() {
      const db = admin;
      void db; // deliberately unused: this is the trap
      show(
         'called with local `const db = admin` in the caller — helper still sees parent',
         await identityFromGlobalDb()
      );
   })();

   /*
    *  Use case 2 — pass the Database as an argument.
    *  identity(admin) reports admin. me stays the shell member because the
    *  argument is a sibling, not a new client. A default parameter written
    *  as db.getName() would still read the global, so the caller must pass
    *  the name from the handle.
    */
   banner('2. Explicit parameter');
   explain(`
   Use case: mdblib.identity(handle) takes the Database as an argument.
   Read dbName. parent, admin, and config must report those names. me stays
   the shell member because these are siblings, not new clients.
   Restriction: every helper in the call chain must take the handle. A default
   such as dbName = db.getName() still reads the global db.
   `);
   show('mdblib.identity(parent)', await mdblib.identity(parent));
   show('mdblib.identity(admin) — dbName is admin', await mdblib.identity(admin));
   show('mdblib.identity(configDb) — dbName is config', await mdblib.identity(configDb));

   /*
    *  Use case 3 — for(db) once per block.
    *  The facade closes over that Database. name() and identity() use it.
    *  snapshot() is keyed by getMongo(), so for(admin) hits the snapshot
    *  for(parent) just filled. for() does not open a client and does not
    *  set read preference.
    */
   banner('3. mdblib.for(db) — one facade per Database');
   explain(`
   Use case: mdblib.for(handle) binds the Database once for every method on
   the returned object. The block owns the handle. The facade does not assign
   the global db.
   Read dbName on identity(), name(), and the admin snapshot. name() must be
   "admin". The admin snapshot must be a hit and its me must match the parent,
   because both handles share getMongo().
   Restriction: for() does not open, close, or set read preference. A nested
   helper that still calls the global hello() escapes the binding.
   `);
   const mParent = mdblib.for(parent);
   const mAdmin = mdblib.for(admin);
   show('mdblib.for(parent).identity()', await mParent.identity());
   show('mdblib.for(admin).identity() — nested hello uses admin', await mAdmin.identity());
   show('mdblib.for(admin).name()', mAdmin.name());
   show('mdblib.for(parent).snapshot() — fills the shell client', await mParent.snapshot());
   show('mdblib.for(admin).snapshot() — hit, same me, dbName admin', await mAdmin.snapshot());

   const savedDb = db;
   try {
      /*
       *  Use case 4 — one direct client per advertised member.
       *  The child URI copies parent userinfo, replaces the host, sets
       *  directConnection, and drops replicaSet. pinned is hello.me === host.
       *  connect(parent URI) is not this case: server selection can land on
       *  the same member. The URI is never printed.
       */
      banner('4. Targeted member contexts (directConnection to each hello.hosts entry)');
      explain(`
      Use case: open one directConnection client per hello.hosts entry, primary
      first, then each other member. This is the discovery connect() shape.
      Read askedHost, me, pinned, writable, and secondary. pinned must be true.
      One row is the writable primary. The others are secondaries.
      sameMongoAsParent must be false: each direct client is a new Mongo object.
      Restriction: connect(parent URI) can select the same member again, so a
      matching me would not prove the clients are distinct. Fewer than two
      hello.hosts entries (mongos, standalone) skips the member walk. The
      rebuilt URI is not printed. Read preference on the pin is primaryPreferred.
      `);
      const topo = await readHelloAsync(parent);
      const hosts = topo.hosts;
      const primaryHost = topo.primary;
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
            const live = await describe(host, handle);
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
         /*
          *  Use case 5 — one in-flight hello per member.
          *  for(member).snapshot() stores the driver command() promise on that
          *  Mongo before awaiting it. Shell hello() / runCommand() would finish
          *  the first member before the next started. withChildSession must not
          *  run inside this Promise.all: it assigns the one global db.
          */
         banner('5. Parallel facades each read their own member snapshot');
         explain(`
         Use case: Promise.all of mdblib.for(member).snapshot() across the direct
         clients. Each facade closes over its own handle.
         Read me against askedHost, writable against secondary, and startedMs
         against returnedMs. me must match askedHost. One row is writable. The
         rest are secondaries. maxInFlight must equal the member count, and the
         last start must be earlier than the first return.
         Restriction: one hello per client. Two commands on the same for() result
         stay sequential. Shell hello() and runCommand() do not overlap inside
         Promise.all. Do not call withChildSession from these tasks.
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

         /*
          *  Use case 6 — one session slot versus a WeakMap, then database scope.
          *  The module-level let is what sessionSnapshot is today: the first
          *  caller stamps it and every later client reuses that hello.
          *  Reads are awaited one at a time so the stamp is not itself a race.
          *  scope() is dbStats on the closed-over Database and is not cached
          *  on the Mongo client.
          */
         banner('6. One module-level snapshot vs a WeakMap, and db scope on one client');
         explain(`
         Use case: fill one let from the direct primary, then ask it for each
         secondary. A fresh WeakMap is filled from the same primary and then
         asked for those secondaries, then for admin on the primary client.
         scope() runs dbStats on the primary database and on admin.
         Read me, writable, cachedMongoIsHandle, hit, and dbName. The let must
         stay a hit, keep the primary me and writable true, and report
         cachedMongoIsHandle false for a secondary. The WeakMap must miss on
         that secondary and store that member's me. admin must hit, keep the
         primary me, and report dbName "admin". scope() dbName and collections
         must differ between the two databases.
         Restriction: these reads are one at a time so the first caller stamps
         the single let. Running the fills together would race that stamp.
         The let stores the resolved hello. It is not an in-flight promise.
         `);

         let moduleSnap = null;
         async function snapshotViaModuleLet(handle) {
            const mongo = handle.getMongo();
            const hit = moduleSnap !== null;
            const hello = await readHelloAsync(handle);
            if (!moduleSnap) {
               moduleSnap = {
                  "mongo": mongo,
                  "me": hello.me,
                  "writable": hello.writable,
                  "secondary": hello.secondary
               };
            }
            return {
               "cache": "module-let",
               "hit": hit,
               "askedHost": hello.me,
               "me": moduleSnap.me,
               "writable": moduleSnap.writable,
               "secondary": moduleSnap.secondary,
               "cachedMongoIsHandle": moduleSnap.mongo === mongo
            };
         }

         const freshByMongo = new WeakMap();
         async function snapshotViaFreshWeakMap(handle) {
            const mongo = handle.getMongo();
            let entry = freshByMongo.get(mongo);
            const hit = !!entry;
            if (!entry) {
               const hello = await readHelloAsync(handle);
               entry = {
                  "mongo": mongo,
                  "me": hello.me,
                  "writable": hello.writable,
                  "secondary": hello.secondary
               };
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

         show('module-let filled by direct primary', await snapshotViaModuleLet(primaryMember.handle));
         show('fresh WeakMap filled by direct primary', await snapshotViaFreshWeakMap(primaryMember.handle));
         for (const member of secondaries) {
            show(
               `module-let asked for ${member.host} — hit, me stays the primary, cachedMongoIsHandle false`,
               await snapshotViaModuleLet(member.handle)
            );
            show(
               `fresh WeakMap asked for ${member.host} — miss, me is that host`,
               await snapshotViaFreshWeakMap(member.handle)
            );
         }
         const primaryAdmin = primaryMember.handle.getSiblingDB('admin');
         show(
            'fresh WeakMap asked for admin on the primary client — hit, me stays the primary, dbName is admin',
            await snapshotViaFreshWeakMap(primaryAdmin)
         );
         show('for(primary).scope()', await mdblib.for(primaryMember.handle).scope());
         show('for(primary admin).scope()  ← dbName is admin, same Mongo snapshot', await mdblib.for(primaryAdmin).scope());
         show('for(primary admin).name()', mdblib.for(primaryAdmin).name());

         /*
          *  Use case 7 — global db assignment.
          *  askedMe is read from each handle before any task assigns db, so
          *  the assignment order stays the array order (primary, then
          *  secondaries). After every assignment, each task reads the global.
          *  The last write wins for every reader. Section 5 did not, because
          *  each facade closed over its handle. finally restores the shell db.
          */
         banner('7. Assigning the global db collapses the member; for() does not');
         explain(`
         Use case: each task records its own hello.me, assigns the global db,
         waits until every assignment has happened, then reads the global.
         This is the withChildSession hazard if two member gathers overlap.
         Read askedMe and seenMe. askedMe must match askedHost. Every seenMe
         must be the last host in the list, the later assignment. Section 5
         kept a different me per row.
         Restriction: do not overlap two withChildSession calls. Record the
         handle's own me before anyone assigns the global. The shell db is
         restored after this section. The reads after the gate share the last
         client; a library gather should keep one command in flight on a client.
         `);
         for (const member of members) {
            member.askedMe = (await readHelloAsync(member.handle)).me ?? null;
         }
         let arrived = 0;
         let release;
         const bothAssigned = new Promise(resolve => { release = resolve; });
         const raced = await Promise.all(members.map(async member => {
            db = member.handle;
            arrived++;
            if (arrived === members.length) release();
            await bothAssigned;
            const seen = await identityFromGlobalDb();
            return {
               "askedHost": member.host,
               "askedMe": member.askedMe,
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
