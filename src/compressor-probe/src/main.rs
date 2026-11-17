// Testing implementation for Compressor analysis.md.
// This is the probe that produced compressor-analysis.json on 2026-11-17
// (rustc 1.99.1, snap 1.1.2, flate2 1.1.11 on miniz_oxide, zstd 0.14.4).
// Rung 10 is a fresh CSPRNG draw, so a rerun will not match those rows.
// With no arguments it writes /tmp/compressor-grid.json and
// /tmp/compressor-digest.txt. Two arguments are the grid path and the digest path.
// It does not write the published JSON.
use flate2::write::ZlibEncoder;
use flate2::Compression;
use serde_json::{json, Value};
use snap::raw::Encoder as SnappyEncoder;
use std::fs::File;
use std::io::{Read, Write};
use std::time::Instant;

const BSON_MAX: usize = 16 * 1024 * 1024;
const MAX_MESSAGE: usize = 48_000_000;
const HEADER: usize = 16;
const DETAILS: usize = 9;

#[derive(Clone, Copy)]
struct Job {
    tag: &'static str,
    carriers: &'static [&'static str],
    rungs: &'static [u8],
    zlib: &'static [i32],
    zstd: &'static [i32],
}

fn main() {
    let range = zstd::compression_level_range();
    let started = Instant::now();
    let mut points = Vec::new();
    let jobs = jobs();
    for job in jobs {
        let zstd_levels: Vec<i32> = job.zstd.iter().copied().filter(|lvl| range.contains(lvl)).collect();
        for &carrier in job.carriers {
            for &rung in job.rungs {
                for target in job.sizes() {
                    let tb = Instant::now();
                    let doc = build_doc(target, carrier, rung);
                    let build_ms = tb.elapsed().as_millis();
                    let (shape, doc_len, body) = match doc {
                        Some(doc) => {
                            let mut body = vec![0u8; 5 + doc.len()];
                            body[4] = 0;
                            body[5..].copy_from_slice(&doc);
                            ("document", Some(doc.len()), body)
                        }
                        None => {
                            let mut body = vec![0u8; target];
                            let crypto = if rung == 10 { urandom(target) } else { Vec::new() };
                            fill_payload(&mut body, 0, target, rung, &mut xorshift(0xB0D + rung as u32), &crypto);
                            ("raw", None, body)
                        }
                    };
                    let bits_src = if shape == "document" { &body[5..] } else { body.as_slice() };
                    let bits = round_n(entropy_bits(bits_src), 3);
                    let original = HEADER + body.len();
                    push_none(&mut points, job.tag, carrier, rung, shape, target, doc_len, &body, bits, original);
                    let tz = Instant::now();
                    for level in job.zlib {
                        let compressed = zlib_compress(&body, *level);
                        push_compressed(&mut points, job.tag, carrier, rung, shape, target, doc_len, &body, bits, original, "zlib", Some(*level), &compressed);
                    }
                    let zlib_ms = tz.elapsed().as_millis();
                    let ts = Instant::now();
                    for level in &zstd_levels {
                        let compressed = zstd::bulk::compress(&body, *level).unwrap_or_else(|err| {
                            panic!("zstd {level} on {} bytes: {err}", body.len());
                        });
                        push_compressed(&mut points, job.tag, carrier, rung, shape, target, doc_len, &body, bits, original, "zstd", Some(*level), &compressed);
                    }
                    let zstd_ms = ts.elapsed().as_millis();
                    let compressed = SnappyEncoder::new().compress_vec(&body).expect("snappy");
                    push_compressed(&mut points, job.tag, carrier, rung, shape, target, doc_len, &body, bits, original, "snappy", None, &compressed);
                    if target >= (1 << 20) {
                        eprintln!("  {carrier} r{rung} {target} build {build_ms}ms zlib {zlib_ms}ms zstd {zstd_ms}ms body {}", body.len());
                    }
                }
                eprintln!("{} {carrier} rung {rung} {}ms", job.tag, started.elapsed().as_millis());
            }
        }
    }

    let guard = guard_trip();
    let meta = json!({
        "measured": "2026-11-17",
        "compressor": "rust",
        "rustc": "1.99.1",
        "libraries": {
            "snappy": "snap 1.1.2 raw, same framing as snappy::RawCompress and the Rust driver",
            "zlib": "flate2 1.1.11 default backend (miniz_oxide), zlib wrapper, same call the Rust driver makes",
            "zstd": "zstd 0.14.4"
        },
        "zstdDefault": zstd::DEFAULT_COMPRESSION_LEVEL,
        "zstdLevelRange": [range.start(), range.end()],
        "ratio": "originalWire / framedWire. Higher is tighter. none is 1.",
        "originalWire": "16-byte MsgHeader + body",
        "framedWire": "16-byte MsgHeader + 9-byte OP_COMPRESSED details + compressed body",
        "body": "4 flag bytes, kind byte 0, and a BSON {ping:1, p:<payload>} document. A target below a legal document is a raw buffer (shape raw).",
        "maxMessage": MAX_MESSAGE,
        "guardTripsAtBody": guard,
        "slices": {
            "length": "2^0 through 2^23 plus 16777216; five carriers; rungs 1, 5, 10; zlib -1,0,1,6,9; zstd 1,3,9; snappy",
            "level64": "65536; five carriers; rungs 1-10; zlib -1 and 0-9; zstd -1 and 1-22; snappy",
            "rung1m": "1048576; five carriers; rungs 1-10; zlib -1 and 0-9; zstd 1,3,9; snappy",
            "levelMax": "16777216; binary and int32; rungs 1 and 10; zlib -1 and 0-9; zstd -1,1,3,6,9,19,22; snappy"
        },
        "count": points.len(),
        "seconds": round_n(started.elapsed().as_secs_f64(), 1)
    });
    let mut args = std::env::args().skip(1);
    let grid_path = args.next().unwrap_or_else(|| "/tmp/compressor-grid.json".to_string());
    let digest_path = args.next().unwrap_or_else(|| "/tmp/compressor-digest.txt".to_string());
    write_grid(&grid_path, &meta, &points);
    write_digest(&digest_path, &points);
    eprintln!("done {} points in {:.1}s guard={}", points.len(), started.elapsed().as_secs_f64(), guard);
}

