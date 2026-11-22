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
 *  Every generator has random(), srandom(seed, seq), and bigint
 *  state and inc. Those two words are readable and writable. random()
 *  returns the next uint32. srandom(seed, seq) selects the stream.
 *  Both arguments are required: an integer from 0 through 2^53-1, or
 *  a bigint from 0 through 2^64-1. inc must be odd.
 *  pcg32.seed(seed, seq) returns a new generator already seeded.
 *  pcg32.rng(state, inc) restores one from those raw words. Both
 *  arguments are required. The snapshot of gen is
 *  pcg32.rng(gen.state, gen.inc).
 *  pcg32.random_r(gen) and pcg32.srandom_r(gen, seed, seq) call the
 *  methods on that generator.
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
   const BRAND = Symbol('pcg32');

   function word64(value, label) {
      if (typeof value === 'bigint') {
         if (value < 0n || value > MASK64)
            throw new Error('pcg32: ' + label + ' does not fit in an unsigned 64-bit integer');
         return value;
      }
      if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
         const hi = Math.floor(value / TWO32);
         const lo = value % TWO32;
         return (BigInt(hi) << 32n) | BigInt(lo);
      }
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
      let s = state;
      let i = inc;

      function random() {
         const old = s;
         s = (old * MULTIPLIER + i) & MASK64;
         // JS shifts are 32-bit, so the xorshift result is masked first.
         const xorshifted = Number((((old >> 18n) ^ old) >> 27n) & MASK32);
         const rot = Number(old >> 59n);
         return ((xorshifted >>> rot) | (xorshifted << ((-rot) & 31))) >>> 0;
      }

      function srandom(seed, seq) {
         if (seed === undefined)
            throw new Error('pcg32: seed is required');
         if (seq === undefined)
            throw new Error('pcg32: sequence is required');
         const initstate = word64(seed, 'seed');
         const initseq = word64(seq, 'sequence');
         s = 0n;
         i = ((initseq << 1n) | 1n) & MASK64;
         random();
         s = (s + initstate) & MASK64;
         random();
      }

      const gen = {};
      Object.defineProperties(gen, {
         'random': { 'value': random },
         'srandom': { 'value': srandom },
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
      Object.defineProperty(gen, BRAND, { 'value': true });
      return gen;
   }

   function isGenerator(gen) {
      return gen != null && gen[BRAND] === true;
   }

   function rng(state, inc) {
      if (state === undefined || inc === undefined)
         throw new Error('pcg32: rng requires a state and an inc');
      return create(word64(state, 'state'), oddInc(inc));
   }

   function seed(initstate, initseq) {
      const gen = create(0n, 1n);
      gen.srandom(initstate, initseq);
      return gen;
   }

   function random_r(gen) {
      if (!isGenerator(gen))
         throw new Error('pcg32: random_r requires a generator');
      return gen.random();
   }

   function srandom_r(gen, initstate, initseq) {
      if (!isGenerator(gen))
         throw new Error('pcg32: srandom_r requires a generator');
      gen.srandom(initstate, initseq);
   }

   const stream = create(INITIAL_STATE, INITIAL_INC);
   Object.defineProperties(stream, {
      'rng': { 'value': rng },
      'seed': { 'value': seed },
      'random_r': { 'value': random_r },
      'srandom_r': { 'value': srandom_r }
   });
   return stream;
})();

// EOF
