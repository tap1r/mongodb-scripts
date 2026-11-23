# PCG32

[`src/pcg-xsh-rr.js`](src/pcg-xsh-rr.js) is one JavaScript `pcg32`. The generator is the basic-library PCG from Melissa O'Neill, `pcg32_setseq_xsh_rr`: a 64-bit linear congruential generator with the xorshift-high / rotate-right output. The minimal C form is [`pcg_basic.h`](https://github.com/imneme/pcg-c-basic/blob/master/pcg_basic.h) and [`pcg_basic.c`](https://github.com/imneme/pcg-c-basic/blob/master/pcg_basic.c) (Apache-2.0). The family is described in [PCG: A Family of Simple Fast Space-Efficient Statistically Good Algorithms for Random Number Generation](https://www.pcg-random.org/pdf/hmc-cs-2014-0905.pdf) and at [pcg-random.org](https://www.pcg-random.org/).

The JavaScript started as that generator written out with a 16-bit limb `UINT64`. That copy is frozen at [`legacy/mongo-shell/src/pcg-xsh-rr.js`](legacy/mongo-shell/src/pcg-xsh-rr.js). The live file keeps the same stream and is arranged around two mongosh constraints: a 64-bit integer is a heap allocation, and every function in a loaded script is rewritten into an async wrapper. The contract is in [ROADMAP](ROADMAP.md). There is no version field.

A seed is a value the caller keeps. `srandom(seed, seq)` and `spawn(seed, seq)` start one stream. Passing that same pair again rebuilds the same `random()` series, so a recorded run can be replayed. The sequence selects the stream: `(seq << 1) | 1` is one of 2^63 odd increments, and that stream has period 2^64. `spawn` returns the new generator and leaves the global `pcg32` on the stream it already held.

`$rand` in `mdblib.js` takes no seed. Each refill is new bytes from `crypto.webcrypto.getRandomValues`. A fuzzer seed that would record the number, pass it to `spawn`, and use that one stream for the run is tabled. The output of `pcg32` is statistical. `state` and `inc` determine the rest of the stream. The published generator is reported to pass TestU01 BigCrush. BigCrush was not run on this copy.

## The reference generator

`pcg32_random_t` is two `uint64_t` words, `state` and `inc`. `inc` is always odd, so each stream has period 2^64. `pcg32_srandom_r` stores `(initseq << 1) | 1`, steps once from state 0, adds the seed, and steps again. Both outputs are discarded. The published static initializer is `{ 0x853c49e6748fea9b, 0xda3e39cb94b95bdb }`.

A draw saves the old state, stores `old * 0x5851f42d4c957f2d + inc` modulo 2^64, and returns the XSH-RR of the saved state: `((old >> 18) ^ old) >> 27`, rotated right by `old >> 59`. `pcg32_boundedrand_r` draws until the sample is at least `2^32 % bound`, then returns `sample % bound`. A rejected sample has already advanced the state. The bound runs from 1 through 2^32−1.

The first draw on the published initializer is `0x152ca78d`. The first draw after `srandom(42, 54)` is `0xa15c02b7`. The limb copy and the live file both return that second value.

## The limb copy

The frozen file is the reference step written as methods on a four-limb object. Each shift, multiply, and add returns a new `UINT64`. `random()` then builds a hex string and passes it to `parseInt`. The global is `pcg32`, with `random`, `srandom`, `random_r`, and `srandom_r`. There is no `boundedrand`, `advance`, `spawn`, or `clone`. The snapshot is unmaintained.

A number seed on that file is split with `Math.floor(n / 0xffffffff)` and `n >> 32`. For 42 and 54 the split is still zero in the high half, which is why the first draw matches. The live file splits on 2^32, so a number between 2^32 and 2^53−1 lands in the right limbs.

## The live file

`pcg32` is one generator, started from the published initializer. `random()` returns the next uint32. `boundedrand(bound)` is the basic-library rejection loop. `advance(delta)` jumps the state by `delta` steps and leaves `inc` alone. `srandom(seed, seq)` reseeds that generator. `spawn(seed, seq)` returns a new generator and leaves `pcg32` on its current stream. `restore(state, inc)` returns a new generator with those raw words. `clone()` copies the current words. `state` and `inc` are enumerable bigint properties. An even `inc` throws and leaves the previous word.

A seed, sequence, state, or delta is an integer from 0 through 2^53−1, or a bigint through 2^64−1. The hot step stores the words as two int32 halves. `join` puts the high bit back with `>>> 0` when a caller reads `state` or `inc`. `advance` and the seed add in `srandom` still use bigint, then split the result back into the halves.

`boundedrand` compiles a body for a bound and keeps the last two. A power-of-two bound has threshold 0, so that body masks with `bound - 1` and keeps the first sample. Any other bound writes the remainder as a literal. The multiply sits in the compiled body. A call to `random()` for that sample costs more, under mongosh, than repeating the multiply. A third bound compiles again and drops the older body.

