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
// An unknown slice or carrier name fails the run.
use flate2::write::ZlibEncoder;
use flate2::Compression;
use serde_json::{json, Value};
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

const INT32: Carrier = Carrier { name: "int32", form: Form::Array { width: 4, type_byte: 0x10, kind: Kind::Int32 } };
const DOUBLE: Carrier = Carrier { name: "double", form: Form::Array { width: 8, type_byte: 0x01, kind: Kind::Double } };
const LONG: Carrier = Carrier { name: "long", form: Form::Array { width: 8, type_byte: 0x12, kind: Kind::Long } };
const DATE: Carrier = Carrier { name: "date", form: Form::Array { width: 8, type_byte: 0x09, kind: Kind::Long } };
const TIMESTAMP: Carrier = Carrier { name: "timestamp", form: Form::Array { width: 8, type_byte: 0x11, kind: Kind::Timestamp } };
const DECIMAL128: Carrier = Carrier { name: "decimal128", form: Form::Array { width: 16, type_byte: 0x13, kind: Kind::Decimal } };
const STRING: Carrier = Carrier { name: "string", form: Form::String };
const BINARY: Carrier = Carrier { name: "binary", form: Form::Binary };

const CARRIER_TABLE: [&Carrier; 8] = [&INT32, &DOUBLE, &LONG, &DATE, &TIMESTAMP, &DECIMAL128, &STRING, &BINARY];
const CHART_CARRIERS: [&Carrier; 7] = [&INT32, &DOUBLE, &LONG, &DATE, &DECIMAL128, &STRING, &BINARY];
const LEVEL_MAX_CARRIERS: [&Carrier; 2] = [&BINARY, &INT32];
const COMPARE_CARRIERS: [&Carrier; 3] = [&LONG, &DATE, &TIMESTAMP];
// The digest prints these five. Long, date, and timestamp stay out of it.
const DIGEST_CARRIERS: &[&str] = &["int32", "double", "decimal128", "string", "binary"];

const _: () = {
    let mut i = 0;
    while i < DIGEST_CARRIERS.len() {
        let name = DIGEST_CARRIERS[i];
        let mut found = false;
        let mut j = 0;
        while j < CARRIER_TABLE.len() {
            if str_eq(CARRIER_TABLE[j].name, name) {
                found = true;
            }
            j += 1;
        }
        if !found {
            panic!("digest carrier");
        }
        i += 1;
    }
};

const fn str_eq(left: &str, right: &str) -> bool {
    let left = left.as_bytes();
    let right = right.as_bytes();
    if left.len() != right.len() {
        return false;
    }
    let mut i = 0;
    while i < left.len() {
        if left[i] != right[i] {
            return false;
        }
        i += 1;
    }
    true
}

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
    carriers: &'static [&'static Carrier],
    patterns: &'static [u8],
    zlib: &'static [i32],
    zstd: &'static [i32],
    sizes: &'static [usize],
    about: &'static str,
}

