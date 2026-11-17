# Compressor analysis

Network OP_MSG compression only. Ratio is the original message length divided by the framed `OP_COMPRESSED` length. Higher is tighter. `none` sits at 1. A framed message that comes out longer than the original is still sent.

The grid is [`compressor-analysis.json`](compressor-analysis.json) (5,951 points, Node v26.13.1, 17 November 2026). This is the compressor output plus the 25-byte frame. It is not a socket round trip. Driver and server behaviour is from the sources named under each quirk. WiredTiger block compression is a different problem and is left out.

## Setup

The compressed body is an OP_MSG body: 4 flag bytes, a kind byte of 0, and a BSON command document `{ping: 1, p: <payload>}`. `ping` is a compressible command. The original wire size is the 16-byte header plus that body. The framed size is the 16-byte header, the 9-byte `OP_COMPRESSED` details (original opcode, uncompressed size, compressor id), and the compressed body.

Length is the target document size: powers of two from 2^0 through 2^23, then the largest legal document, 16,777,216. That top point is `BSONObjMaxUserSize` for the whole document, so a value of 2^24 does not fit inside it. An array stops before the next element would pass the target, and the row records the real `doc` size. A target below a legal document is a raw buffer of that length (`shape: "raw"`). The first documents are int32 at 32 bytes (document 30), double at 64 (document 56), decimal128 at 64 (document 61), and string and binary at 32 (document 32).

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

Rung 10 is a fresh draw for each point, so two slices are two draws. The bits sit in a narrow band. Rungs 1–9 are seeded and repeat.

Wire compressor ids are noop 0, snappy 1, zlib 2, zstd 3. The `none` row is an uncompressed OP_MSG. It is not the protocol noop compressor.

What was sampled:

| Slice | Sizes | Rungs | Levels |
| --- | --- | --- | --- |
| `length` | 2^0 through 2^23, plus 16,777,216 | 1, 5, 10 | zlib −1, 0, 1, 6, 9 and zstd 1, 3, 9 |
| `level64` | 65,536 | 1–10 | zlib −1 and 0–9, zstd −1 and 1–22 |
| `rung1m` | 1,048,576 | 1–10 | zlib −1 and 0–9, zstd 1, 3, 9 |
| `levelMax` | 16,777,216 | 1 and 10 | zlib −1 and 0–9, zstd −1, 1, 3, 6, 9, 19, 22 on binary and int32 |

Snappy is absent from this Node, so that surface is empty. zstd levels 10–22 are on the 64 KiB sweep, and 19 and 22 are also on the max-document sample. They are not on the length curves. The full cross of every level, every rung, and every size was not run. zstd 19–22 on a 16 MiB int32 array takes tens of seconds per document.

## Measured entropy at 64 KiB

Bits/byte from the `level64` draw. Rungs 3 and 4 on a byte payload fill all 256 values, so they measure 8.000. String rung 10 stays at 6.549 because it is printable. Binary rung 10 is 7.997. int32 rungs 9 and 10 meet at 6.146 and 6.143.

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
| 10 | 6.143 | 6.909 | 7.475 | 6.549 | 7.997 |

Decimal128 stays lower than the other carriers until rung 10. The value lives in the low bytes and the high bytes stay zero on rungs 1–6.

## Length

Operating points: zlib 6, which is also the zlib default, and zstd 3, which is the Node driver and the server reply. “Last target still over” is the largest sampled target whose framed message is longer than the original. Ratios are at 1 MiB and at the max document.

