(() => {
   /*
    *  Name: "rtt.js"
    *  Version: "0.2.0"
    *  Description: "reports application round trip time latency"
    *  Disclaimer: "https://raw.githubusercontent.com/tap1r/mongodb-scripts/master/DISCLAIMER.md"
    *  Authors: ["tap1r <luke.prochazka@gmail.com>"]
    *
    *  Notes:
    *  - mongosh only
    *  - Reports on all discoverable servers only
    *  - Supports mongos, replica sets and direct modes
    *
    *  TODOs:
    *  - TBA
    */

   // Syntax: mongosh [connection options] --quiet [-f|--file] rtt.js

   let __script = { "name": "rtt.js", "version": "0.2.0" };
   let banner = `\n\x1b[33m#### Running script ${__script.name} v${__script.version} on shell v${version()}\x1b[0m\n`;
   console.clear();
   console.log(banner);

   function isSharded() {
      /*
       *  is mongos process
       */
      return db.hello().msg === 'isdbgrid';
   }

   function mongoOptions() {
      /*
       *  returns MongoClient() options to construct new connections
       */
      let {
         username = null,
         password = null,
         'source': authSource = 'admin',
         'mechanism': authMech = 'DEFAULT'
      } = db.getMongo().__serviceProvider.mongoClient.options?.credentials ?? {};
      let {
         compressors = ['none'],
         tls = false
      } = db.getMongo().__serviceProvider.mongoClient.options;

      return [username, password, authSource, authMech, compressors, tls];
   }

   function discoverMongos() {
      /*
       *  returns an array of available mongos instances attached to the sharded cluster
       */
      let mongos = [];
      let namespace = db.getSiblingDB('config').getCollection('mongos');
      let options = {
         "allowDiskUse": true,
         "readConcern": { "level": "local" },
         "comment": "Discovering living mongos process"
      };
      let offsetMS = 60000; // 1min
      let pipeline = [
         { "$match": {
            "$expr": {
               "$gte": ["$ping", { "$subtract": ["$$NOW", offsetMS] }]
         } } },
         { "$project": {
            "_id": 0,
            "host": {
               "$cond": [
                  { "$ifNull": ["$advisoryHostFQDNs", true] },
                  "$_id",
                  { "$concat": [
                     { "$first": "$advisoryHostFQDNs" },
                     ":",
                     { "$arrayElemAt": [{ "$split": ["$_id", ":"] }, 1] }
                  ] }
               ]
            }
         } }
      ];
      try {
         mongos = namespace.aggregate(pipeline, options).toArray();
      }
      catch(e) {
         console.log('Lack the ability to discover mongos:', e);
      }

      return mongos.map(({ host }) => host);
   }

   function mongosSeededURI(seedList = []) {
      /*
       *
       */
      let [username, password, authSource, authMech, compressors, tls] = mongoOptions();
      let seededURI;
      if (username == null) {
         seededURI = `mongodb://${seedList.toString()}/?tls=${tls}&compressors=${compressors}`;
      } else {
         seededURI = `mongodb://${username}:${password}@${seedList.toString()}/?tls=${tls}&authSource=${authSource}&authMechanism=${authMech}&compressors=${compressors}`;
      }

      return seededURI;
   }

   function servers() {
      /*
       *  return the topology object from the mongosh private class
       */
      return db.getMongo().__serviceProvider.mongoClient.topology.s.description.servers;
   }

   function latency(rtt) {
      /*
       *  rtt in ms to 1 decimal place
       */
      return Intl.NumberFormat('en', {
         "minimumIntegerDigits": 1,
         "minimumFractionDigits": 1,
         "maximumFractionDigits": 1,
         "style": "unit",
         "unit": "millisecond",
         "unitDisplay": "short"
      }).format(rtt);
   }

   if (isSharded()) {
      db = connect(mongosSeededURI(discoverMongos()));
   }

   let me = db.runCommand({ "whatsmyuri": 1 }).you.match(/^(?<src>.+)\:(?:\d+)$/).groups.src;
   for ([host, { 'roundTripTime': rtt } = {}] of servers().entries()) {
      console.log(`Application latency from ${me} to ${host} = ${latency(rtt)}`);
   }

   console.log('');
})();

// EOF