const SLICES: [Slice; 6] = [
    Slice {
        tag: "length",
        carriers: &CHART_CARRIERS,
        patterns: &PATTERNS_LENGTH,
        zlib: &ZLIB_LENGTH,
        zstd: &ZSTD_LENGTH,
        sizes: &LENGTH_SIZES,
        about: "2^0 through 2^23 plus 16777216; seven carriers; patterns 1, 5, 10; zlib -1,0,1,6,9; zstd 1,3,9; snappy",
    },
    Slice {
        tag: "level64",
        carriers: &CHART_CARRIERS,
        patterns: &PATTERNS_ALL,
        zlib: &ZLIB_ALL,
        zstd: &ZSTD_LEVEL64,
        sizes: &LEVEL64_SIZES,
        about: "65536; seven carriers; patterns 1-10; zlib -1 and 0-9; zstd -1 and 1-22; snappy",
    },
    Slice {
        tag: "oneMiB",
        carriers: &CHART_CARRIERS,
        patterns: &PATTERNS_ALL,
        zlib: &ZLIB_ALL,
        zstd: &ZSTD_LENGTH,
        sizes: &ONE_MIB_SIZES,
        about: "1048576; seven carriers; patterns 1-10; zlib -1 and 0-9; zstd 1,3,9; snappy",
    },
    Slice {
        tag: "levelMax",
        carriers: &LEVEL_MAX_CARRIERS,
        patterns: &PATTERNS_LEVEL_MAX,
        zlib: &ZLIB_ALL,
        zstd: &ZSTD_LEVEL_MAX,
        sizes: &LEVEL_MAX_SIZES,
        about: "16777216; binary and int32; patterns 1 and 10; zlib -1 and 0-9; zstd -1,1,3,6,9,19,22; snappy",
    },
    // Patterns the length charts skip. The chart reads patterns 1, 5, and 10 from length.
    Slice {
        tag: "surface",
        carriers: &CHART_CARRIERS,
        patterns: &PATTERNS_SURFACE,
        zlib: &ZLIB_CHART,
        zstd: &ZSTD_CHART,
        sizes: &LENGTH_SIZES,
        about: "2^0 through 2^23 plus 16777216; seven carriers; patterns 2, 3, 4, 6, 7, 8, 9; zlib 6; zstd 3; snappy",
    },
    Slice {
        tag: "compare",
        carriers: &COMPARE_CARRIERS,
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
    let slice_filter = name_env("COMPRESSOR_SLICES");
    let carrier_filter = name_env("COMPRESSOR_CARRIERS");
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
        for carrier in slice.carriers {
            if !carrier_filter.is_empty() && !carrier_filter.iter().any(|name| name == carrier.name) {
                continue;
            }
            for &pattern in slice.patterns {
                if !pattern_filter.is_empty() && !pattern_filter.contains(&pattern) {
                    continue;
                }
                for &target in slice.sizes {
                    points.extend(measure(slice.tag, carrier.name, pattern, target, slice.zlib, &zstd_levels, &mut random));
                }
                eprintln!("{} {} pattern {pattern} {}ms", slice.tag, carrier.name, started.elapsed().as_millis());
            }
        }
    }

    let guard = guard_trip();
    let meta = meta_json(guard, points.len(), *range.start(), *range.end());
    let mut args = std::env::args().skip(1);
    let grid_path = args.next().unwrap_or_else(|| "/tmp/compressor-grid.json".to_string());
    let digest_path = args.next().unwrap_or_else(|| "/tmp/compressor-digest.txt".to_string());
    write_grid(&grid_path, &meta, &points);
    if slice_filter.is_empty() && carrier_filter.is_empty() && pattern_filter.is_empty() && zstd_override.is_empty() {
        write_digest(&digest_path, &points);
    }
    eprintln!("done {} points in {:.1}s guard={}", points.len(), started.elapsed().as_secs_f64(), guard);
}

fn name_env(key: &str) -> Vec<String> {
    let names: Vec<String> = parse_env(key);
    require_known(key, &names);
    names
}

fn require_known(key: &str, names: &[String]) {
    for name in names {
        let known = match key {
            "COMPRESSOR_SLICES" => SLICES.iter().any(|slice| slice.tag == name),
            "COMPRESSOR_CARRIERS" => CARRIER_TABLE.iter().any(|carrier| carrier.name == name),
            _ => false,
        };
        if !known {
            panic!("{key}: unknown {name}");
        }
    }
}

fn parse_env<T: FromStr>(key: &str) -> Vec<T> {
    std::env::var(key).ok().map(|raw| parse_tokens(key, &raw)).unwrap_or_default()
}

fn parse_tokens<T: FromStr>(key: &str, raw: &str) -> Vec<T> {
    raw.split(',').map(|token| token.trim()).filter(|token| !token.is_empty()).map(|token| {
        token.parse().unwrap_or_else(|_| panic!("{key}: bad token {token}"))
    }).collect()
}

fn meta_json(guard: usize, count: usize, zstd_min: i32, zstd_max: i32) -> String {
    let meta = json!({
        "compressor": "rust",
        "rustc": "1.99.1",
        "libraries": {
            "snappy": "snap 1.1.2 raw, same framing as snappy::RawCompress and the Rust driver",
            "zlib": "flate2 1.1.11 default backend (miniz_oxide), zlib wrapper, same call the Rust driver makes",
            "zstd": "zstd 0.14.4"
        },
        "zstdDefault": zstd::DEFAULT_COMPRESSION_LEVEL,
        "zstdLevelRange": [zstd_min, zstd_max],
        "ratio": "originalWire / framedWire. Higher is tighter. none is 1.",
        "originalWire": "16-byte MsgHeader + body",
        "framedWire": "16-byte MsgHeader + 9-byte OP_COMPRESSED details + compressed body",
        "body": "4 flag bytes, kind byte 0, and a BSON {ping:1, p:<payload>} document. A target below a legal document is a raw buffer (shape raw).",
        "maxMessage": MAX_MESSAGE,
        "guardTripsAtBody": guard,
        "slices": null,
        "count": count
    });
    let mut text = serde_json::to_string_pretty(&meta).unwrap();
    let needle = "\"slices\": null";
    let found = text.find(needle).expect("slices");
    text.replace_range(found..found + needle.len(), &format!("\"slices\": {}", slice_meta_json()));
    text
}