| Carrier | Rung | Bits at 64 KiB | zlib 6 still over at | zstd 3 still over at | zlib 6 at 1 MiB | zlib 6 at max | zstd 3 at 1 MiB | zstd 3 at max |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| int32 | 1 | 2.646 | 32 | 64 | 4.8830 | 5.2434 | 17.7719 | 32.3536 |
| int32 | 5 | 3.372 | 32 | 64 | 4.4887 | 4.8432 | 14.3402 | 30.6632 |
| int32 | 10 | 6.142 | 256 | 256 | 1.6405 | 1.8272 | 1.8366 | 1.8384 |
| double | 1 | 2.084 | 16 | 64 | 6.2705 | 6.7373 | 25.1981 | 86.3448 |
| double | 5 | 2.979 | 32 | 64 | 5.8936 | 6.2801 | 18.9086 | 75.6440 |
| double | 10 | 6.915 | 512 | 512 | 1.3589 | 1.4536 | 1.4611 | 1.4745 |
| decimal128 | 1 | 1.457 | 16 | 16 | 8.7308 | 9.0145 | 40.9238 | 60.3491 |
| decimal128 | 5 | 1.868 | 32 | 32 | 8.2213 | 8.3087 | 31.1885 | 57.1414 |
| decimal128 | 10 | 7.476 | 1,024 | 1,024 | 1.1781 | 1.2315 | 1.2136 | 1.2517 |
| string | 1 | 0.003 | 32 | 32 | 966.4488 | 1025.4408 | 10082.6635 | 28728.1455 |
| string | 5 | 4.002 | 32 | 32 | 495.3222 | 514.0085 | 5924.2768 | 10375.5331 |
| string | 10 | 6.549 | 256 | 256 | 1.2076 | 1.2076 | 1.2103 | 1.2106 |
| binary | 1 | 0.003 | 32 | 32 | 966.4488 | 1025.4408 | 10082.6635 | 28728.1455 |
| binary | 5 | 4.002 | 32 | 32 | 495.3222 | 514.0085 | 5890.9944 | 10369.1205 |
| binary | 10 | 7.997 | 16,777,216 | 16,777,216 | 0.999681 | 0.999694 | 0.999957 | 0.999976 |

A zero string and a zero binary are the same shape, and their ratios match. A zero int32 array does not. At the max document, zlib 6 is 5.24 on that array and 1025 on the zero binary. The keys are the difference.

The size where the framed message crosses back under the original grows with entropy. Low rungs cross between 16 and 64 bytes. int32 rung 10 crosses at 256, decimal128 rung 10 at 1,024. Binary rung 10 stays over at every sampled length, including the max document, by 406 bytes at zstd 3 (ratio 0.999976). Four decimal places round that ratio to 1.0000. The byte count is the one to keep.

zstd 1 against zstd 3 on rung 1 inverts by carrier. At 1 MiB, level 1 is tighter on the numeric arrays. At the max document, level 3 pulls ahead on double and decimal128, and level 1 is still ahead on int32. Level 9 is the loosest of the three on the numeric carriers. On the zero string and the zero binary, levels 1 and 3 match at 28728.1455 and level 9 is a step tighter at 28777.4220.

| Carrier | zstd 1 at 1 MiB | zstd 3 at 1 MiB | zstd 1 at max | zstd 3 at max | zstd 9 at max |
| --- | --- | --- | --- | --- | --- |
| int32 | 37.8009 | 17.7719 | 34.8866 | 32.3536 | 20.9814 |
| double | 46.9653 | 25.1981 | 41.1262 | 86.3448 | 36.7183 |
| decimal128 | 60.3957 | 40.9238 | 56.1967 | 60.3491 | 46.9346 |
| string | 9986.6381 | 10082.6635 | 28728.1455 | 28728.1455 | 28777.4220 |
| binary | 9986.6381 | 10082.6635 | 28728.1455 | 28728.1455 | 28777.4220 |

On the double rung 1 curve, zstd 1, 3, and 9 are under the original at the 32-byte raw buffer (zstd 3 ratio 1.142857) and over again at the first document, 64 bytes, document length 56, ratio 0.974684. From 128 bytes on they stay under. The dip is the change from a raw buffer to a document.

## Rung at 1 MiB

zlib 6. The same rung is a different ratio on each carrier. Rung 3 is the byte counter, which is why string and binary drop from about 966 to about 235 while int32 only moves from 4.88 to 3.65.

