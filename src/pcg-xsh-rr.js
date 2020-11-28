var UINT64 = function(a, b, c, d) {
    var a48, a32, a16, a00;
    var _mask = {
        1: 0x0001,
        2: 0x0003,
        3: 0x0007,
        4: 0x000f,
        5: 0x001f,
        6: 0x003f,
        7: 0x007f,
        8: 0x00ff,
        9: 0x01ff,
        10: 0x03ff,
        11: 0x07ff,
        12: 0x0fff,
        13: 0x1fff,
        14: 0x3fff,
        15: 0x7fff,
        16: 0xffff,
        32: 0xffffffff
    };
  
    if (typeof c === 'undefined') {
        a48 = (a >> 16) & _mask[16];
        a32 = a & _mask[16];
        a16 = (b >> 16) & _mask[16];
        a00 = b & _mask[16];
    }
    else {
        a48 = a;
        a32 = b;
        a16 = c;
        a00 = d;
    }
  
    function rshift(n) {
        n = +n;

        if (n <= 0)   return UINT64(a48, a32, a16, a00);
        if (n >= 64)  return UINT64(0, 0, 0, 0);
        if (n === 16) return UINT64(0, a48, a32, a16);
        if (n === 32) return UINT64(0, 0, a48, a32);
        if (n === 48) return UINT64(0, 0, 0, a48);

        var _n = n % 16;
        var a = a48 >> _n;
        var b = ((a48 & _mask[_n]) << (16 - _n)) | (a32 >> _n);
        var c = ((a32 & _mask[_n]) << (16 - _n)) | (a16 >> _n);
        var d = ((a16 & _mask[_n]) << (16 - _n)) | (a00 >> _n);

        a = a & _mask[16];
        b = b & _mask[16];
        c = c & _mask[16];
        d = d & _mask[16];

        if (n < 16)      return UINT64(a, b, c, d);
        else if (n < 32) return UINT64(0, a, b, c);
        else if (n < 48) return UINT64(0, 0, a, b);
        else             return UINT64(0, 0, 0, a);
    }
  
    function lshift(n) {
        n = +n;

        if(n <= 0)   return UINT64(a48, a32, a16, a00);
        if(n >= 64)  return UINT64(0, 0, 0, 0);
        if(n === 16) return UINT64(a32, a16, a00, 0);
        if(n === 32) return UINT64(a16, a00, 0, 0);
        if(n === 48) return UINT64(a00, 0, 0, 0);

        var _n = n % 16;
        var a = (a48 << _n) | (a32 >> (16 - _n));
        var b = (a32 << _n) | (a16 >> (16 - _n));
        var c = (a16 << _n) | (a00 >> (16 - _n));
        var d = a00 << _n;

        a = a & _mask[16];
        b = b & _mask[16];
        c = c & _mask[16];
        d = d & _mask[16];

        if(n < 16)      return UINT64(a, b, c, d);
        else if(n < 32) return UINT64(b, c, d, 0);
        else if(n < 48) return UINT64(c, d, 0, 0);
        else            return UINT64(d, 0, 0, 0);
    }
  
    function or(other) {
        return UINT64(
            a48 | other._a48,
            a32 | other._a32,
            a16 | other._a16,
            a00 | other._a00
        );
    }
  
    function xor(other) {
        return UINT64(
            a48 ^ other._a48,
            a32 ^ other._a32,
            a16 ^ other._a16,
            a00 ^ other._a00
        );
    }
  
    function and(other) {
        return UINT64(
            a48 & other._a48,
            a32 & other._a32,
            a16 & other._a16,
            a00 & other._a00
        );
    }
  
    function mul(other) {
        var b00 = other._a00;
        var b16 = other._a16;
        var b32 = other._a32;
        var b48 = other._a48;

        var c00 = a00 * b00

        var c16 = c00 >> 16;
        c16 += a00 * b16;
        var c32 = c16 >> 16;
        c16 &= _mask[16];
        c16 += a16 * b00;

        c32 += c16 >> 16;
        c32 += a00 * b32;
        var c48 = c32 >> 16;
        c32 &= _mask[16];
        c32 += a16 * b16;
        c48 += c32 >> 16;
        c32 &= _mask[16];
        c32 += a32 * b00;

        c48 += c32 >> 16;
        c48 += a00 * b48;
        c48 &= _mask[16];
        c48 += a16 * b32;
        c48 &= _mask[16];
        c48 += a32 * b16;
        c48 &= _mask[16];
        c48 += a48 * b00;

        c00 = c00 & _mask[16];
        c16 = c16 & _mask[16];
        c32 = c32 & _mask[16];
        c48 = c48 & _mask[16];

        return UINT64(c48, c32, c16, c00);
    }
  
    function add(other) {
        var b00 = other._a00;
        var b16 = other._a16;
        var b32 = other._a32;
        var b48 = other._a48;

        var c00 = a00 + b00;
        var c16 = a16 + b16 + (c00 >> 16);
        var c32 = a32 + b32 + (c16 >> 16);
        var c48 = a48 + b48 + (c32 >> 16);

        c00 = c00 & _mask[16];
        c16 = c16 & _mask[16];
        c32 = c32 & _mask[16];
        c48 = c48 & _mask[16];

        return UINT64(c48, c32, c16, c00);
    }
  
    function hex() {
        if(a48 === 0 && a32 === 0 && a16 === 0 && a00 === 0) return '0';

        var o = a00.toString(16);
        while(o.length < 4) o = '0' + o;

        o = a16.toString(16) + o;
        while(o.length < 8) o = '0' + o;

        o = a32.toString(16) + o;
        while(o.length < 12) o = '0' + o;

        o = a48.toString(16) + o;
        while(o.length < 16) o = '0' + o;

        o = o.replace(/^0+/, '');

        return '0x' + o;
    }
  
    function bin() {
        if(a48 === 0 && a32 === 0 && a16 === 0 && a00 === 0) return '0';

        var o = a00.toString(2);
        while(o.length < 16) o = '0' + o;

        o = a16.toString(2) + o;
        while(o.length < 32) o = '0' + o;

        o = a32.toString(2) + o;
        while(o.length < 48) o = '0' + o;

        o = a48.toString(2) + o;
        while(o.length < 64) o = '0' + o;

        o = o.replace(/^0+/, '');

        return '0b' + o;
    }
  
    return {
        _a48: a48,
        _a32: a32,
        _a16: a16,
        _a00: a00,

        rshift: rshift,
        lshift: lshift,
        or: or,
        xor: xor,
        and: and,
        mul: mul,
        add: add,

        hex: hex,
        bin: bin
    };
};

