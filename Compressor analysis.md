# Compressor analysis

Network OP_MSG compression only. Ratio is the original message length divided by the framed `OP_COMPRESSED` length. Higher is tighter. `none` sits at 1. A framed message that comes out longer than the original is still sent.

The grid is [`compressor-analysis.json`](compressor-analysis.json) (6,430 points, Rust, 17 November 2026, 91.2 seconds). The libraries are snap 1.1.2 (raw Snappy), flate2 1.1.11 with its default backend miniz_oxide (zlib wrapper), and zstd 0.14.4, built with rustc 1.99.1. Those are the calls the Rust driver makes. The mongodb crate was not linked. This is the compressor output plus the 25-byte frame. It is not a socket round trip. Driver and server behaviour is from the sources named under each quirk. WiredTiger block compression is a different problem and is left out.

## Setup

The compressed body is an OP_MSG body: 4 flag bytes, a kind byte of 0, and a BSON command document `{ping: 1, p: <payload>}`. `ping` is a compressible command. The original wire size is the 16-byte header plus that body. The framed size is the 16-byte header, the 9-byte `OP_COMPRESSED` details (original opcode, uncompressed size, compressor id), and the compressed body.

Length is the target document size: powers of two from 2^0 through 2^23, then the largest legal document, 16,777,216. That top point is `BSONObjMaxUserSize` for the whole document, so a value of 2^24 does not fit inside it. An array stops before the next element, plus both terminators, would pass the target, and the row records the real `doc` size. A target below a legal document is a raw buffer of that length (`shape: "raw"`). The first documents are int32 at 32 bytes (document 30), double at 64 (document 56), decimal128 at 64 (document 61), and string and binary at 32 (document 32).

Carriers are int32, double, decimal128, string, and binary. Null and bool are omitted. Each carrier is its own surface. An int32 array of zeros still contains the keys `"0"`, `"1"`, and so on. A string or binary of zeros does not.

Rungs 1–10 are generators. The entropy axis is the measured Shannon bits/byte of that document, stored on the row as `bits`. The rung number is not that measurement.

| Rung | Generator |
| --- | --- |
| 1 | Constant zero |
| 2 | Period 4 |
| 3 | Byte counter, 0 through 255 |
| 4 | Stride 17 across the byte values |
| 5 | Low nibble |
| 6 | A short repeated phrase, or a small integer pattern |
| 7 | Half pattern, half xorshift |
| 8 | xorshift in a reduced range |
| 9 | xorshift across the type |
| 10 | CSPRNG. Strings are mapped into 95 printable bytes. Decimal128 is 16 random bytes, not a validated Decimal128 |

Rung 10 is a fresh draw for each point, so two slices are two draws. The bits sit in a narrow band. Rungs 1–9 are seeded and repeat. int32 rung 10, zlib 6, is 1.6329 on the length curve and 1.6332 on the 1 MiB rung slice.

Wire compressor ids are noop 0, snappy 1, zlib 2, zstd 3. The `none` row is an uncompressed OP_MSG. It is not the protocol noop compressor. The protocol noop is not in the grid. Wrapping an unchanged body adds the 9-byte details, so that framed message is 9 bytes longer.

What was sampled:

| Slice | Sizes | Rungs | Levels |
| --- | --- | --- | --- |
| `length` | 2^0 through 2^23, plus 16,777,216 | 1, 5, 10 | zlib −1, 0, 1, 6, 9; zstd 1, 3, 9; snappy |
| `level64` | 65,536 | 1–10 | zlib −1 and 0–9; zstd −1 and 1–22; snappy |
| `rung1m` | 1,048,576 | 1–10 | zlib −1 and 0–9; zstd 1, 3, 9; snappy |
| `levelMax` | 16,777,216 | 1 and 10 | zlib −1 and 0–9; zstd −1, 1, 3, 6, 9, 19, 22; snappy. Binary and int32 only |

Snappy has no level. zstd levels 10–22 are on the 64 KiB sweep, and 19 and 22 are also on the max-document sample. They are not on the length curves. The full cross of every level, every rung, and every size was not run.

