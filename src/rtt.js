(() => {
   /*
    *  Name: "rtt.js"
    *  Version: "0.1.0"
    *  Description: "reports application round trip time latency"
    *  Disclaimer: "https://raw.githubusercontent.com/tap1r/mongodb-scripts/master/DISCLAIMER.md"
    *  Authors: ["tap1r <luke.prochazka@gmail.com>"]
    *
    *  Notes:
    *  - Reports on all discoverable servers only
    *  - Supports replica sets and direct modes only
    *
    *  TODOs:
    *  - add mongos discovery
    */
   let servers = () => db.getMongo().__serviceProvider.mongoClient.topology.s.description.servers;
   let src = db.runCommand({ "whatsmyuri": 1}).you.match(/^(?<src>.+)\:\d+/).groups.src;
   let rtt = (roundTripTime) => {
      roundTripTime = Math.round(roundTripTime * 10);
      roundTripTime = (roundTripTime * 0.1).toFixed(1);
      return +roundTripTime;
   }
   for ([host, { roundTripTime } = {}] of servers().entries()) {
      console.log(`Application latency from ${src} to ${host} = ${rtt(roundTripTime)}ms`);
   }
})();

// EOF
