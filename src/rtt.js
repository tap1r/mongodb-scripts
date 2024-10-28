(() => {
   /*
    *  Name: "rtt.js"
    *  Version: "0.1.2"
    *  Description: "reports application round trip time latency"
    *  Disclaimer: "https://raw.githubusercontent.com/tap1r/mongodb-scripts/master/DISCLAIMER.md"
    *  Authors: ["tap1r <luke.prochazka@gmail.com>"]
    *
    *  Notes:
    *  - mongosh only
    *  - Reports on all discoverable servers only
    *  - Supports replica sets and direct modes only
    *
    *  TODOs:
    *  - add mongos discovery
    */

   // Syntax: mongosh [connection options] --quiet [-f|--file] rtt.js

   let __script = { "name": "rtt.js", "version": "0.1.2" };
   let banner = `\n\x1b[33m#### Running script ${__script.name} v${__script.version} on shell v${version()}\x1b[0m\n`;
   console.clear();
   console.log(banner);

   let servers = () => db.getMongo().__serviceProvider.mongoClient.topology.s.description.servers;
   let src = db.runCommand({ "whatsmyuri": 1}).you.match(/^(?<src>.+)\:(?:\d+)$/).groups.src;
   let latency = (rtt) => // rtt in ms to 1 decimal place
      Intl.NumberFormat('en', {
         "minimumIntegerDigits": 1,
         "minimumFractionDigits": 1,
         "maximumFractionDigits": 1,
         "style": "unit",
         "unit": "millisecond",
         "unitDisplay": "short"
      }).format(rtt);
   for ([host, { 'roundTripTime': rtt } = {}] of servers().entries()) {
      console.log(`Application latency from ${src} to ${host} = ${latency(rtt)}`);
   }
   console.log('');
})();

// EOF
