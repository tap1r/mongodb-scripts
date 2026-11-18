// Testing implementation for Compressor analysis.md.
// Libraries: rustc 1.99.1, snap 1.1.2, flate2 1.1.11 on miniz_oxide, zstd 0.14.4.
// Level options were read from Rust mongodb 3.10.1. This probe does not link that crate.
// Pattern 10 is a fresh CSPRNG draw, so a rerun will not match those rows.
// With no arguments it writes /tmp/compressor-grid.json and
// /tmp/compressor-digest.txt. Two arguments are the grid path and the digest path.
// It does not write the published JSON.
// COMPRESSOR_SLICES, COMPRESSOR_CARRIERS, and COMPRESSOR_PATTERNS, comma-separated, limit a run.
// COMPRESSOR_ZSTD replaces that run's zstd levels.
// A pattern or zstd token that does not parse fails the run.
use flate2::write::ZlibEncoder;
use flate2::Compression;
use serde_json::{json, Map, Value};
use snap::raw::Encoder as SnappyEncoder;
use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Write};
use std::str::FromStr;
use std::time::Instant;

const KIB: usize = 1024;
const MIB: usize = 1024 * 1024;
const KIB_64: usize = 64 * KIB;
const BSON_MAX: usize = 16 * MIB;
const MAX_MESSAGE: usize = 48_000_000;
const HEADER: usize = 16;
const DETAILS: usize = 9;

const ZLIB_LENGTH: [i32; 5] = [-1, 0, 1, 6, 9];
const ZLIB_ALL: [i32; 11] = [-1, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
const ZLIB_CHART: [i32; 1] = [6];
const ZSTD_LENGTH: [i32; 3] = [1, 3, 9];
// The full sweep. levelMax stays the seven-level sample below.
const ZSTD_LEVEL64: [i32; 23] = [
    -1, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22,
];
const ZSTD_LEVEL_MAX: [i32; 7] = [-1, 1, 3, 6, 9, 19, 22];
const ZSTD_CHART: [i32; 1] = [3];

const PATTERNS_ALL: [u8; 10] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const PATTERNS_LENGTH: [u8; 3] = [1, 5, 10];
const PATTERNS_LEVEL_MAX: [u8; 2] = [1, 10];
const PATTERNS_SURFACE: [u8; 7] = surface_patterns();
const PATTERNS_COMPARE: [u8; 4] = [1, 5, 9, 10];

const CARRIERS: &[&str] = &["int32", "double", "long", "date", "decimal128", "string", "binary"];
const LEVEL_MAX_CARRIERS: &[&str] = &["binary", "int32"];
const COMPARE_CARRIERS: &[&str] = &["long", "date", "timestamp"];
// The digest prints these five. Long, date, and timestamp stay out of it.
const DIGEST_CARRIERS: &[&str] = &["int32", "double", "decimal128", "string", "binary"];

const LENGTH_SIZES: [usize; 25] = length_sizes();
const LEVEL64_SIZES: [usize; 1] = [KIB_64];
const ONE_MIB_SIZES: [usize; 1] = [MIB];
const LEVEL_MAX_SIZES: [usize; 1] = [BSON_MAX];
const COMPARE_SIZES: [usize; 2] = [KIB_64, BSON_MAX];

// Meta key order. The run order of SLICES is separate, and it is the row order.
const SLICE_META_ORDER: [&str; 6] = ["compare", "length", "level64", "levelMax", "oneMiB", "surface"];

const fn surface_patterns() -> [u8; 7] {
    let mut out = [0u8; 7];
    let mut n = 0;
    let mut i = 0;
    while i < PATTERNS_ALL.len() {
        let pattern = PATTERNS_ALL[i];
        let mut skip = false;
        let mut j = 0;
        while j < PATTERNS_LENGTH.len() {
            if PATTERNS_LENGTH[j] == pattern {
                skip = true;
            }
            j += 1;
        }
        if !skip {
            out[n] = pattern;
            n += 1;
        }
        i += 1;
    }
    if n != 7 {
        panic!("surface patterns");
    }
    out
}

const fn length_sizes() -> [usize; 25] {
    let mut sizes = [0usize; 25];
    let mut n = 0;
    while n <= 23 {
        sizes[n] = 1usize << n;
        n += 1;
    }
    sizes[24] = BSON_MAX;
    sizes
}

struct Slice {
    tag: &'static str,
    carriers: &'static [&'static str],
    patterns: &'static [u8],
    zlib: &'static [i32],
    zstd: &'static [i32],
    sizes: &'static [usize],
    about: &'static str,
}

