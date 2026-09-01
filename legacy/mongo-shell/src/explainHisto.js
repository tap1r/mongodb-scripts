/*
 *  Name: "explainHisto.js"
 *  Version: "0.1.4"
 *  Description: "Generates a text-based histogram of aggregation stage execution timers"
 *  Disclaimer: "https://raw.githubusercontent.com/tap1r/mongodb-scripts/master/DISCLAIMER.md"
 *  Authors: ["tap1r <luke.prochazka@gmail.com>"]
 *
 *  Legacy archive line: v0.1.4 is the snapshot for this script. mongosh-only
 *  (incompatible with legacy mongo: no require). Still the demarked version
 *  for the whole-tree freeze. Further feature work (sharded explain stages,
 *  --eval overlay) targets mongosh; see ROADMAP.md → Legacy mongo shell
 *  retirement.
 *
 *  Notes:
 *  - mongosh only (`require`, jsonc-require). Legacy mongo has no require.
 *  - provides histogram of stage execution times
 *  - expects ./pipeline.jsonc (operator-supplied; not shipped). jsonc-require
 *    must be resolvable on mongosh's require path.
 *  - prepends $sample to reduce explain runtime; stats are of the sampled pipeline.
 *  - uses explain('executionStats'); the stages array shape is version/driver-dependent.
 */

// Usage: mongosh [connection options] [--quiet] [-f|--file] </path/to/>explainHisto.js

(() => {
   const __script = { "name": "explainHisto.js", "version": "0.1.4" };
   require('jsonc-require');
   const userPipeline = require('./pipeline.jsonc');
   const dbName = 'database';
   const collName = 'collection';
   const namespace = db.getSiblingDB(dbName).getCollection(collName);
   const sampleSize = 100;

   // Construct pipeline with sampling for performance (if required)
   const pipeline = [
      { "$sample": { "size": sampleSize } },
      ...userPipeline
   ];

   const options = {
      "allowDiskUse": true,
      "cursor": { "batchSize": 0 },
      "readConcern": { "level": "local" },
      "comment": `${__script.name} v${__script.version}`
   };

   console.log(`\n\x1b[33m#### Running script ${__script.name} v${__script.version} on shell v${version()}\x1b[0m`);
   console.log('\nRunning aggregation explain plan (executionStats)...\n');

   // Run explain
   const explainOutput = namespace.explain('executionStats').aggregate(pipeline, options);

   // Locate stages array - structure can depend on MongoDB version/drivers
   const stages = explainOutput.stages || (explainOutput.executionStats && explainOutput.executionStats.stages);

   if (!stages || !Array.isArray(stages)) {
      console.error('Error: Could not find "stages" array in explain output.');
      // printjson(explainOutput); // Uncomment to debug structure if needed
      return;
   }

   // Extract data for histogram
   const data = stages.map((stage, index) => {
      // Find the stage operator (e.g., $match, $lookup)
      // Usually the first key starting with '$', or special keys like '$cursor'
      let name = Object.keys(stage).find(k => k.startsWith('$'));

      // Fallback for known specific stage wrappers or empty keys
      if (!name) {
         if (stage.$cursor) name = '$cursor';
         else name = 'Unknown';
      }

      const time = stage.executionTimeMillisEstimate !== undefined ? stage.executionTimeMillisEstimate : 0;
      const prevTime = index > 0 ? (stages[index - 1].executionTimeMillisEstimate || 0) : 0;
      const delta = time - prevTime;

      return {
         "id": index,
         "name": name,
         "time": +time,
         "delta": delta
      };
   });

   // Calculate scaling
   const maxTime = Math.max(...data.map(d => d.time));
   const maxBarLength = 40; // Max characters for the bar
   const totalTime = data.reduce((sum, d) => sum + d.delta, 0);

   // Print Histogram
   console.log(`Stage execution timers (estimate) over ${sampleSize} sampled documents:`);
   console.log('━'.repeat(95));

   data.forEach(item => {
      const pct = maxTime > 0 ? (item.time / maxTime) : 0;
      const barLen = Math.round(pct * maxBarLength);
      const bar = '░'.repeat(barLen);

      // Formatting columns
      const label = `Stage ${item.id} (${item.name})`;
      const labelPad = label.padEnd(33);
      const timePad = `${item.time}ms`.padStart(8);
      const deltaPad = `Δ ${item.delta}ms`;
      console.log(`${labelPad} ┃ ${bar} ${timePad} ${deltaPad}`);
   });

   console.log('━'.repeat(95));
   console.log(`Total estimated time: ${totalTime}ms`);
   console.log(`Per document estimated average time: ${totalTime / sampleSize}ms`);
   console.log('━'.repeat(95));
})();

// EOF