## Measured entropy at 64 KiB

Bits/byte from the `level64` draw. Rungs 3 and 4 on a byte payload fill all 256 values, so they measure 8.000. String rung 10 is 6.550 because it is printable. Binary rung 10 is 7.998. int32 rungs 9 and 10 sit at 6.146 and 6.137.

| Rung | int32 | double | decimal128 | string | binary |
| --- | --- | --- | --- | --- | --- |
| 1 | 2.646 | 2.084 | 1.457 | 0.003 | 0.003 |
| 2 | 3.077 | 2.638 | 1.716 | 2.002 | 2.002 |
| 3 | 4.493 | 3.862 | 2.429 | 8.000 | 8.000 |
| 4 | 3.785 | 3.440 | 2.060 | 8.000 | 8.000 |
| 5 | 3.372 | 2.979 | 1.868 | 4.002 | 4.002 |
| 6 | 3.555 | 2.850 | 2.004 | 2.968 | 2.968 |
| 7 | 4.094 | 4.127 | 3.392 | 6.369 | 6.369 |
| 8 | 5.280 | 6.492 | 2.945 | 5.171 | 5.171 |
| 9 | 6.146 | 5.488 | 5.095 | 6.571 | 6.571 |
| 10 | 6.137 | 6.913 | 7.476 | 6.550 | 7.998 |

Decimal128 stays lower than the other carriers until rung 10. The value lives in the low bytes and the high bytes stay zero on rungs 1–6.

## Length

Operating points are zlib 6, zstd 3, and snappy. On every paired cell in this grid, the flate2 default (level −1) matches zlib 6. zstd 3 is `zstd::DEFAULT_COMPRESSION_LEVEL`, which is what the Rust driver uses when the level is `None`, and it is the Node driver constant and the server reply. Snappy has no level.

“Still over at” is the largest sampled target whose framed message is longer than the original. On two curves the message goes under and then over again, so the column is the last over target, and the dips are below. Bits are the length-slice document at 64 KiB. Rung 10 is that draw.

| Carrier | Rung | Bits at 64 KiB | zlib 6 | zstd 3 | snappy |
| --- | --- | --- | --- | --- | --- |
| int32 | 1 | 2.646 | 32 | 64 | 64 |
| int32 | 5 | 3.372 | 64 | 64 | 64 |
| int32 | 10 | 6.141 | 256 | 256 | 65,536 |
| double | 1 | 2.084 | 16 | 64 | 16 |
| double | 5 | 2.979 | 64 | 64 | 64 |
| double | 10 | 6.919 | 512 | 512 | 65,536 |
| decimal128 | 1 | 1.457 | 16 | 16 | 16 |
| decimal128 | 5 | 1.868 | 32 | 32 | 16 |
| decimal128 | 10 | 7.476 | 1,024 | 1,024 | 65,536 |
| string | 1 | 0.003 | 32 | 32 | 32 |
| string | 5 | 4.002 | 32 | 32 | 32 |
| string | 10 | 6.548 | 256 | 256 | 16,777,216 |
| binary | 1 | 0.003 | 32 | 32 | 32 |
| binary | 5 | 4.002 | 32 | 32 | 32 |
| binary | 10 | 7.997 | 16,777,216 | 16,777,216 | 16,777,216 |

Ratios on the same length curve, at 1 MiB and at the max document. A ratio under 1 is six decimals so it does not round to 1.0000. The string rung 10 zlib cells are six decimals for the same reason: 1.206653 and 1.206659 both round to 1.2067.

