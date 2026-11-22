/*
 *  Name: "pcg-xsh-rr.js"
 *  Description: "PCG-XSH-RR 32-bit generator"
 *  Disclaimer: "https://raw.githubusercontent.com/tap1r/mongodb-scripts/master/DISCLAIMER.md"
 *  Authors: ["tap1r <luke.prochazka@gmail.com>"]
 *
 *  Mongosh 1.10 / 2.10+. The frozen limb copy is
 *  legacy/mongo-shell/src/pcg-xsh-rr.js.
 *
 *  pcg32 is one generator, started from the published initializer.
 *  Every generator has random(), boundedrand(bound), advance(delta),
 *  srandom(seed, seq), clone(), and bigint state and inc. Those two
 *  words are readable and writable. random() returns the next uint32.
 *  boundedrand(bound) returns an unbiased integer in 0 .. bound-1.
 *  bound is an integer from 1 through 2^32-1. advance(delta) moves
 *  the state forward delta steps. delta follows the same integer
 *  rules as a seed. srandom(seed, seq) reseeds this generator. A seed
 *  or sequence is an integer from 0 through 2^53-1, or a bigint from
 *  0 through 2^64-1. inc must be odd.
 *  pcg32.spawn(seed, seq) returns a new generator already seeded.
 *  It does not change pcg32.
 *  pcg32.restore(state, inc) returns a new generator with those raw
 *  words. Both arguments are required.
 *  gen.clone() returns a new generator with gen's current words.
 */

var pcg32 = (function() {
   'use strict';

   // PCG-XSH-RR: 64-bit LCG, 32-bit xorshift-high / rotate output.
   const MULTIPLIER = 0x5851f42d4c957f2dn;
   const MASK64 = 0xffffffffffffffffn;
   const MASK32 = 0xffffffffn;
   // Published initializer. random() follows this stream until srandom().
   const INITIAL_STATE = 0x853c49e6748fea9bn;
   const INITIAL_INC = 0xda3e39cb94b95bdbn;
   const TWO32 = 4294967296;

   // A uint64 word, or null when the value is not one.
   function parseWord(value) {
      if (typeof value === 'bigint')
         return (value >= 0n && value <= MASK64) ? value : null;
      if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
         const hi = Math.floor(value / TWO32);
         const lo = value % TWO32;
         return (BigInt(hi) << 32n) | BigInt(lo);
      }
      return null;
   }

   function word64(value, label) {
      const word = parseWord(value);
      if (word !== null)
         return word;
      throw new Error('pcg32: ' + label + ' must be an integer from 0 through 2^53-1, or a bigint through 2^64-1');
   }

   // The LCG modulus is 2^64, so a full period needs an odd increment.
   function oddInc(value) {
      const word = word64(value, 'inc');
      if ((word & 1n) === 0n)
         throw new Error('pcg32: inc must be odd');
      return word;
   }

   function create(state, inc) {
      let s = word64(state, 'state');
      let i = oddInc(inc);

      function random() {
         const old = s;
         s = (old * MULTIPLIER + i) & MASK64;
         // JS shifts are 32-bit, so the xorshift result is masked first.
         const xorshifted = Number((((old >> 18n) ^ old) >> 27n) & MASK32);
         const rot = Number(old >> 59n);
         return ((xorshifted >>> rot) | (xorshifted << ((-rot) & 31))) >>> 0;
      }

      function boundedrand(bound) {
         let b;
         if (typeof bound === 'bigint') {
            if (bound >= 1n && bound <= MASK32)
               b = Number(bound);
         } else if (typeof bound === 'number' && Number.isInteger(bound) && bound >= 1 && bound <= 0xffffffff) {
            b = bound;
         }
         if (b === undefined)
            throw new Error('pcg32: bound must be an integer from 1 through 2^32-1');
         // (-bound) mod 2^32, then mod bound. Samples below that threshold are rejected.
         const threshold = ((-b) >>> 0) % b;
         for (;;) {
            const r = random();
            if (r >= threshold)
               return r % b;
         }
      }

      function advance(delta) {
         let d = word64(delta, 'delta');
         let curMult = MULTIPLIER;
         let curPlus = i;
         let accMult = 1n;
         let accPlus = 0n;
         while (d > 0n) {
            if ((d & 1n) === 1n) {
               accMult = (accMult * curMult) & MASK64;
               accPlus = (accPlus * curMult + curPlus) & MASK64;
            }
            curPlus = ((curMult + 1n) * curPlus) & MASK64;
            curMult = (curMult * curMult) & MASK64;
            d >>= 1n;
         }
         s = (accMult * s + accPlus) & MASK64;
      }

      function srandom(seed, seq) {
         const initstate = word64(seed, 'seed');
         const initseq = word64(seq, 'sequence');
         s = 0n;
         // (seq << 1) | 1 is odd, including after the 64-bit mask.
         i = ((initseq << 1n) | 1n) & MASK64;
         random();
         s = (s + initstate) & MASK64;
         random();
      }

      function clone() {
         return create(s, i);
      }

      const gen = {};
      Object.defineProperties(gen, {
         'random': { 'value': random },
         'boundedrand': { 'value': boundedrand },
         'advance': { 'value': advance },
         'srandom': { 'value': srandom },
         'clone': { 'value': clone },
         'state': {
            'enumerable': true,
            'get': function() { return s; },
            'set': function(value) { s = word64(value, 'state'); }
         },
         'inc': {
            'enumerable': true,
            'get': function() { return i; },
            'set': function(value) { i = oddInc(value); }
         }
      });
      return gen;
   }

   function restore(state, inc) {
      return create(state, inc);
   }

   function spawn(initstate, initseq) {
      const gen = create(0n, 1n);
      gen.srandom(initstate, initseq);
      return gen;
   }

   const stream = create(INITIAL_STATE, INITIAL_INC);
   Object.defineProperties(stream, {
      'spawn': { 'value': spawn },
      'restore': { 'value': restore }
   });
   return stream;
})();

// EOF