var rng = function(state, inc) {
    var state = state | 0;
    var inc = inc | 0;
    return {
        state: state,
        inc: inc
    };
};

var _pcg32_global = rng(UINT64(0x853c49e6, 0x748fea9b), UINT64(0xda3e39cb, 0x94b95bdb));

function srandom_r(_rng, initstate, initseq) {
    if(typeof initstate === 'number') initstate = UINT64(Math.floor(initstate / 0xffffffff), initstate >> 32);
    if(typeof initseq === 'number') initseq = UINT64(Math.floor(initseq / 0xffffffff), initseq >> 32);
    _rng.state = UINT64(0, 0);
    _rng.inc = initseq.lshift(1).or(UINT64(0, 1));
    random_r(_rng);
    _rng.state = _rng.state.add(initstate);
    random_r(_rng);
}

function srandom(seed, seq) {
    srandom_r(_pcg32_global, seed, seq);
}

function random_r(_rng) {
    var oldstate = _rng.state;
    _rng.state = oldstate.mul(UINT64(0x5851f42d, 0x4c957f2d)).add(_rng.inc);
    var xorshifted = oldstate.rshift(18).xor(oldstate).rshift(27).and(UINT64(0, 0xffffffff));
    var rot = oldstate.rshift(59)._a00;
    var rot2 = (-rot) & 31;
    var result = xorshifted.rshift(rot).or(xorshifted.lshift(rot2)).and(UINT64(0, 0xffffffff));
    var result32 = parseInt(result.hex(), 16);
    return result32;
}

function random() {
    return random_r(_pcg32_global);
}

pcg32 = _pcg32_global;
pcg32.random = random;
pcg32.srandom = srandom;
pcg32.srandom_r = srandom_r;
pcg32.random_r = random_r;
pcg32.UINT64 = UINT64;
pcg32.rng = rng;

// EOF