| Carrier | Rung | zlib 6 at 1 MiB | zlib 6 at max | zstd 3 at 1 MiB | zstd 3 at max | snappy at 1 MiB | snappy at max |
| --- | --- | --- | --- | --- | --- | --- | --- |
| int32 | 1 | 4.8345 | 5.2085 | 17.7719 | 32.3538 | 2.4419 | 2.6696 |
| int32 | 5 | 4.4526 | 4.8207 | 14.3402 | 30.2315 | 2.0928 | 2.3444 |
| int32 | 10 | 1.6329 | 1.8220 | 1.8349 | 1.8385 | 1.1272 | 1.2027 |
| double | 1 | 6.2239 | 6.6922 | 25.1981 | 86.4311 | 3.0146 | 3.2307 |
| double | 5 | 5.8676 | 6.2604 | 18.9086 | 75.6518 | 3.3966 | 3.6323 |
| double | 10 | 1.3569 | 1.4522 | 1.4615 | 1.4746 | 1.0875 | 1.1282 |
| decimal128 | 1 | 8.6753 | 9.0757 | 40.9238 | 60.3339 | 4.5913 | 4.7988 |
| decimal128 | 5 | 8.4092 | 8.5267 | 31.1885 | 57.1260 | 4.0817 | 4.2628 |
| decimal128 | 10 | 1.1775 | 1.2317 | 1.2269 | 1.2508 | 1.0490 | 1.0796 |
| string | 1 | 966.4488 | 1025.5035 | 10082.6635 | 28728.1455 | 21.2952 | 21.3179 |
| string | 5 | 495.0883 | 513.9927 | 5924.2768 | 10375.5331 | 21.1919 | 21.2144 |
| string | 10 | 1.206653 | 1.206659 | 1.2104 | 1.2106 | 0.999945 | 0.999954 |
| binary | 1 | 966.4488 | 1025.4408 | 10082.6635 | 28728.1455 | 21.2952 | 21.3179 |
| binary | 5 | 495.3222 | 514.0085 | 5890.9944 | 10369.1205 | 21.1911 | 21.2144 |
| binary | 10 | 0.999824 | 0.999841 | 0.999957 | 0.999976 | 0.999945 | 0.999954 |

A zero string and a zero binary track each other. At 1 MiB, zlib 6 is 966.4488 on both and zstd 3 is 10082.6635 on both. At the max document zlib 6 is 1025.5035 on the string and 1025.4408 on the binary. A zero int32 array is a different shape: zlib 6 is 5.2085 there. The keys are the difference.

The size where the framed message crosses back under the original grows with entropy. Low rungs cross between 16 and 64 bytes. int32 rung 10 crosses at 256 for zlib 6 and zstd 3. Snappy on int32, double, and decimal128 rung 10 is still 14 bytes over at 64 KiB (ratio 0.999786) and under from 128 KiB. Decimal128 rung 10 crosses at 1,024 for zlib and zstd.

On decimal128 rung 1, zlib 6 at 1 MiB (8.6753) is slightly looser than at 64 KiB (8.6879), then tighter at the max document (9.0757).

Binary rung 10 stays over at every sampled length for zlib 6, zstd 3, and snappy, including the max document. zstd 3 is 19 bytes over at 64 KiB (ratio 0.999710), 45 bytes over at 1 MiB (0.999957), and 406 bytes over at the max document (0.999976). Four decimal places round that last ratio to 1.0000. The byte count is the one to keep. String rung 10 is printable, 6.548 bits/byte on this length draw. zlib 6 and zstd 3 are still over at 256 bytes and under from 512. Snappy stays over through the max document, 777 bytes over on the string (0.999954) and 778 bytes over on the binary.

zstd 1 against zstd 3 on rung 1 inverts with size. At 1 MiB, level 1 is tighter on the numeric arrays. At the max document, level 3 is tighter on int32, double, and decimal128. Level 9 is the loosest of the three on those carriers. On the zero string and the zero binary, levels 1 and 3 match at 28728.1455 and level 9 is a step tighter at 28777.4220.

| Carrier | zstd 1 at 1 MiB | zstd 3 at 1 MiB | zstd 1 at max | zstd 3 at max | zstd 9 at max |
| --- | --- | --- | --- | --- | --- |
| int32 | 37.8009 | 17.7719 | 24.8378 | 32.3538 | 21.0825 |
| double | 46.9653 | 25.1981 | 41.1268 | 86.4311 | 37.2339 |
| decimal128 | 60.3957 | 40.9238 | 56.2017 | 60.3339 | 47.0716 |
| string | 9986.6381 | 10082.6635 | 28728.1455 | 28728.1455 | 28777.4220 |
| binary | 9986.6381 | 10082.6635 | 28728.1455 | 28728.1455 | 28777.4220 |