struct Point {
    slice: &'static str,
    carrier: &'static str,
    rung: u8,
    shape: &'static str,
    target: usize,
    doc: Option<usize>,
    body: usize,
    bits: f64,
    compressor: &'static str,
    level: Option<i32>,
    compressed: usize,
    raw_ratio: f64,
    wire: usize,
    wire_ratio: f64,
    expands: bool,
}

fn jobs() -> Vec<Job> {
    vec![
        Job { tag: "length", carriers: &CARRIERS, rungs: &[1, 5, 10], zlib: &[-1, 0, 1, 6, 9], zstd: &[1, 3, 9] },
        Job { tag: "level64", carriers: &CARRIERS, rungs: &[1, 2, 3, 4, 5, 6, 7, 8, 9, 10], zlib: &[-1, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9], zstd: &[-1, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22] },
        Job { tag: "rung1m", carriers: &CARRIERS, rungs: &[1, 2, 3, 4, 5, 6, 7, 8, 9, 10], zlib: &[-1, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9], zstd: &[1, 3, 9] },
        Job { tag: "levelMax", carriers: &["binary", "int32"], rungs: &[1, 10], zlib: &[-1, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9], zstd: &[-1, 1, 3, 6, 9, 19, 22] },
    ]
}

const CARRIERS: [&str; 5] = ["int32", "double", "decimal128", "string", "binary"];

impl Job {
    fn sizes(&self) -> Vec<usize> {
        match self.tag {
            "length" => {
                let mut sizes: Vec<usize> = (0..=23).map(|n| 1usize << n).collect();
                sizes.push(BSON_MAX);
                sizes
            }
            "level64" => vec![65536],
            "rung1m" => vec![1 << 20],
            "levelMax" => vec![BSON_MAX],
            _ => Vec::new(),
        }
    }
}

fn push_none(points: &mut Vec<Point>, slice: &'static str, carrier: &'static str, rung: u8, shape: &'static str, target: usize, doc: Option<usize>, body: &[u8], bits: f64, original: usize) {
    points.push(Point {
        slice, carrier, rung, shape, target, doc, body: body.len(), bits,
        compressor: "none", level: None, compressed: body.len(), raw_ratio: 1.0,
        wire: original, wire_ratio: 1.0, expands: false,
    });
}