## What mongosh changes

mongosh 2.14.3 embeds Node v24.22.2. A script passed to `--file`, `--eval`, or `load()` is rewritten by `@mongosh/async-rewriter2`. Each user function starts an async function and returns the value when that function finishes before its first `await`. A call inside the function pays that wrapper on every iteration. The [scripting guide](mongosh-scripting-guide.md#a-tight-loop-pays-for-each-function-call) has the small-loop numbers. Node timings of the same call leave the wrapper out.

`random()` and `boundedrand()` are built with `new Function`. That string is compiled when the file runs, after the rewriter has finished with the file. Each generator keeps its four halves on one object. `random()` is its own function, so a hot `boundedrand()` leaves it alone. A direct `eval` in the same scope as the halves matched the stream and slowed later `random()` from about 32 ms to about 58 ms per million, and alternating bounds from about 80 ms to about 273 ms. Inside an inlined step, `r % bound` with a variable bound measured about 34 ms per million, step included, and the same loop with a literal `% 10` measured about 7 ms. The `boundedrand` wrapper keeps a compiled body for each of the last two bounds.

The halves are int32 (`| 0`) because a `>>> 0` result at or above 2^31 is a heap number in this engine. The value handed back to the caller is still `>>> 0`. `Math.imul` of the same 16-bit column products was about 700 ms per million in this shell. A `Uint32Array` of the four halves was about 9 ms per million `random()` calls on Node 26 and about 87 ms in mongosh 2.14.3, against about 42 ms for closed-over halves at that point in the work. The live file keeps the object.

## Timings

mongosh 2.14.3, `mongosh --nodb --quiet` on a file that `load()`s the generator. One million calls. Five samples, in milliseconds.

`random()` on the limb copy calls `pcg32.srandom(42, 54)` and then `pcg32.random()`. The live `random()`, `boundedrand(10)`, and alternating columns call `pcg32.spawn(42, 54)` inside the timed function, then the draw. Those results are consumed with `(s + draw) >>> 0`. The limb copy has no `boundedrand`.

The live `random()`, `boundedrand(10)`, and alternating columns are one sitting of the current file. The limb columns, the `srandom()` column, and `$rand` are earlier sittings on the same shell.

The `srandom()` column is one million calls of `srandom(i, 1)` on one generator. The live row calls `pcg32.spawn(0, 1)` before the timer, then `gen.srandom(i, 1)`. The limb row calls `pcg32.srandom(i, 1)`. The counted result is the number of calls. `srandom` on the live file is a function in the loaded script, so the rewriter wraps it, and the seed add still uses bigint. Each call discards two outputs and writes a new seed. That column is the cost of setting the stream.

`$rand` is that same earlier sitting as `srandom()`. The function is the pool in `mdblib.js`: 4096 uint32 values, refilled by `crypto.webcrypto.getRandomValues`, each draw `word / 2^32` in [0, 1). The harness copies those lines and does not `load()` `mdblib.js`. The function is top-level in the timed file, so the rewriter wraps it. The sum of the draws is consumed.

| Generator | `random()` | `srandom()` | `$rand` | `boundedrand(10)` | alternating 10 and 1000 |
| --- | --- | --- | --- | --- | --- |
| Limb copy | 3948.1, 3860.0, 3861.4, 3865.0, 3863.7 | 7473.5, 7402.2, 7424.6, 7414.5, 7503.7 |  |  |  |
| Live `src/pcg-xsh-rr.js` | 21.7, 21.4, 21.5, 21.3, 21.4 | 1644.7, 1643.0, 1643.5, 1643.1, 1644.3 |  | 40.7, 42.9, 43.1, 42.8, 42.7 | 44.5, 44.2, 44.0, 44.5, 45.9 |
| `$rand` |  |  | 594.5, 596.6, 594.3, 593.8, 593.1 |  |  |

Seed. The limb copy and the live file take a seed. The value of that argument is the pair the caller keeps: the same seed and sequence rebuild the `random()` series, which is what makes a recorded run replayable. The `srandom()` column is one million reseeds. `$rand` has no seed argument, so the caller has no pair to pass back and the next run is a new series.

The middle samples are 3863.7 ms and 21.4 ms for `random()`, 7424.6 ms and 1643.5 ms for `srandom()`, 594.3 ms for `$rand`, 42.8 ms for `boundedrand(10)`, and 44.5 ms for the alternating pair.

The same harness on the int32 file before `new Function` (commit `302d6cd`) was 31.2 ms, 91.7 ms, and 100.6 ms for those three calls. An earlier run of the bigint step, before the halves, was about 256 ms and 392 ms for `random()` and `boundedrand(10)`.