On the double rung 1 curve, zstd 1, 3, and 9 are under the original at the 32-byte raw buffer (zstd 3 ratio 1.142857) and over again at the first document, 64 bytes, document length 56, ratio 0.974684. From 128 bytes on they stay under. The dip is the change from a raw buffer to a document. Snappy on double rung 5 does the same kind of dip: under at the 32-byte raw buffer (1.043478) and one byte over at the first document (0.987179), then under from 128.

## Rung at 1 MiB

zlib 6. The same rung is a different ratio on each carrier. Rung 3 is the byte counter, which is why string drops from 966.4488 to 235.6398 while int32 only moves from 4.8345 to 3.6558. String rungs 3 and 4 are the same ratio, and binary rungs 3 and 4 are the same ratio, because both generators use every byte value.

| Rung | int32 | double | decimal128 | string | binary |
| --- | --- | --- | --- | --- | --- |
| 1 | 4.8345 | 6.2239 | 8.6753 | 966.4488 | 966.4488 |
| 2 | 4.8153 | 6.2152 | 8.6613 | 960.2537 | 961.1338 |
| 3 | 3.6558 | 6.2043 | 6.8661 | 235.6398 | 235.7457 |
| 4 | 3.2887 | 5.1077 | 6.1380 | 235.6398 | 235.7457 |
| 5 | 4.4526 | 5.8676 | 8.4092 | 495.0883 | 495.3222 |
| 6 | 4.7531 | 6.1721 | 8.6119 | 398.4031 | 398.4031 |
| 7 | 2.8989 | 3.8048 | 3.4225 | 1.9892 | 1.9892 |
| 8 | 1.9460 | 2.4919 | 3.8855 | 1.4617 | 1.4617 |
| 9 | 1.6337 | 2.0516 | 2.0305 | 1.2005 | 1.2005 |
| 10 | 1.6332 | 1.3572 | 1.1775 | 1.2066 | 0.999824 |

zstd 3 at the same size. Level 1 is tighter than level 3 on this slice for int32 rungs 1, 2, 5, 6, and 8 (37.8009 against 17.7719 at rung 1), double rungs 1, 2, and 5, and decimal128 rungs 1, 2, 5, 6, and 8. Decimal128 rung 4 is close (14.6484 against 14.6386). The operating level is the looser one on those cells. zlib 6 beats zstd 3 on double rung 8 (2.4919 against 2.2528) and on decimal128 rungs 7, 8, and 9 (3.4225 against 3.2770, 3.8855 against 3.6416, 2.0305 against 1.9601).

| Rung | int32 | double | decimal128 | string | binary |
| --- | --- | --- | --- | --- | --- |
| 1 | 17.7719 | 25.1981 | 40.9238 | 10082.6635 | 10082.6635 |
| 2 | 17.8175 | 24.7112 | 40.5864 | 6393.8841 | 6355.1333 |
| 3 | 4.6336 | 8.5914 | 10.0399 | 2502.6181 | 2496.6595 |
| 4 | 8.2141 | 15.9978 | 14.6386 | 2502.6181 | 2496.6595 |
| 5 | 14.3402 | 18.9086 | 31.1885 | 5924.2768 | 5890.9944 |
| 6 | 17.3983 | 23.0876 | 37.5287 | 5698.8967 | 5668.0919 |
| 7 | 3.9270 | 4.5692 | 3.2770 | 1.9990 | 1.9990 |
| 8 | 1.9672 | 2.2528 | 3.6416 | 1.5318 | 1.5318 |
| 9 | 1.8333 | 2.2926 | 1.9601 | 1.2036 | 1.2036 |
| 10 | 1.8354 | 1.4622 | 1.2316 | 1.2104 | 0.999957 |

Snappy at the same size. It stays over the original on string rungs 8–10 and binary rungs 8–10. The numeric rung 10 rows are under.

