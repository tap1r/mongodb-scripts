/*
 *  Name: "modifiedCountDocumentsByKey.js"
 *  Version: "0.1.6"
 *  Description: "overloaded countDocuments mongosh helper"
 *  Disclaimer: "https://raw.githubusercontent.com/tap1r/mongodb-scripts/master/DISCLAIMER.md"
 *  Authors: ["tap1r <luke.prochazka@gmail.com>"]
 */

Object.getPrototypeOf(db.getSiblingDB('$').getCollection('_')).countDocuments = (function() {
   /*
    *  overloading the factory countDocuments helper to support this documented use case:
    *  https://www.mongodb.com/docs/manual/reference/method/db.collection.countDocuments/#count-all-documents-in-a-collection
    */
   const method = () => db.getSiblingDB('$').getCollection('_'); // collection method
   const fn = 'countDocuments'; // target method's name for overloaded
   //
   const _prototype = () => Object.getPrototypeOf(method()); // method's prototype
   const _fn = '_' + fn; // wrapped shadow method's name
   if (_prototype()[fn].name !== 'modifiedCountDocumentsByKey') {
      // copy to shadowed method from the prototype if it doesn't already exist
      _prototype()[_fn] = _prototype()[fn];
   }
   function modifiedCountDocumentsByKey(query = {}, options = {}, dbOptions = {}) {
      /*
       *  https://www.mongodb.com/docs/manual/reference/method/db.collection.countDocuments/#syntax
       */
      // substitute an empty filter with the optimised key scan method
      query = (Object.keys(query).length) ? query : { "_id": { "$gte": MinKey } };

      // pass the modified query to the shadow method
      return this[_fn](query, options, dbOptions);
   }
   // beware as existing mongosh decorators are not preserved with overloading
   return modifiedCountDocumentsByKey;
})();

(() => { // verification
   const _prototype = db.getSiblingDB('$').getCollection('_');
   console.log(assert(typeof _prototype._countDocuments === 'function', '_countDocuments is not a function, overloading failed.'));
   console.log(assert(_prototype.countDocuments.name === 'modifiedCountDocumentsByKey', 'countDocuments is not overloaded by modifiedCountDocumentsByKey, overloading failed.'));
})();

(() => { // performance validation
   const namespace = db.getSiblingDB('database').getCollection('collection');
   console.log('Pre-warming keys into cache from "database.collection".');
   namespace.countDocuments({ "_id": { "$gte": MinKey } });

   // time the expected key scan performance of the original method
   const t0 = process.hrtime();
   const countShadow = namespace._countDocuments({ "_id": { "$gte": MinKey } });
   const t1 = process.hrtime(t0);

   // time the overloaded method performance
   const t2 = process.hrtime();
   const countOverload = namespace.countDocuments();
   const t3 = process.hrtime(t2);

   const rtt1 = Math.round(t1[0] * 1000 + t1[1] / 1000000);
   const rtt2 = Math.round(t3[0] * 1000 + t3[1] / 1000000);

   console.log('Original count yields', countShadow, 'in', rtt1, 'ms');
   console.log('Overloaded count yields', countOverload, 'in', rtt2, 'ms');
})();

// EOF
