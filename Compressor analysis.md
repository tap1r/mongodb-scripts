# Compressor analysis

This knowledge base article covers network compression on an OP_MSG: the compressor a driver applies to a command before the bytes go on the wire. WiredTiger block compression is a different problem and is left out.

The ratio is the original message length divided by the framed `OP_COMPRESSED` length. Higher is tighter. A ratio of 2 means the framed message is half as long. A ratio of 1 is the same size. Below 1, compression made the message larger, and the drivers still send that larger message. The `none` row is an uncompressed OP_MSG. It is not the protocol noop compressor, which would add 9 bytes and was not measured.

[`src/compressor-charts.py`](src/compressor-charts.py) draws the pictures from [`compressor-analysis.json`](compressor-analysis.json). The probe is [`src/compressor-probe`](src/compressor-probe). The pictures are the quickest way through. The grids at the [end](#tables) are the lookup.

## What shows up

If the bytes repeat, turn zstd on. A 16 MiB string of zeros finishes at 28,728× with zstd, 1,026× with zlib, and 21× with snappy. A 16 MiB array of zero doubles still reaches 86.4×. An array of zero int32s stops well short of that, because the keys `"0"`, `"1"`, and so on are still in the document: zstd gets to 32.4×, zlib to 5.2×, and snappy to 2.7×.

A zero long is the same eight zero bytes as a zero double. Only the type byte changes, 0x12 instead of 0x01. zstd finishes that array at 74.2×, and a zero date, type byte 0x09, matches it. zlib stays at 6.7× and snappy at 3.2× on all three. A timestamp of zeros does not follow the date. zstd finishes it at 86.3×, with the double. Once the array is several megabytes, zstd is the compressor that notices the type byte. At 64 KiB the four still agree, all 17.7×. The other timestamp rows are in [long and date](#long-and-date).

Random bytes do not shrink. A 16 MiB cryptographic binary is longer after framing for every compressor and every level in this grid. At the levels on the length charts, zstd adds 406 bytes, snappy 778, and zlib 2,660. A random printable string measures about 6.55 bits per byte and looks like text. zlib and zstd get it down to about 1.21×. Snappy is still 777 bytes longer at 16 MiB.

The saving does not start at the first byte. Below a few dozen bytes the 25-byte frame costs more than the compressor gives back, and the ratio drops below 1. The Node driver and the Rust driver have no small-message cutoff, so that larger frame is what goes out.

zstd level 3 is the level these drivers send when zstd is left unset, and the level the server uses on a reply. It is a strong default, and a higher number is sometimes a looser message. On a 64 KiB array of zero int32s, level 1 is tighter than level 3. On the 16 MiB version, level 3 is tighter, and level 9 is a step backwards. The [level charts](#compressor-levels) have the whole curve. A client level changes the request only. The zstd reply stays at 3.

## How to read the charts

Blue is zlib at level 6 on the length charts, and every zlib level from −1 to 9 on the level charts. Level −1 matches level 6 on every paired cell, and −1 is the library default. Orange is zstd at level 3, the level these drivers send when zstd is left unset. Purple is every other zstd level, and it appears only on the level charts. Green is snappy, which has no level. The dashed line is a ratio of 1. Above it, the framed message is smaller. Below it, the frame made the message larger.

The next two figures are the manifold and the levels. The [per-carrier charts](#per-carrier) are patterns 1, 5, and 10, one BSON type at a time.

## The manifold

Each sheet is one compressor across every pattern and every sampled size. The vertical axis is the pattern, which generator filled the bytes. It is not bits per byte.

![Wire ratio over document size and pattern. One panel per carrier. Blue, orange, and green sheets are zlib 6, zstd 3, and snappy. The length charts are the slices at patterns 1, 5, and 10.](compressor-analysis/manifold.png)

The patterns in between are not a straight slope. On the string, zstd at 1 MiB is 10,083× at pattern 1, 2,503× at patterns 3 and 4, 5,924× at pattern 5, and 1.999× at pattern 7. Patterns 3 and 4 both use every byte value, so they share a ratio, and pattern 7 is where half the bytes become noise. The cliff at pattern 7 is there at 64 KiB and at 16 MiB. The valley at patterns 3 and 4 is deep at 64 KiB and at 1 MiB, and shallow by 16 MiB. The length charts skip both.

A higher bits-per-byte figure is not always the harder payload. String pattern 5 is 4.00 bits/byte and zstd's ratio at 1 MiB is 5,924×. int32 pattern 5 is 3.37 bits/byte and the ratio is 14.3×. The string is a repeated phrase. The int32 array is keys plus integers.

On a number, pattern 3 is the element index, so a long document is a long counter. On the 16 MiB double, zstd is 85.9× at pattern 2, 7.4× at pattern 3, and 75.7× at pattern 5. The middle panel of the double chart sits next to the top panel and never shows that hole.

At 1 MiB, zlib level 6 beats zstd level 3 on a handful of mid-range rows: double pattern 8 (2.4919× against 2.2528×), long pattern 8 (2.6210× against 2.4344×), date pattern 8 (2.6211× against 2.4406×), and decimal128 patterns 7, 8, and 9 (3.4225× against 3.2770×, 3.8855× against 3.6416×, 2.0305× against 1.9601×). Everywhere else in that slice, zstd 3 is tighter. From pattern 8 up, snappy is below the line on both string and binary. The [1 MiB grids](#tables) hold the rest.

## Compressor levels

Both charts are one array of zero int32s. The left is 64 KiB and the right is 16 MiB, each at every zstd level from −1 to 22 and every zlib level from −1 to 9. Orange is level 3, the level these drivers send when zstd is left unset. Purple is every other zstd level, and those are a Rust-only request: the connection string has no zstd level. Blue is zlib. Snappy is the dashed line. It has no level.

![Wire ratio by level for one zero int32 array. Orange is zstd 3, sent when left unset. Purple is every other zstd level. Blue is zlib from −1 to 9. Left, 64 KiB, labelled 13.1× at zstd 3. Right, 16 MiB, labelled 32.4× at zstd 3 and 44.8× at level 17. Snappy is the green dashed line.](compressor-analysis/levels.png)

A level in the high teens is much slower on a 16 MiB document than at 64 KiB. This one array has the missing zstd levels filled in. The other 16 MiB rows are still the sample: zstd −1, 1, 3, 6, 9, 19, and 22.

On the 64 KiB array, level 3 sits in a sag at 13.1×. Level 1, to the left of it, is 16.4×. The curve then bumps along, drops to 7.7× at level 13, jumps, and peaks at levels 19–21 at 36.7×. Level 22 is a hair looser, 36.6×. Level −1 is inside the legal range, measured here as −131072 through 22, and it is a fast level of its own, 7.4× on this document. It matched level 3 on 13 of the 74 paired cells in the grid, all of them string or binary, and it differed on the other 61. Every numeric pair differed.

On the 16 MiB array the sag has moved. Level 3 is 32.4×. It beats level 1 at 24.8× and level 2 at 20.5×. Level 4 is 33.0×, and levels 6 and 7 are 36.3× and 36.5×. Levels 8 through 15 sit around 21×, with level 12 the low point at 21.0×. Level 17 is the tightest at 44.8×. Level 19 is 44.6×, levels 20 and 21 are 43.7×, and level 22 is 44.4×. Level −1 is 15.6×. Snappy is 2.2× on the 64 KiB array and 2.7× on this one. Even the worst zstd level in either chart beats snappy on zero int32s. On the cryptographic binary, every zstd level loses.

At 1 MiB, level 1 is tighter than level 3 on several numeric patterns, including the zero int32 array at 37.8009× against 17.7719×. At the max document that relationship flips for the numeric carriers. Level 3 is tighter than level 1: 32.3538× against 24.8378× for int32, 86.4311× against 41.1268× for double, 74.1804× against 41.1352× for long, 74.1689× against 41.1340× for date, and 60.3339× against 56.2017× for decimal128. Level 9 is the loosest of those three on the numbers. On the zero string and the zero binary, levels 1 and 3 meet at 28,728.1455× and level 9 is one step tighter, 28,777.4220×. The [1 MiB grid](#zstd-3-at-1-mib) lists which patterns.

zlib is the blue line. The spec calls level 9 the best compression. On this 16 MiB array, level 3 is the tightest zlib level at 6.21×, and level 6, the default match, is 5.21×. Level 9 is 5.2075×, slightly looser than level 6. At 64 KiB the same shape sits lower: level 3 is 4.86× and level 6 is 4.21×. Level 0 is store, the point on the floor of both charts, 2,660 bytes longer on the 16 MiB document, ratio 0.999841. Level −1 matches level 6 on all 669 paired cells. The other zlib levels are a URI option, from −1 to 9. What Node does with level 0 is in [What the drivers send](#what-the-drivers-send).

Which levels a caller can actually set depends on the driver.

| Compressor | Connection string | Rust code | Node, PyMongo, Java |
| --- | --- | --- | --- |
| snappy | No level | No level | No level |
| zlib | −1 to 9 | 0 to 9, or unset for the flate2 default | Node publishes 0 to 9, and 0 selects the default. PyMongo and Java take −1 to 9 |
| zstd | None | Any level in the library range, or unset for 3 | 3 only |

Rust mongodb 3.10.1 exposes `Compressor::Zstd { level }`: any value `zstd::compression_level_range()` returns, or unset for level 3. `validate()` rejects a level outside that range. The three compression features are off unless the crate is built with them. PyMongo calls `zstd.compress` with no level. The Java driver calls `Zstd.defaultCompressionLevel()`. Node hardcodes `ZSTD_COMPRESSION_LEVEL = 3`.

The reply does not follow the client level. The server has no compression level to set. `net.compression.compressors` only names which compressors it will offer. `session_workflow.cpp` keeps the compressor id from a compressed request and compresses the reply with that compressor's compiled-in default: `Z_DEFAULT_COMPRESSION` for zlib, and `ZSTD_CLEVEL_DEFAULT` for zstd, which is 3. A client that sends zstd at level 19 still reads a level-3 reply. Snappy has no level. An uncompressed request is answered uncompressed.

## Per carrier

The manifold already showed the shape. What follows is the boring detail: one BSON type at a time, patterns 1, 5, and 10, kept for the notches, the crossings, and the finishes. The full crossing list is the [table](#where-the-framed-message-stops-being-larger) at the end.

The combined figure puts all seven carriers on two shared scales. After that, each chart has three panels. The top is repetitive (pattern 1), the middle is mixed (pattern 5), and the bottom is nearly random (pattern 10). Document size runs along the bottom, from 1 byte to the largest legal BSON document, 16 MiB. The wire ratio runs up the side. Each panel has its own vertical scale, so a 20× curve and a 20,000× curve can both be read.

The pale vertical line is the first target that holds a real BSON document. To the left of that line the buffer is raw bytes. The labels on the right of a top panel are the 16 MiB finish. The bits/byte in a panel title are measured on that panel's 64 KiB document. The pattern number names which generator filled the bytes. Bits per byte are the entropy of that buffer. A single bits/byte figure does not place a payload on one of these curves.

## All seven carriers

One scale for the whole row, so the carriers can be compared. The bottom row is labelled where that scale hides the result: snappy below the line on the printable string, and every drawn line below it on the cryptographic binary.

![All seven carriers together. The top row is repetitive data and the bottom row is nearly random data, each row on one shared scale. The string and binary panels on the bottom row are labelled where they stay below the line.](compressor-analysis/combined.png)

The zero string and the zero binary leave the top row. zstd separates the numbers: the zero double highest, then the long and the date together, then decimal128, then the int32 array, held down by its keys. zlib and snappy do not make that split. On the zero double, the zero long, and the zero date they finish together, at 6.7× and 3.2×. On a pure run snappy has a ceiling near 21×, and zstd does not.

On the bottom row the numeric arrays still finish above the line: int32 highest, then the double, the long, and the date close together, then decimal128. The printable string just clears the line for zlib and zstd. Snappy stays just below it. The cryptographic binary never clears it. A ratio of 0.999976 and a ratio of 1 are the same pixel on that shared scale, which is why the byte counts are the number to keep. The [16 MiB table](#ratio-at-16-mib) has them.

## string and binary

![string wire ratio against document size. The top panel is labelled 28,728×, 1,026×, and 21.3×. The bottom panel marks snappy still below the line, 777 bytes longer at 16 MiB.](compressor-analysis/string.png)

![binary wire ratio against document size. The top panel is labelled 28,728×. The bottom panel notes that the three drawn lines stay below the line, and gives the 16 MiB byte counts.](compressor-analysis/binary.png)

A run of zero bytes is the same payload either way, 0.003 bits/byte, which is why the two top panels match. zstd keeps finding a smaller encoding as the run gets longer: 1,009× at 64 KiB, 10,083× at 1 MiB, 28,728× at 16 MiB. zlib climbs and then flattens: 504×, 966×, 1,026×. Snappy is already 20.9× at 64 KiB and only inches up to 21.3×. At 1 MiB, zlib is 966.4488× on both and zstd is 10,082.6635× on both. At the max document zlib is 1,025.5035× on the string and 1,025.4408× on the binary. The keys in an int32 array break that match. The same zlib level there is 5.2×.

The middle panels are a repeated phrase, 4.002 bits/byte, and they stay together. zstd finishes the string at 10,376× and the binary at 10,369×. Snappy is still about 21×.

The bottom panels are why these stay two charts. A string maps random bytes into 95 printable characters, so it measures 6.548 bits/byte on this draw and looks like text. zlib and zstd are still below the line at 256 bytes and above it from 512, and they are essentially done by 1 MiB, at about 1.21×. From 1 MiB to 16 MiB, zlib moves from 1.206653× to 1.206659×. Snappy stays below the line, 777 bytes longer at 16 MiB. Binary pattern 10 is raw CSPRNG, 7.997 bits/byte, with no alphabet to hide in. Every compressor stays below the dashed line at every sampled size. Raising the level does not fix it. At 64 KiB, every zstd level from −1 through 22 is the same 19 bytes longer (ratio 0.999710). At 16 MiB, snappy is 778 bytes longer. zstd is 406 bytes longer at every sampled level except level 22, which is one byte less. zlib is 2,660 bytes longer at every sampled level except level 1, which is 15,514 bytes longer, ratio 0.999076. There is no level in this grid at which a cryptographic binary should be wrapped.

## double

![double wire ratio against document size. The top panel is labelled 86.4×, 6.7×, and 3.2×, and marks the notch back below the line. The middle panel marks a one-byte-longer notch.](compressor-analysis/double.png)

Zero doubles finish at 86.4× with zstd, 6.7× with zlib, and 3.2× with snappy. The notch on the way there is the part worth a second look.

The pale line in the top panel is the first real document, 56 bytes inside a 64-byte target. zstd is already above the line on the 32-byte raw buffer (ratio 1.142857) and drops back below it on that first document (0.974684). From 128 bytes on it stays above. The dip is the change from a raw buffer to a document, not a change in the compressor. Snappy does a smaller version of the same notch on the middle panel: above the line on the 32-byte raw buffer (1.043478), one byte longer on the first document (0.987179), then above the line from 128 bytes.

On nearly random doubles, zlib and zstd are still below the line at 512 bytes and above it from 1 KiB, finishing near 1.45× and 1.47×. Snappy is still below the line at 64 KiB and above it from 128 KiB. It is 1.087× at 1 MiB and 1.128× on the max document. The [crossing table](#where-the-framed-message-stops-being-larger) is the same lookup for the other carriers. On a double, snappy's last target below the line on the repetitive panel is 16 bytes. zstd's is 64, because of that notch.

## long and date

![long wire ratio against document size. The top panel is labelled 74.2×, 6.7×, and 3.2×, and marks the notch back below the line. It notes that the zero double finishes at 86.4×.](compressor-analysis/long.png)

![date wire ratio against document size. The top panel is labelled 74.2×, 6.7×, and 3.2×, and notes that the chart tracks the long chart.](compressor-analysis/date.png)

A date uses the same int64 ladder as the long. On a zero array the finishes match, and so does the notch, at the same ratios as the double. The corner note on the long chart is the zero double, 86.4×, which this array does not reach.

The gap between a zero double and a zero long is invisible at 64 KiB, both 17.7×. At 1 MiB they are 25.2× and 24.9×. It opens at 4 MiB, 48.6× against 38.7×, and finishes at 86.4× against 74.2×.

The mixed pattern is where zstd separates the date from the long. At 64 KiB, zstd is 10.9× on the date and 10.4× on the long. At 16 MiB the finishes are 77.6× and 77.3×. zlib and snappy stay within a few thousandths, 6.2612× against 6.2587× and 2.8829× against 2.8828×. Nearly random bytes match as well. zstd finishes the date at 1.4741× against the long's 1.4746×. The long's middle panel finishes at 77.3× for zstd, a little above the double's 75.7×, with zlib at 6.3× and snappy at 2.9×.

A timestamp is not a chart. It is in the `compare` slice: long, date, and timestamp, at 64 KiB and 16 MiB, patterns 1, 5, 9, and 10. It is two uint32 fields, increment then seconds. On a zero array those fields are zero, so the value bytes match a zero date and the type byte is 0x11. zlib and snappy track the date. zstd does not, once the array is large: at 16 MiB it finishes at 86.3×, with the zero double.

Patterns 1 through 9 write the same integer into both timestamp fields, so the payload is denser than a date of the same pattern. At pattern 9 on the 16 MiB document the timestamp measures 6.646 bits/byte and the long 4.969. zstd is 1.48× on the timestamp and 2.22× on the long. zlib is 2.21× against 2.38×, and snappy is 1.43× against 1.55×. On the mixed pattern the timestamp is already a little denser at 16 MiB, 3.361 bits/byte against 2.987. Snappy finishes at 2.69× against 2.88×, and zstd at 78.3× against the long's 77.3×. Pattern 10 is eight random bytes in both layouts. The three carriers match within 0.001 at 64 KiB and at 16 MiB. Snappy is still below the line at 64 KiB, 14 bytes longer, ratio 0.999786, on all three.

## int32

![int32 wire ratio against document size. The top panel is labelled 32.4×, 5.2×, and 2.7× at 16 MiB. The bottom panel marks the crossings.](compressor-analysis/int32.png)

An int32 array never becomes a run of zeros. Even pattern 1 carries the keys, so the top panel tops out in the tens rather than the thousands. zstd pulls away from zlib once the document is past a few hundred bytes and finishes at 32.4×, against 5.2× for zlib and 2.7× for snappy. The middle panel is the same shape with a lower ceiling: 30.2× for zstd at 16 MiB.

The bottom panel is a fresh cryptographic draw in each integer, and it still shrinks. The keys and the 4-byte layout keep the 64 KiB document near 6.14 bits/byte rather than 8, and zstd finishes at 1.84×. Snappy is the late one. It is still below the line at 64 KiB (14 bytes longer, ratio 0.999786) and above it from 128 KiB. zlib and zstd are still below the line at 256 bytes and above it from 512.

The orange line gains, flattens, and gains again as the array grows. The [level charts](#compressor-levels) are the same habit in the other direction: a higher level is not always a tighter message.

## decimal128

![decimal128 wire ratio against document size. The top panel is labelled 60.3×, 9.1×, and 4.8×, and marks snappy at 1.55×. The bottom panel notes 1.06× and 1.12× at 64 KiB.](compressor-analysis/decimal128.png)

Until the bytes are actually random, this is the most compressible number in the set. The value lives in the low bytes and the high bytes stay zero. The 64 KiB document measures 1.457 bits/byte. On pattern 1, zstd finishes at 60.3×, zlib at 9.1×, and snappy at 4.8×. All three are still below the line at 16 bytes and above it from 32. At 32 bytes snappy is the tightest of the three, 1.55×, and from 128 bytes it falls behind.

Pattern 10 fills all 16 bytes from the CSPRNG. Those bytes are not a validated Decimal128. The 64 KiB document is the noisiest number in the grid, 7.476 bits/byte. At that size zstd is 1.06× and zlib is 1.12×. Snappy stays below the line through 64 KiB and goes above it from 128 KiB. At 16 MiB the ratios are 1.25× for zstd, 1.23× for zlib, and 1.08× for snappy.

The zlib curve on pattern 1 wiggles. It is 8.6879× at 64 KiB, 8.6753× at 1 MiB, and 9.0757× at the max document. The 1 MiB point is a hair looser than the 64 KiB point.

## What the drivers send

A compressed body that is larger than the original is still written. mongosh 2.14.2, in `OpCompressedRequest.toBin`, wraps a compressible command once a compressor has been agreed. The Rust driver does the same in `write_op_compressed_to`. The probe called the same snap, flate2, and zstd entry points, so the ratios above are the bytes those calls produce. A 1-byte raw buffer at zlib 6 is the small end of that: the original wire message is 17 bytes, the framed message is 34, and the ratio is 0.5.

On an incompressible input the compressor keeps the bytes and adds its own frame. Of the 406 bytes zstd adds at level 3 on a 16 MiB cryptographic binary, 397 are the compressor frame and 9 are the `OP_COMPRESSED` details. zlib's stored-block framing is the 2,660 bytes. Snappy's is the 778. The per-level exceptions are in [string and binary](#string-and-binary).

The log line "Compressed message would be larger than maximum allowed" is an allocation guard. `MaxMessageSizeBytes` is `48 * 1000 * 1000`. `MessageCompressorManager::compressMessage` returns the original message when the worst-case compressed buffer, plus the 9-byte details and the 16-byte header, would exceed that. For zlib the bound first exceeds 48,000,000 at body length 47,985,319. The grid records that length as `guardTripsAtBody`. No body in this grid trips it. A legal document is at most 16 MiB, so the expansion you see on a short message is the frame.

`write_op_compressed_to` returns an error when the framed length exceeds the max message size. Before hello that cap is `48 * 1024 * 1024`, which is 50,331,648 bytes. After hello it is the size the server advertised, 48,000,000. The two caps differ by 2,331,648 bytes. The expansion in this grid is far inside both.

Level 0 is the easy knob to misread. flate2 level 0 is store, and that is what Rust sends for 0. The level 0 row in the JSON is that store row. The Node driver sets a zlib level only when `zlibCompressionLevel` is truthy, and `compressCommand` passes `description.zlibCompressionLevel ?? 0`, so an omitted level and an explicit 0 both take the Node default. The JSON row is not the row this Node driver sends for 0. The Rust URI accepts `zlibCompressionLevel` −1 as the flate2 default, which matched level 6 here, and rejects values above 9 and negatives other than −1.

The Node driver leaves `hello`, the legacy hello names, `saslStart`, `saslContinue`, `getnonce`, `authenticate`, `createUser`, `updateUser`, `copydbSaslStart`, `copydbgetnonce`, and `copydb` uncompressed. The grid uses `ping`. An uncompressed request gets an uncompressed reply.

Snappy has no level. This mongosh has no `snappy` module, so the Node driver on this machine does not offer it. The green lines are the library the Rust driver links when the feature is on.

## Conclusion

Turn zstd on for ordinary documents, logs, and low-cardinality fields. That is where the wire saving is large. zlib and snappy still help, and they leave most of that saving behind. Ordinary documents include the keys. An array of integers compresses like an array of keys, not like a string of the values. A zero long and a zero date finish at 74.2×, the zero double at 86.4×. A timestamp of zeros finishes with the double.

Leave compression off when the payload is ciphertext, a compressed blob, or any other near-random binary. Every level in this grid still adds a frame, and within a legal document the ratio stays below 1. Printable random text is the awkward middle. zlib and zstd reach about 1.21×, and snappy costs bytes at every size.

Keep snappy in the negotiated list when the peer supports it and the payload is repetitive. It starts helping at slightly smaller sizes than zstd on some of the numeric rows, because its wrapper is slimmer, and it stops helping sooner as the bytes get noisier. It has no level to get wrong. On a run of zeros it flattens near 21× while zstd keeps going. It will not do that for a cryptographic binary. This mongosh build does not include the module. The Rust driver can, behind a feature that is off by default. The server's default list is `snappy,zstd,zlib`, and negotiation walks the client's list.

Leave zstd at level 3, the orange point, unless a measured payload says otherwise. That is the level these drivers send when zstd is left unset. Node, PyMongo, and the Java driver have no zstd level to change. Rust can change it in code. The connection string still cannot. The zstd reply stays at 3.

Below a few dozen bytes the frame dominates, and the driver sends the framed message anyway. The 48,000,000 guard is a worst-case allocation check, and a legal document never reaches it.

## Notes

The body is an OP_MSG body: 4 flag bytes, a kind byte of 0, and a BSON command `{ping: 1, p: <payload>}`. The original wire size is the 16-byte header plus that body. The framed size adds 9 bytes of `OP_COMPRESSED` details. The ratio above is that compressor output plus the 25-byte frame. It is not a socket round trip.

A target below a legal document is a raw buffer. An array stops before the next element, plus both terminators, would pass the target, and the row records the real document size. The first documents are int32 at 32 bytes (document 30), double, long, and date at 64 (document 56), decimal128 at 64 (document 61), and string and binary at 32 (document 32). A value of 2^24 does not fit: 16,777,216 is already the whole document.

Carriers are int32, double, long, date, decimal128, string, and binary. Null and bool are omitted. Each carrier is its own surface.

| Pattern | Generator |
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

On a string or a binary that table is the byte generator. On a number, pattern 3 is the element index and pattern 4 is that index masked to a byte. A long and a date keep the high four bytes at zero through pattern 9. Pattern 10 fills all eight bytes from the CSPRNG. A timestamp is two uint32 fields, and on patterns 1–9 the same integer is written into both.

Patterns 1–9 are seeded, so the same pattern at the same size comes back as the same buffer. Pattern 10 is a fresh draw for every point, including every run of the probe. Two slices are two draws, which is why int32 pattern 10 at zlib 6 is 1.6329× on the length curve and 1.6332× on the `oneMiB` slice. The bits stay in a narrow band.

The probe calls the same snap, flate2, and zstd entry points the Rust driver uses. Library versions, and the driver version the level options were read from, are in the probe header. The mongodb crate is not linked. flate2 here is miniz_oxide, so the zlib bytes need not match Node or the server's libz. With no arguments the probe writes `/tmp/compressor-grid.json` and `/tmp/compressor-digest.txt`. Two arguments are those two paths. It leaves the published grid where it is.

The [compression spec](https://github.com/mongodb/specifications/blob/master/source/compression/OP_COMPRESSED.md) defines one level, `zlibCompressionLevel`, from −1 to 9. It calls −1 the library default, 0 no compression, 1 the fastest, and 9 the best compression. Snappy has no level. zstd was added later, and the spec still has no zstd level.

Wire compressor ids are noop 0, snappy 1, zlib 2, and zstd 3. zstd levels 10–22 are on the 64 KiB sweep and on the 16 MiB zero int32 array. They are not on the length curves or the manifold. The slice table is the inventory of what each picture used. The full cross of every level, every pattern, and every size was not run.

| Slice | What it is |
| --- | --- |
| `length` | Powers of two from 2^0 through 2^23, plus 16,777,216. Seven carriers. Patterns 1, 5, 10. |
| `level64` | 65,536 bytes. Seven carriers. Patterns 1–10. zlib −1 and 0–9, zstd −1 and 1–22, snappy. |
| `oneMiB` | 1,048,576 bytes. Seven carriers. Patterns 1–10. zlib −1 and 0–9, zstd 1, 3, 9, snappy. |
| `levelMax` | 16,777,216 bytes. int32 and binary. Patterns 1 and 10. zlib −1 and 0–9. zstd −1, 1, 3, 6, 9, 19, and 22, plus every zstd level from −1 through 22 on the zero int32 array. |
| `surface` | The same sizes as `length`. Seven carriers. Patterns 2, 3, 4, 6, 7, 8, and 9. zlib 6, zstd 3, and snappy. |
| `compare` | 65,536 and 16,777,216. long, date, and timestamp. Patterns 1, 5, 9, and 10. zlib 6, zstd 3, and snappy. |

## Tables

### Where the framed message stops being larger

The largest sampled target still below the line, the last size at which the framed message is longer than the original. On the double charts the line is crossed twice, so the number here is the later one. The dips are the notches at the first document. Bits are the length-slice document at 64 KiB.

| Carrier | Pattern | Bits at 64 KiB | zlib 6 | zstd 3 | snappy |
| --- | --- | --- | --- | --- | --- |
| int32 | 1 | 2.646 | 32 | 64 | 64 |
| int32 | 5 | 3.372 | 64 | 64 | 64 |
| int32 | 10 | 6.141 | 256 | 256 | 65,536 |
| double | 1 | 2.084 | 16 | 64 | 16 |
| double | 5 | 2.979 | 64 | 64 | 64 |
| double | 10 | 6.919 | 512 | 512 | 65,536 |
| long | 1 | 2.084 | 16 | 64 | 16 |
| long | 5 | 2.664 | 64 | 64 | 64 |
| long | 10 | 6.915 | 512 | 512 | 65,536 |
| date | 1 | 2.084 | 16 | 64 | 16 |
| date | 5 | 2.640 | 64 | 64 | 64 |
| date | 10 | 6.916 | 512 | 512 | 65,536 |
| decimal128 | 1 | 1.457 | 16 | 16 | 16 |
| decimal128 | 5 | 1.868 | 32 | 32 | 16 |
| decimal128 | 10 | 7.476 | 1,024 | 1,024 | 65,536 |
| string | 1 | 0.003 | 32 | 32 | 32 |
| string | 5 | 4.002 | 32 | 32 | 32 |
| string | 10 | 6.548 | 256 | 256 | 16,777,216 |
| binary | 1 | 0.003 | 32 | 32 | 32 |
| binary | 5 | 4.002 | 32 | 32 | 32 |
| binary | 10 | 7.997 | 16,777,216 | 16,777,216 | 16,777,216 |

### Ratio at 16 MiB

The same length curve, at the max document. A ratio below 1 is six decimals so it does not round to 1.0000. The zlib cells for a string at pattern 10 are six decimals for the same reason.

| Carrier | Pattern | zlib 6 | zstd 3 | snappy |
| --- | --- | --- | --- | --- |
| int32 | 1 | 5.2085 | 32.3538 | 2.6696 |
| int32 | 5 | 4.8207 | 30.2315 | 2.3444 |
| int32 | 10 | 1.8220 | 1.8385 | 1.2027 |
| double | 1 | 6.6922 | 86.4311 | 3.2307 |
| double | 5 | 6.2604 | 75.6518 | 3.6323 |
| double | 10 | 1.4522 | 1.4746 | 1.1282 |
| long | 1 | 6.6936 | 74.1804 | 3.2307 |
| long | 5 | 6.2587 | 77.2849 | 2.8828 |
| long | 10 | 1.4520 | 1.4746 | 1.1283 |
| date | 1 | 6.6922 | 74.1689 | 3.2307 |
| date | 5 | 6.2612 | 77.5955 | 2.8829 |
| date | 10 | 1.4521 | 1.4741 | 1.1280 |
| decimal128 | 1 | 9.0757 | 60.3339 | 4.7988 |
| decimal128 | 5 | 8.5267 | 57.1260 | 4.2628 |
| decimal128 | 10 | 1.2317 | 1.2508 | 1.0796 |
| string | 1 | 1,025.5035 | 28,728.1455 | 21.3179 |
| string | 5 | 513.9927 | 10,375.5331 | 21.2144 |
| string | 10 | 1.206659 | 1.2106 | 0.999954 |
| binary | 1 | 1,025.4408 | 28,728.1455 | 21.3179 |
| binary | 5 | 514.0085 | 10,369.1205 | 21.2144 |
| binary | 10 | 0.999841 | 0.999976 | 0.999954 |

Ratios below are wire ratios from the `oneMiB` slice, at 1,048,576 bytes. Pattern 10 in this slice is a different draw from pattern 10 on the length charts.

### zlib 6 at 1 MiB

| Pattern | int32 | double | long | date | decimal128 | string | binary |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 4.8345 | 6.2239 | 6.2249 | 6.2238 | 8.6753 | 966.4488 | 966.4488 |
| 2 | 4.8153 | 6.2152 | 6.2161 | 6.2155 | 8.6613 | 960.2537 | 961.1338 |
| 3 | 3.6558 | 6.2043 | 4.8663 | 4.8663 | 6.8661 | 235.6398 | 235.7457 |
| 4 | 3.2887 | 5.1077 | 4.3029 | 4.3080 | 6.1380 | 235.6398 | 235.7457 |
| 5 | 4.4526 | 5.8676 | 5.8659 | 5.8703 | 8.4092 | 495.0883 | 495.3222 |
| 6 | 4.7531 | 6.1721 | 6.1712 | 6.1723 | 8.6119 | 398.4031 | 398.4031 |
| 7 | 2.8989 | 3.8048 | 3.8816 | 3.8822 | 3.4225 | 1.9892 | 1.9892 |
| 8 | 1.9460 | 2.4919 | 2.6210 | 2.6211 | 3.8855 | 1.4617 | 1.4617 |
| 9 | 1.6337 | 2.0516 | 2.2134 | 2.2134 | 2.0305 | 1.2005 | 1.2005 |
| 10 | 1.6332 | 1.3572 | 1.3572 | 1.3573 | 1.1775 | 1.2066 | 0.999824 |

String patterns 3 and 4 match, and so do binary patterns 3 and 4. Both generators use every byte value. That is the cliff on the [manifold](#the-manifold). An int32 chart only sags.

### zstd 3 at 1 MiB

Level 1 is tighter than level 3 here for int32 patterns 1, 2, 5, 6, and 8, double patterns 1, 2, and 5, and decimal128 patterns 1, 2, 5, 6, and 8. Decimal128 pattern 4 is close: 14.6484× against 14.6386×. On long and date, level 1 is tighter at patterns 1, 2, 4, 5, 6, 7, and 8. On the zero string and the zero binary, level 3 is the tighter of the two.

| Pattern | int32 | double | long | date | decimal128 | string | binary |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 17.7719 | 25.1981 | 24.8523 | 24.8582 | 40.9238 | 10,082.6635 | 10,082.6635 |
| 2 | 17.8175 | 24.7112 | 24.8859 | 25.2363 | 40.5864 | 6,393.8841 | 6,355.1333 |
| 3 | 4.6336 | 8.5914 | 6.5781 | 6.5783 | 10.0399 | 2,502.6181 | 2,496.6595 |
| 4 | 8.2141 | 15.9978 | 9.9068 | 9.9337 | 14.6386 | 2,502.6181 | 2,496.6595 |
| 5 | 14.3402 | 18.9086 | 19.4062 | 19.7669 | 31.1885 | 5,924.2768 | 5,890.9944 |
| 6 | 17.3983 | 23.0876 | 23.1442 | 23.3109 | 37.5287 | 5,698.8967 | 5,668.0919 |
| 7 | 3.9270 | 4.5692 | 5.3198 | 5.3215 | 3.2770 | 1.9990 | 1.9990 |
| 8 | 1.9672 | 2.2528 | 2.4344 | 2.4406 | 3.6416 | 1.5318 | 1.5318 |
| 9 | 1.8333 | 2.2926 | 2.2187 | 2.2153 | 1.9601 | 1.2036 | 1.2036 |
| 10 | 1.8354 | 1.4622 | 1.4622 | 1.4639 | 1.2316 | 1.2104 | 0.999957 |

### snappy at 1 MiB

| Pattern | int32 | double | long | date | decimal128 | string | binary |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 2.4419 | 3.0146 | 3.0143 | 3.0145 | 4.5913 | 21.2952 | 21.2952 |
| 2 | 2.4290 | 3.0007 | 3.0087 | 3.0087 | 4.5798 | 21.2745 | 21.2740 |
| 3 | 1.7773 | 2.5011 | 2.1496 | 2.1496 | 3.1825 | 19.6897 | 19.6897 |
| 4 | 1.5595 | 2.2090 | 2.1025 | 2.1026 | 3.1281 | 19.6897 | 19.6897 |
| 5 | 2.0928 | 3.3966 | 2.7372 | 2.7378 | 4.0817 | 21.1919 | 21.1911 |
| 6 | 2.1951 | 3.3897 | 2.9198 | 2.9198 | 4.4511 | 21.1530 | 21.1530 |
| 7 | 1.5914 | 2.3303 | 2.1149 | 2.1156 | 2.0577 | 1.9096 | 1.9096 |
| 8 | 1.2915 | 1.5240 | 1.7675 | 1.7676 | 2.4969 | 0.999945 | 0.999943 |
| 9 | 1.1272 | 1.4527 | 1.4468 | 1.4468 | 1.5358 | 0.999945 | 0.999945 |
| 10 | 1.1268 | 1.0836 | 1.0840 | 1.0831 | 1.0492 | 0.999945 | 0.999945 |

### Bits per byte at 64 KiB

From the `level64` draw. Patterns 3 and 4 on a byte payload fill all 256 values, so they measure 8.000. String pattern 10 stays near 6.550 because it is printable. Binary pattern 10 is 7.998. Decimal128 stays lower than int32, double, string, and binary until pattern 10. Long and date measure lower than decimal128 at patterns 7 and 9.

| Pattern | int32 | double | long | date | decimal128 | string | binary |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 2.646 | 2.084 | 2.084 | 2.084 | 1.457 | 0.003 | 0.003 |
| 2 | 3.077 | 2.638 | 2.440 | 2.440 | 1.716 | 2.002 | 2.002 |
| 3 | 4.493 | 3.862 | 3.513 | 3.506 | 2.429 | 8.000 | 8.000 |
| 4 | 3.785 | 3.440 | 2.963 | 2.963 | 2.060 | 8.000 | 8.000 |
| 5 | 3.372 | 2.979 | 2.664 | 2.640 | 1.868 | 4.002 | 4.002 |
| 6 | 3.555 | 2.850 | 2.838 | 2.838 | 2.004 | 2.968 | 2.968 |
| 7 | 4.094 | 4.127 | 3.215 | 3.216 | 3.392 | 6.369 | 6.369 |
| 8 | 5.280 | 6.492 | 4.199 | 4.175 | 2.945 | 5.171 | 5.171 |
| 9 | 6.146 | 5.488 | 4.967 | 4.968 | 5.095 | 6.571 | 6.571 |
| 10 | 6.137 | 6.913 | 6.915 | 6.912 | 7.476 | 6.550 | 7.998 |
