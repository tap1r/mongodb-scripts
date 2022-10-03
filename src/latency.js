/*
 *  Name: "latency.js"
 *  Version: "0.1.3"
 *  Description: driver and network latency telemetry PoC
 *  Authors: ["tap1r <luke.prochazka@gmail.com>"]
 */

// Usage: "mongosh [connection options] --quiet latency.js"

let tableWidth = 40,
    slowms = db.getSiblingDB('admin').getProfilingStatus().slowms,
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
    report = ``, res = {}, rtt, t0, t1, t2, t3, totalTime;

t0 = process.hrtime();
try { res = db.getSiblingDB('admin').aggregate(pipeline, options).toArray()[0] }
catch(e) { printjson(e) }
t1 = process.hrtime(t0);
let { t, "attr": { "durationMillis": durationMillis }
    } = db.adminCommand(
        { "getLog": "global" }
    ).log.map(logString => {
        return EJSON.parse(logString)
    }).filter(log => {
        return log?.attr?.command?.comment == filter
    })[0];
t2 = process.hrtime();
try { db.hello().ok }
catch(e) { printjson(e) }
t3 = process.hrtime(t2);

totalTime = t1[0] * 1000 + (t1[1] / 1000000);
rtt = t3[0] * 1000 + (t3[1] / 1000000);

function fomatted(duration) {
    return Intl.NumberFormat('en', {
        "minimumIntegerDigits": 1,
        "minimumFractionDigits": 2,
        "maximumFractionDigits": 2,
        "style": "unit",
        "unit": "millisecond",
        "unitDisplay": "short" // "narrow"
    }).format(duration);
}

report = `
${'='.repeat(tableWidth)}
Delay/slowms factor:\t${fomatted(slowms).padStart(16)}
Total measurement time:\t${fomatted(totalTime).padStart(16)}
${'-'.repeat(tableWidth)}
Latency breakdown:\n
Server execution time:\t${fomatted(durationMillis - slowms).padStart(16)}
Network Latency (RTT):\t${fomatted(rtt).padStart(16)}
Driver execution time:\t${fomatted(totalTime - durationMillis - rtt).padStart(16)}
${'='.repeat(tableWidth)}
`;

console.log(report);
