# Useful aggregation pipelines

## (Pre-4.2) dynamic variables: using _current time_ to fetch the latest x days

```javascript
// 1 day offset example
var dbName = 'database';
var collName = 'collection';
var options = { allowDiskUse: true };
var agg = [
    {
       $lookup: {
            from: "any",
            pipeline: [ { $collStats: {} } ],
            as: "time"
        }
    },{
        $unwind: "$time"
    },{
        $addFields: { "now": "$time.localTime" }
    },{
        $project: { "time": 0 }
    },{
        $match: {
            $expr: {
                $gte: [ "$isodate", { $subtract: [ "$now", 24 * 3600 * 1000 ] } ]
            }
        }
    }
];
db.getSiblingDB(dbName).getCollection(collName).aggregate(agg, options);
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
==================================================
Start time:                         1574926639.139
End time:                           1574923039.139
Interval:                                   1hr(s)
Avg oplog compression ratio:                6.51:1
Doc count:                                     360
Total Ops size:                            0.04 MB
Estimated total Ops size on disk:          0.01 MB
--------------------------------------------------
Estimated current oplog churn:          0.01 MB/hr
==================================================
```

## Schema analysis

A aggregation pipeline to describe a collection _schema_ as inferred from a canonicalised document _shape_.

```javascript
var dbName = 'database';
var collName = 'collection';
var options = { allowDiskUse: true };
var agg = [
    {
        $sample: { size: 1000 }
    },{
        $group: {
            _id: null,
            __doc: { $mergeObjects: "$$ROOT" }
        }
    },{
        $facet: {
            "Canonical (1D) shape (with most recent values)": [
                {
                    $project: {
                        _id: 0
                    }
                },{
                    $replaceRoot: { newRoot: { $mergeObjects: "$__doc" } }
                }
            ],
            "Canonical (1D) shape with types": [
                {
                    $project: {
                        _id: 0,
                        __doc: { $objectToArray: "$__doc" }
                    }
                },{
                    $unwind: "$__doc"
                },{
                    $set: {
                        "__doc.v": { $type: "$__doc.v" }
                    }
                },{
                    $group: {
                        _id: null,
                        "__doc": { $push: { "k": "$__doc.k", "v": "$__doc.v" } }
                    }
                },{
                    $project: {
                        _id: 0,
                        __doc: { $arrayToObject: "$__doc" }
                    }
                },{
                    $replaceRoot: { newRoot: { $mergeObjects: "$__doc" } }
                }
            ]
        }
    }
];
db.getSiblingDB(dbName).getCollection(collName).aggregate(agg, options).pretty();
```

### Sample schema output

Leveraging the Atlas test data suite as an example, we use "_`var dbName = 'sample_airbnb';`_" and "_`var collName = 'listingsAndReviews';`_" parameters to generate:

