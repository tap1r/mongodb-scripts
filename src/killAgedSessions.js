(async(filter = {}, age = 300000) => {
   /*
    *  Name: "killAgedSessions.js"
    *  Version: "0.1.3"
    *  Description: "kill aged sessions (and associated operations) by user"
    *  Disclaimer: "https://raw.githubusercontent.com/tap1r/mongodb-scripts/master/DISCLAIMER.md"
    *  Authors: ["tap1r <luke.prochazka@gmail.com>"]
    *
    *  Notes:
    *  - customise $listSessions filter to match your needs
    */

   // Syntax: mongosh [connection options] --quiet [--eval 'let user = {}, age = 300000;'] [-f|--file] killAgedSessions.js

   /*
    *  Parameters:
    *
    *  filter: <document> (optional) session filter
    *          {} (current user)
    *          { "users": [{ "user": "user", "db": "admin" }] } (specific user(s))
    *          { "allUsers": true } (all users)
    *  age: <int> (optional) session age in ms, defaults to 5 minutes
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
   const filter = typeof filter !== 'undefined' ? filter
                : {};
   const maxIdleMs = typeof age !== 'undefined' ? age : 300_000;
   const namespace = db.getSiblingDB('config').getCollection('system.sessions');
   const listSessions = [
      { "$listSessions": filter },
      { "$match": {
         "$expr": {
            "$lt": [
               "$lastUse",
               { "$subtract": ["$$NOW", maxIdleMs] }
            ]
      } } }
   ];
   const killSessions = async({
         '_id': { 'id': uuid = UUID() } = {},
         'user': { 'name': filter = {} } = {},
         'lastUse': maxIdleMs = 0
      } = {}) => {
      console.log('Killing session', uuid, 'for user', filter, 'last active', maxIdleMs.toISOString());
      try {
         db.adminCommand({ "killSessions": [{ "id": uuid }] });
      } catch(e) {
         console.log('Failed to terminate', uuid, 'with error:', e);
      }
   }

   namespace.aggregate(listSessions).forEach(killSessions);
})();

// EOF
