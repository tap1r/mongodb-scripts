(() => {
   /*
    *  Name: "aggSleepy.js"
    *  Version: "0.1.1"
    *  Description: "aggregation based '$sleepy' pipeline PoC to substitute for $function's sleep()"
    *  Disclaimer: "https://raw.githubusercontent.com/tap1r/mongodb-scripts/master/DISCLAIMER.md"
    *  Authors: ["tap1r <luke.prochazka@gmail.com>"]
    */

   const __script = { "name": "aggSleepy.js", "version": "0.1.1" };

   console.log(`\n\x1b[33m#### Running script ${__script.name} v${__script.version} on shell v${this.version()}\x1b[0m\n`);

   const dbName = '$';
   const namespace = db.getSiblingDB(dbName);
   const $sleepy = [
      { "$documents": [
         // seed the initial range to sample time meaurement performance
         { "array": { "$range": [0, "$$samples"] } }
      ] },
      { "$unwind": "$array" },
      { "$lookup": {
         "from": "_",
         "pipeline": [
            { "$collStats": {} }, // get realtime clock measurement per lookup
            { "$replaceRoot": { "newRoot": { "localTime": "$localTime" } } }
         ],
         "as": "_now"
      } },
      { "$group": {
         // count lookup interations per millisecond interval
         "_id": { "$arrayElemAt": ["$_now.localTime", 0] },
         "opCount": { "$count": {} }
      } },
      { "$group": {
         "_id": null,
         "opCounters": { "$max": "$opCount" },
         "initialSleepMS": { "$count": {} }
      } },
      { "$set": {
         // extrapolate range to the remaining desired sleep time
         "array": {
            "$range": [
               0,
               { "$ceil": {
                  "$multiply": [
                     "$opCounters",
                     { "$subtract": [
                        "$$sleepy",
                        // round down initial sample
                        { "$add": ["$initialSleepMS", -1] }
                     ] },
                     1.025 // execution weighting for extrapolation
         ] } }] }
      } },
      { "$unwind": "$array" },
      { "$lookup": {
         "from": "_",
         "pipeline": [
            { "$collStats": {} },
            { "$replaceRoot": { "newRoot": { "localTime": "$localTime" } } }
         ],
         "as": "_now"
      } },
      { "$group": {
         "_id": { "_now": { "$arrayElemAt": ["$_now.localTime", 0] } },
         "initialSleepMS": { "$first": "$initialSleepMS" },
         "opCounters": { "$first": "$opCounters" }
      } },
      { "$group": {
         "_id": null,
         "extrapolatedSleepMS": { "$count": {} },
         "initialSleepMS": { "$first": "$initialSleepMS" },
         "opCounters": { "$first": "$opCounters" }
      } },
      { "$set": {
         "_id": { "$literal": "$sleepy" },
         "samples": "$$samples",
         "sleepy": "$$sleepy",
         "totalSleepMS": {
            "$add": [
               "$extrapolatedSleepMS",
               "$initialSleepMS",
               -2
         ] }
      } },
      // comment out to expose sample metrics
      { "$unset": ["opCounters", "initialSleepMS", "extrapolatedSleepMS"] }
   ];

   /*
    *  Usage demonstration
    */

   const filter = `Synthetic slow operation at ${Date.now()}`;
   const pipeline = [
      { "$documents": [
         // sample documents for illustration purposes
         { "_id": new ObjectId(), "name": "Robert", "number": 1 },
         { "_id": new ObjectId(), "name": "Alice", "number": 5 },
         { "_id": new ObjectId(), "name": "Eve", "number": 42 }
      ] },
      // insert synthetic slow operation here
      { "$unionWith": { "pipeline": $sleepy } }
   ];
   const aggOptions = {
      "comment": filter,  // required for performance validation
      "let": {
         "sleepy": 100,   // target sleep time in milliseconds
         "samples": 10000 // initial sample size (worth ~40-80ms)
      }
   };

   console.log(namespace.aggregate(pipeline, aggOptions).toArray());
   // console.log(namespace.aggregate(pipeline, aggOptions).explain());
   const [{ 'attr': { durationMillis = -1 } = {} } = {}] = db.adminCommand(
         { "getLog": "global" }
      ).log.map(
         EJSON.parse
      ).filter(
         ({ 'attr': { 'command': { comment = '' } = {} } = {} } = {}) => {
            return comment == filter;
         }
      );
   console.log('logged opTime:', durationMillis);
})();

// Sample output:
/*
   [
      {
      _id: ObjectId('67572aa3779e427f39592d0d'),
      name: 'Robert',
      number: 1
      },
      {
      _id: ObjectId('67572aa3779e427f39592d0e'),
      name: 'Alice',
      number: 5
      },
      {
      _id: ObjectId('67572aa3779e427f39592d0f'),
      name: 'Eve',
      number: 42
      },
      { _id: '$sleepy', samples: 10000, sleepy: 100, totalSleepMS: 100 }
   ]
   logged opTime: 100
*/

// EOF
