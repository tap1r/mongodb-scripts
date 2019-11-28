# Useful aggregation pipelines

## (Pre-4.2) dynamic variables: using _current time_ to fetch the latest x days

```javascript
// 1 day offset
var offsetms = 24 * 3600 * 1000
var agg = [{
       $lookup:{
            from: "any",
            pipeline: [ { $collStats: {} } ],
            as: "time"
        }
    },{
        $unwind:'$time'
    },{
        $addFields: { "now": "$time.localTime" }
    },{
        $project: { "time": 0 }
    },{
        $match:{
            $expr: {
                $gte: [ "$isodate", { $subtract: [ "$now", offsetms ] } ]
            }
        }
    }
]
db.collection.aggregate(agg)
```

## Measuring real-time _oplog_ churn

The [oplogchurn.js](src/oplogchurn.js) script provides a metric of real-time oplog churn by measuring over the most recent interval, as opposed to over the entire oplog:

### Using _oplogchurn.js_

Sample syntax to run against on the _mongo_ shell:

```bash
mongo [+options] --quiet oplogchurn.js
```

### Sample output

```text
-------------------------------------------------------------------------------------------
Start time:				1574924633.044
End time:				1574921033.044
Interval:				1 Hr(s)
Avg oplog compression ratio:		6.51:1
Doc count:				360
Total Ops size:				38.82KB
Estimated total Ops size on disk:	5.96KB
-------------------------------------------------------------------------------------------
Estimated current oplog churn:		5.96 KB/Hr
-------------------------------------------------------------------------------------------
```
