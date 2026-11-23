/*
 *  Name: "pcg-xsh-rr.js"
 *  Description: "PCG-XSH-RR 32-bit generator"
 *  Disclaimer: "https://raw.githubusercontent.com/tap1r/mongodb-scripts/master/DISCLAIMER.md"
 *  Authors: ["tap1r <luke.prochazka@gmail.com>"]
 *
 *  Mongosh 1.10 / 2.10+. The reference implementation in this repo is
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

   // A uint64 word, or null when the value is not one. A bigint may
   // run through 2^64-1. A number stops at 2^53-1 and is split on 2^32.
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

   // The word, or a throw that names the argument.
   function word64(value, label) {
      const word = parseWord(value);
      if (word !== null)
         return word;
      throw new Error('pcg32: ' + label + ' must be an integer from 0 through 2^53-1, or a bigint through 2^64-1');
   }

   // The period is 2^64 only when inc is odd.
   function oddInc(value) {
      const word = word64(value, 'inc');
      if ((word & 1n) === 0n)
         throw new Error('pcg32: inc must be odd');
      return word;
   }

   // One half of a bigint word, as a number. The store uses `| 0`, so a
   // half with the high bit set stays an int32. A uint32 store would be
   // a heap number on every such step.
   function hi32(word) {
      return Number(word >> 32n);
   }

   // The low half. Same storage rule as hi32.
   function lo32(word) {
      return Number(word & 0xffffffffn);
   }

   // A bigint from the int32 halves. >>> 0 puts the high bit back.
   function join(hi, lo) {
      return (BigInt(hi >>> 0) << 32n) | BigInt(lo >>> 0);
   }

   // An integer from 1 through 2^32-1. A bigint in range becomes that number.
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

   // One LCG step. The saved state stays in ohi/olo and the new state
   // lands in hi/lo. Sixteen-bit columns, because a 32-bit chunk times
   // a 16-bit limb does not fit in 32 bits and >>> drops a carry past
   // 2^32. `| 0` keeps each product an int32 multiply. Carry is the
   // unsigned compare of the wrapped low half with the product, by
   // flipping the sign bit. random() and boundedrand() use this string.
   const STATE =
      'const ohi=hi;' +
      'const olo=lo;' +
      'const a0=olo&0xffff;' +
      'const a1=olo>>>16;' +
      'const c0=(a0*0x7f2d)|0;' +
      'const c1=(a0*0x4c95)|0;' +
      'const c2=(a1*0x7f2d)|0;' +
      'const mid=(c0>>>16)+(c1&0xffff)+(c2&0xffff);' +
      'const plo=(c0&0xffff)|((mid&0xffff)<<16);' +
      'const phi=((a1*0x4c95)+(c1>>>16)+(c2>>>16)+(mid>>>16))|0;' +
      'const d0=(a0*0xf42d)|0;' +
      'const d1=(a0*0x5851)|0;' +
      'const d2=(a1*0xf42d)|0;' +
      'const dmid=(d0>>>16)+(d1&0xffff)+(d2&0xffff);' +
      'let cross=(d0&0xffff)|((dmid&0xffff)<<16);' +
      'const h0=ohi&0xffff;' +
      'const h1=ohi>>>16;' +
      'const e0=(h0*0x7f2d)|0;' +
      'const e1=(h0*0x4c95)|0;' +
      'const e2=(h1*0x7f2d)|0;' +
      'const emid=(e0>>>16)+(e1&0xffff)+(e2&0xffff);' +
      'cross=(cross+((e0&0xffff)|((emid&0xffff)<<16)))|0;' +
      'const sum=plo+ilo;' +
      'lo=sum|0;' +
      'const carry=((lo^-2147483648)<(plo^-2147483648))|0;' +
      'hi=(phi+cross+ihi+carry)|0;';

   // The reseed's second step. Its high half is 0, 1, or 2, so the
   // high-half columns of STATE collapse to hi * 0x4c957f2d. This string
   // is for that step only.
   const SEED =
      'const olo=lo;' +
      'const a0=olo&0xffff;' +
      'const a1=olo>>>16;' +
      'const c0=(a0*0x7f2d)|0;' +
      'const c1=(a0*0x4c95)|0;' +
      'const c2=(a1*0x7f2d)|0;' +
      'const mid=(c0>>>16)+(c1&0xffff)+(c2&0xffff);' +
      'const plo=(c0&0xffff)|((mid&0xffff)<<16);' +
      'const phi=((a1*0x4c95)+(c1>>>16)+(c2>>>16)+(mid>>>16))|0;' +
      'const d0=(a0*0xf42d)|0;' +
      'const d1=(a0*0x5851)|0;' +
      'const d2=(a1*0xf42d)|0;' +
      'const dmid=(d0>>>16)+(d1&0xffff)+(d2&0xffff);' +
      'let cross=(d0&0xffff)|((dmid&0xffff)<<16);' +
      'cross=(cross+(hi*0x4c957f2d))|0;' +
      'const sum=plo+ilo;' +
      'lo=sum|0;' +
      'const carry=((lo^-2147483648)<(plo^-2147483648))|0;' +
      'hi=(phi+cross+ihi+carry)|0;';

   // XSH-RR of the saved state: ((old >> 18) ^ old) >> 27, rotated right
   // by old >> 59. The final >>> 0 is the uint32 result.
   const OUTPUT =
      'const xorLo=((olo>>>18)|((ohi&0x3ffff)<<14))^olo;' +
      'const xorHi=(ohi>>>18)^ohi;' +
      'const xorshifted=(xorLo>>>27)|(xorHi<<5);' +
      'const rot=ohi>>>27;' +
      'const r=((xorshifted>>>rot)|(xorshifted<<((-rot)&31)))>>>0;';

   const STEP = STATE + OUTPUT;

   // One random() per generator. new Function compiles after mongosh has
   // rewritten the file, so a tight loop does not pay that wrapper.
   // This call stays separate from boundedrand(), so each keeps its own shape.
   const buildRandom = new Function('box',
      '"use strict";return function random(){' +
         'let hi=box.hi, lo=box.lo, ihi=box.ihi, ilo=box.ilo;' +
         STEP +
         'box.hi=hi; box.lo=lo; return r;' +
      '};'
   );

   // Multiply-add only. The reseed throws this step's output away, so
   // OUTPUT stays out. Its own function keeps srandom a small call.
   const buildStep = new Function('box',
      '"use strict";return function step(){' +
         'let hi=box.hi, lo=box.lo, ihi=box.ihi, ilo=box.ilo;' +
         SEED +
         'box.hi=hi; box.lo=lo;' +
      '};'
   );

   // The bound is a decimal in the body. checkBound has accepted it.
   // A power of two masks with bound - 1 and keeps the first sample.
   // Any other bound uses a literal remainder, and a sample below the
   // threshold is drawn again.
   function compileBound(box, bound, threshold) {
      const b = bound >>> 0;
      const t = threshold >>> 0;
      const mod = t === 0 ? ('r&' + (b - 1)) : ('r%' + b);
      const accept = 'box.hi=hi;box.lo=lo;return ' + mod + ';';
      const body = t === 0
         ? STEP + accept
         : STEP + 'if(r>=' + t + '){' + accept + '}for(;;){' + STEP + 'if(r>=' + t + '){' + accept + '}}';
      return new Function('box',
         '"use strict";return function(){' +
            'let hi=box.hi,lo=box.lo,ihi=box.ihi,ilo=box.ilo;' +
            body +
         '};'
      )(box);
   }

   // The last two bounds, most recent first. srandom does not clear them.
   // An empty slot is f0 === null, and s0 starts at 0, so a bound of -1
   // must not call an empty slot. The lookup runs again after checkBound,
   // because a bigint bound becomes the number a slot may already hold.
   const buildBound = new Function('box', 'checkBound', 'compileBound',
      '"use strict";' +
      'let s0=0,f0=null,s1=0,f1=null;' +
      'return function boundedrand(bound){' +
         'if(f0!==null&&bound===s0)return f0();' +
         'if(f1!==null&&bound===s1){' +
            'const f=f0,s=s0;f0=f1;s0=s1;f1=f;s1=s;return f0();' +
         '}' +
         'if(typeof bound!=="number"||(bound>>>0)!==bound||bound===0)bound=checkBound(bound);' +
         'if(f0!==null&&bound===s0)return f0();' +
         'if(f1!==null&&bound===s1){' +
            'const f=f0,s=s0;f0=f1;s0=s1;f1=f;s1=s;return f0();' +
         '}' +
         'const threshold=((-bound)>>>0)%bound;' +
         'f1=f0;s1=s0;s0=bound;f0=compileBound(box,bound,threshold);' +
         'return f0();' +
      '};'
   );

   // One box of four int32 halves. random, the reseed step, and
   // boundedrand close over that box.
   function create(state, inc) {
      const stateWord = word64(state, 'state');
      const incWord = oddInc(inc);
      const box = {
         'hi': hi32(stateWord) | 0,
         'lo': lo32(stateWord) | 0,
         'ihi': hi32(incWord) | 0,
         'ilo': lo32(incWord) | 0
      };
      const random = buildRandom(box);
      const step = buildStep(box);
      const boundedrand = buildBound(box, checkBound, compileBound);

      // Jump the state by delta steps. inc stays. The jump is bigint,
      // which a draw does not use.
      function advance(delta) {
         let d = word64(delta, 'delta');
         let curMult = MULTIPLIER;
         let curPlus = join(box.ihi, box.ilo);
         let accMult = 1n;
         let accPlus = 0n;
         let s = join(box.hi, box.lo);
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
         box.hi = hi32(s) | 0;
         box.lo = lo32(s) | 0;
      }

      // Bigint arguments, and numbers above 2^32-1. Two draws discard
      // the two seed outputs. A uint32 pair uses the fast path below.
      function slowSrandom(seed, seq) {
         const initstate = word64(seed, 'seed');
         const initseq = word64(seq, 'sequence');
         box.hi = 0;
         box.lo = 0;
         // (seq << 1) | 1 is odd, including after the 64-bit mask.
         const nextInc = ((initseq << 1n) | 1n) & MASK64;
         box.ihi = hi32(nextInc) | 0;
         box.ilo = lo32(nextInc) | 0;
         random();
         const mixed = (join(box.hi, box.lo) + initstate) & MASK64;
         box.hi = hi32(mixed) | 0;
         box.lo = lo32(mixed) | 0;
         random();
      }

      // Both arguments are uint32 numbers, and -0 counts as 0. The
      // increment is (seq * 2) >>> 0 | 1, because a shift of the whole
      // word would drop a high bit. The first step from state 0 is that
      // increment, so the seed is added to it and one step() finishes
      // the reseed. Anything else goes to slowSrandom.
      const srandom = new Function('box', 'step', 'slow',
         '"use strict";return function srandom(seed,seq){' +
            'if(typeof seed!=="number"||typeof seq!=="number"||(seed>>>0)!==seed||(seq>>>0)!==seq)return slow(seed,seq);' +
            'box.ihi=seq>>>31;' +
            'box.ilo=(((seq*2)>>>0)|1)|0;' +
            'box.hi=box.ihi;' +
            'box.lo=box.ilo;' +
            'const lo=(box.lo>>>0)+seed;' +
            'box.lo=lo|0;' +
            'box.hi=(box.hi+(lo>=4294967296?1:0))|0;' +
            'step();' +
         '};'
      )(box, step, slowSrandom);

      // A new generator with these words.
      function clone() {
         return create(join(box.hi, box.lo), join(box.ihi, box.ilo));
      }

      // state and inc are the enumerable bigint view of the halves.
      // Writing an even inc throws, and the previous word stays.
      const gen = {};
      Object.defineProperties(gen, {
         'random': { 'value': random },
         'boundedrand': { 'value': boundedrand },
         'advance': { 'value': advance },
         'srandom': { 'value': srandom },
         'clone': { 'value': clone },
         'state': {
            'enumerable': true,
            'get': function() { return join(box.hi, box.lo); },
            'set': function(value) {
               const word = word64(value, 'state');
               box.hi = hi32(word) | 0;
               box.lo = lo32(word) | 0;
            }
         },
         'inc': {
            'enumerable': true,
            'get': function() { return join(box.ihi, box.ilo); },
            'set': function(value) {
               const word = oddInc(value);
               box.ihi = hi32(word) | 0;
               box.ilo = lo32(word) | 0;
            }
         }
      });
      return gen;
   }

   // A new generator holding these raw words. Both are required.
   function restore(state, inc) {
      return create(state, inc);
   }

   // A new seeded generator. The global pcg32 keeps its stream.
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