```javascript
{
    "Canonical (1D) shape (with most recent values)" : [
        {
            "_id" : "22879740",
            "listing_url" : "https://www.airbnb.com/rooms/22879740",
            "name" : "Nice bedroom",
            "summary" : "There is couple of markets nearby. By bus you can go to Kadikoy or Uskudar in 10 minutes.",
            "space" : "",
            "description" : "There is couple of markets nearby. By bus you can go to Kadikoy or Uskudar in 10 minutes.",
            "neighborhood_overview" : "",
            "notes" : "",
            "transit" : "",
            "access" : "",
            "interaction" : "",
            "house_rules" : "",
            "property_type" : "Apartment",
            "room_type" : "Private room",
            "bed_type" : "Real Bed",
            "minimum_nights" : "1",
            "maximum_nights" : "7",
            "cancellation_policy" : "flexible",
            "last_scraped" : ISODate("2019-02-18T05:00:00Z"),
            "calendar_last_scraped" : ISODate("2019-02-18T05:00:00Z"),
            "first_review" : ISODate("2015-05-02T04:00:00Z"),
            "last_review" : ISODate("2019-02-11T05:00:00Z"),
            "accommodates" : 2,
            "bedrooms" : 1,
            "beds" : 1,
            "number_of_reviews" : 0,
            "bathrooms" : NumberDecimal("1.0"),
            "amenities" : [
                "TV",
                "Wifi",
                "Kitchen",
                "Hot tub",
                "Heating",
                "Washer",
                "Essentials",
                "Shampoo",
                "Hair dryer",
                "Iron",
                "Private living room"
            ],
            "price" : NumberDecimal("90.00"),
            "security_deposit" : NumberDecimal("300.00"),
            "cleaning_fee" : NumberDecimal("20.00"),
            "extra_people" : NumberDecimal("0.00"),
            "guests_included" : NumberDecimal("1"),
            "images" : {
                "thumbnail_url" : "",
                "medium_url" : "",
                "picture_url" : "https://a0.muscache.com/im/pictures/0ccc141c-2899-4fdf-ac45-f39d2273027c.jpg?aki_policy=large",
                "xl_picture_url" : ""
            },
            "host" : {
                "host_id" : "75140848",
                "host_url" : "https://www.airbnb.com/users/show/75140848",
                "host_name" : "Burc",
                "host_location" : "TR",
                "host_about" : "",
                "host_thumbnail_url" : "https://a0.muscache.com/im/pictures/54e84e8c-f30b-49cc-8018-bbf111b9342a.jpg?aki_policy=profile_small",
                "host_picture_url" : "https://a0.muscache.com/im/pictures/54e84e8c-f30b-49cc-8018-bbf111b9342a.jpg?aki_policy=profile_x_medium",
                "host_neighbourhood" : "",
                "host_is_superhost" : false,
                "host_has_profile_pic" : true,
                "host_identity_verified" : false,
                "host_listings_count" : 1,
                "host_total_listings_count" : 1,
                "host_verifications" : [
                    "email",
                    "phone",
                    "google"
                ]
            },
            "address" : {
                "street" : "Üsküdar, İstanbul, Turkey",
                "suburb" : "Üsküdar",
                "government_area" : "Uskudar",
                "market" : "Istanbul",
                "country" : "Turkey",
                "country_code" : "TR",
                "location" : {
                    "type" : "Point",
                    "coordinates" : [
                        29.0184,
                        41.01082
                    ],
                    "is_location_exact" : false
                }
            },
            "availability" : {
                "availability_30" : 0,
                "availability_60" : 0,
                "availability_90" : 0,
                "availability_365" : 0
            },
            "review_scores" : {
            },
            "reviews" : [ ],
            "weekly_price" : NumberDecimal("1150.00"),
            "monthly_price" : NumberDecimal("4350.00"),
            "reviews_per_month" : 1
        }
    ],
    "Canonical (1D) shape with types" : [
        {
            "_id" : "string",
            "listing_url" : "string",
            "name" : "string",
            "summary" : "string",
            "space" : "string",
            "description" : "string",
            "neighborhood_overview" : "string",
            "notes" : "string",
            "transit" : "string",
            "access" : "string",
            "interaction" : "string",
            "house_rules" : "string",
            "property_type" : "string",
            "room_type" : "string",
            "bed_type" : "string",
            "minimum_nights" : "string",
            "maximum_nights" : "string",
            "cancellation_policy" : "string",
            "last_scraped" : "date",
            "calendar_last_scraped" : "date",
            "first_review" : "date",
            "last_review" : "date",
            "accommodates" : "int",
            "bedrooms" : "int",
            "beds" : "int",
            "number_of_reviews" : "int",
            "bathrooms" : "decimal",
            "amenities" : "array",
            "price" : "decimal",
            "security_deposit" : "decimal",
            "cleaning_fee" : "decimal",
            "extra_people" : "decimal",
            "guests_included" : "decimal",
            "images" : "object",
            "host" : "object",
            "address" : "object",
            "availability" : "object",
            "review_scores" : "object",
            "reviews" : "array",
            "weekly_price" : "decimal",
            "monthly_price" : "decimal",
            "reviews_per_month" : "int"
        }
    ]
}
```