fn push_compressed(points: &mut Vec<Point>, slice: &'static str, carrier: &'static str, rung: u8, shape: &'static str, target: usize, doc: Option<usize>, body: &[u8], bits: f64, original: usize, compressor: &'static str, level: Option<i32>, compressed: &[u8]) {
    let wire = HEADER + DETAILS + compressed.len();
    let raw_ratio = round_n(body.len() as f64 / compressed.len() as f64, 6);
    let wire_ratio = round_n(original as f64 / wire as f64, 6);
    points.push(Point {
        slice, carrier, rung, shape, target, doc, body: body.len(), bits,
        compressor, level, compressed: compressed.len(), raw_ratio, wire, wire_ratio,
        expands: wire > original,
    });
}

fn zlib_compress(data: &[u8], level: i32) -> Vec<u8> {
    let compression = if level < 0 { Compression::default() } else { Compression::new(level as u32) };
    let mut enc = ZlibEncoder::new(Vec::new(), compression);
    enc.write_all(data).expect("zlib write");
    enc.finish().expect("zlib finish")
}

fn urandom(n: usize) -> Vec<u8> {
    let mut buf = vec![0u8; n];
    File::open("/dev/urandom").expect("urandom").read_exact(&mut buf).expect("urandom read");
    buf
}

fn xorshift(seed: u32) -> impl FnMut() -> u32 {
    let mut x = if seed == 0 { 1 } else { seed };
    move || {
        x ^= x.wrapping_shl(13);
        x ^= x.wrapping_shr(17);
        x ^= x.wrapping_shl(5);
        x
    }
}

fn entropy_bits(buf: &[u8]) -> f64 {
    if buf.is_empty() { return 0.0; }
    let mut hist = [0u32; 256];
    for &byte in buf { hist[byte as usize] += 1; }
    let n = buf.len() as f64;
    let mut h = 0.0;
    for count in hist {
        if count == 0 { continue; }
        let p = count as f64 / n;
        h -= p * p.log2();
    }
    h
}

fn round_n(value: f64, digits: i32) -> f64 {
    let scale = 10f64.powi(digits);
    (value * scale).round() / scale
}

fn fill_payload(buf: &mut [u8], start: usize, len: usize, rung: u8, rand: &mut impl FnMut() -> u32, crypto: &[u8]) {
    let end = start + len;
    match rung {
        1 => buf[start..end].fill(0),
        2 => { for i in start..end { buf[i] = ((i - start) & 3) as u8; } }
        3 => { for i in start..end { buf[i] = ((i - start) & 0xff) as u8; } }
        4 => { for i in start..end { buf[i] = (((i - start) * 17) & 0xff) as u8; } }
        5 => { for i in start..end { buf[i] = ((i - start) & 0x0f) as u8; } }
        6 => {
            let phrase = b"the cat sat on the mat ";
            for i in start..end { buf[i] = phrase[(i - start) % phrase.len()]; }
        }
        7 => {
            let phrase = b"the cat sat on the mat ";
            let half = start + (len >> 1);
            for i in start..half { buf[i] = phrase[(i - start) % phrase.len()]; }
            for i in half..end { buf[i] = (rand() & 0xff) as u8; }
        }
        8 => { for i in start..end { buf[i] = (rand() % 36) as u8; } }
        9 => { for i in start..end { buf[i] = (32 + (rand() % 95)) as u8; } }
        _ => {
            let n = len.min(crypto.len());
            buf[start..start + n].copy_from_slice(&crypto[..n]);
        }
    }
}

fn write_ping(buf: &mut [u8], mut p: usize) -> usize {
    buf[p] = 0x10;
    p += 1;
    buf[p..p + 4].copy_from_slice(b"ping");
    p += 4;
    buf[p] = 0;
    p += 1;
    buf[p..p + 4].copy_from_slice(&1i32.to_le_bytes());
    p + 4
}

fn build_doc(target: usize, carrier: &str, rung: u8) -> Option<Vec<u8>> {
    match carrier {
        "string" => build_scalar(target, rung, true),
        "binary" => build_scalar(target, rung, false),
        "int32" => build_array(target, rung, 4, 0x10),
        "double" => build_array(target, rung, 8, 0x01),
        _ => build_array(target, rung, 16, 0x13),
    }
}

