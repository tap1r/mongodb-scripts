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
   // A draw keeps the words as int32 halves. state and inc stay bigints.
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

   function hi32(word) {
      return Number(word >> 32n);
   }

   function lo32(word) {
      return Number(word & 0xffffffffn);
   }

   function join(hi, lo) {
      // The halves are int32. >>> 0 puts the high bit back.
      return (BigInt(hi >>> 0) << 32n) | BigInt(lo >>> 0);
   }

   function checkBound(bound) {
      let b;
      if (typeof bound === 'bigint') {
         if (bound >= 1n && bound <= MASK32)
            b = Number(bound);
      } else if (typeof bound === 'number' && Number.isInteger(bound) && bound >= 1 && bound <= 0xffffffff) {
         b = bound;
      }
      if (b === undefined)
         throw new Error('pcg32: bound must be an integer from 1 through 2^32-1');
      return b;
   }

   function create(state, inc) {
      const stateWord = word64(state, 'state');
      const incWord = oddInc(inc);
      let hi = hi32(stateWord) | 0;
      let lo = lo32(stateWord) | 0;
      let ihi = hi32(incWord) | 0;
      let ilo = lo32(incWord) | 0;

      function random() {
         const ohi = hi;
         const olo = lo;
         // Multiplier 0x5851f42d4c957f2d, one 16-bit column at a time.
         // | 0 keeps each column in int32. The halves are stored the same
         // way, and >>> 0 puts the high bit back on the way out. Carry is
         // the unsigned compare of the wrapped low half with the product.
         const a0 = olo & 0xffff;
         const a1 = olo >>> 16;
         const c0 = (a0 * 0x7f2d) | 0;
         const c1 = (a0 * 0x4c95) | 0;
         const c2 = (a1 * 0x7f2d) | 0;
         const mid = (c0 >>> 16) + (c1 & 0xffff) + (c2 & 0xffff);
         const plo = (c0 & 0xffff) | ((mid & 0xffff) << 16);
         const phi = ((a1 * 0x4c95) + (c1 >>> 16) + (c2 >>> 16) + (mid >>> 16)) | 0;
         const d0 = (a0 * 0xf42d) | 0;
         const d1 = (a0 * 0x5851) | 0;
         const d2 = (a1 * 0xf42d) | 0;
         const dmid = (d0 >>> 16) + (d1 & 0xffff) + (d2 & 0xffff);
         let cross = (d0 & 0xffff) | ((dmid & 0xffff) << 16);
         const h0 = ohi & 0xffff;
         const h1 = ohi >>> 16;
         const e0 = (h0 * 0x7f2d) | 0;
         const e1 = (h0 * 0x4c95) | 0;
         const e2 = (h1 * 0x7f2d) | 0;
         const emid = (e0 >>> 16) + (e1 & 0xffff) + (e2 & 0xffff);
         cross = (cross + ((e0 & 0xffff) | ((emid & 0xffff) << 16))) | 0;
         const sum = plo + ilo;
         lo = sum | 0;
         const carry = ((lo ^ -2147483648) < (plo ^ -2147483648)) | 0;
         hi = (phi + cross + ihi + carry) | 0;
         const xorLo = ((olo >>> 18) | ((ohi & 0x3ffff) << 14)) ^ olo;
         const xorHi = (ohi >>> 18) ^ ohi;
         const xorshifted = (xorLo >>> 27) | (xorHi << 5);
         const rot = ohi >>> 27;
         return ((xorshifted >>> rot) | (xorshifted << ((-rot) & 31))) >>> 0;
      }

      // A rejected sample is rare for small bounds, so it can pay for a call.
      function reject(b, threshold) {
         for (;;) {
            const n = random();
            if (n >= threshold)
               return n % b;
         }
      }

      // -1 is not a valid bound, so the first call always misses.
      let cachedBound = -1;
      let cachedThresh = 0;
      function boundedrand(bound) {
         // A repeated bound skips the range test and the threshold division.
         // The >>> test throws on a bigint, so the typeof test has to come first.
         // This is the same multiply as random(). A call costs more than the
         // copy in mongosh. A rejected sample uses random().
         let threshold;
         if (bound === cachedBound) {
            threshold = cachedThresh;
         } else {
            if (typeof bound !== 'number' || (bound >>> 0) !== bound || bound === 0)
               bound = checkBound(bound);
            threshold = ((-bound) >>> 0) % bound;
            cachedBound = bound;
            cachedThresh = threshold;
         }
         const ohi = hi;
         const olo = lo;
         const a0 = olo & 0xffff;
         const a1 = olo >>> 16;
         const c0 = (a0 * 0x7f2d) | 0;
         const c1 = (a0 * 0x4c95) | 0;
         const c2 = (a1 * 0x7f2d) | 0;
         const mid = (c0 >>> 16) + (c1 & 0xffff) + (c2 & 0xffff);
         const plo = (c0 & 0xffff) | ((mid & 0xffff) << 16);
         const phi = ((a1 * 0x4c95) + (c1 >>> 16) + (c2 >>> 16) + (mid >>> 16)) | 0;
         const d0 = (a0 * 0xf42d) | 0;
         const d1 = (a0 * 0x5851) | 0;
         const d2 = (a1 * 0xf42d) | 0;
         const dmid = (d0 >>> 16) + (d1 & 0xffff) + (d2 & 0xffff);
         let cross = (d0 & 0xffff) | ((dmid & 0xffff) << 16);
         const h0 = ohi & 0xffff;
         const h1 = ohi >>> 16;
         const e0 = (h0 * 0x7f2d) | 0;
         const e1 = (h0 * 0x4c95) | 0;
         const e2 = (h1 * 0x7f2d) | 0;
         const emid = (e0 >>> 16) + (e1 & 0xffff) + (e2 & 0xffff);
         cross = (cross + ((e0 & 0xffff) | ((emid & 0xffff) << 16))) | 0;
         const sum = plo + ilo;
         lo = sum | 0;
         const carry = ((lo ^ -2147483648) < (plo ^ -2147483648)) | 0;
         hi = (phi + cross + ihi + carry) | 0;
         const xorLo = ((olo >>> 18) | ((ohi & 0x3ffff) << 14)) ^ olo;
         const xorHi = (ohi >>> 18) ^ ohi;
         const xorshifted = (xorLo >>> 27) | (xorHi << 5);
         const rot = ohi >>> 27;
         const r = ((xorshifted >>> rot) | (xorshifted << ((-rot) & 31))) >>> 0;
         if (r >= threshold)
            return r % bound;
         return reject(bound, threshold);
      }

      function advance(delta) {
         let d = word64(delta, 'delta');
         let curMult = MULTIPLIER;
         let curPlus = join(ihi, ilo);
         let accMult = 1n;
         let accPlus = 0n;
         let s = join(hi, lo);
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
         hi = hi32(s) | 0;
         lo = lo32(s) | 0;
      }

      function srandom(seed, seq) {
         const initstate = word64(seed, 'seed');
         const initseq = word64(seq, 'sequence');
         hi = 0;
         lo = 0;
         // (seq << 1) | 1 is odd, including after the 64-bit mask.
         const incWord = ((initseq << 1n) | 1n) & MASK64;
         ihi = hi32(incWord) | 0;
         ilo = lo32(incWord) | 0;
         random();
         const mixed = (join(hi, lo) + initstate) & MASK64;
         hi = hi32(mixed) | 0;
         lo = lo32(mixed) | 0;
         random();
      }

      function clone() {
         return create(join(hi, lo), join(ihi, ilo));
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
            'get': function() { return join(hi, lo); },
            'set': function(value) {
               const word = word64(value, 'state');
               hi = hi32(word) | 0;
               lo = lo32(word) | 0;
            }
         },
         'inc': {
            'enumerable': true,
            'get': function() { return join(ihi, ilo); },
            'set': function(value) {
               const word = oddInc(value);
               ihi = hi32(word) | 0;
               ilo = lo32(word) | 0;
            }
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
