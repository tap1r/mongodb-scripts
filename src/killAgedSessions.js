(async() => {
   /*
    *  Name: "killAgedSessions.js"
    *  Version: "0.2.1"
    *  Description: "kill aged sessions (and associated operations) by user"
    *  Disclaimer: "https://raw.githubusercontent.com/tap1r/mongodb-scripts/master/DISCLAIMER.md"
    *  Authors: ["tap1r <luke.prochazka@gmail.com>"]
    *
    *  Notes:
    *  - customise $listSessions filter to match your needs
    *  - lists persisted sessions via $listSessions (config.system.sessions);
    *    in-memory sessions not yet refreshed may not appear
    *  - aggregation results stream via an async generator; consumers pull
    *    fixed-size batches and fan out individual killSessions concurrently
    */

   // Syntax: mongosh [connection options] [--quiet] [--eval 'let filter = {}, age = 300000, batchSize = 32;'] [-f|--file] </path/to/>killAgedSessions.js

   /*
    *  Parameters (--eval globals):
    *
    *  filter: <document> (optional) $listSessions filter
    *          {} (current user)
    *          { "users": [{ "user": "user", "db": "admin" }] } (specific user(s))
    *          { "allUsers": true } (all users)
    *  age: <int> (optional) max idle time in ms; sessions with lastUse older than
    *       (now - age) are killed. Defaults to 300000 (5 minutes)
    *  batchSize: <int> (optional) how many sessions to consume per fan-out
    *             wave. Defaults to 32
    */

   /*
    *  Example: terminates all self-owned sessions older than 5 minutes
    *
    *    mongosh --host "replset/localhost" killAgedSessions.js
    *
    *  Example: terminates all user sessions older than 1 minute
    *
    *    mongosh --host "replset/localhost" --eval 'let filter = { "allUsers": true }, age = 60000;' killAgedSessions.js
    *
    *  Example: terminates user dba's sessions older than 500ms
    *
    *    mongosh --host "replset/localhost" --eval 'let filter = { "users": [{ "user": "dba", "db": "admin" }] }, age = 500;' killAgedSessions.js
    */

   const __script = { "name": "killAgedSessions.js", "version": "0.2.1" };
   // Resolve --eval globals (do not shadow with IIFE params — ()() would ignore them)
   const sessionFilter = typeof filter !== 'undefined' ? filter : {};
   const maxIdleMs = typeof age !== 'undefined' ? Number(age) : 300000;
   const consumeBatchSize = typeof batchSize !== 'undefined' && Number(batchSize) > 0
      ? Number(batchSize)
      : 32;

   console.log(`\n\x1b[33m#### Running script ${__script.name} v${__script.version} on shell v${version()}\x1b[0m`);
   console.log(`filter: ${EJSON.stringify(sessionFilter)}, maxIdleMs: ${maxIdleMs}, batchSize: ${consumeBatchSize}`);

   const namespace = db.getSiblingDB('config').getCollection('system.sessions');
   const listSessionsPipeline = [
      { "$listSessions": sessionFilter },
      { "$match": {
         "$expr": {
            "$lt": [
               "$lastUse",
               { "$subtract": ["$$NOW", maxIdleMs] }
            ]
         }
      } }
   ];
   const aggOptions = {
      "cursor": { "batchSize": consumeBatchSize },
      "comment": `${__script.name} v${__script.version}`
   };

   const formatLastUse = lastUse => {
      if (lastUse instanceof Date) return lastUse.toISOString();
      if (lastUse == null) return String(lastUse);
      try { return ISODate(lastUse).toISOString(); } catch(_) { return String(lastUse); }
   };

   /*
    *  Stream matched sessions from the aggregation cursor (one doc at a time).
    */
   async function* listAgedSessions(pipeline = listSessionsPipeline, options = aggOptions) {
      const cursor = namespace.aggregate(pipeline, options);
      for await (const session of cursor) {
         yield session;
      }
   }

   /*
    *  Batch-consume streamed sessions into fixed-size arrays.
    */
   async function* batchConsume(source, size = consumeBatchSize) {
      let batch = [];
      for await (const session of source) {
         batch.push(session);
         if (batch.length >= size) {
            yield batch;
            batch = [];
         }
      }
      if (batch.length) yield batch;
   }

   /*
    *  Individual killSessions — one command per session (fan-out unit).
    */
   const killOne = async({
         '_id': { 'id': sessionId } = {},
         'user': { 'name': userName } = {},
         lastUse
      } = {}) => {
      if (!sessionId) {
         return { "outcome": "skipped", "reason": "missing session id" };
      }

      const lastActive = formatLastUse(lastUse);
      console.log(`Killing session ${sessionId} for user ${userName ?? '(unknown)'} last active ${lastActive}`);

      const reply = await db.adminCommand({ "killSessions": [{ "id": sessionId }] });
      if (reply?.ok !== 1) {
         const err = reply?.errmsg ?? reply?.codeName ?? EJSON.stringify(reply);
         throw new Error(`killSessions failed for ${sessionId}: ${err}`);
      }

      return { "outcome": "killed", "id": sessionId, "user": userName ?? null, "lastUse": lastActive };
   };

   const tallyResults = (results, counters) => {
      for (const result of results) {
         if (result.status === 'fulfilled') {
            const { outcome, reason } = result.value ?? {};
            if (outcome === 'skipped') {
               counters.skipped++;
               console.log(`Skipped: ${reason ?? 'unknown reason'}`);
            } else {
               counters.killed++;
            }
         } else {
            counters.failed++;
            const reason = result.reason?.errmsg ?? result.reason?.message ?? String(result.reason);
            console.log(`Failed: ${reason}`);
         }
      }
   };

   const counters = { "matched": 0, "killed": 0, "skipped": 0, "failed": 0 };
   let wave = 0;

   for await (const batch of batchConsume(listAgedSessions(), consumeBatchSize)) {
      wave++;
      counters.matched += batch.length;
      console.log(`\nWave ${wave}: fan-out ${batch.length} killSessions`);
      // Fan out individual kills for this batch; do not await inside the map body spawn
      const results = await Promise.allSettled(batch.map(killOne));
      tallyResults(results, counters);
   }

   if (!counters.matched) {
      console.log('Nothing to kill');
      return;
   }

   console.log(`\nSummary: matched=${counters.matched}, killed=${counters.killed}, skipped=${counters.skipped}, failed=${counters.failed}, waves=${wave}`);
   if (counters.failed > 0) {
      // Non-zero mental model for operators; mongosh -f does not always surface process exit codes
      throw new Error(`${__script.name}: ${counters.failed} session kill(s) failed`);
   }
})();

// EOF