fn build_scalar(target: usize, rung: u8, string: bool) -> Option<Vec<u8>> {
    let overhead = 4 + 10 + 8 + 1;
    if target < overhead { return None; }
    let content_len = target - overhead;
    let mut buf = vec![0u8; target];
    let mut p = write_ping(&mut buf, 4);
    let crypto = if rung == 10 { urandom(content_len) } else { Vec::new() };
    let mut rand = xorshift(0x5eed + rung as u32);
    if string {
        buf[p] = 0x02;
        p += 1;
        buf[p] = b'p';
        buf[p + 1] = 0;
        p += 2;
        buf[p..p + 4].copy_from_slice(&((content_len as i32) + 1).to_le_bytes());
        p += 4;
        fill_payload(&mut buf, p, content_len, rung, &mut rand, &crypto);
        if rung == 10 {
            for i in 0..content_len { buf[p + i] = 32 + (buf[p + i] % 95); }
        }
        p += content_len;
        buf[p] = 0;
        p += 1;
    } else {
        buf[p] = 0x05;
        p += 1;
        buf[p] = b'p';
        buf[p + 1] = 0;
        p += 2;
        buf[p..p + 4].copy_from_slice(&(content_len as i32).to_le_bytes());
        p += 4;
        buf[p] = 0;
        p += 1;
        fill_payload(&mut buf, p, content_len, rung, &mut rand, &crypto);
        p += content_len;
    }
    buf[p] = 0;
    p += 1;
    if p != target { panic!("scalar size {p} != {target}"); }
    buf[..4].copy_from_slice(&(target as i32).to_le_bytes());
    Some(buf)
}

fn build_array(target: usize, rung: u8, width: usize, type_byte: u8) -> Option<Vec<u8>> {
    if target < 23 { return None; }
    let mut buf = vec![0u8; target];
    let mut p = write_ping(&mut buf, 4);
    buf[p] = 0x04;
    p += 1;
    buf[p] = b'p';
    buf[p + 1] = 0;
    p += 2;
    let arr_size_at = p;
    p += 4;
    let mut rand = xorshift(0xA11A + rung as u32 * 17 + width as u32);
    let mut crypto = if rung == 10 { urandom(width * 64) } else { Vec::new() };
    let mut crypto_at = 0usize;
    let mut i = 0usize;
    loop {
        let key = i.to_string();
        let need = 1 + key.len() + 1 + width;
        if p + need + 2 > target { break; }
        buf[p] = type_byte;
        p += 1;
        buf[p..p + key.len()].copy_from_slice(key.as_bytes());
        p += key.len();
        buf[p] = 0;
        p += 1;
        if width == 4 {
            let value = int_value(i, rung, &mut rand, &mut crypto, &mut crypto_at);
            buf[p..p + 4].copy_from_slice(&value.to_le_bytes());
        } else if width == 8 {
            if rung == 10 {
                refill(&mut crypto, &mut crypto_at, 8);
                buf[p..p + 8].copy_from_slice(&crypto[crypto_at..crypto_at + 8]);
                crypto_at += 8;
            } else {
                let n = double_value(i, rung, &mut rand);
                buf[p..p + 8].copy_from_slice(&n.to_le_bytes());
            }
        } else {
            buf[p..p + 16].fill(0);
            write_decimal(i, rung, &mut rand, &mut crypto, &mut crypto_at, &mut buf[p..p + 16]);
        }
        p += width;
        i += 1;
        if i > 5_000_000 { break; }
    }
    if i == 0 { return None; }
    buf[p] = 0;
    p += 1;
    let arr_size = (p - arr_size_at) as i32;
    buf[arr_size_at..arr_size_at + 4].copy_from_slice(&arr_size.to_le_bytes());
    buf[p] = 0;
    p += 1;
    buf[..4].copy_from_slice(&(p as i32).to_le_bytes());
    Some(buf[..p].to_vec())
}

fn refill(crypto: &mut Vec<u8>, at: &mut usize, need: usize) {
    if *at + need > crypto.len() {
        File::open("/dev/urandom").expect("urandom").read_exact(crypto).expect("urandom");
        *at = 0;
    }
}

fn int_value(i: usize, rung: u8, rand: &mut impl FnMut() -> u32, crypto: &mut Vec<u8>, crypto_at: &mut usize) -> i32 {
    match rung {
        1 => 0,
        2 => (i & 3) as i32,
        3 => i as i32,
        4 => (i & 255) as i32,
        5 => (i & 15) as i32,
        6 => ((i & 7) * 100) as i32,
        7 => if i & 1 == 0 { (i & 15) as i32 } else { (rand() & 0xffff) as i32 },
        8 => (rand() % 1_000_000) as i32,
        9 => rand() as i32,
        _ => {
            refill(crypto, crypto_at, 4);
            let v = i32::from_le_bytes(crypto[*crypto_at..*crypto_at + 4].try_into().unwrap());
            *crypto_at += 4;
            v
        }
    }
}

