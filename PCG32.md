# PCG32

[`src/pcg-xsh-rr.js`](src/pcg-xsh-rr.js) is an optimised JavaScript `pcg32` for mongosh. It follows Melissa O'Neill's basic-library generator, `pcg32_setseq_xsh_rr`: a 64-bit linear congruential generator, with an xorshift and a rotate that turn the state into a 32-bit result. The short C form is [`pcg_basic.h`](https://github.com/imneme/pcg-c-basic/blob/master/pcg_basic.h) and [`pcg_basic.c`](https://github.com/imneme/pcg-c-basic/blob/master/pcg_basic.c) (Apache-2.0). The family is described in [PCG: A Family of Simple Fast Space-Efficient Statistically Good Algorithms for Random Number Generation](https://www.pcg-random.org/pdf/hmc-cs-2014-0905.pdf) and at [pcg-random.org](https://www.pcg-random.org/).

The rows below put that generator next to `crypto.webcrypto.getRandomValues()` and Node's `Math.random()`. Each figure is the average of five samples of one million calls. The `pcg32` rows and `crypto.webcrypto.getRandomValues()` each ran in their own mongosh 2.14.3 process. `Math.random()` ran in Node v26.13.1. The last column bins the high byte of a uint32, 256 ways, and reports χ² divided by 255. `boundedrand(10)` uses ten bins and divides by 9, so those histograms share one scale. A fair split of independent draws scatters around 1. Below 1 is flatter than that, and above 1 is more uneven.

| Call | One million calls | χ² / df |
| --- | ---: | ---: |
| Reference implementation `random()` | 3845.8 ms | 0.99 |
| Reference implementation `srandom()` | 7537.6 ms | 0.28 |
| Optimised `random()` | 22.6 ms | 0.99 |
| Optimised `srandom()` | 5.5 ms | 0.28 |
| Optimised `boundedrand(10)` | 17.4 ms | 1.11 |
| Optimised `boundedrand`, alternating 10 and 1000 | 17.8 ms |  |
| `crypto.webcrypto.getRandomValues()` | 460.1 ms | 0.93 |
| Node `Math.random()` | 3.3 ms | 0.99 |

The alternating row mixes two bounds, so that cell is empty. The `srandom()` rows are one million reseeds, `srandom(i, 1)`. The ratio 0.28 is the high byte of the first `random()` after each seed from `0` through `999999`, with sequence `1`. The 3.3 ms figure is Node's `Math.random()`, set beside the mongosh timings.

## Which one to reach for

**Replay a run.** Use Optimised `pcg32`, the file linked above. `spawn(seed, seq)` or `srandom(seed, seq)` starts one stream, and the same pair builds that stream again, so a recorded run can be played back. `random()` is the next uint32. `boundedrand(bound)` is an unbiased integer from 0 through `bound - 1`, which is the call for a die, an array slot, or a field that should not pile up at the low end. `advance(delta)` skips forward that many steps and leaves `inc`, the stream number, alone. Write the seed and the sequence down with the output. `state` and `inc` determine every later result, so a key, a token, or a nonce wants `crypto.webcrypto.getRandomValues()`.

**See the straightforward copy.** The reference implementation is frozen at [`legacy/mongo-shell/src/pcg-xsh-rr.js`](legacy/mongo-shell/src/pcg-xsh-rr.js). It is the same generator, written as methods on 16-bit limbs, and it is the slow row in the table. Use it to check that Optimised still returns the same stream. A loop that draws wants Optimised.

**Hide the next value.** `crypto.webcrypto.getRandomValues()` fills a typed array from the operating system's generator. Earlier outputs leave the next ones unpredictable. That is the call for key material, a session token, a nonce, or an IV. It takes no seed, so the next run is a new series.

**Take the engine's own float.** `Math.random()` returns a number in `[0, 1)`. On this machine it is V8's xorshift128+, inside Node. It is the fastest row in the table. The engine seeds it, and a script has no way to read that state, set it, or jump it. Use it for a throwaway shuffle or a sample where the series never has to come back and the number is not a secret. V8's own note on this generator says it stays the wrong tool for hashing, signatures, and encryption.

The uniformity column above only asks whether one byte of each output is spread evenly. `Math.random()` and `getRandomValues()` agree on that check. The choice between them is whether the next value has to stay hidden.

## How a `pcg32` draw works

The generator is two 64-bit words, `state` and `inc`. `inc` stays odd. Seeding stores `(initseq << 1) | 1`, one of 2^63 streams, steps once from state 0, adds the seed, and steps again. Both of those outputs are thrown away. A fresh generator starts at `{ 0x853c49e6748fea9b, 0xda3e39cb94b95bdb }`.

A draw remembers the old state, stores `old * 0x5851f42d4c957f2d + inc` modulo 2^64, and returns an xorshift-rotate of the saved state: `((old >> 18) ^ old) >> 27`, rotated right by `old >> 59`. Each stream has period 2^64. `spawn` returns the new generator and leaves the global `pcg32` on the stream it already held.

A plain `random() % bound` favours the low end whenever `bound` is not a power of two. `boundedrand(bound)` avoids that. It keeps drawing until the sample is at least `2^32 % bound`, then returns `sample % bound`. A sample that is thrown away has already moved the state. The bound runs from 1 through 2^32−1.

The first `random()` on a fresh generator is `0x152ca78d`. The first `random()` after `srandom(42, 54)` is `0xa15c02b7`. The reference implementation and Optimised both return that second value. The published generator is reported to pass TestU01 BigCrush, a long statistical test suite. BigCrush was not run on this copy.

## Reference implementation

Each shift, multiply, and add on the frozen file builds a new `UINT64`. `random()` then makes a hex string and passes it to `parseInt`. That is the slow row.

A number seed there is split with `Math.floor(n / 0xffffffff)` as the high half and `n >> 32` as the low half. In JavaScript the shift count keeps only its low five bits, so `n >> 32` is the number as a 32-bit integer and a small seed stays in the low half. For 42 and 54 the high half is still zero, so the first draw matches Optimised. Optimised splits on 2^32. The two splits diverge once the seed reaches 8589934590, which is `2 * (2^32−1)`.

## Optimised

Same generator as the reference row, with the step kept on ordinary numbers so a tight loop in mongosh stays fast.

mongosh makes a 64-bit integer a heap allocation, and it wraps every function in a loaded script so the function can be awaited. The hot step keeps each word as two int32 halves, so a draw does not allocate a bigint. Reading `state` or `inc` puts the high bit back with `>>> 0`. `advance` still uses bigint, because a jump is rare next to a draw.

When both `srandom` arguments are numbers in the uint32 range, the reseed stays on numbers too. It is the same two updates as the seeding above: store the odd increment and step from state 0, then add the seed and step again. The first update does not build an output, and the output of the second step is discarded. A bigint, or a number above 2^32−1, still runs the bigint mix and then splits the words back into halves.

`boundedrand` compiles a small function for a bound and remembers the last two. A power-of-two bound masks with `bound - 1`. Any other bound writes the remainder as a literal in that function, which is the fast form of a remainder in this shell. A third distinct bound compiles again and drops the older one.

`random()`, `boundedrand()`, and the numeric `srandom()` are built with `new Function`. That string is compiled after mongosh has finished rewriting the file, so a tight loop pays for ordinary JavaScript. The [scripting guide](mongosh-scripting-guide.md#a-tight-loop-pays-for-each-function-call) shows what the wrapper costs on a smaller loop.

## How the rows were measured

The figures above are those five-sample averages. Each `pcg32` row and `crypto.webcrypto.getRandomValues()` ran in its own process, with `mongosh --nodb --quiet` on one file. `Math.random()` ran in Node v26.13.1. That Node is separate from the Node v24.22.2 embedded in mongosh 2.14.3.

`random()` on the reference implementation seeds with `pcg32.srandom(42, 54)` and then calls `pcg32.random()`. The Optimised `random()` and `boundedrand` rows call `pcg32.spawn(42, 54)` inside the timed function, then draw. Each draw is folded into a running uint32, `(s + draw) >>> 0`, so the result has to be produced. `boundedrand(10)` uses one compiled body. The alternating row uses both cached bodies, bounds 10 and 1000. The two `random()` histograms are the same series, so their ratios match.

The `srandom()` rows are one million reseeds, `srandom(i, 1)`, on one generator. The reference row calls `pcg32.srandom`. The Optimised row creates the generator with `pcg32.spawn(0, 1)` once, inside the function that runs the loop, before the timer starts, then calls `gen.srandom(i, 1)`. The value kept from the timed loop is the number of calls. That row is the cost of setting the stream. A generator created at the top of the file is a different cost, because mongosh turns that binding into a global and every call pays for the lookup. The histogram counts the first `random()` after each of those reseeds. The two copies produce the same counts. Across seeds `0` through `999999` with sequence `1`, that high byte is flatter than one long stream, which is the ratio 0.28.

`crypto.webcrypto.getRandomValues()` is measured as one million calls. Each call fills a `Uint32Array` of one word, created once inside the timed function, and the word is folded in with `(s + buf[0]) >>> 0`. The loop sits in a nested function, the same shape as the Optimised `random()` row. The histogram uses the high byte of that word. The figure is one sitting. A later run is a new series.

Node `Math.random()` is one million calls in a file run by Node v26.13.1. Each call returns a float in `[0, 1)`, and the sum is kept. The histogram bins `Math.floor(x * 256)`. This row is one sitting as well. A later run is a new series.
