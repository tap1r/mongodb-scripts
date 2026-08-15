(async() => {
   /*
    *  Name: "killAgedSessions.js"
    *  Version: "0.2.0"
    *  Description: "kill aged sessions (and associated operations) by user"
    *  Disclaimer: "https://raw.githubusercontent.com/tap1r/mongodb-scripts/master/DISCLAIMER.md"
    *  Authors: ["tap1r <luke.prochazka@gmail.com>"]
    *
    *  Notes:
    *  - customise $listSessions filter to match your needs
    *  - lists persisted sessions via $listSessions (config.system.sessions);
    *    in-memory sessions not yet refreshed may not appear
    *  - kills are fanned out concurrently via Promise.allSettled
    */

   // Syntax: mongosh [connection options] [--quiet] [--eval 'let filter = {}, age = 300000;'] [-f|--file] </path/to/>killAgedSessions.js

   /*
    *  Parameters (--eval globals):
    *
    *  filter: <document> (optional) $listSessions filter
    *          {} (current user)
    *          { "users": [{ "user": "user", "db": "admin" }] } (specific user(s))
    *          { "allUsers": true } (all users)
    *  age: <int> (optional) max idle time in ms; sessions with lastUse older than
    *       (now - age) are killed. Defaults to 300000 (5 minutes)
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

   const __script = { "name": "killAgedSessions.js", "version": "0.2.0" };
   // Resolve --eval globals (do not shadow with IIFE params — ()() would ignore them)
   const sessionFilter = typeof filter !== 'undefined' ? filter : {};
   const maxIdleMs = typeof age !== 'undefined' ? Number(age) : 300000;

   console.log(`\n\x1b[33m#### Running script ${__script.name} v${__script.version} on shell v${this.version()}\x1b[0m`);
   console.log(`filter: ${EJSON.stringify(sessionFilter)}, maxIdleMs: ${maxIdleMs}`);

   const namespace = db.getSiblingDB('config').getCollection('system.sessions');
   const listSessions = [
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

   const formatLastUse = lastUse => {
      if (lastUse instanceof Date) return lastUse.toISOString();
      if (lastUse == null) return String(lastUse);
      try { return ISODate(lastUse).toISOString(); } catch(_) { return String(lastUse); }
   };

   const killOne = async({
         '_id': { 'id': id } = {},
         'user': { 'name': userName } = {},
         lastUse
      } = {}) => {
      if (!id) {
         return { "outcome": "skipped", "reason": "missing session id" };
      }

      const lastActive = formatLastUse(lastUse);
      console.log(`Killing session ${id} for user ${userName ?? '(unknown)'} last active ${lastActive}`);

      const reply = await db.adminCommand({ "killSessions": [{ "id": id }] });
      if (reply?.ok !== 1) {
         const err = reply?.errmsg ?? reply?.codeName ?? EJSON.stringify(reply);
         throw new Error(`killSessions failed for ${id}: ${err}`);
      }

      return { "outcome": "killed", "id": id, "user": userName ?? null, "lastUse": lastActive };
   };

   const sessions = await namespace.aggregate(listSessions).toArray();
   console.log(`Matched ${sessions.length} aged session(s)`);

   if (!sessions.length) {
      console.log('Nothing to kill');
      return;
   }

   const results = await Promise.allSettled(sessions.map(killOne));

   let killed = 0, skipped = 0, failed = 0;
   for (const result of results) {
      if (result.status === 'fulfilled') {
         const { outcome, reason } = result.value ?? {};
         if (outcome === 'skipped') {
            skipped++;
            console.log(`Skipped: ${reason ?? 'unknown reason'}`);
         } else {
            killed++;
         }
      } else {
         failed++;
         const reason = result.reason?.errmsg ?? result.reason?.message ?? String(result.reason);
         console.log(`Failed: ${reason}`);
      }
   }

   console.log(`\nSummary: matched=${sessions.length}, killed=${killed}, skipped=${skipped}, failed=${failed}`);
   if (failed > 0) {
      // Non-zero mental model for operators; mongosh -f does not always surface process exit codes
      throw new Error(`${__script.name}: ${failed} session kill(s) failed`);
   }
})();

// EOF