fn double_value(i: usize, rung: u8, rand: &mut impl FnMut() -> u32) -> f64 {
    match rung {
        1 => 0.0,
        2 => (i & 3) as f64,
        3 => i as f64,
        4 => (i & 255) as f64,
        5 => (i & 15) as f64 / 2.0,
        6 => (i & 7) as f64 * 0.5,
        7 => if i & 1 == 0 { (i & 15) as f64 } else { (rand() % 1000) as f64 / 7.0 },
        8 => (rand() % 1_000_000) as f64 / 1000.0,
        _ => (rand() as f64) / 4294967296.0,
    }
}

fn write_decimal(i: usize, rung: u8, rand: &mut impl FnMut() -> u32, crypto: &mut Vec<u8>, crypto_at: &mut usize, slot: &mut [u8]) {
    if rung == 1 { return; }
    if rung == 10 {
        refill(crypto, crypto_at, 16);
        slot.copy_from_slice(&crypto[*crypto_at..*crypto_at + 16]);
        *crypto_at += 16;
        return;
    }
    if rung >= 7 {
        let v = if rung == 9 { rand() } else if rung == 8 { rand() % 1_000_000 } else { (i & 0xffff) as u32 };
        slot[..4].copy_from_slice(&v.to_le_bytes());
        if rung == 7 && (i & 1) == 1 { slot[4..8].copy_from_slice(&rand().to_le_bytes()); }
        if rung == 9 { slot[4..8].copy_from_slice(&rand().to_le_bytes()); }
        return;
    }
    let v: u32 = match rung {
        2 => (i & 3) as u32,
        3 => i as u32,
        4 => (i & 255) as u32,
        5 => (i & 15) as u32,
        _ => ((i & 7) * 100) as u32,
    };
    slot[..4].copy_from_slice(&v.to_le_bytes());
}

fn guard_trip() -> usize {
    let mut n = MAX_MESSAGE - 200_000;
    while n <= MAX_MESSAGE {
        let bound = n + (n >> 12) + (n >> 14) + (n >> 25) + 13 + DETAILS + HEADER;
        if bound > MAX_MESSAGE { return n; }
        n += 1;
    }
    0
}

fn write_grid(path: &str, meta: &Value, points: &[Point]) {
    let mut file = File::create(path).expect("grid");
    write!(file, "{{\n  \"meta\": ").unwrap();
    serde_json::to_writer_pretty(&mut file, meta).unwrap();
    write!(file, ",\n  \"rows\": [\n").unwrap();
    for (i, point) in points.iter().enumerate() {
        let row = json!({
            "slice": point.slice,
            "carrier": point.carrier,
            "rung": point.rung,
            "shape": point.shape,
            "target": point.target,
            "doc": point.doc,
            "body": point.body,
            "bits": point.bits,
            "compressor": point.compressor,
            "level": point.level,
            "compressed": point.compressed,
            "rawRatio": point.raw_ratio,
            "wire": point.wire,
            "wireRatio": point.wire_ratio,
            "expands": point.expands
        });
        write!(file, "    ").unwrap();
        serde_json::to_writer(&mut file, &row).unwrap();
        if i + 1 != points.len() { writeln!(file, ",").unwrap(); } else { writeln!(file).unwrap(); }
    }
    writeln!(file, "  ]\n}}").unwrap();
}

fn find<'a>(points: &'a [Point], slice: &str, carrier: &str, rung: u8, compressor: &str, level: Option<i32>, target: Option<usize>) -> &'a Point {
    points.iter().find(|p| p.slice == slice && p.carrier == carrier && p.rung == rung && p.compressor == compressor && p.level == level && target.map(|t| p.target == t).unwrap_or(true)).expect("row")
}