fn slice_meta_json() -> String {
    let mut out = String::from("{\n");
    for (i, tag) in SLICE_META_ORDER.iter().enumerate() {
        let slice = SLICES.iter().find(|slice| slice.tag == *tag).unwrap_or_else(|| panic!("missing slice {tag}"));
        let value = serde_json::to_string(slice.about).unwrap();
        out.push_str("    \"");
        out.push_str(tag);
        out.push_str("\": ");
        out.push_str(&value);
        if i + 1 != SLICE_META_ORDER.len() {
            out.push(',');
        }
        out.push('\n');
    }
    out.push_str("  }");
    out
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
    let built = payload(target, carrier, pattern, random);
    let build_ms = tb.elapsed().as_millis();
    let bits = round_n(entropy_bits(built.bits_src()), 3);
    let original = HEADER + built.body().len();
    let shape = built.shape();
    let doc = built.doc_len();
    push_point(&mut points, slice, carrier, pattern, shape, target, doc, built.body(), bits, original, "none", None, built.body().len(), 0);
    let tz = Instant::now();
    for level in zlib {
        let compressed = zlib_compress(built.body(), *level);
        push_point(&mut points, slice, carrier, pattern, shape, target, doc, built.body(), bits, original, "zlib", Some(*level), compressed.len(), DETAILS);
    }
    let zlib_ms = tz.elapsed().as_millis();
    let ts = Instant::now();
    for level in zstd {
        let compressed = zstd::bulk::compress(built.body(), *level).unwrap_or_else(|err| {
            panic!("zstd {level} on {} bytes: {err}", built.body().len());
        });
        push_point(&mut points, slice, carrier, pattern, shape, target, doc, built.body(), bits, original, "zstd", Some(*level), compressed.len(), DETAILS);
    }
    let zstd_ms = ts.elapsed().as_millis();
    let compressed = SnappyEncoder::new().compress_vec(built.body()).expect("snappy");
    push_point(&mut points, slice, carrier, pattern, shape, target, doc, built.body(), bits, original, "snappy", None, compressed.len(), DETAILS);
    if target >= MIB {
        eprintln!("  {carrier} p{pattern} {target} build {build_ms}ms zlib {zlib_ms}ms zstd {zstd_ms}ms body {}", built.body().len());
    }
    points
}