| Rung | int32 | double | decimal128 | string | binary |
| --- | --- | --- | --- | --- | --- |
| 1 | 2.4419 | 3.0146 | 4.5913 | 21.2952 | 21.2952 |
| 2 | 2.4290 | 3.0007 | 4.5798 | 21.2745 | 21.2740 |
| 3 | 1.7773 | 2.5011 | 3.1825 | 19.6897 | 19.6897 |
| 4 | 1.5595 | 2.2090 | 3.1281 | 19.6897 | 19.6897 |
| 5 | 2.0928 | 3.3966 | 4.0817 | 21.1919 | 21.1911 |
| 6 | 2.1951 | 3.3897 | 4.4511 | 21.1530 | 21.1530 |
| 7 | 1.5914 | 2.3303 | 2.0577 | 1.9096 | 1.9096 |
| 8 | 1.2915 | 1.5240 | 2.4969 | 0.999945 | 0.999943 |
| 9 | 1.1272 | 1.4527 | 1.5358 | 0.999945 | 0.999945 |
| 10 | 1.1268 | 1.0836 | 1.0492 | 0.999945 | 0.999945 |

## Levels

On a 64 KiB int32 rung 1 document, the zstd ratio is not monotone in the level. Level −1 is 7.3631, level 1 is 16.3844, level 3 is 13.0508, level 13 is 7.6770, levels 19–21 are 36.6838, and level 22 is 36.6428. Level −1 matches level 3 on 13 of the 54 paired cells and differs on 41. The 13 matches are string and binary. Every numeric pair differs. Level −1 is inside `zstd::compression_level_range()`, measured here as −131072 through 22. It is a fast level. The default is 3.

At the max int32 rung 1 document the sampled zstd levels are −1 at 15.5767, 1 at 24.8378, 3 at 32.3538, 6 at 36.3012, 9 at 21.0825, 19 at 44.5510, and 22 at 44.3807. Level 9 is looser than level 1. Level 19 is the tightest of that set. Snappy on that document is 2.6696.

zlib on that same max document spreads more than one step. Level 1 is 5.5678, level 2 is 6.0278, level 3 is 6.2053, and level 6 is 5.2085. Level 3 is the tightest of the sampled zlib levels there. Level 9 is 5.2075, slightly looser than level 6. Level −1 matches level 6 on all 479 paired cells. Level 0, store, is 2,660 bytes over (ratio 0.999841).

Binary rung 10 at 64 KiB stays over the original at every zlib level and every zstd level from −1 through 22. The zstd ratio is 0.999710 at every one of those levels, which is 19 bytes over. zlib is 30 bytes over except at level 1, which is 73 bytes over.

## Quirks

Each one is named, then the cells or the source that show it.

### Framing expansion

mongosh 2.14.2, Node driver `OpCompressedRequest.toBin`, wraps a compressible command once a compressor is agreed. The Rust driver `write_op_compressed_to` writes `OP_COMPRESSED` after compressing. The framed length is what gets written. The probe called the same snap, flate2, and zstd entry points.

A 1-byte raw buffer, zlib 6: original wire 17 bytes, framed 34, ratio 0.500000. The same pattern holds through the “still over” column above.

Binary rung 10, zstd 3, is 19 bytes over at 64 KiB (ratio 0.999710), 45 bytes over at 1 MiB (0.999957), and 406 bytes over at the max document (0.999976). zlib 6 is 30, 185, and 2,660 bytes over at those three sizes. Snappy is 13, 58, and 778. Those messages are the measurement of the expansion. They are the bytes that would be sent.

### 48,000,000 allocation guard

`MaxMessageSizeBytes` is `48 * 1000 * 1000`. `MessageCompressorManager::compressMessage` returns the original message when the worst-case compressed buffer, plus the 9-byte details and the 16-byte header, would exceed that. The debug text is “Compressed message would be larger than maximum allowed”.

For zlib that bound first exceeds 48,000,000 at body length 47,985,319 (bound 48,000,001). Body 47,985,318 lands on 48,000,000 and is allowed. The grid records that trip point as `guardTripsAtBody`. No body in this grid trips the guard. A legal document is at most 16 MiB. The short-message expansion is the frame, not this guard.