const SLICES: [Slice; 6] = [
    Slice {
        tag: "length",
        carriers: CARRIERS,
        patterns: &PATTERNS_LENGTH,
        zlib: &ZLIB_LENGTH,
        zstd: &ZSTD_LENGTH,
        sizes: &LENGTH_SIZES,
        about: "2^0 through 2^23 plus 16777216; seven carriers; patterns 1, 5, 10; zlib -1,0,1,6,9; zstd 1,3,9; snappy",
    },
    Slice {
        tag: "level64",
        carriers: CARRIERS,
        patterns: &PATTERNS_ALL,
        zlib: &ZLIB_ALL,
        zstd: &ZSTD_LEVEL64,
        sizes: &LEVEL64_SIZES,
        about: "65536; seven carriers; patterns 1-10; zlib -1 and 0-9; zstd -1 and 1-22; snappy",
    },
    Slice {
        tag: "oneMiB",
        carriers: CARRIERS,
        patterns: &PATTERNS_ALL,
        zlib: &ZLIB_ALL,
        zstd: &ZSTD_LENGTH,
        sizes: &ONE_MIB_SIZES,
        about: "1048576; seven carriers; patterns 1-10; zlib -1 and 0-9; zstd 1,3,9; snappy",
    },
    Slice {
        tag: "levelMax",
        carriers: LEVEL_MAX_CARRIERS,
        patterns: &PATTERNS_LEVEL_MAX,
        zlib: &ZLIB_ALL,
        zstd: &ZSTD_LEVEL_MAX,
        sizes: &LEVEL_MAX_SIZES,
        about: "16777216; binary and int32; patterns 1 and 10; zlib -1 and 0-9; zstd -1,1,3,6,9,19,22; snappy",
    },
    // Patterns the length charts skip. The chart reads patterns 1, 5, and 10 from length.
    Slice {
        tag: "surface",
        carriers: CARRIERS,
        patterns: &PATTERNS_SURFACE,
        zlib: &ZLIB_CHART,
        zstd: &ZSTD_CHART,
        sizes: &LENGTH_SIZES,
        about: "2^0 through 2^23 plus 16777216; seven carriers; patterns 2, 3, 4, 6, 7, 8, 9; zlib 6; zstd 3; snappy",
    },
    Slice {
        tag: "compare",
        carriers: COMPARE_CARRIERS,
        patterns: &PATTERNS_COMPARE,
        zlib: &ZLIB_CHART,
        zstd: &ZSTD_CHART,
        sizes: &COMPARE_SIZES,
        about: "65536 and 16777216; long, date, and timestamp; patterns 1, 5, 9, 10; zlib 6; zstd 3; snappy",
    },
];

fn main() {
    let range = zstd::compression_level_range();
    let started = Instant::now();
    let mut points = Vec::new();
    let slice_filter = split_env("COMPRESSOR_SLICES");
    let carrier_filter = split_env("COMPRESSOR_CARRIERS");
    let pattern_filter: Vec<u8> = parse_env("COMPRESSOR_PATTERNS");
    let zstd_override: Vec<i32> = parse_env("COMPRESSOR_ZSTD");
    let mut random = Random::new();
    for slice in &SLICES {
        if !slice_filter.is_empty() && !slice_filter.iter().any(|name| name == slice.tag) {
            continue;
        }
        let zstd_levels: Vec<i32> = if zstd_override.is_empty() {
            slice.zstd.iter().copied().filter(|lvl| range.contains(lvl)).collect()
        } else {
            zstd_override.iter().copied().filter(|lvl| range.contains(lvl)).collect()
        };
        for &carrier in slice.carriers {
            if !carrier_filter.is_empty() && !carrier_filter.iter().any(|name| name == carrier) {
                continue;
            }
            for &pattern in slice.patterns {
                if !pattern_filter.is_empty() && !pattern_filter.contains(&pattern) {
                    continue;
                }
                for &target in slice.sizes {
                    points.extend(measure(slice.tag, carrier, pattern, target, slice.zlib, &zstd_levels, &mut random));
                }
                eprintln!("{} {carrier} pattern {pattern} {}ms", slice.tag, started.elapsed().as_millis());
            }
        }
    }

    let guard = guard_trip();
    let meta = json!({
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
        "slices": slice_meta(),
        "count": points.len()
    });
    let mut args = std::env::args().skip(1);
    let grid_path = args.next().unwrap_or_else(|| "/tmp/compressor-grid.json".to_string());
    let digest_path = args.next().unwrap_or_else(|| "/tmp/compressor-digest.txt".to_string());
    write_grid(&grid_path, &meta, &points);
    if slice_filter.is_empty() && carrier_filter.is_empty() && pattern_filter.is_empty() && zstd_override.is_empty() {
        write_digest(&digest_path, &points);
    }
    eprintln!("done {} points in {:.1}s guard={}", points.len(), started.elapsed().as_secs_f64(), guard);
}