| Rung | int32 | double | decimal128 | string | binary |
| --- | --- | --- | --- | --- | --- |
| 1 | 4.8830 | 6.2705 | 8.7308 | 966.4488 | 966.4488 |
| 2 | 4.8632 | 6.2627 | 8.7079 | 961.1338 | 961.1338 |
| 3 | 3.6472 | 6.2393 | 6.8607 | 234.9008 | 234.8482 |
| 4 | 3.3099 | 4.4134 | 5.5247 | 234.9008 | 234.8482 |
| 5 | 4.4887 | 5.8936 | 8.2213 | 495.3222 | 495.3222 |
| 6 | 4.7992 | 6.2068 | 8.6596 | 398.5545 | 398.4031 |
| 7 | 2.8953 | 3.7886 | 3.4188 | 1.9907 | 1.9907 |
| 8 | 1.9449 | 2.4904 | 3.6992 | 1.4778 | 1.4778 |
| 9 | 1.6401 | 2.0504 | 2.0318 | 1.2019 | 1.2019 |
| 10 | 1.6398 | 1.3587 | 1.1782 | 1.2075 | 0.999681 |

zstd 3 at the same size. Level 1 beats level 3 on this slice for int32 rungs 1, 2, 5, and 6 (37.8009 against 17.7719 at rung 1), double rungs 1, 2, and 5, and decimal128 rungs 1, 2, 5, and 6. The operating level is the looser one on those cells.

| Rung | int32 | double | decimal128 | string | binary |
| --- | --- | --- | --- | --- | --- |
| 1 | 17.7719 | 25.1981 | 40.9238 | 10082.6635 | 10082.6635 |
| 2 | 17.8175 | 24.7112 | 40.5864 | 6393.8841 | 6355.1333 |
| 3 | 4.6336 | 8.5914 | 10.0399 | 2502.6181 | 2496.6595 |
| 4 | 8.2141 | 15.9978 | 14.6386 | 2502.6181 | 2496.6595 |
| 5 | 14.3402 | 18.9086 | 31.1885 | 5924.2768 | 5890.9944 |
| 6 | 17.3983 | 23.0876 | 37.5287 | 5698.8967 | 5668.0919 |
| 7 | 3.9270 | 4.5692 | 3.2770 | 1.9994 | 1.9994 |
| 8 | 1.9672 | 2.2528 | 3.6416 | 1.5318 | 1.5318 |
| 9 | 1.8333 | 2.2926 | 1.9601 | 1.2036 | 1.2036 |
| 10 | 1.8331 | 1.4614 | 1.2139 | 1.2103 | 0.999957 |

## Levels

On a 64 KiB int32 rung 1 document, the zstd ratio is not monotone in the level. Level 1 is 16.3844, level 3 is 13.0508, level 13 is 7.6770, and level 19 is 36.6838. Level −1 matches level 3 on all 54 paired cells.

At the max int32 rung 1 document the sampled levels are −1 and 3 at 32.3536, 1 at 34.8866, 6 at 34.8000, 9 at 20.9814, 19 at 44.5426, and 22 at 44.3807. Level 9 is looser than level 1. Level 19 is the tightest of that set.

zlib on that same max document is a small spread: level 1 is 5.0343, level 5 is 5.2500, level 6 is 5.2434, level 9 is 5.1794. Level 9 is slightly looser than level 6. Level −1 matches level 6 on all 479 paired cells.

Binary rung 10 at 64 KiB stays over the original at every zlib level and every zstd level from −1 through 22. The zstd ratio is 0.999710, which is 19 bytes over.

## Quirks

Each one is named, then the cells or the source that show it.

### Framing expansion

mongosh 2.14.2, Node driver `OpCompressedRequest.toBin`, wraps a compressible command once a compressor is agreed. The framed length is what gets written.

A 1-byte raw buffer, zlib 6: original wire 17 bytes, framed 34, ratio 0.500000. The same pattern holds through the “still over” column above. Binary rung 10, zstd 3, is 19 bytes over at 64 KiB (ratio 0.999710), 45 bytes over at 1 MiB (0.999957), and 406 bytes over at the max document (0.999976). Those messages are the measurement of the expansion. They are the bytes that would be sent.

### 48,000,000 allocation guard