### zstd raw block

On binary rung 10 the compressor keeps an incompressible block inside a frame and the frame is a few dozen to a few hundred bytes over the input. The ratio sits just under 1. At 64 KiB the zstd frame is the same 19 bytes over at every level from −1 through 22. At the max document the zstd frame adds 397 bytes and the 9-byte details make 406 on the wire. zlib 6 on the same document adds 2,660 bytes on the wire (ratio 0.999841). zlib level 1 adds 15,514 (ratio 0.999076). Snappy adds 778 (ratio 0.999954). The driver still wraps any of them.

String rung 10 is printable. zstd 3 at the max document is 1.2106. Snappy on that string stays over, by 777 bytes at the max document.

### zlib store and the default

flate2 level 0 is store. It is over the original at the max int32 rung 1 document by 2,660 bytes, ratio 0.999841. The same store overhead is what zlib 6 emits on incompressible binary: the max binary rung 10 document is also 2,660 bytes over at levels −1, 0, and 2 through 9.

Level −1 in this probe is `Compression::default()`. It matches level 6 on every paired cell. The Rust driver stores `None` for URI `zlibCompressionLevel` −1, and that `None` is this default. Levels 0–9 are real (`Compression::new(level)`). Values above 9, and negatives other than −1, are rejected.

The Node driver sets `zlibOptions.level` only when `zlibCompressionLevel` is truthy, and `compressCommand` passes `description.zlibCompressionLevel ?? 0`. An omitted level and an explicit 0 both take the default row on that driver. The level 0 row in the JSON is the store row, which is what Rust sends for 0.

Server replies use `Z_DEFAULT_COMPRESSION` in `message_compressor_zlib.cpp` and ignore the client’s `zlibCompressionLevel`. A sweep of the client level moves the request only.

### One zstd level on the reply

The Node driver constant is `ZSTD_COMPRESSION_LEVEL = 3`. The server reply uses `ZSTD_CLEVEL_DEFAULT` in `message_compressor_zstd.cpp`. There is no URI key for a zstd level.

Rust mongodb 3.10.1 adds `Compressor::Zstd { level: Option<i32> }`. `None` uses `zstd::DEFAULT_COMPRESSION_LEVEL` (3). `from_str("zstd")` sets `None`. There is no `write_zstd_level`. `validate()` requires the level to sit in `zstd::compression_level_range()`. The features `zstd-compression`, `zlib-compression`, and `snappy-compression` are off unless enabled. A Rust level moves the request. The reply stays at 3.

The measured effect of leaving 3 is in the level tables above. On the 64 KiB int32 rung 1 document, level 3 (13.0508) is looser than level 1 (16.3844) and much looser than level 19 (36.6838). Level −1 on that document is 7.3631. On the max double rung 1 document, level 3 (86.4311) is tighter than level 1 (41.1268). On the max int32 rung 1 document, level 3 (32.3538) is tighter than level 1 (24.8378) and tighter than level −1 (15.5767).

### The reply follows the request

`session_workflow.cpp` `compressResponse` returns the message unchanged when the request arrived uncompressed. A compressed request is answered with the same compressor id, at the server’s own level.

### Commands that are left uncompressed

The Node driver skips `hello`, the legacy hello names, `saslStart`, `saslContinue`, `getnonce`, `authenticate`, `createUser`, `updateUser`, `copydbSaslStart`, `copydbgetnonce`, and `copydb`. The grid uses `ping`.

### Snappy

Snappy has no level. The column is snap 1.1.2 raw, the same framing as the server’s `snappy::RawCompress` and the Rust driver’s `snap::raw::Encoder`. This mongosh has no `snappy` module, so the Node driver on this machine does not offer that compressor. The ratios above are the library the Rust driver links when the feature is on.

### Rust max message size

`write_op_compressed_to` returns an error when the framed length exceeds the max message size. Before hello that cap is `48 * 1024 * 1024`. After hello it is the size the server advertised, which is 48,000,000. The pre-hello cap and the server cap differ by 768 KiB. The expansion in this grid is far inside both caps.