fn write_digest(path: &str, points: &[Point]) {
    let mut out = String::new();
    let carriers = ["int32", "double", "decimal128", "string", "binary"];
    out.push_str("LENGTH zlib6 zstd3 snappy\n");
    for carrier in carriers {
        for rung in [1u8, 5, 10] {
            let last = |comp, level| {
                points.iter().filter(|p| p.slice == "length" && p.carrier == carrier && p.rung == rung && p.compressor == comp && p.level == level && p.expands).map(|p| p.target).max()
            };
            let cell = |comp, level, target| find(points, "length", carrier, rung, comp, level, Some(target)).wire_ratio;
            let bits = find(points, "length", carrier, rung, "zlib", Some(6), Some(65536)).bits;
            out.push_str(&format!("{carrier}\t{rung}\t{bits}\tzlib {}\tzstd {}\tsnappy {}\tz6 {} {} {}\tz3 {} {} {}\tsn {} {} {}\n",
                last("zlib", Some(6)).unwrap_or(0),
                last("zstd", Some(3)).unwrap_or(0),
                last("snappy", None).unwrap_or(0),
                cell("zlib", Some(6), 65536), cell("zlib", Some(6), 1 << 20), cell("zlib", Some(6), BSON_MAX),
                cell("zstd", Some(3), 65536), cell("zstd", Some(3), 1 << 20), cell("zstd", Some(3), BSON_MAX),
                cell("snappy", None, 65536), cell("snappy", None, 1 << 20), cell("snappy", None, BSON_MAX)));
        }
    }
    out.push_str("ZSTD1V3\n");
    for carrier in carriers {
        let c = |level, target| find(points, "length", carrier, 1, "zstd", Some(level), Some(target)).wire_ratio;
        out.push_str(&format!("{carrier}\t{}\t{}\t{}\t{}\t{}\n", c(1, 1 << 20), c(3, 1 << 20), c(1, BSON_MAX), c(3, BSON_MAX), c(9, BSON_MAX)));
    }
    out.push_str("ONE_MIB\n");
    for rung in 1u8..=10 {
        let mut line = format!("r{rung}");
        for carrier in carriers {
            for (comp, level) in [("zlib", Some(6)), ("zstd", Some(3)), ("snappy", None)] {
                let p = find(points, "rung1m", carrier, rung, comp, level, None);
                line.push_str(&format!("\t{carrier}:{comp}:{}:{}", p.bits, p.wire_ratio));
            }
        }
        out.push('\n');
        out.push_str(&line);
    }
    out.push('\n');
    out.push_str("LEVEL64 int32 r1 zstd\n");
    for p in points.iter().filter(|p| p.slice == "level64" && p.carrier == "int32" && p.rung == 1 && p.compressor == "zstd") {
        out.push_str(&format!("{}:{}\n", p.level.unwrap(), p.wire_ratio));
    }
    out.push_str("LEVELMAX\n");
    for carrier in ["int32", "binary"] {
        for rung in [1u8, 10] {
            for p in points.iter().filter(|p| p.slice == "levelMax" && p.carrier == carrier && p.rung == rung && (p.compressor == "zlib" || p.compressor == "zstd" || p.compressor == "snappy")) {
                out.push_str(&format!("{carrier} r{rung} {} {:?} {} extra {}\n", p.compressor, p.level, p.wire_ratio, p.wire as isize - (HEADER + p.body) as isize));
            }
        }
    }
    let mut z_pairs = 0usize;
    let mut z_mis = 0usize;
    let mut s_pairs = 0usize;
    let mut s_mis = 0usize;
    for p in points.iter().filter(|p| p.compressor == "zlib" && p.level == Some(-1)) {
        let o = find(points, p.slice, p.carrier, p.rung, "zlib", Some(6), Some(p.target));
        z_pairs += 1;
        if o.compressed != p.compressed { z_mis += 1; }
    }
    for p in points.iter().filter(|p| p.compressor == "zstd" && p.level == Some(-1)) {
        if points.iter().any(|o| o.slice == p.slice && o.carrier == p.carrier && o.rung == p.rung && o.target == p.target && o.compressor == "zstd" && o.level == Some(3)) {
            let o = find(points, p.slice, p.carrier, p.rung, "zstd", Some(3), Some(p.target));
            s_pairs += 1;
            if o.compressed != p.compressed { s_mis += 1; }
        }
    }
    out.push_str(&format!("PAIRS zlib -1 vs 6 {z_pairs} mismatches {z_mis}\n"));
    out.push_str(&format!("PAIRS zstd -1 vs 3 {s_pairs} mismatches {s_mis}\n"));
    let tiny = find(points, "length", "int32", 1, "zlib", Some(6), Some(1));
    out.push_str(&format!("TINY zlib6 body {} wire {} ratio {} expands {}\n", tiny.body, tiny.wire, tiny.wire_ratio, tiny.expands));
    std::fs::write(path, out).unwrap();
}