`MaxMessageSizeBytes` is `48 * 1000 * 1000`. `MessageCompressorManager::compressMessage` returns the original message when the worst-case compressed buffer, plus the 9-byte details and the 16-byte header, would exceed that. The debug text is “Compressed message would be larger than maximum allowed”.

For zlib that bound first exceeds 48,000,000 at body length 47,985,319 (bound 48,000,001). Body 47,985,318 lands on 48,000,000 and is allowed. No body in this grid trips the guard. A legal document is at most 16 MiB. The short-message expansion is the frame, not this guard.

### zstd raw block

On binary rung 10 the compressor keeps an incompressible block inside a frame and the frame is a few dozen to a few hundred bytes over the input. The ratio sits just under 1. At the max document the zstd frame adds 397 bytes and the 9-byte details make 406 on the wire. zlib 6 on the same document adds 5,135 bytes on the wire (ratio 0.999694), because its stored-block framing is larger. The driver still wraps either one.

String rung 10 is printable, 6.549 bits/byte at 64 KiB, and zstd 3 at the max document is 1.2106. The same rung on binary, near 8 bits/byte, stays under 1.

### zlib store and the default

`deflateSync` level 0 is store. It is over the original at every sampled length. The max int32 rung 1 document is 2,575 bytes over, ratio 0.999847.

`deflateSync` level −1 matches level 6 on every paired cell. The Node driver sets `zlibOptions.level` only when `zlibCompressionLevel` is truthy, and `compressCommand` passes `description.zlibCompressionLevel ?? 0`. An omitted level and an explicit 0 both take this default row. The level 0 row in the JSON is the store row, which is what Rust’s `Compression::new(0)` produces. It is not what this Node driver sends for 0.

Server replies use `Z_DEFAULT_COMPRESSION` in `message_compressor_zlib.cpp` and ignore the client’s `zlibCompressionLevel`. A sweep of the client level moves the request only.

### One zstd level on Node and on the reply

The Node driver constant is `ZSTD_COMPRESSION_LEVEL = 3`. The server reply uses `ZSTD_CLEVEL_DEFAULT` in `message_compressor_zstd.cpp`. There is no URI key for a zstd level.

Rust mongodb 3.10.1 adds `Compressor::Zstd { level: Option<i32> }`. `None` uses `zstd::DEFAULT_COMPRESSION_LEVEL` (3). `from_str("zstd")` sets `None`. There is no `write_zstd_level`. `validate()` requires the level to sit in `zstd::compression_level_range()`. The features `zstd-compression`, `zlib-compression`, and `snappy-compression` are off unless enabled. A Rust level moves the request. The reply stays at 3.

The measured effect of leaving 3 is in the level tables above. On the 64 KiB int32 rung 1 document, level 3 (13.0508) is looser than level 1 (16.3844) and much looser than level 19 (36.6838). On the max double rung 1 document, level 3 (86.3448) is tighter than level 1 (41.1262).

### The reply follows the request

`session_workflow.cpp` `compressResponse` returns the message unchanged when the request arrived uncompressed. A compressed request is answered with the same compressor id, at the server’s own level.

### Commands that are left uncompressed

The Node driver skips `hello`, the legacy hello names, `saslStart`, `saslContinue`, `getnonce`, `authenticate`, `createUser`, `updateUser`, `copydbSaslStart`, `copydbgetnonce`, and `copydb`. The grid uses `ping`.

### Snappy

Snappy has no level. This Node has no `snappy` module (`snappy: false` in the grid). That column is empty.

### Rust sends an expanded body too

`write_op_compressed_to` writes `OP_COMPRESSED` after compressing. It returns an error when the framed length exceeds the max message size. Before hello that cap is `48 * 1024 * 1024`. After hello it is the size the server advertised, which is 48,000,000. The pre-hello cap and the server cap differ by 768 KiB.

Rust zlib levels are 0–9, and −1 in the URI (`zlibCompressionLevel`) means the flate2 default. Level 0 is the store row above. Values above 9, and negatives other than −1, are rejected.
