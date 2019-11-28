# Useful aggregation pipelines

## (Pre-4.2) dynamic variables: using _current time_

```javascript
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
                $gte: [ "$isodate", { $subtract: [ "$now", 5 * 24 * 3600 * 1000 ] } ]
            }
        }
    }
]
db.collection.aggregate(agg)
```
