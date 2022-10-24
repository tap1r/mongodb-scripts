/*
 *  Name: "latency.js"
 *  Version: "0.1.5"
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
    result, rtt, t0, t1, t2, t3, totalTime,
    report, tableWidth, padding, longestValue,
    columnWidth = 24, spacing = 2;

t0 = process.hrtime();
try { result = db.getSiblingDB('admin').aggregate(pipeline, options).toArray()[0] }
catch(error) { throw error }
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
// try { db.hello().ok }
try { (db.adminCommand({ "ping": 1 }).ok == 1) }
catch(error) { throw error }
t3 = process.hrtime(t2);
totalTime = t1[0] * 1000 + (t1[1] / 1000000);
rtt = t3[0] * 1000 + (t3[1] / 1000000);

function fomatted(duration) {
    return Intl.NumberFormat('en', {
        "minimumIntegerDigits": 1,
        "minimumFractionDigits": 2,
        "maximumFractionDigits": 2,
        "style": "unit",
        "unit": "millisecond", // https://tc39.es/proposal-unified-intl-numberformat/section6/locales-currencies-tz_proposed_out.html#sec-issanctionedsimpleunitidentifier
        "unitDisplay": "short" // "narrow"
    }).format(duration)
}

longestValue = fomatted(totalTime).length;
tableWidth = columnWidth + longestValue + spacing;
padding = longestValue + spacing;

report = `
${'='.repeat(tableWidth)}
${'Delay/slowms factor:'.padEnd(columnWidth) + fomatted(slowms).padStart(padding)}
${'Total measurement time:'.padEnd(columnWidth) + fomatted(totalTime).padStart(padding)}
${'='.repeat(tableWidth)}
Latency breakdown
${'-'.repeat(tableWidth)}
${'Server execution time:'.padEnd(columnWidth) + fomatted(durationMillis - slowms).padStart(padding)}
${'Network Latency (RTT):'.padEnd(columnWidth) + fomatted(rtt).padStart(padding)}
${'Driver execution time:'.padEnd(columnWidth) + fomatted(totalTime - durationMillis - rtt).padStart(padding)}
${'='.repeat(tableWidth)}
`;

console.log(report);
