# PCG32

[`src/pcg-xsh-rr.js`](src/pcg-xsh-rr.js) is a JavaScript `pcg32`. It follows Melissa O'Neill's basic-library generator, `pcg32_setseq_xsh_rr`: a 64-bit linear congruential generator, with an xorshift and a rotate that turn the state into a 32-bit result. The short C form is [`pcg_basic.h`](https://github.com/imneme/pcg-c-basic/blob/master/pcg_basic.h) and [`pcg_basic.c`](https://github.com/imneme/pcg-c-basic/blob/master/pcg_basic.c) (Apache-2.0). The family is described in [PCG: A Family of Simple Fast Space-Efficient Statistically Good Algorithms for Random Number Generation](https://www.pcg-random.org/pdf/hmc-cs-2014-0905.pdf) and at [pcg-random.org](https://www.pcg-random.org/).

This repo has two copies of that generator. The reference implementation is frozen at [`legacy/mongo-shell/src/pcg-xsh-rr.js`](legacy/mongo-shell/src/pcg-xsh-rr.js). The live file is the one linked above. They produce the same stream. The live file is written for mongosh, where a 64-bit integer is a heap allocation and every function in a loaded script is wrapped so it can be awaited. The call list is in the [roadmap](ROADMAP.md). The live file has no version number.

## What a seed is for

`srandom(seed, seq)` and `spawn(seed, seq)` start one stream. Keep the pair. Passing that same pair again rebuilds the same series of `random()` results, so a recorded run can be replayed.

The sequence picks the stream. The generator stores `(seq << 1) | 1`, one of 2^63 odd increments, and that stream has period 2^64. `spawn` returns the new generator and leaves the global `pcg32` on the stream it already held.

`$rand` in `mdblib.js` takes no seed. When its pool runs dry it reads fresh bytes from `crypto.webcrypto.getRandomValues()`, so the next run is a new series. A fuzzer option that would record a seed, pass it to `spawn`, and keep that one stream for the run is planned, and the fuzzer still draws with `$rand`.

`Math.random()` is the engine's own generator. The engine seeds it, and a script has no way to read, set, or jump that state.

`pcg32` is a statistical generator. `state` and `inc` determine every later result. The published generator is reported to pass TestU01 BigCrush. BigCrush was not run on this copy.

## How a draw works

The C generator is two 64-bit words, `state` and `inc`. `inc` stays odd. Seeding stores `(initseq << 1) | 1`, steps once from state 0, adds the seed, and steps again. Both of those outputs are thrown away. A fresh generator starts at `{ 0x853c49e6748fea9b, 0xda3e39cb94b95bdb }`.

A draw remembers the old state, stores `old * 0x5851f42d4c957f2d + inc` modulo 2^64, and returns an xorshift-rotate of the saved state: `((old >> 18) ^ old) >> 27`, rotated right by `old >> 59`.

`boundedrand(bound)` keeps drawing until the sample is at least `2^32 % bound`, then returns `sample % bound`. A rejected sample has already moved the state. The bound runs from 1 through 2^32−1.

The first `random()` on a fresh generator is `0x152ca78d`. The first `random()` after `srandom(42, 54)` is `0xa15c02b7`. The reference implementation and the live file both return that second value.

## Reference implementation

The frozen file writes the step as methods on an object of four 16-bit limbs. Each shift, multiply, and add builds a new `UINT64`. `random()` then makes a hex string and passes it to `parseInt`. The global is `pcg32`, and its methods are `random`, `srandom`, `random_r`, and `srandom_r`. The file is left as it was.

A number seed there is split with `Math.floor(n / 0xffffffff)` and `n >> 32`. For 42 and 54 the high half is still zero, so the first draw matches the live file. The live file splits on 2^32, so a number from 2^32 through 2^53−1 lands in the right half.

## Live file

`pcg32` starts from the published initializer.

- `random()` returns the next uint32.
- `boundedrand(bound)` is the rejection loop above.
- `advance(delta)` moves the state forward `delta` steps and leaves `inc` alone.
- `srandom(seed, seq)` reseeds this generator.
- `spawn(seed, seq)` returns a new generator and leaves `pcg32` where it was.
- `restore(state, inc)` returns a new generator holding those two words.
- `clone()` copies the current words.
- `state` and `inc` are enumerable bigint properties. Writing an even `inc` throws, and the previous word stays.

A seed, sequence, state, or delta is an integer from 0 through 2^53−1, or a bigint through 2^64−1.

The hot step keeps each 64-bit word as two int32 halves, so a draw does not allocate a bigint. Reading `state` or `inc` puts the high bit back with `>>> 0`. `advance` still uses bigint.

When both `srandom` arguments are numbers in the uint32 range, the reseed stays on numbers. It stores the odd increment, adds the seed with a carry into the high half, and takes one more step. The output of that step is discarded. A bigint, or a number above 2^32−1, still runs the bigint mix and then splits the words back into halves.

`boundedrand` compiles a small function for a bound and remembers the last two. A power-of-two bound masks with `bound - 1`. Any other bound writes the remainder as a literal number in that function. A third distinct bound compiles again and drops the older one.

`random()`, `boundedrand()`, and the numeric `srandom()` are built with `new Function`. mongosh rewrites every function in a script it loads, and that wrapper is paid on every call from a tight loop. A string passed to `new Function` is compiled afterwards, as ordinary JavaScript. The [scripting guide](mongosh-scripting-guide.md#a-tight-loop-pays-for-each-function-call) measures that wrapper on a smaller loop.

## Timings

Each number is the average of five samples. A sample is one million calls. The reference implementation, the live calls, and `crypto.webcrypto.getRandomValues()` were each timed in their own mongosh 2.14.3 process, with `mongosh --nodb --quiet` on one file. `Math.random()` was timed in Node v26.13.1. That Node is separate from the Node v24.22.2 embedded in mongosh 2.14.3.

| Call | One million calls |
| --- | ---: |
| Reference implementation `random()` | 3845.8 ms |
| Reference implementation `srandom()` | 7537.6 ms |
| Live `random()` | 22.6 ms |
| Live `srandom()` | 5.5 ms |
| Live `boundedrand(10)` | 17.4 ms |
| Live `boundedrand`, alternating 10 and 1000 | 17.8 ms |
| `crypto.webcrypto.getRandomValues()` | 460.1 ms |
| Node `Math.random()` | 3.3 ms |

`random()` on the reference implementation seeds with `pcg32.srandom(42, 54)` and then calls `pcg32.random()`. The live `random()` and `boundedrand` rows call `pcg32.spawn(42, 54)` inside the timed function, then draw. Each draw is folded into a running uint32, `(s + draw) >>> 0`, so the result has to be produced. `boundedrand(10)` uses one compiled body. The alternating row uses both cached bodies, bounds 10 and 1000.

The `srandom()` rows are one million reseeds, `srandom(i, 1)`, on one generator. The reference row calls `pcg32.srandom`. The live row creates the generator with `pcg32.spawn(0, 1)` once, inside the function that runs the loop, before the timer starts, then calls `gen.srandom(i, 1)`. The value kept from the loop is the number of calls. That row is the cost of setting the stream. A generator created at the top of the file is a different cost, because mongosh turns that binding into a global and every call pays for the lookup.

`crypto.webcrypto.getRandomValues()` is the runtime call underneath `$rand`. The row is one million of those calls. Each call fills a `Uint32Array` of one word, created once inside the timed function, and the word is folded in with `(s + buf[0]) >>> 0`. The loop sits in a nested function, the same shape as the live `random()` row. `$rand` in `mdblib.js` is the fuzzer's helper on top of this call: it keeps 4096 words and hands them out one at a time.

Node `Math.random()` is one million calls in a file run by Node v26.13.1. Each call returns a float in [0, 1), and the sum is kept. That figure is the engine's generator, timed as ordinary JavaScript.

The reference implementation and the live file both take a seed. The pair you keep is what makes the series replayable. `crypto.webcrypto.getRandomValues()` and `Math.random()` take no seed, so the next run is a new series.
