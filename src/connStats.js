(() => {
   /*
    *  Name: "connStats.js"
    *  Version: "0.1.6"
    *  Description: "report detailed connection pooling statistics"
    *  Disclaimer: "https://raw.githubusercontent.com/tap1r/mongodb-scripts/master/DISCLAIMER.md"
    *  Authors: ["tap1r <luke.prochazka@gmail.com>"]
    */

   /*
    *  Notes:
    *  - requires "inprog" privileges to capture all connections
    *  - statistics are per host as determined by connection read preferences
    *
    *  TODO:
    *  - incorporate db.runCommand({ "whatsmyuri": 1}).you;
    *  - add support for DRIVERS-3027 when complete
    */

   // Usage: mongosh [connection options] --quiet [-f|--file] connStats.js

   const aggOpts = {
         "comment": "connStats.js v0.1.6"
      },
      pipeline = [
         { "$currentOp": {
            "allUsers": true,
            "localOps": true,
            "idleConnections": true,
            "idleCursors": true,
            "idleSessions": true
            // "targetAllNodes": true // sharded option
         } },
         { "$match": {
            "client": { "$exists": true } // minimum requirement to capture network client details
            // use post match filter for any other criteria to avoid bypassing the pool matching heuristics
         } },
         { "$group": {
            "_id": {
               "host": "$host",
               "client": { // minimum requirement to detect distinct client pools
                  "endpoint": { "$first": { "$split": ["$client", ":"] } },
                  "driverVersion": "$clientMetadata.driver.version",
                  "platform": "$clientMetadata.platform",
                  "os": "$clientMetadata.os"
                  // do not use application or driver names here
                  // they can vary on SDAM connections within the same MongoClient() instance
            } },
            "connections": {
               "$push": {
                  "applicationName": { "$ifNull": ["$clientMetadata.application.name", "$clientMetadata.driver.name"] },
                  "connectionId": { "$ifNull": ["$connectionId", null] },
                  "ephemeralPort": { "$toInt": { "$arrayElemAt": [{ "$split": ["$client", ":"] }, 1] } },
                  "opid": { "$ifNull": ["$opid", null] },
                  // "lsid": { "$ifNull": ["$lsid.id", null] },
                  "opType": { "$ifNull": ["$op", null] },
                  "msg": { "$ifNull": ["$msg", null] },
                  "active": "$active",
                  // "currentOpTime": { "$toDate": "$currentOpTime" },
                  "secs_running": { "$ifNull": ["$secs_running", null] },
                  "microsecs_running": { "$ifNull": ["$microsecs_running", null] },
                  "command": { "$ifNull": ["$command", null] },
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
                  // "namespace": { "$ifNull": ["$ns", null] },
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
         { "$match": { // post filter recommended on dervied pool metrics
            // "users": { "$in": [{ "user": "tapir", "db": "admin" }, null] }, // use null to capture SDAM events
            // "appName": { "$in": [/^greedyApp/, null] }, // use null to capture SDAM events
            // "appName": { "$in": [/^(?:mongosh|MongoDB Shell)/, null] }, // use null to capture SDAM events
            // "appName": /^(?:nodejs|MongoDB Internal Client|NetworkInterfaceTL)/,
            // "ns": /^admin/,
            // "command.aggregate": { "$exists": true },
            // "secs_running": { "$gte": 0 }
         } },
         { "$sort": { "totalConnections": -1 } },
         { "$unset": ["_id", "connections"] }
      ];
      // results;

   // results = db.getSiblingDB('admin').aggregate(pipeline, aggOpts).toArray();
   // console.log(results);
   db.getSiblingDB('admin').aggregate(pipeline, aggOpts).forEach(console.log);
})();

// EOF