fn push_point(points: &mut Vec<Point>, slice: &'static str, carrier: &'static str, pattern: u8, shape: &'static str, target: usize, doc: Option<usize>, body: &[u8], bits: f64, original: usize, compressor: &'static str, level: Option<i32>, compressed_len: usize, details: usize) {
    let wire = HEADER + details + compressed_len;
    let raw_ratio = round_n(body.len() as f64 / compressed_len as f64, 6);
    let wire_ratio = round_n(original as f64 / wire as f64, 6);
    points.push(Point {
        slice, carrier, pattern, shape, target, doc, body: body.len(), bits,
        compressor, level, compressed: compressed_len, raw_ratio, wire, wire_ratio,
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

enum Payload {
    Document { doc: Vec<u8>, body: Vec<u8> },
    Raw { body: Vec<u8> },
}

impl Payload {
    fn shape(&self) -> &'static str {
        match self {
            Payload::Document { .. } => "document",
            Payload::Raw { .. } => "raw",
        }
    }

    fn doc_len(&self) -> Option<usize> {
        match self {
            Payload::Document { doc, .. } => Some(doc.len()),
            Payload::Raw { .. } => None,
        }
    }

    fn body(&self) -> &[u8] {
        match self {
            Payload::Document { body, .. } | Payload::Raw { body } => body,
        }
    }

    fn bits_src(&self) -> &[u8] {
        match self {
            Payload::Document { body, .. } => &body[5..],
            Payload::Raw { body } => body,
        }
    }
}

fn payload(target: usize, name: &str, pattern: u8, random: &mut dyn Read) -> Payload {
    if let Some(doc) = build_doc(target, name, pattern, random) {
        let body = wrap_doc(&doc);
        return Payload::Document { doc, body };
    }
    let mut body = vec![0u8; target];
    let crypto = if pattern == 10 {
        let mut bytes = vec![0u8; target];
        random.read_exact(&mut bytes).expect("urandom read");
        bytes
    } else {
        Vec::new()
    };
    fill_payload(&mut body, 0, target, pattern, &mut xorshift(0xB0D + pattern as u32), &crypto);
    Payload::Raw { body }
}

fn wrap_doc(doc: &[u8]) -> Vec<u8> {
    let mut body = vec![0u8; 5 + doc.len()];
    body[4] = 0;
    body[5..].copy_from_slice(doc);
    body
}

struct Crypto<'a> {
    random: &'a mut dyn Read,
    buf: Vec<u8>,
    at: usize,
}

impl<'a> Crypto<'a> {
    fn open(random: &'a mut dyn Read, pattern: u8, window: usize) -> Self {
        let mut buf = Vec::new();
        if pattern == 10 {
            buf = vec![0u8; window];
            random.read_exact(&mut buf).expect("urandom read");
        }
        Self { random, buf, at: 0 }
    }

    fn take(&mut self, need: usize) -> &[u8] {
        if self.at + need > self.buf.len() {
            self.random.read_exact(&mut self.buf).expect("urandom");
            self.at = 0;
        }
        let start = self.at;
        self.at += need;
        &self.buf[start..self.at]
    }
}

fn carrier(name: &str) -> &'static Carrier {
    CARRIER_TABLE.iter().copied().find(|carrier| carrier.name == name).unwrap_or_else(|| panic!("unknown carrier {name}"))
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
    let mut crypto = Crypto::open(random, pattern, width * 64);
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
        // Pattern 10 copies width raw bytes. The seeded ladders are not called.
        if pattern == 10 {
            let drawn = crypto.take(width);
            buf[p..p + width].copy_from_slice(drawn);
        } else {
            match kind {
                Kind::Int32 => {
                    let value = int_value(i, pattern, &mut rand);
                    buf[p..p + 4].copy_from_slice(&value.to_le_bytes());
                }
                Kind::Double => {
                    let n = double_value(i, pattern, &mut rand);
                    buf[p..p + 8].copy_from_slice(&n.to_le_bytes());
                }
                Kind::Long => {
                    let n = long_value(i, pattern, &mut rand);
                    buf[p..p + 8].copy_from_slice(&n.to_le_bytes());
                }
                Kind::Timestamp => {
                    let (inc, sec) = timestamp_value(i, pattern, &mut rand);
                    buf[p..p + 4].copy_from_slice(&inc.to_le_bytes());
                    buf[p + 4..p + 8].copy_from_slice(&sec.to_le_bytes());
                }
                Kind::Decimal => {
                    buf[p..p + 16].fill(0);
                    write_decimal(i, pattern, &mut rand, &mut buf[p..p + 16]);
                }
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

// Pattern 10 copies raw bytes in the array builder and does not call these ladders.
fn int_value(i: usize, pattern: u8, rand: &mut impl FnMut() -> u32) -> i32 {
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
        _ => panic!("pattern {pattern}"),
    }
}

fn long_value(i: usize, pattern: u8, rand: &mut impl FnMut() -> u32) -> i64 {
    // The same ladder as int32, widened. Values fit in 32 bits, so the high four bytes stay zero.
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

fn timestamp_value(i: usize, pattern: u8, rand: &mut impl FnMut() -> u32) -> (u32, u32) {
    // BSON timestamp is a uint32 increment and a uint32 seconds, not one int64.
    let low = long_value(i, pattern, rand) as u32;
    (low, low)
}

fn double_value(i: usize, pattern: u8, rand: &mut impl FnMut() -> u32) -> f64 {
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

fn write_decimal(i: usize, pattern: u8, rand: &mut impl FnMut() -> u32, slot: &mut [u8]) {
    if pattern == 1 { return; }
    if pattern > 9 { panic!("pattern {pattern}"); }
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

fn write_grid(path: &str, meta: &str, points: &[Point]) {
    let mut file = File::create(path).expect("grid");
    write!(file, "{{\n  \"meta\": {meta}").unwrap();
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

fn expanding_target(map: &HashMap<RowKey<'_>, &Point>, slice: &str, carrier: &str, pattern: u8, compressor: &str, level: Option<i32>) -> usize {
    map.values().filter(|point| {
        point.slice == slice && point.carrier == carrier && point.pattern == pattern && point.compressor == compressor && point.level == level && point.expands
    }).map(|point| point.target).max().unwrap_or(0)
}

fn digest_text(points: &[Point]) -> String {
    let map = point_index(points);
    let mut out = String::new();
    out.push_str(&length_section(&map));
    out.push_str(&zstd_section(&map));
    out.push_str(&one_mib_section(&map));
    out.push_str(&level64_section(&map));
    out.push_str(&level_max_section(&map));
    out.push_str(&pairs_section(&map));
    let tiny = lookup(&map, "length", "int32", 1, "zlib", Some(6), 1);
    out.push_str(&format!("TINY zlib6 body {} wire {} ratio {} expands {}\n", tiny.body, tiny.wire, tiny.wire_ratio, tiny.expands));
    out
}

fn length_section(map: &HashMap<RowKey<'_>, &Point>) -> String {
    let mut out = String::from("LENGTH zlib6 zstd3 snappy\n");
    for &carrier in DIGEST_CARRIERS {
        for pattern in [1u8, 5, 10] {
            out.push_str(&length_line(map, carrier, pattern));
        }
    }
    out
}

fn length_line(map: &HashMap<RowKey<'_>, &Point>, carrier: &str, pattern: u8) -> String {
    let last = |comp, level| expanding_target(map, "length", carrier, pattern, comp, level);
    let cell = |comp, level, target| lookup(map, "length", carrier, pattern, comp, level, target).wire_ratio;
    let bits = lookup(map, "length", carrier, pattern, "zlib", Some(6), KIB_64).bits;
    format!("{carrier}\t{pattern}\t{bits}\tzlib {}\tzstd {}\tsnappy {}\tz6 {} {} {}\tz3 {} {} {}\tsn {} {} {}\n",
        last("zlib", Some(6)),
        last("zstd", Some(3)),
        last("snappy", None),
        cell("zlib", Some(6), KIB_64), cell("zlib", Some(6), MIB), cell("zlib", Some(6), BSON_MAX),
        cell("zstd", Some(3), KIB_64), cell("zstd", Some(3), MIB), cell("zstd", Some(3), BSON_MAX),
        cell("snappy", None, KIB_64), cell("snappy", None, MIB), cell("snappy", None, BSON_MAX))
}

fn zstd_section(map: &HashMap<RowKey<'_>, &Point>) -> String {
    let mut out = String::from("ZSTD1V3\n");
    for &carrier in DIGEST_CARRIERS {
        let c = |level, target| lookup(map, "length", carrier, 1, "zstd", Some(level), target).wire_ratio;
        out.push_str(&format!("{carrier}\t{}\t{}\t{}\t{}\t{}\n", c(1, MIB), c(3, MIB), c(1, BSON_MAX), c(3, BSON_MAX), c(9, BSON_MAX)));
    }
    out
}

fn one_mib_section(map: &HashMap<RowKey<'_>, &Point>) -> String {
    let mut out = String::from("ONE_MIB\n");
    for pattern in 1u8..=10 {
        let mut line = format!("p{pattern}");
        for &carrier in DIGEST_CARRIERS {
            for (comp, level) in [("zlib", Some(6)), ("zstd", Some(3)), ("snappy", None)] {
                let p = lookup(map, "oneMiB", carrier, pattern, comp, level, MIB);
                line.push_str(&format!("\t{carrier}:{comp}:{}:{}", p.bits, p.wire_ratio));
            }
        }
        out.push('\n');
        out.push_str(&line);
    }
    out.push('\n');
    out
}

fn level64_section(map: &HashMap<RowKey<'_>, &Point>) -> String {
    let mut out = String::from("LEVEL64 int32 pattern 1 zstd\n");
    for level in ZSTD_LEVEL64 {
        let p = lookup(map, "level64", "int32", 1, "zstd", Some(level), KIB_64);
        out.push_str(&format!("{}:{}\n", p.level.unwrap(), p.wire_ratio));
    }
    out
}

fn level_max_section(map: &HashMap<RowKey<'_>, &Point>) -> String {
    let mut out = String::from("LEVELMAX\n");
    for carrier in ["int32", "binary"] {
        for pattern in [1u8, 10] {
            for level in ZLIB_ALL {
                out.push_str(&level_max_line(lookup(map, "levelMax", carrier, pattern, "zlib", Some(level), BSON_MAX)));
            }
            for level in ZSTD_LEVEL_MAX {
                out.push_str(&level_max_line(lookup(map, "levelMax", carrier, pattern, "zstd", Some(level), BSON_MAX)));
            }
            out.push_str(&level_max_line(lookup(map, "levelMax", carrier, pattern, "snappy", None, BSON_MAX)));
        }
    }
    out
}

fn level_max_line(point: &Point) -> String {
    format!("{} p{} {} {:?} {} extra {}\n", point.carrier, point.pattern, point.compressor, point.level, point.wire_ratio, point.wire as isize - (HEADER + point.body) as isize)
}

fn pairs_section(map: &HashMap<RowKey<'_>, &Point>) -> String {
    let mut z_pairs = 0usize;
    let mut z_mis = 0usize;
    let mut s_pairs = 0usize;
    let mut s_mis = 0usize;
    for point in map.values().filter(|point| point.compressor == "zlib" && point.level == Some(-1)) {
        let other = lookup(map, point.slice, point.carrier, point.pattern, "zlib", Some(6), point.target);
        z_pairs += 1;
        if other.compressed != point.compressed { z_mis += 1; }
    }
    for point in map.values().filter(|point| point.compressor == "zstd" && point.level == Some(-1)) {
        if let Some(other) = map.get(&(point.slice, point.carrier, point.pattern, "zstd", Some(3), point.target)) {
            s_pairs += 1;
            if other.compressed != point.compressed { s_mis += 1; }
        }
    }
    format!("PAIRS zlib -1 vs 6 {z_pairs} mismatches {z_mis}\nPAIRS zstd -1 vs 3 {s_pairs} mismatches {s_mis}\n")
}

fn write_digest(path: &str, points: &[Point]) {
    std::fs::write(path, digest_text(points)).unwrap();
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

    struct Script {
        data: Vec<u8>,
        at: usize,
    }

    impl Read for Script {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            let n = buf.len().min(self.data.len() - self.at);
            if n == 0 { return Ok(0); }
            buf[..n].copy_from_slice(&self.data[self.at..self.at + n]);
            self.at += n;
            Ok(n)
        }
    }

    fn doc(target: usize, name: &str, pattern: u8) -> Vec<u8> {
        let mut random = PanicRead;
        build_doc(target, name, pattern, &mut random).unwrap()
    }

    fn carrier_names<'a>(carriers: &'a [&'a Carrier]) -> Vec<&'a str> {
        carriers.iter().map(|carrier| carrier.name).collect()
    }

    fn sample(slice: &'static str, carrier: &'static str, pattern: u8, compressor: &'static str, level: Option<i32>, target: usize, bits: f64, wire_ratio: f64, expands: bool) -> Point {
        Point {
            slice, carrier, pattern, shape: "document", target, doc: Some(target),
            body: 10, bits, compressor, level, compressed: 4, raw_ratio: wire_ratio,
            wire: 40, wire_ratio, expands,
        }
    }

    fn panic_text(err: Box<dyn std::any::Any + Send>) -> String {
        if let Some(text) = err.downcast_ref::<String>() { return text.clone(); }
        if let Some(text) = err.downcast_ref::<&str>() { return (*text).to_string(); }
        String::new()
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
    fn pattern_10_copies_width_bytes() {
        let mut data = vec![0u8; 4096];
        data[..16].copy_from_slice(&[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
        let mut random = Script { data: data.clone(), at: 0 };
        let int32 = build_doc(64, "int32", 10, &mut random).unwrap();
        assert!(int32.windows(4).any(|bytes| bytes == [1, 2, 3, 4]));
        let mut random = Script { data: data.clone(), at: 0 };
        let decimal = build_doc(128, "decimal128", 10, &mut random).unwrap();
        assert!(decimal.windows(16).any(|bytes| bytes == &data[..16]));
    }

    #[test]
    fn crypto_refill_rereads_the_window() {
        let mut random = Script { data: vec![1, 1, 1, 1, 2, 2, 2, 2], at: 0 };
        let mut crypto = Crypto::open(&mut random, 10, 4);
        assert_eq!(crypto.take(4), &[1, 1, 1, 1]);
        assert_eq!(crypto.take(4), &[2, 2, 2, 2]);
    }

    #[test]
    fn string_pattern_10_stays_printable() {
        let source = [0u8, 1, 2, 200, 94, 95, 96, 10, 31];
        let mut random = Script { data: source.to_vec(), at: 0 };
        let doc = build_doc(32, "string", 10, &mut random).unwrap();
        let content = &doc[21..30];
        for (got, src) in content.iter().zip(source) {
            assert_eq!(*got, 32 + (src % 95));
        }
    }

    #[test]
    fn slice_table() {
        let tags: Vec<_> = SLICES.iter().map(|slice| slice.tag).collect();
        assert_eq!(tags, ["length", "level64", "oneMiB", "levelMax", "surface", "compare"]);
        assert_eq!(PATTERNS_SURFACE, [2, 3, 4, 6, 7, 8, 9]);
        let length = SLICES.iter().find(|slice| slice.tag == "length").unwrap();
        let surface = SLICES.iter().find(|slice| slice.tag == "surface").unwrap();
        let compare = SLICES.iter().find(|slice| slice.tag == "compare").unwrap();
        assert_eq!(length.sizes, surface.sizes);
        assert_eq!(length.sizes.len(), 25);
        assert_eq!(length.sizes[0], 1);
        assert_eq!(*length.sizes.last().unwrap(), BSON_MAX);
        assert_eq!(length.patterns, &[1, 5, 10]);
        assert_eq!(carrier_names(length.carriers), ["int32", "double", "long", "date", "decimal128", "string", "binary"]);
        assert_eq!(carrier_names(compare.carriers), ["long", "date", "timestamp"]);
        let level_max = SLICES.iter().find(|slice| slice.tag == "levelMax").unwrap();
        assert_eq!(level_max.zstd, &[-1, 1, 3, 6, 9, 19, 22]);
        assert_eq!(carrier_names(level_max.carriers), ["binary", "int32"]);
        assert_eq!(level_max.patterns, &[1, 10]);
        assert_eq!(level_max.sizes, &[BSON_MAX]);
        for name in DIGEST_CARRIERS {
            assert!(CARRIER_TABLE.iter().any(|carrier| carrier.name == *name));
        }
        let text = slice_meta_json();
        let mut at = 0;
        for tag in SLICE_META_ORDER {
            let key = format!("\"{tag}\"");
            let found = text[at..].find(&key).unwrap();
            at += found + key.len();
        }
        assert!(text.contains("\"levelMax\": \"16777216; binary and int32; patterns 1 and 10; zlib -1 and 0-9; zstd -1,1,3,6,9,19,22; snappy\""));
        assert!(text.contains("\"surface\": \"2^0 through 2^23 plus 16777216; seven carriers; patterns 2, 3, 4, 6, 7, 8, 9; zlib 6; zstd 3; snappy\""));
        let mut slices = serde_json::Map::new();
        for tag in SLICE_META_ORDER {
            let about = SLICES.iter().find(|slice| slice.tag == tag).unwrap().about;
            slices.insert(tag.to_string(), Value::String(about.to_string()));
        }
        let expected = json!({
            "compressor": "rust",
            "rustc": "1.99.1",
            "libraries": {
                "snappy": "snap 1.1.2 raw, same framing as snappy::RawCompress and the Rust driver",
                "zlib": "flate2 1.1.11 default backend (miniz_oxide), zlib wrapper, same call the Rust driver makes",
                "zstd": "zstd 0.14.4"
            },
            "zstdDefault": zstd::DEFAULT_COMPRESSION_LEVEL,
            "zstdLevelRange": [1, 22],
            "ratio": "originalWire / framedWire. Higher is tighter. none is 1.",
            "originalWire": "16-byte MsgHeader + body",
            "framedWire": "16-byte MsgHeader + 9-byte OP_COMPRESSED details + compressed body",
            "body": "4 flag bytes, kind byte 0, and a BSON {ping:1, p:<payload>} document. A target below a legal document is a raw buffer (shape raw).",
            "maxMessage": MAX_MESSAGE,
            "guardTripsAtBody": 7,
            "slices": slices,
            "count": 3
        });
        assert_eq!(meta_json(7, 3, 1, 22), serde_json::to_string_pretty(&expected).unwrap());
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
        assert_eq!(none.shape, "document");
        assert_eq!(none.wire_ratio, 1.0);
        assert_eq!(none.raw_ratio, 1.0);
        assert!(!none.expands);
        assert_eq!(none.doc, Some(30));
        assert_eq!(none.compressed, none.body);
        assert_eq!(none.wire, HEADER + none.body);
        let zlib = &points[1];
        assert_eq!(zlib.wire, HEADER + DETAILS + zlib.compressed);
        let map = point_index(&points);
        assert_eq!(lookup(&map, "length", "int32", 1, "none", None, 32).doc, Some(30));
        assert!(map.get(&("length", "int32", 1, "zstd", Some(9), 32)).is_none());
    }

    #[test]
    fn raw_target_has_no_document() {
        let mut random = PanicRead;
        let points = measure("length", "int32", 1, 1, &[6], &[3], &mut random);
        assert_eq!(points[0].shape, "raw");
        assert_eq!(points[0].doc, None);
        assert_eq!(points[0].body, 1);
        assert_eq!(points[0].bits, 0.0);
        assert_eq!(points[0].wire_ratio, 1.0);
    }

    #[test]
    fn parsed_tokens() {
        assert_eq!(parse_tokens::<i32>("COMPRESSOR_ZSTD", "-1, 3"), vec![-1, 3]);
        assert_eq!(parse_tokens::<u8>("COMPRESSOR_PATTERNS", "1,10"), vec![1, 10]);
        let caught = std::panic::catch_unwind(|| parse_tokens::<i32>("COMPRESSOR_ZSTD", "3,no"));
        assert!(caught.is_err());
    }

    #[test]
    fn unknown_filter_names() {
        require_known("COMPRESSOR_SLICES", &["length".into(), "compare".into()]);
        require_known("COMPRESSOR_CARRIERS", &["timestamp".into()]);
        let err = std::panic::catch_unwind(|| require_known("COMPRESSOR_SLICES", &["lenght".into()])).unwrap_err();
        assert_eq!(panic_text(err), "COMPRESSOR_SLICES: unknown lenght");
        let err = std::panic::catch_unwind(|| require_known("COMPRESSOR_CARRIERS", &["int3".into()])).unwrap_err();
        assert_eq!(panic_text(err), "COMPRESSOR_CARRIERS: unknown int3");
    }

    #[test]
    fn digest_lines_come_from_the_index() {
        let mut points = Vec::new();
        for (level, ratio, expands) in [(Some(6), 1.5, true), (Some(6), 2.5, false), (Some(6), 3.5, false)] {
            let target = [KIB_64, MIB, BSON_MAX][points.len()];
            points.push(sample("length", "int32", 1, "zlib", level, target, 2.5, ratio, expands));
        }
        for (ratio, expands) in [(4.5, false), (5.5, true), (6.5, false)] {
            let target = [KIB_64, MIB, BSON_MAX][points.len() - 3];
            points.push(sample("length", "int32", 1, "zstd", Some(3), target, 2.5, ratio, expands));
        }
        for ratio in [7.5, 8.5, 9.5] {
            let target = [KIB_64, MIB, BSON_MAX][points.len() - 6];
            points.push(sample("length", "int32", 1, "snappy", None, target, 2.5, ratio, false));
        }
        let map = point_index(&points);
        assert_eq!(
            length_line(&map, "int32", 1),
            "int32\t1\t2.5\tzlib 65536\tzstd 1048576\tsnappy 0\tz6 1.5 2.5 3.5\tz3 4.5 5.5 6.5\tsn 7.5 8.5 9.5\n"
        );
        assert_eq!(expanding_target(&map, "length", "int32", 1, "snappy", None), 0);

        let mut one = Vec::new();
        for pattern in 1u8..=10 {
            for carrier in DIGEST_CARRIERS {
                for (comp, level) in [("zlib", Some(6)), ("zstd", Some(3)), ("snappy", None)] {
                    one.push(sample("oneMiB", carrier, pattern, comp, level, MIB, 1.5, 2.5, false));
                }
            }
        }
        let text = one_mib_section(&point_index(&one));
        assert!(text.starts_with("ONE_MIB\n\np1\t"));
        assert!(text.contains("\tint32:zlib:1.5:2.5"));
        assert!(text.ends_with('\n'));

        let mut levels = Vec::new();
        for level in ZSTD_LEVEL64.into_iter().rev() {
            levels.push(sample("level64", "int32", 1, "zstd", Some(level), KIB_64, 1.0, level as f64, false));
        }
        let text = level64_section(&point_index(&levels));
        assert!(text.starts_with("LEVEL64 int32 pattern 1 zstd\n-1:-1\n1:1\n"));
        assert!(text.ends_with("22:22\n"));

        let mut maxes = Vec::new();
        for carrier in ["binary", "int32"] {
            for pattern in [10u8, 1] {
                maxes.push(sample("levelMax", carrier, pattern, "snappy", None, BSON_MAX, 1.0, 1.25, false));
                for level in ZSTD_LEVEL_MAX.into_iter().rev() {
                    maxes.push(sample("levelMax", carrier, pattern, "zstd", Some(level), BSON_MAX, 1.0, 1.25, false));
                }
                for level in ZLIB_ALL.into_iter().rev() {
                    maxes.push(sample("levelMax", carrier, pattern, "zlib", Some(level), BSON_MAX, 1.0, 1.25, false));
                }
            }
        }
        let text = level_max_section(&point_index(&maxes));
        assert!(text.starts_with("LEVELMAX\nint32 p1 zlib Some(-1) 1.25 extra 14\n"));
        assert!(text.contains("int32 p1 zstd Some(-1) 1.25 extra 14\n"));
        assert!(text.contains("int32 p1 snappy None 1.25 extra 14\n"));

        let mut pairs = vec![
            sample("length", "int32", 1, "zlib", Some(-1), 32, 1.0, 1.0, false),
            sample("length", "int32", 1, "zlib", Some(6), 32, 1.0, 1.0, false),
            sample("length", "int32", 1, "zstd", Some(-1), 32, 1.0, 1.0, false),
            sample("length", "double", 1, "zstd", Some(-1), 32, 1.0, 1.0, false),
            sample("length", "double", 1, "zstd", Some(3), 32, 1.0, 1.0, false),
        ];
        pairs[0].compressed = 4;
        pairs[1].compressed = 4;
        pairs[2].compressed = 9;
        pairs[3].compressed = 8;
        pairs[4].compressed = 3;
        assert_eq!(pairs_section(&point_index(&pairs)), "PAIRS zlib -1 vs 6 1 mismatches 0\nPAIRS zstd -1 vs 3 1 mismatches 1\n");
    }
}