fn slice_meta() -> Value {
    let mut slices = Map::new();
    for tag in SLICE_META_ORDER {
        let slice = SLICES.iter().find(|slice| slice.tag == tag).unwrap_or_else(|| panic!("missing slice {tag}"));
        slices.insert(tag.to_string(), Value::String(slice.about.to_string()));
    }
    Value::Object(slices)
}

struct Point {
    slice: &'static str,
    carrier: &'static str,
    pattern: u8,
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

impl Point {
    fn row(&self) -> Value {
        json!({
            "slice": self.slice,
            "carrier": self.carrier,
            "pattern": self.pattern,
            "shape": self.shape,
            "target": self.target,
            "doc": self.doc,
            "body": self.body,
            "bits": self.bits,
            "compressor": self.compressor,
            "level": self.level,
            "compressed": self.compressed,
            "rawRatio": self.raw_ratio,
            "wire": self.wire,
            "wireRatio": self.wire_ratio,
            "expands": self.expands
        })
    }
}

struct Random {
    file: Option<File>,
}

impl Random {
    fn new() -> Self {
        Self { file: None }
    }
}

impl Read for Random {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        if self.file.is_none() {
            self.file = Some(File::open("/dev/urandom").expect("urandom"));
        }
        self.file.as_mut().unwrap().read(buf)
    }
}

fn measure(slice: &'static str, carrier: &'static str, pattern: u8, target: usize, zlib: &[i32], zstd: &[i32], random: &mut dyn Read) -> Vec<Point> {
    let mut points = Vec::new();
    let tb = Instant::now();
    let doc = build_doc(target, carrier, pattern, random);
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
            let crypto = if pattern == 10 {
                let mut bytes = vec![0u8; target];
                random.read_exact(&mut bytes).expect("urandom read");
                bytes
            } else {
                Vec::new()
            };
            fill_payload(&mut body, 0, target, pattern, &mut xorshift(0xB0D + pattern as u32), &crypto);
            ("raw", None, body)
        }
    };
    let bits_src = if shape == "document" { &body[5..] } else { body.as_slice() };
    let bits = round_n(entropy_bits(bits_src), 3);
    let original = HEADER + body.len();
    push_none(&mut points, slice, carrier, pattern, shape, target, doc_len, &body, bits, original);
    let tz = Instant::now();
    for level in zlib {
        let compressed = zlib_compress(&body, *level);
        push_compressed(&mut points, slice, carrier, pattern, shape, target, doc_len, &body, bits, original, "zlib", Some(*level), &compressed);
    }
    let zlib_ms = tz.elapsed().as_millis();
    let ts = Instant::now();
    for level in zstd {
        let compressed = zstd::bulk::compress(&body, *level).unwrap_or_else(|err| {
            panic!("zstd {level} on {} bytes: {err}", body.len());
        });
        push_compressed(&mut points, slice, carrier, pattern, shape, target, doc_len, &body, bits, original, "zstd", Some(*level), &compressed);
    }
    let zstd_ms = ts.elapsed().as_millis();
    let compressed = SnappyEncoder::new().compress_vec(&body).expect("snappy");
    push_compressed(&mut points, slice, carrier, pattern, shape, target, doc_len, &body, bits, original, "snappy", None, &compressed);
    if target >= MIB {
        eprintln!("  {carrier} p{pattern} {target} build {build_ms}ms zlib {zlib_ms}ms zstd {zstd_ms}ms body {}", body.len());
    }
    points
}

fn split_env(key: &str) -> Vec<String> {
    std::env::var(key).ok().map(|raw| parse_tokens(key, &raw)).unwrap_or_default()
}

fn parse_env<T: FromStr>(key: &str) -> Vec<T> {
    std::env::var(key).ok().map(|raw| parse_tokens(key, &raw)).unwrap_or_default()
}

fn parse_tokens<T: FromStr>(key: &str, raw: &str) -> Vec<T> {
    raw.split(',').map(|token| token.trim()).filter(|token| !token.is_empty()).map(|token| {
        token.parse().unwrap_or_else(|_| panic!("{key}: bad token {token}"))
    }).collect()
}

fn push_none(points: &mut Vec<Point>, slice: &'static str, carrier: &'static str, pattern: u8, shape: &'static str, target: usize, doc: Option<usize>, body: &[u8], bits: f64, original: usize) {
    points.push(Point {
        slice, carrier, pattern, shape, target, doc, body: body.len(), bits,
        compressor: "none", level: None, compressed: body.len(), raw_ratio: 1.0,
        wire: original, wire_ratio: 1.0, expands: false,
    });
}

