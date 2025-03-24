(() => {
   /*
    *  Name: "aggSleepy.js"
    *  Version: "0.2.1"
    *  Description: "aggregation based '$sleepy' pipeline PoC to substitute for $function's sleep()"
    *  Disclaimer: "https://raw.githubusercontent.com/tap1r/mongodb-scripts/master/DISCLAIMER.md"
    *  Authors: ["tap1r <luke.prochazka@gmail.com>"]
    */

   const __script = { "name": "aggSleepy.js", "version": "0.2.1" };
   if (typeof console === 'undefined') {
      /*
       *  legacy mongo detected
       */
      var console = {
         log: print,
         clear: () => _runMongoProgram('clear'),
         error: arg => printjson(arg, '', true, 64),
         debug: arg => printjson(arg, '', true, 64),
         dir: arg => printjson(arg, '', true, 64)
      };
      var EJSON = { parse: JSON.parse };
   }

   console.log(`\n\x1b[33m#### Running script ${__script.name} v${__script.version} on shell v${this.version()}\x1b[0m`);

   const dbName = '$';
   const namespace = db.getSiblingDB(dbName);
   const $sleepy = [
      { "$documents": [
         // seed the initial range to sample time meaurement performance
         { "_": {
            "$map": {
               "input": { "$range": [0, "$$samples"] },
               "in": null
            }
         } }
      ] },
      { "$unwind": "$_" },
      { "$lookup": {
         "from": "_",
         "pipeline": [
            { "$collStats": {} }, // get realtime clock measurement per lookup
            { "$replaceWith": { "localTime": "$localTime" } }
         ],
         "as": "_now"
      } },
      { "$group": {
         // count lookup interations per millisecond interval
         "_id": { "$first": "$_now.localTime" },
         "opCount": { "$count": {} }
      } },
      { "$group": {
         "_id": null,
         "opCounters": { "$max": "$opCount" },
         "initialSleepMS": { "$count": {} }
      } },
      { "$set": {
         // extrapolate range to the remaining desired sleep time
         "_": {
            "$map": {
               "input": {
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
                           1 // weighting
                  ] } }]
               },
               "in": null
         } }
      } },
      { "$unwind": "$_" },
      { "$lookup": {
         "from": "_",
         "pipeline": [
            { "$collStats": {} },
            { "$replaceWith": { "localTime": "$localTime" } }
         ],
         "as": "_now"
      } },
      { "$group": {
         "_id": { "$first": "$_now.localTime" },
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
         "sleepy": 1000,  // target sleep time in milliseconds
         "samples": 1000  // initial sample size
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
