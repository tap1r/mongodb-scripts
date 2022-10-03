/*
 *  Name: "latency.js"
 *  Version: "0.1.2"
 *  Description: driver and network latency telemetry PoC
 *  Authors: ["tap1r <luke.prochazka@gmail.com>"]
 */

// Usage: "mongosh [connection options] --quiet latency.js"

let slowms = db.getSiblingDB('admin').getProfilingStatus().slowms,
    filter = `Synthetic slow operation at ${performance.now()}`,
    pipeline = [
        { "$currentOp": {} },
        { "$limit": 1 },
        { "$project": {
            "_id": 0,
            "slowms": {
                "$function": {
                    "body": function(ms) {
                        sleep(ms);
                        return ms;
                    },
                    // "args": ["$$delayms"],
                    "args": [slowms],
                    "lang": "js"
        } } } }],
    options = {
        "comment": filter,
        "cursor": { "batchSize": 1 },
        "readConcern": { "level": "local" },
        // "let": { "delayms": slowms }
    },
    res = {}, t0, t1, t2, t3, totalTime;

t0 = process.hrtime();
try { res = db.getSiblingDB('admin').aggregate(pipeline, options).toArray()[0] }
catch(e) { printjson(e) }
t1 = process.hrtime(t0);
let { t,
      "attr": { "command": { "$clusterTime": { "clusterTime": clusterTime } } },
      "attr": { "durationMillis": durationMillis }
    } = db.adminCommand(
        { "getLog": "global" }
    ).log.map(logString => {
        return EJSON.parse(logString)
    }).filter(log => {
        return log?.attr?.command?.comment == filter
    })[0];
totalTime = t1[0] * 1000 + (t1[1] / 1000000);
t2 = process.hrtime();
try { (db.hello().ok) }
catch(e) { printjson(e) }
t3 = process.hrtime(t2);
rtt = t3[0] * 1000 + (t3[1] / 1000000);

console.log(`
    ===================================
    Delay/slowms factor:\t${slowms}ms
    Total query time:\t\t${durationMillis}ms
    Total App/network time:\t${(totalTime - durationMillis).toFixed(2)}ms
    -----------------------------------
    Total measurement time:\t${totalTime.toFixed(2)}ms
    -----------------------------------
    Server execution time:\t${durationMillis - slowms}ms
    Network Latency (RTT):\t${rtt.toFixed(2)}ms
    Driver execution time:\t${(totalTime - durationMillis - rtt).toFixed(2)}ms
    ===================================
`);
