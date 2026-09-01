(() => {
   /*
    *  Name: "connStats.js"
    *  Version: "0.1.14"
    *  Description: "report detailed connection pooling statistics"
    *  Disclaimer: "https://raw.githubusercontent.com/tap1r/mongodb-scripts/master/DISCLAIMER.md"
    *  Authors: ["tap1r <luke.prochazka@gmail.com>"]
    *
    *  Legacy archive line: v0.1.14 is the snapshot for this script. mongosh-only
    *  (usage; still the demarked version for the whole-tree freeze). Further
    *  feature work (whatsmyuri, DRIVERS-3027, targetAllNodes) targets mongosh;
    *  see ROADMAP.md → Legacy mongo shell retirement.
    */

   /*
    *  Notes:
    *  - mongosh only
    *  - requires "inprog" privileges to capture all connections, but supports fallback
    *  - statistics are per mongos/mongod as determined by the connection URI and readPreference
    *  - $currentOp client addresses: IPv4/hostname as host:port; IPv6 always bracketed as [addr]:port
    *
    *  TODO:
    *  - incorporate db.runCommand({ "whatsmyuri": 1}).you;
    *  - add support for https://jira.mongodb.org/browse/DRIVERS-3027 when complete
    */

   // Usage: mongosh [connection options] [--quiet] [-f|--file] </path/to/>connStats.js

   const namespace = db.getSiblingDB('admin'),
      aggOpts = {
         "comment": "connStats.js v0.1.14"
      },
      inprog = [
         { "$currentOp": { "allUsers": true } },
         { "$limit": 1 }
      ],
      pipeline = [
         { "$currentOp": {
            "allUsers": true,
            "localOps": (db.hello().msg === 'isdbgrid') ? true : false, // sharded option
            "idleConnections": true,
            "idleCursors": true,
            "idleSessions": true,
            // "targetAllNodes": (db.hello().msg === 'isdbgrid') ? true : false // TBA: sharded option for future feature on aggreaggte cluster connections
         } },
         { "$match": {
            "client": { "$exists": true } // minimum requirement to capture network client details
            // use post match filter for any other criteria to avoid bypassing the pool matching heuristics
         } },
         { "$set": {
            /*
             *  Parse $currentOp "client" into endpoint + ephemeralPort.
             *  Assumes IPv6 is always bracketed ([2001:db8::1]:54321); IPv4/host use a single host:port colon.
             */
            "clientParsed": {
               "$let": {
                  "vars": {
                     "m": {
                        "$regexFind": {
                           "input": "$client",
                           "regex": /^(?:\[([^\]]+)\]|([^:]+)):(\d+)$/
                  } } },
                  "in": {
                     "endpoint": {
                        "$ifNull": [
                           { "$arrayElemAt": ["$$m.captures", 0] }, // bracketed IPv6 (group 1)
                           { "$arrayElemAt": ["$$m.captures", 1] }  // IPv4 or hostname (group 2)
                     ] },
                     "ephemeralPort": {
                        "$toInt": { "$arrayElemAt": ["$$m.captures", 2] }
            } } } }
         } },
         { "$group": {
            "_id": {
               "host": "$host",
               "client": { // minimum requirement to detect distinct client pools
                  "endpoint": "$clientParsed.endpoint",
                  "driverVersion": "$clientMetadata.driver.version",
                  "platform": "$clientMetadata.platform",
                  "os": "$clientMetadata.os"
                  /*
                   *  Do not use application or driver names here,
                   *  as the metadata can vary across SDAM connections,
                   *  even within the same MongoClient() instance
                   */
            } },
            "connections": {
               "$push": {
                  "applicationName": { "$ifNull": ["$clientMetadata.application.name", "$clientMetadata.driver.name"] },
                  "connectionId": { "$ifNull": ["$connectionId", null] },
                  "ephemeralPort": "$clientParsed.ephemeralPort",
                  "opid": { "$ifNull": ["$opid", null] },
                  // "opType": { "$ifNull": ["$op", null] }, // TBA: unused at this point
                  // "msg": { "$ifNull": ["$msg", null] }, // TBA: unused at this point
                  "active": "$active",
                  // "currentOpTime": { "$toDate": "$currentOpTime" }, // TBA: kept for potential post-filter match on op age
                  "secs_running": { "$ifNull": ["$secs_running", null] }, // TBA: kept for potential post-filter match
                  // "command": { "$ifNull": ["$command", null] }, // TBA: kept for potential post-filter match
                  "sdam": { // streaming hello monitor
                     "$and": [
                        { "$or": [
                           { "$eq": ["$clientMetadata.driver.name", "NetworkInterfaceTL"] },
                           "$command.hello",
                           "$command.isMaster",
                           "$command.ismaster"
                        ] },
                        "$command.maxAwaitTimeMS",
                        { "$not": { "$ifNull": ["$effectiveUsers.user", false] } }
                  ] },
                  "rtt": { // rtt monitor
                     "$and": [
                        { "$or": [
                           { "$eq": ["$clientMetadata.driver.name", "NetworkInterfaceTL"] },
                           "$command.hello",
                           "$command.isMaster",
                           "$command.ismaster",
                           "$command.ping",
                           { "$not": { "$ifNull": ["$command", false] } }
                        ] },
                        { "$not": { "$ifNull": ["$command.maxAwaitTimeMS", false] } },
                        { "$not": { "$ifNull": ["$effectiveUsers.user", false] } }
                  ] },
                  // "namespace": { "$ifNull": ["$ns", null] }, // TBA: kept for potential post-filter match
                  "user": { // reconstitute the user format
                     "$ifNull": [
                        { "$concat": [
                           { "$first": "$effectiveUsers.user" },
                           "@",
                           { "$first": "$effectiveUsers.db" }
                        ] },
                        "unprivileged"
                  ] }
            } }
         } },
         { "$set": {
            "host": "$_id.host",
            "appName": {
               "$max": {
                  "$filter": {
                     "input": "$connections.applicationName",
                     "as": "appName",
                     "cond": { "$ne": ["NetworkInterfaceTL", "$$appName"] }
            } } },
            "srcIP": "$_id.client.endpoint",
            "driverVersion": "$_id.client.driverVersion",
            "platform": "$_id.client.platform",
            "os": "$_id.client.os",
            // "user": { "$min": "$connections.user" },
            "authenticatedUsers": {
               "$setDifference": [
                  { "$setIntersection": [
                     "$connections.user",
                     "$connections.user"
                  ] },
                  ["unprivileged"]
            ] },
            // "users": "$connections.user",
            "activePooledConnections": {
               "$sum": {
                  "$map": {
                     "input": "$connections",
                     "as": "connection",
                     "in": {
                        "$cond": [
                           { "$and": [
                              { "$not": {
                                 "$or": [
                                    "$$connection.sdam",
                                    "$$connection.rtt"
                              ] } },
                              "$$connection.active"
                           ] },
                           1, 0
            ] } } } },
            "idlePooledConnections": {
               "$sum": {
                  "$map": {
                     "input": "$connections",
                     "as": "connection",
                     "in": {
                        "$cond": [
                           { "$and": [
                              { "$not": {
                                 "$or": [
                                    "$$connection.sdam",
                                    "$$connection.rtt"
                              ] } },
                              { "$not": "$$connection.active" }
                           ] },
                           1, 0
            ] } } } },
            "adminConnections": { // administrative/monitoring connections
               "$sum": {
                  "$map": {
                     "input": "$connections",
                     "as": "connection",
                     "in": {
                        "$cond": [
                           { "$or": [
                              "$$connection.sdam",
                              "$$connection.rtt"
                           ] },
                           1, 0
            ] } } } },
            "pools": { // indicative of distinct MongoClient() instances
               "$sum": {
                  "$map": {
                     "input": "$connections.sdam",
                     "as": "sdam",
                     "in": { "$cond": ["$$sdam", 1, 0] }
            } } },
            "MongoClientOpids": {
               "$map": {
                  "input": {
                     "$filter": {
                        "input": "$connections",
                        "as": "connection",
                        "cond": "$$connection.sdam"
                     } },
                  "as": "sdam",
                  "in": "$$sdam.opid"
            } },
            "sdamConnectionIds": {
               "$map": {
                  "input": {
                     "$filter": {
                        "input": "$connections",
                        "as": "connection",
                        "cond": "$$connection.sdam"
                     } },
                  "as": "sdam",
                  "in": "$$sdam.connectionId"
            } },
            "rttConnectionIds": {
               "$map": {
                  "input": {
                     "$filter": {
                        "input": "$connections",
                        "as": "connection",
                        "cond": "$$connection.rtt"
                     } },
                  "as": "rtt",
                  "in": "$$rtt.connectionId"
            } },
            "totalConnections": { "$size": "$connections" }
         } },
         // { "$match": { // post filter recommended on derived pool metrics
            // "users": { "$in": [{ "user": "tapir", "db": "admin" }, null] }, // use null to capture SDAM events
            // "appName": { "$in": [/^greedyApp/, null] }, // use null to capture SDAM events
            // "appName": { "$in": [/^(?:mongosh|MongoDB Shell)/, null] }, // use null to capture SDAM events
            // "appName": /^(?:nodejs|MongoDB Internal Client|NetworkInterfaceTL)/,
            // "ns": /^admin/,
            // "command.aggregate": { "$exists": true },
            // "secs_running": { "$gte": 0 }
         // } },
         { "$sort": { "totalConnections": -1 } },
         { "$unset": ["_id", "connections"] }
      ];

   function hasInprog() {
      try {
         namespace.aggregate(inprog, aggOpts).toArray();
         return true;
      } catch(e) {
         return false;
      }
   }

   const allUsers = hasInprog();
   if (!allUsers) {
      console.error('User has no inprog privilege, falling back to { "allUsers": false }');
      console.log('PARTIAL: own ops only');
      pipeline[0].$currentOp.allUsers = false;
   }

   const scope = allUsers ? "allUsers" : "ownOps";
   namespace.aggregate(pipeline, aggOpts).forEach(doc => {
      console.log({ scope, ...doc });
   });
})();

// EOF