fn push_compressed(points: &mut Vec<Point>, slice: &'static str, carrier: &'static str, pattern: u8, shape: &'static str, target: usize, doc: Option<usize>, body: &[u8], bits: f64, original: usize, compressor: &'static str, level: Option<i32>, compressed: &[u8]) {
    let wire = HEADER + DETAILS + compressed.len();
    let raw_ratio = round_n(body.len() as f64 / compressed.len() as f64, 6);
    let wire_ratio = round_n(original as f64 / wire as f64, 6);
    points.push(Point {
        slice, carrier, pattern, shape, target, doc, body: body.len(), bits,
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

fn fill_payload(buf: &mut [u8], start: usize, len: usize, pattern: u8, rand: &mut impl FnMut() -> u32, crypto: &[u8]) {
    let end = start + len;
    match pattern {
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
        10 => {
            let n = len.min(crypto.len());
            buf[start..start + n].copy_from_slice(&crypto[..n]);
        }
        _ => panic!("pattern {pattern}"),
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

#[derive(Clone, Copy)]
enum Kind { Int32, Double, Long, Timestamp, Decimal }

#[derive(Clone, Copy)]
enum Form {
    String,
    Binary,
    Array { width: usize, type_byte: u8, kind: Kind },
}

struct Carrier {
    name: &'static str,
    form: Form,
}

const CARRIER_TABLE: [Carrier; 8] = [
    Carrier { name: "int32", form: Form::Array { width: 4, type_byte: 0x10, kind: Kind::Int32 } },
    Carrier { name: "double", form: Form::Array { width: 8, type_byte: 0x01, kind: Kind::Double } },
    Carrier { name: "long", form: Form::Array { width: 8, type_byte: 0x12, kind: Kind::Long } },
    Carrier { name: "date", form: Form::Array { width: 8, type_byte: 0x09, kind: Kind::Long } },
    Carrier { name: "timestamp", form: Form::Array { width: 8, type_byte: 0x11, kind: Kind::Timestamp } },
    Carrier { name: "decimal128", form: Form::Array { width: 16, type_byte: 0x13, kind: Kind::Decimal } },
    Carrier { name: "string", form: Form::String },
    Carrier { name: "binary", form: Form::Binary },
];

fn carrier(name: &str) -> &'static Carrier {
    CARRIER_TABLE.iter().find(|carrier| carrier.name == name).unwrap_or_else(|| panic!("unknown carrier {name}"))
}

fn build_doc(target: usize, name: &str, pattern: u8, random: &mut dyn Read) -> Option<Vec<u8>> {
    match carrier(name).form {
        Form::String => build_scalar(target, pattern, true, random),
        Form::Binary => build_scalar(target, pattern, false, random),
        Form::Array { width, type_byte, kind } => build_array(target, pattern, width, type_byte, kind, random),
    }
}

fn build_scalar(target: usize, pattern: u8, string: bool, random: &mut dyn Read) -> Option<Vec<u8>> {
    let overhead = 4 + 10 + 8 + 1;
    if target < overhead { return None; }
    let content_len = target - overhead;
    let mut buf = vec![0u8; target];
    let mut p = write_ping(&mut buf, 4);
    let crypto = if pattern == 10 {
        let mut bytes = vec![0u8; content_len];
        random.read_exact(&mut bytes).expect("urandom read");
        bytes
    } else {
        Vec::new()
    };
    let mut rand = xorshift(0x5eed + pattern as u32);
    if string {
        buf[p] = 0x02;
        p += 1;
        buf[p] = b'p';
        buf[p + 1] = 0;
        p += 2;
        buf[p..p + 4].copy_from_slice(&((content_len as i32) + 1).to_le_bytes());
        p += 4;
        fill_payload(&mut buf, p, content_len, pattern, &mut rand, &crypto);
        if pattern == 10 {
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
        fill_payload(&mut buf, p, content_len, pattern, &mut rand, &crypto);
        p += content_len;
    }
    buf[p] = 0;
    p += 1;
    if p != target { panic!("scalar size {p} != {target}"); }
    buf[..4].copy_from_slice(&(target as i32).to_le_bytes());
    Some(buf)
}

fn build_array(target: usize, pattern: u8, width: usize, type_byte: u8, kind: Kind, random: &mut dyn Read) -> Option<Vec<u8>> {
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
    let mut rand = xorshift(0xA11A + pattern as u32 * 17 + width as u32);
    let mut crypto = if pattern == 10 {
        let mut bytes = vec![0u8; width * 64];
        random.read_exact(&mut bytes).expect("urandom read");
        bytes
    } else {
        Vec::new()
    };
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
        match kind {
            Kind::Int32 => {
                let value = int_value(i, pattern, &mut rand, random, &mut crypto, &mut crypto_at);
                buf[p..p + 4].copy_from_slice(&value.to_le_bytes());
            }
            Kind::Double => {
                if pattern == 10 {
                    refill(random, &mut crypto, &mut crypto_at, 8);
                    buf[p..p + 8].copy_from_slice(&crypto[crypto_at..crypto_at + 8]);
                    crypto_at += 8;
                } else {
                    let n = double_value(i, pattern, &mut rand);
                    buf[p..p + 8].copy_from_slice(&n.to_le_bytes());
                }
            }
            Kind::Long => {
                if pattern == 10 {
                    refill(random, &mut crypto, &mut crypto_at, 8);
                    buf[p..p + 8].copy_from_slice(&crypto[crypto_at..crypto_at + 8]);
                    crypto_at += 8;
                } else {
                    let n = long_value(i, pattern, &mut rand);
                    buf[p..p + 8].copy_from_slice(&n.to_le_bytes());
                }
            }
            Kind::Timestamp => {
                let (inc, sec) = timestamp_value(i, pattern, &mut rand, random, &mut crypto, &mut crypto_at);
                buf[p..p + 4].copy_from_slice(&inc.to_le_bytes());
                buf[p + 4..p + 8].copy_from_slice(&sec.to_le_bytes());
            }
            Kind::Decimal => {
                buf[p..p + 16].fill(0);
                write_decimal(i, pattern, &mut rand, random, &mut crypto, &mut crypto_at, &mut buf[p..p + 16]);
            }
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

fn refill(random: &mut dyn Read, crypto: &mut Vec<u8>, at: &mut usize, need: usize) {
    if *at + need > crypto.len() {
        random.read_exact(crypto).expect("urandom");
        *at = 0;
    }
}

fn int_value(i: usize, pattern: u8, rand: &mut impl FnMut() -> u32, random: &mut dyn Read, crypto: &mut Vec<u8>, crypto_at: &mut usize) -> i32 {
    match pattern {
        1 => 0,
        2 => (i & 3) as i32,
        3 => i as i32,
        4 => (i & 255) as i32,
        5 => (i & 15) as i32,
        6 => ((i & 7) * 100) as i32,
        7 => if i & 1 == 0 { (i & 15) as i32 } else { (rand() & 0xffff) as i32 },
        8 => (rand() % 1_000_000) as i32,
        9 => rand() as i32,
        10 => {
            refill(random, crypto, crypto_at, 4);
            let v = i32::from_le_bytes(crypto[*crypto_at..*crypto_at + 4].try_into().unwrap());
            *crypto_at += 4;
            v
        }
        _ => panic!("pattern {pattern}"),
    }
}

fn long_value(i: usize, pattern: u8, rand: &mut impl FnMut() -> u32) -> i64 {
    // The same ladder as int32, widened. Values fit in 32 bits, so the high four bytes stay zero.
    // Pattern 10 copies raw bytes in the array builder and does not call this ladder.
    match pattern {
        1 => 0,
        2 => (i & 3) as i64,
        3 => i as i64,
        4 => (i & 255) as i64,
        5 => (i & 15) as i64,
        6 => ((i & 7) * 100) as i64,
        7 => if i & 1 == 0 { (i & 15) as i64 } else { (rand() & 0xffff) as i64 },
        8 => (rand() % 1_000_000) as i64,
        9 => rand() as u32 as i64,
        _ => panic!("pattern {pattern}"),
    }
}

fn timestamp_value(i: usize, pattern: u8, rand: &mut impl FnMut() -> u32, random: &mut dyn Read, crypto: &mut Vec<u8>, crypto_at: &mut usize) -> (u32, u32) {
    // BSON timestamp is a uint32 increment and a uint32 seconds, not one int64.
    if pattern == 10 {
        refill(random, crypto, crypto_at, 8);
        let inc = u32::from_le_bytes(crypto[*crypto_at..*crypto_at + 4].try_into().unwrap());
        let sec = u32::from_le_bytes(crypto[*crypto_at + 4..*crypto_at + 8].try_into().unwrap());
        *crypto_at += 8;
        return (inc, sec);
    }
    let low = long_value(i, pattern, rand) as u32;
    (low, low)
}

fn double_value(i: usize, pattern: u8, rand: &mut impl FnMut() -> u32) -> f64 {
    // Pattern 10 copies raw bytes in the array builder and does not call this ladder.
    match pattern {
        1 => 0.0,
        2 => (i & 3) as f64,
        3 => i as f64,
        4 => (i & 255) as f64,
        5 => (i & 15) as f64 / 2.0,
        6 => (i & 7) as f64 * 0.5,
        7 => if i & 1 == 0 { (i & 15) as f64 } else { (rand() % 1000) as f64 / 7.0 },
        8 => (rand() % 1_000_000) as f64 / 1000.0,
        9 => (rand() as f64) / 4294967296.0,
        _ => panic!("pattern {pattern}"),
    }
}

fn write_decimal(i: usize, pattern: u8, rand: &mut impl FnMut() -> u32, random: &mut dyn Read, crypto: &mut Vec<u8>, crypto_at: &mut usize, slot: &mut [u8]) {
    if pattern == 1 { return; }
    if pattern == 10 {
        refill(random, crypto, crypto_at, 16);
        slot.copy_from_slice(&crypto[*crypto_at..*crypto_at + 16]);
        *crypto_at += 16;
        return;
    }
    if pattern >= 7 {
        let v = if pattern == 9 { rand() } else if pattern == 8 { rand() % 1_000_000 } else { (i & 0xffff) as u32 };
        slot[..4].copy_from_slice(&v.to_le_bytes());
        if pattern == 7 && (i & 1) == 1 { slot[4..8].copy_from_slice(&rand().to_le_bytes()); }
        if pattern == 9 { slot[4..8].copy_from_slice(&rand().to_le_bytes()); }
        return;
    }
    let v: u32 = match pattern {
        2 => (i & 3) as u32,
        3 => i as u32,
        4 => (i & 255) as u32,
        5 => (i & 15) as u32,
        6 => ((i & 7) * 100) as u32,
        _ => panic!("pattern {pattern}"),
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
        write!(file, "    ").unwrap();
        serde_json::to_writer(&mut file, &point.row()).unwrap();
        if i + 1 != points.len() { writeln!(file, ",").unwrap(); } else { writeln!(file).unwrap(); }
    }
    writeln!(file, "  ]\n}}").unwrap();
}

type RowKey<'a> = (&'a str, &'a str, u8, &'a str, Option<i32>, usize);

fn point_index(points: &[Point]) -> HashMap<RowKey<'_>, &Point> {
    let mut map = HashMap::with_capacity(points.len());
    for point in points {
        let key = (point.slice, point.carrier, point.pattern, point.compressor, point.level, point.target);
        if map.insert(key, point).is_some() {
            panic!("duplicate row {key:?}");
        }
    }
    map
}

fn lookup<'a>(map: &HashMap<RowKey<'a>, &'a Point>, slice: &str, carrier: &str, pattern: u8, compressor: &str, level: Option<i32>, target: usize) -> &'a Point {
    map.get(&(slice, carrier, pattern, compressor, level, target)).copied().unwrap_or_else(|| {
        panic!("missing row {slice} {carrier} pattern {pattern} {compressor} {level:?} t={target}")
    })
}

fn write_digest(path: &str, points: &[Point]) {
    let map = point_index(points);
    let mut out = String::new();
    out.push_str("LENGTH zlib6 zstd3 snappy\n");
    for &carrier in DIGEST_CARRIERS {
        for pattern in [1u8, 5, 10] {
            let last = |comp, level| {
                points.iter().filter(|p| p.slice == "length" && p.carrier == carrier && p.pattern == pattern && p.compressor == comp && p.level == level && p.expands).map(|p| p.target).max()
            };
            let cell = |comp, level, target| lookup(&map, "length", carrier, pattern, comp, level, target).wire_ratio;
            let bits = lookup(&map, "length", carrier, pattern, "zlib", Some(6), KIB_64).bits;
            out.push_str(&format!("{carrier}\t{pattern}\t{bits}\tzlib {}\tzstd {}\tsnappy {}\tz6 {} {} {}\tz3 {} {} {}\tsn {} {} {}\n",
                last("zlib", Some(6)).unwrap_or(0),
                last("zstd", Some(3)).unwrap_or(0),
                last("snappy", None).unwrap_or(0),
                cell("zlib", Some(6), KIB_64), cell("zlib", Some(6), MIB), cell("zlib", Some(6), BSON_MAX),
                cell("zstd", Some(3), KIB_64), cell("zstd", Some(3), MIB), cell("zstd", Some(3), BSON_MAX),
                cell("snappy", None, KIB_64), cell("snappy", None, MIB), cell("snappy", None, BSON_MAX)));
        }
    }
    out.push_str("ZSTD1V3\n");
    for &carrier in DIGEST_CARRIERS {
        let c = |level, target| lookup(&map, "length", carrier, 1, "zstd", Some(level), target).wire_ratio;
        out.push_str(&format!("{carrier}\t{}\t{}\t{}\t{}\t{}\n", c(1, MIB), c(3, MIB), c(1, BSON_MAX), c(3, BSON_MAX), c(9, BSON_MAX)));
    }
    out.push_str("ONE_MIB\n");
    for pattern in 1u8..=10 {
        let mut line = format!("p{pattern}");
        for &carrier in DIGEST_CARRIERS {
            for (comp, level) in [("zlib", Some(6)), ("zstd", Some(3)), ("snappy", None)] {
                let p = lookup(&map, "oneMiB", carrier, pattern, comp, level, MIB);
                line.push_str(&format!("\t{carrier}:{comp}:{}:{}", p.bits, p.wire_ratio));
            }
        }
        out.push('\n');
        out.push_str(&line);
    }
    out.push('\n');
    out.push_str("LEVEL64 int32 pattern 1 zstd\n");
    for p in points.iter().filter(|p| p.slice == "level64" && p.carrier == "int32" && p.pattern == 1 && p.compressor == "zstd") {
        out.push_str(&format!("{}:{}\n", p.level.unwrap(), p.wire_ratio));
    }
    out.push_str("LEVELMAX\n");
    for carrier in ["int32", "binary"] {
        for pattern in [1u8, 10] {
            for p in points.iter().filter(|p| p.slice == "levelMax" && p.carrier == carrier && p.pattern == pattern && (p.compressor == "zlib" || p.compressor == "zstd" || p.compressor == "snappy")) {
                out.push_str(&format!("{carrier} p{pattern} {} {:?} {} extra {}\n", p.compressor, p.level, p.wire_ratio, p.wire as isize - (HEADER + p.body) as isize));
            }
        }
    }
    let mut z_pairs = 0usize;
    let mut z_mis = 0usize;
    let mut s_pairs = 0usize;
    let mut s_mis = 0usize;
    for p in points.iter().filter(|p| p.compressor == "zlib" && p.level == Some(-1)) {
        let o = lookup(&map, p.slice, p.carrier, p.pattern, "zlib", Some(6), p.target);
        z_pairs += 1;
        if o.compressed != p.compressed { z_mis += 1; }
    }
    for p in points.iter().filter(|p| p.compressor == "zstd" && p.level == Some(-1)) {
        if let Some(o) = map.get(&(p.slice, p.carrier, p.pattern, "zstd", Some(3), p.target)) {
            s_pairs += 1;
            if o.compressed != p.compressed { s_mis += 1; }
        }
    }
    out.push_str(&format!("PAIRS zlib -1 vs 6 {z_pairs} mismatches {z_mis}\n"));
    out.push_str(&format!("PAIRS zstd -1 vs 3 {s_pairs} mismatches {s_mis}\n"));
    let tiny = lookup(&map, "length", "int32", 1, "zlib", Some(6), 1);
    out.push_str(&format!("TINY zlib6 body {} wire {} ratio {} expands {}\n", tiny.body, tiny.wire, tiny.wire_ratio, tiny.expands));
    std::fs::write(path, out).unwrap();
}

#[cfg(test)]
mod tests {
    use super::*;

    struct PanicRead;

    impl Read for PanicRead {
        fn read(&mut self, _buf: &mut [u8]) -> std::io::Result<usize> {
            panic!("seeded pattern read urandom");
        }
    }

    fn doc(target: usize, name: &str, pattern: u8) -> Vec<u8> {
        let mut random = PanicRead;
        build_doc(target, name, pattern, &mut random).unwrap()
    }

    #[test]
    fn first_documents() {
        assert_eq!(doc(32, "int32", 1).len(), 30);
        assert_eq!(doc(64, "double", 1).len(), 56);
        assert_eq!(doc(64, "long", 1).len(), 56);
        assert_eq!(doc(64, "date", 1).len(), 56);
        assert_eq!(doc(64, "decimal128", 1).len(), 61);
        assert_eq!(doc(32, "string", 1).len(), 32);
        assert_eq!(doc(32, "binary", 1).len(), 32);
        let int32 = doc(32, "int32", 1);
        assert_eq!(i32::from_le_bytes(int32[..4].try_into().unwrap()), 30);
    }

    #[test]
    fn date_reuses_the_long_ladder() {
        let mut date = doc(64, "date", 1);
        let long = doc(64, "long", 1);
        for byte in &mut date {
            if *byte == 0x09 { *byte = 0x12; }
        }
        assert_eq!(date, long);
    }

    #[test]
    fn seeded_patterns_do_not_read_urandom() {
        let carriers = ["int32", "double", "long", "date", "decimal128", "string", "binary", "timestamp"];
        for carrier in carriers {
            for pattern in 1..=9 {
                let mut random = PanicRead;
                let built = build_doc(128, carrier, pattern, &mut random);
                assert!(built.is_some(), "{carrier} pattern {pattern}");
            }
        }
    }

    #[test]
    #[should_panic(expected = "pattern 11")]
    fn unexpected_pattern() {
        let mut random = PanicRead;
        let _ = build_doc(64, "int32", 11, &mut random);
    }

    #[test]
    #[should_panic(expected = "unknown carrier")]
    fn unknown_carrier() {
        let mut random = PanicRead;
        let _ = build_doc(64, "nope", 1, &mut random);
    }

    #[test]
    fn slice_table() {
        let tags: Vec<_> = SLICES.iter().map(|slice| slice.tag).collect();
        assert_eq!(tags, ["length", "level64", "oneMiB", "levelMax", "surface", "compare"]);
        assert_eq!(PATTERNS_SURFACE, [2, 3, 4, 6, 7, 8, 9]);
        let length = SLICES.iter().find(|slice| slice.tag == "length").unwrap();
        let surface = SLICES.iter().find(|slice| slice.tag == "surface").unwrap();
        assert_eq!(length.sizes, surface.sizes);
        assert_eq!(length.sizes.len(), 25);
        assert_eq!(length.sizes[0], 1);
        assert_eq!(*length.sizes.last().unwrap(), BSON_MAX);
        assert_eq!(length.patterns, &[1, 5, 10]);
        let level_max = SLICES.iter().find(|slice| slice.tag == "levelMax").unwrap();
        assert_eq!(level_max.zstd, &[-1, 1, 3, 6, 9, 19, 22]);
        assert_eq!(level_max.carriers, &["binary", "int32"]);
        assert_eq!(level_max.patterns, &[1, 10]);
        assert_eq!(level_max.sizes, &[BSON_MAX]);
        let meta = slice_meta().as_object().unwrap().clone();
        let keys: Vec<_> = meta.keys().cloned().collect();
        assert_eq!(keys, ["compare", "length", "level64", "levelMax", "oneMiB", "surface"]);
        assert_eq!(meta["levelMax"], "16777216; binary and int32; patterns 1 and 10; zlib -1 and 0-9; zstd -1,1,3,6,9,19,22; snappy");
        assert_eq!(meta["surface"], "2^0 through 2^23 plus 16777216; seven carriers; patterns 2, 3, 4, 6, 7, 8, 9; zlib 6; zstd 3; snappy");
    }

    #[test]
    fn point_row_keeps_the_keys() {
        let point = Point {
            slice: "length",
            carrier: "int32",
            pattern: 1,
            shape: "raw",
            target: 1,
            doc: None,
            body: 1,
            bits: 0.0,
            compressor: "none",
            level: None,
            compressed: 1,
            raw_ratio: 1.0,
            wire: 17,
            wire_ratio: 1.0,
            expands: false,
        };
        let text = serde_json::to_string(&point.row()).unwrap();
        assert_eq!(text, "{\"bits\":0.0,\"body\":1,\"carrier\":\"int32\",\"compressed\":1,\"compressor\":\"none\",\"doc\":null,\"expands\":false,\"level\":null,\"pattern\":1,\"rawRatio\":1.0,\"shape\":\"raw\",\"slice\":\"length\",\"target\":1,\"wire\":17,\"wireRatio\":1.0}");
    }

    #[test]
    fn measure_order_is_none_zlib_zstd_snappy() {
        let mut random = PanicRead;
        let points = measure("length", "int32", 1, 32, &[6, -1], &[3, 1], &mut random);
        let names: Vec<_> = points.iter().map(|point| (point.compressor, point.level)).collect();
        assert_eq!(names, [("none", None), ("zlib", Some(6)), ("zlib", Some(-1)), ("zstd", Some(3)), ("zstd", Some(1)), ("snappy", None)]);
        let none = &points[0];
        assert_eq!(none.wire_ratio, 1.0);
        assert_eq!(none.raw_ratio, 1.0);
        assert!(!none.expands);
        assert_eq!(none.doc, Some(30));
        let map = point_index(&points);
        assert_eq!(lookup(&map, "length", "int32", 1, "none", None, 32).doc, Some(30));
        assert!(map.get(&("length", "int32", 1, "zstd", Some(9), 32)).is_none());
    }

    #[test]
    fn parsed_tokens() {
        assert_eq!(parse_tokens::<i32>("COMPRESSOR_ZSTD", "-1, 3"), vec![-1, 3]);
        assert_eq!(parse_tokens::<u8>("COMPRESSOR_PATTERNS", "1,10"), vec![1, 10]);
        let caught = std::panic::catch_unwind(|| parse_tokens::<i32>("COMPRESSOR_ZSTD", "3,no"));
        assert!(caught.is_err());
    }
}
