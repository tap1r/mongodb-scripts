/*
 *  Name: "fuzzer-lib.js"
 *  Description: document generators loaded by fuzzer.js after mdblib.js
 *  Disclaimer: "https://raw.githubusercontent.com/tap1r/mongodb-scripts/master/DISCLAIMER.md"
 *  Authors: ["tap1r <luke.prochazka@gmail.com>"]
 *  Roadmap: "https://raw.githubusercontent.com/tap1r/mongodb-scripts/master/ROADMAP.md" (required context)
 *
 *  fuzzer.js loads this file after mdblib.js on the same $MDBLIB /
 *  ~/.mongodb / . search. The $ names stay global so a schema "="
 *  expression can call them. This file is not a module.
 *  Distribution helpers stay in mdblib.js. Temperature converters stay
 *  in mdblib.js and read K from this file.
 */

if (typeof __fuzzerLib === 'undefined') (
   __fuzzerLib = {
      "name": "fuzzer-lib.js"
   });

if (typeof idiomas === 'undefined') (
   idiomas = ['none', 'da', 'nl', 'en', 'fi', 'fr', 'de', 'hu', 'it', 'nb', 'pt', 'ro', 'ru', 'es', 'sv', 'tr']
);

const K = 273.15;
const int32MinVal = -Math.pow(2, 31);
const int32MaxVal = Math.pow(2, 31) - 1;
const int64MinVal = -Math.pow(2, 63);
const int64MaxVal = Math.pow(2, 63) - 1;
const dec128MinVal = -10 * Math.pow(2, 110);
const dec128MaxVal = 10 * Math.pow(2, 110) - 1;

function $NumberLong(arg) {
   /*
    *  NumberLong() wrapper
    */
   return Long.fromNumber(arg);
}

function $NumberDecimal(arg) {
   /*
    *  NumberDecimal() wrapper
    */
   return Decimal128.fromString(arg.toString());
}

function $NumberInt(arg) {
   /*
    *  NumberInt() wrapper
    */
   return NumberInt(arg);
}

function $getRandRegex() {
   /*
    *  generate random regex
    */
   const regexes = [
      /[a-z]/,
      /[A-Z]/,
      /[0-9]/,
      /[a-z0-9]/,
      /[A-Z0-9]/,
      /[a-zA-Z0-9]/,
      /[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?/,
      /[0-9a-fA-F]{8}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{12}/
   ];

   return regexes[$getRandInt(0, regexes.length)];
}

function $getRandNum(min = 0, max = 1) {
   /*
    *  generate random number
    */
   return $rand() * (max - min) + min;
}

function $getRandExp(exponent = 0) {
   /*
    *  generate random exponential number
    */
   return $ceil($getRandNum(0, 9) * Math.pow(10, exponent));
}

function $getRandIntInc(min = 0, max = 1) {
   /*
    *  generate random integer inclusive of the maximum
    */
   min = $ceil(min);
   max = $floor(max);

   return $floor($rand() * (max - min + 1) + min);
}

function $getRandRatioInt(ratios = [1]) {
   /*
    *  generate ratioed random integer
    */
   const weightedIndex = [];
   ratios.forEach((ratio, idx) => {
      for (let i = 0; i < ratio; i++) {
         weightedIndex.push(idx);
      }
   });

   return weightedIndex[$floor($rand() * weightedIndex.length)];
}

function $genRandFrom(len, drawChar) {
   /*
    *  One byte per character, then one string. The old += loop kept every
    *  prefix alive until the function returned.
    */
   if (!(len > 0) || !Number.isFinite(len))
      return '';
   const count = Math.ceil(len);
   if (typeof Buffer !== 'undefined') {
      const buf = Buffer.allocUnsafe(count);
      for (let i = 0; i < count; i++)
         buf[i] = drawChar().charCodeAt(0) & 0xff;
      return buf.toString('latin1');
   }
   const chunk = 1 << 16;
   const parts = [];
   let left = count;
   while (left > 0) {
      const take = left > chunk ? chunk : left;
      const piece = new Array(take);
      for (let i = 0; i < take; i++)
         piece[i] = drawChar();
      parts.push(piece.join(''));
      left -= take;
   }
   return parts.join('');
}

function $genRandHex(len = 1) {
   /*
    *  generate random hexadecimal string
    */
   const chars = '0123456789abcdef';
   return $genRandFrom(len, () => chars.charAt($floor($rand() * 16)));
}

function $genRandStr(len = 1) {
   /*
    *  generate random alpha-numeric string
    */
   const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
   return $genRandFrom(len, () => chars.charAt($floor($rand() * chars.length)));
}

const phraseDet = ['the', 'a', 'one', 'some', 'each'];
const phraseAdj = ['quiet', 'small', 'red', 'cold', 'bright', 'narrow', 'empty', 'heavy'];
const phraseNoun = ['river', 'engine', 'garden', 'stone', 'window', 'market', 'bridge', 'forest', 'signal', 'harbor'];
const phraseVerb = ['holds', 'finds', 'opens', 'leaves', 'carries', 'watches', 'follows', 'marks'];
const phrasePrep = ['in', 'on', 'under', 'near', 'with', 'beside'];
const phraseWords = phraseDet.concat(phraseAdj, phraseNoun, phraseVerb, phrasePrep);

function $genRandWord(list) {
   /*
    *  pick one built-in word, or one entry from list
    */
   const words = (Array.isArray(list) && list.length > 0) ? list : phraseWords;
   return words[$getRandInt(0, words.length)];
}

function $genRandPhrase(sentences) {
   /*
    *  one to three English sentences for a text index
    *  an explicit count is capped at 8
    */
   const n = (sentences > 0 && Number.isFinite(+sentences))
      ? Math.min($floor(+sentences), 8)
      : $getRandIntInc(1, 3);
   const out = [];
   for (let i = 0; i < n; i++) {
      const sentence = ($getRandInt(0, 2) === 0)
         ? `${$genRandWord(phraseDet)} ${$genRandWord(phraseAdj)} ${$genRandWord(phraseNoun)} ${$genRandWord(phraseVerb)} ${$genRandWord(phraseDet)} ${$genRandWord(phraseNoun)}`
         : `${$genRandWord(phraseNoun)} ${$genRandWord(phraseVerb)} ${$genRandWord(phrasePrep)} ${$genRandWord(phraseDet)} ${$genRandWord(phraseAdj)} ${$genRandWord(phraseNoun)}`;
      out.push(sentence.charAt(0).toUpperCase() + sentence.slice(1) + '.');
   }
   return out.join(' ');
}

function $geoNum(n, lo, hi) {
   /*
    *  four decimal places, clamped into the GeoJSON range
    */
   let x = Math.round(n * 10000) / 10000;
   if (x < lo)
      x = lo;
   if (x > hi)
      x = hi;
   return x;
}

/*
 *  Coarse land mask for $genPoint("land") and $genPoint("ocean").
 *  Each ring stays on one side of the antimeridian. Antarctica is two
 *  rectangles. A listed city sits inside one ring. A port need not.
 *  "at" is a tested interior point used when land rejection gives up.
 */

const geoLand = [
   { // africa
      "at": [20, 5],
      "ring": [
         [-17, 21], [-16, 13], [-10, 6.5], [-5, 5], [-2.2, 4.6], [0.2, 5.15],
         [2.6, 6.05], [4.2, 5.9], [8.5, 4.2], [9.5, 1], [12, -6], [13, -12],
         [12, -18], [14, -26], [18, -34.5], [26, -33.5], [32.5, -29],
         [35.5, -22], [40, -15], [42, -12], [50.5, 10], [43, 11.5], [39, 15],
         [43, 22], [39, 22], [34, 28], [32.5, 31.5], [25, 32], [10, 33],
         [3, 37], [-2, 35.5], [-6, 35.5], [-10, 32], [-13, 27], [-17, 21]
      ]
   },
   { // europe
      "at": [10, 50],
      "ring": [
         [-9.5, 36.5], [-9.2, 42], [-10.5, 52], [-8, 55], [-6, 58.6],
         [-3, 59], [5, 62], [16, 69], [25, 71], [32, 70], [40, 68], [44, 60],
         [40, 47], [36, 45], [30.4, 41.4], [29, 40.85], [27, 40.5],
         [20, 39.5], [16, 41], [12, 42], [10, 44], [7.4, 43.15], [5, 43.05],
         [3.6, 43.45], [3, 43.3], [-1, 43.3], [-6, 43.3], [-9, 37],
         [-9.5, 36.5]
      ]
   },
   { // arabia
      "at": [45, 24],
      "ring": [
         [34.6, 28], [36.5, 31.5], [40, 32], [48, 30], [56.6, 26.4],
         [59.5, 22], [57, 17], [53, 16.5], [44, 12.6], [42.5, 16.5],
         [38, 24], [34.8, 27.5]
      ]
   },
   { // india
      "at": [78, 22],
      "ring": [
         [66.2, 25.2], [67.2, 23.5], [69, 22], [72.4, 19], [72.6, 16],
         [74, 12], [77, 8], [80.2, 8.5], [80.6, 13.2], [82, 16], [85, 20],
         [87.5, 21.5], [89, 22], [88.5, 26.5], [84, 27], [80, 31], [75, 32],
         [70, 30], [67, 28], [66.2, 25.2]
      ]
   },
   { // indochina
      "at": [102, 16],
      "ring": [
         [97.5, 8], [100, 6.5], [102, 8], [104.5, 10], [109.2, 13],
         [109.4, 21.4], [106.5, 23.2], [102, 22.5], [100, 20], [97.5, 16],
         [98, 10]
      ]
   },
   { // singapore
      "at": [103.85, 1.33],
      "ring": [
         [103.6, 1.2], [104.1, 1.2], [104.1, 1.48], [103.6, 1.48]
      ]
   },
   { // china
      "at": [105, 35],
      "ring": [
         [87, 28], [75, 37], [73, 40], [87, 49], [105, 53], [120, 53],
         [135, 48], [131, 43], [126, 40], [122.4, 37], [122.2, 31],
         [121.6, 30.5], [114.6, 22.1], [113.5, 22], [108, 21.4], [102, 22],
         [98, 24], [92, 28], [87, 28]
      ]
   },
   { // korea
      "at": [127.5, 36.5],
      "ring": [
         [126, 34.2], [129, 34.6], [129.6, 35.4], [129.7, 37.2],
         [128.4, 38.6], [126.4, 37.8], [126.1, 36], [126, 34.2]
      ]
   },
   { // japan
      "at": [137, 36],
      "ring": [
         [130, 31.2], [131.2, 32.5], [136, 34.5], [139.2, 34.8],
         [140.2, 35.8], [141.2, 38], [142, 41], [145.5, 43.4], [145, 44],
         [141.5, 45.5], [140, 42], [139.5, 38.5], [137, 36.5], [135, 35],
         [133, 34], [131, 33.5], [130, 31.5]
      ]
   },
   { // australia
      "at": [134, -25],
      "ring": [
         [113.2, -22], [114.5, -28], [115, -34], [116, -35.2], [124, -34],
         [130, -32], [135, -35], [140, -38.2], [147, -39], [150, -37.8],
         [151.6, -34], [153.6, -28], [153.4, -24], [150, -20], [146, -16],
         [142, -11], [136, -12], [128, -14], [122, -16], [114, -20],
         [113.2, -22]
      ]
   },
   { // newZealand
      "at": [172, -41],
      "ring": [
         [166.3, -46.2], [168, -46.6], [171, -44], [172.8, -43.7],
         [174.2, -41.5], [175.2, -41], [176.5, -37.8], [175.2, -36.6],
         [174.4, -36.6], [172.5, -39], [171, -42], [168, -44], [166.3, -45]
      ]
   },
   { // alaska
      "at": [-152, 64],
      "ring": [
         [-168, 54.5], [-166, 66], [-162, 68], [-153, 71], [-141, 69.5],
         [-141, 60.2], [-148, 60], [-158, 58], [-166, 54.5]
      ]
   },
   { // northAmerica
      "at": [-100, 40],
      "ring": [
         [-125.4, 49.4], [-130, 55], [-136, 58], [-140, 60], [-105, 68],
         [-88, 68], [-70, 62], [-64, 47], [-66, 44], [-70, 42],
         [-74.4, 40.5], [-75.6, 35.5], [-81, 25.2], [-90, 29], [-97.2, 25.8],
         [-97.6, 20.8], [-96.5, 16.2], [-99.4, 15.8], [-104.2, 17.2],
         [-106.2, 20.4], [-110, 23], [-112, 24], [-117.5, 32.4],
         [-120, 34.2], [-124.5, 40], [-124.8, 48], [-123.6, 49.4]
      ]
   },
   { // southAmerica
      "at": [-60, -15],
      "ring": [
         [-81.2, -5], [-79.6, 8.6], [-77.2, 7], [-71, 12], [-60, 8],
         [-50, 0], [-35.2, -4.5], [-34.7, -8.2], [-35.2, -12], [-39, -16],
         [-40.5, -22], [-44, -23.2], [-48.2, -28], [-52, -32],
         [-58.6, -34.8], [-65, -45], [-71, -55], [-75, -52], [-74, -40],
         [-73, -18], [-70.9, -33.6], [-76, -15], [-77.3, -12.2], [-79, -8],
         [-81.2, -5]
      ]
   },
   { // greenland
      "at": [-42, 72],
      "ring": [
         [-68, 60], [-73, 78], [-60, 82], [-20, 81], [-20, 70], [-43, 60],
         [-68, 60]
      ]
   },
   { // madagascar
      "at": [47, -19],
      "ring": [
         [43.2, -25.6], [43.3, -16], [49, -12], [50.6, -15], [47.5, -25.2],
         [44, -25.6]
      ]
   },
   { // iceland
      "at": [-19, 65],
      "ring": [
         [-24.6, 63.4], [-24.6, 66.5], [-13.5, 66.5], [-13.4, 64.8],
         [-14.5, 63.4]
      ]
   },
   { // antarcticaW
      "at": [-90, -75],
      "ring": [
         [-180, -90], [0, -90], [0, -60], [-180, -60]
      ]
   },
   { // antarcticaE
      "at": [90, -75],
      "ring": [
         [0, -90], [180, -90], [180, -60], [0, -60]
      ]
   },
   { // iberia
      "at": [-3.7, 40.4],
      "ring": [
         [-9.6, 36.6], [-9.5, 42], [-8.2, 43.6], [-1.6, 43.5], [3.35, 42.4],
         [3.15, 41.15], [1.6, 41.05], [-0.4, 38.6], [-5.4, 35.9],
         [-7.8, 36.7], [-9.6, 36.6]
      ]
   }
];

// Major cities. The point is the listed coordinate, not a jitter.
const geoCities = [
   [-0.1276, 51.5072], // London
   [2.3522, 48.8566], // Paris
   [13.405, 52.52], // Berlin
   [-3.7038, 40.4168], // Madrid
   [12.4964, 41.9028], // Rome
   [37.6173, 55.7558], // Moscow
   [28.9784, 41.0082], // Istanbul
   [31.2357, 30.0444], // Cairo
   [3.3792, 6.5244], // Lagos
   [28.0473, -26.2041], // Johannesburg
   [36.8219, -1.2921], // Nairobi
   [55.2708, 25.2048], // Dubai
   [72.8777, 19.076], // Mumbai
   [77.209, 28.6139], // Delhi
   [100.5018, 13.7563], // Bangkok
   [103.8198, 1.3521], // Singapore
   [114.1694, 22.3193], // Hong Kong
   [121.4737, 31.2304], // Shanghai
   [116.4074, 39.9042], // Beijing
   [139.6917, 35.6895], // Tokyo
   [126.978, 37.5665], // Seoul
   [151.2093, -33.8688], // Sydney
   [174.7633, -36.8485], // Auckland
   [-118.2437, 34.0522], // Los Angeles
   [-74.006, 40.7128], // New York
   [-87.6298, 41.8781], // Chicago
   [-79.3832, 43.6532], // Toronto
   [-99.1332, 19.4326], // Mexico City
   [-46.6333, -23.5505], // Sao Paulo
   [-58.3816, -34.6037] // Buenos Aires
];

// Regional cities.
const geoRegional = [
   [-2.2426, 53.4808], // Manchester
   [4.8357, 45.764], // Lyon
   [9.9937, 53.5511], // Hamburg
   [2.1734, 41.3874], // Barcelona
   [9.19, 45.4642], // Milan
   [19.945, 50.0647], // Krakow
   [5.3698, 43.2965], // Marseille
   [-7.5898, 33.5731], // Casablanca
   [-0.187, 5.6037], // Accra
   [38.7578, 9.032], // Addis Ababa
   [18.4241, -33.9249], // Cape Town
   [51.531, 25.2854], // Doha
   [67.0011, 24.8607], // Karachi
   [80.2707, 13.0827], // Chennai
   [105.8342, 21.0278], // Hanoi
   [135.5023, 34.6937], // Osaka
   [129.0756, 35.1796], // Busan
   [144.9631, -37.8136], // Melbourne
   [115.8605, -31.9505], // Perth
   [153.0251, -27.4698], // Brisbane
   [-123.1207, 49.2827], // Vancouver
   [-73.5673, 45.5017], // Montreal
   [-104.9903, 39.7392], // Denver
   [-84.388, 33.749], // Atlanta
   [-103.3496, 20.6597], // Guadalajara
   [-77.0428, -12.0464], // Lima
   [-70.6693, -33.4489], // Santiago
   [-75.5636, 6.2518], // Medellin
   [-34.877, -8.0476], // Recife
   [172.6362, -43.5321] // Christchurch
];

// Harbors. A port need not sit inside the land mask.
const geoPorts = [
   [4.4792, 51.9225], // Rotterdam
   [4.4025, 51.2194], // Antwerp
   [9.9667, 53.5461], // Hamburg
   [8.9463, 44.4056], // Genoa
   [23.6465, 37.942], // Piraeus
   [-5.7998, 35.7595], // Tangier
   [55.027, 25.011], // Jebel Ali
   [39.6682, -4.0435], // Mombasa
   [31.0218, -29.8587], // Durban
   [79.8612, 6.9271], // Colombo
   [103.85, 1.2644], // Singapore
   [114.15, 22.29], // Hong Kong
   [122.0667, 30.6167], // Yangshan
   [139.638, 35.4437], // Yokohama
   [129.04, 35.1], // Busan
   [106.88, -6.104], // Tanjung Priok
   [151.21, -33.97], // Port Botany
   [-118.1937, 33.7701], // Long Beach
   [-95.015, 29.73], // Houston
   [-90.07, 29.95], // New Orleans
   [-79.566, 8.95], // Balboa
   [-46.333, -23.96], // Santos
   [-71.627, -33.046], // Valparaiso
   [-77.15, -12.05] // Callao
];

function $geoContains(ring, lng, lat) {
   /*
    *  ray cast. A horizontal edge is skipped before the division.
    */
   let inside = false;
   for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0];
      const yi = ring[i][1];
      const xj = ring[j][0];
      const yj = ring[j][1];
      if ((yi > lat) === (yj > lat))
         continue;
      if (lng < (xj - xi) * (lat - yi) / (yj - yi) + xi)
         inside = !inside;
   }
   return inside;
}

function $geoOnLand(lng, lat) {
   /*
    *  true when the coordinate sits inside one land ring
    */
   for (let i = 0; i < geoLand.length; i++) {
      if ($geoContains(geoLand[i].ring, lng, lat))
         return true;
   }
   return false;
}

function $geoPoint(lng, lat) {
   /*
    *  one GeoJSON Point from a longitude and a latitude
    */
   return {
      "type": "Point",
      "coordinates": [
         $geoNum(lng, -180, 180),
         $geoNum(lat, -90, 90)
      ]
   };
}

function $geoListedPoint(list) {
   /*
    *  one listed coordinate, passed through $geoNum
    */
   const pick = list[$getRandInt(0, list.length)];
   return $geoPoint(pick[0], pick[1]);
}

function $geoAreaPoint(wantLand) {
   /*
    *  rejection sample in the same uniform measure as $genPoint().
    *  The test uses the four-decimal coordinate that is stored.
    *  After 64 misses, land uses a tested interior point and ocean
    *  uses the mid-Pacific.
    */
   for (let i = 0; i < 64; i++) {
      const lng = $geoNum($getRandNum(-180, 180), -180, 180);
      const lat = $geoNum($getRandNum(-90, 90), -90, 90);
      if ($geoOnLand(lng, lat) === wantLand)
         return $geoPoint(lng, lat);
   }
   if (wantLand) {
      const at = geoLand[$getRandInt(0, geoLand.length)].at;
      return $geoPoint(at[0], at[1]);
   }
   return $geoPoint(-150, 0);
}

function $genPoint(place) {
   /*
    *  one GeoJSON Point inside the longitude and latitude bounds.
    *  No class, or an unknown class, stays that uniform draw.
    *  "land" and "ocean" reject against the coarse mask.
    *  "city", "regional", and "port" are listed coordinates.
    *  Lines, polygons, and the multi helpers stay uniform.
    */
   if (place === 'land')
      return $geoAreaPoint(true);
   if (place === 'ocean')
      return $geoAreaPoint(false);
   if (place === 'city')
      return $geoListedPoint(geoCities);
   if (place === 'regional')
      return $geoListedPoint(geoRegional);
   if (place === 'port')
      return $geoListedPoint(geoPorts);
   return {
      "type": "Point",
      "coordinates": [
         $geoNum($getRandNum(-180, 180), -180, 180),
         $geoNum($getRandNum(-90, 90), -90, 90)
      ]
   };
}

function $genLine() {
   /*
    *  a short GeoJSON LineString. Both ends share one corner.
    */
   const span = $getRandNum(0.1, 1);
   const lng = $geoNum($getRandNum(-180, 180 - span), -180, 180);
   const lat = $geoNum($getRandNum(-90, 90 - span), -90, 90);
   return {
      "type": "LineString",
      "coordinates": [
         [lng, lat],
         [
            $geoNum(lng + $getRandNum(0.05, span), -180, 180),
            $geoNum(lat + $getRandNum(0.05, span), -90, 90)
         ]
      ]
   };
}

function $genPolygon(withHole) {
   /*
    *  one GeoJSON Polygon. The shell is a counterclockwise triangle
    *  from one southwest corner. withHole adds a clockwise hole inside it.
    *  A hole stays at least one degree off either pole. On the sphere the
    *  south edge otherwise stops containing that hole.
    */
   const hole = !!withHole;
   const east = $getRandNum(hole ? 1 : 0.1, hole ? 2 : 1);
   const north = $getRandNum(hole ? 1 : 0.1, hole ? 2 : 1);
   const latLo = hole ? -89 : -90;
   const latHi = hole ? 89 : 90;
   const lng = $geoNum($getRandNum(-180, 180 - east), -180, 180);
   const lat = $geoNum($getRandNum(latLo, latHi - north), -90, 90);
   const lngE = $geoNum(lng + east, -180, 180);
   const latN = $geoNum(lat + north, -90, 90);
   const shell = [[lng, lat], [lngE, lat], [lng, latN], [lng, lat]];
   const coordinates = [shell];
   if (hole) {
      const w = lngE - lng;
      const h = latN - lat;
      const a = [$geoNum(lng + w * 0.2, -180, 180), $geoNum(lat + h * 0.2, -90, 90)];
      const b = [$geoNum(lng + w * 0.2, -180, 180), $geoNum(lat + h * 0.35, -90, 90)];
      const c = [$geoNum(lng + w * 0.35, -180, 180), $geoNum(lat + h * 0.2, -90, 90)];
      coordinates.push([a, b, c, [a[0], a[1]]]);
   }
   return { "type": "Polygon", "coordinates": coordinates };
}

function $geoCount(n) {
   /*
    *  how many parts a Multi* geometry holds
    *  omitted or invalid is 2 to 4. An explicit count is capped at 8.
    */
   if (typeof n !== 'boolean' && n > 0 && Number.isFinite(+n))
      return Math.min($floor(+n), 8);
   return $getRandIntInc(2, 4);
}

function $genMultiPoint(n) {
   /*
    *  one GeoJSON MultiPoint. Each position is inside the
    *  longitude and latitude bounds, the way $genPoint places one.
    *  Omitted n is 2 to 4 positions. An explicit count is capped at 8.
    */
   const coordinates = [];
   const count = $geoCount(n);
   for (let i = 0; i < count; i++)
      coordinates.push($genPoint().coordinates);
   return { "type": "MultiPoint", "coordinates": coordinates };
}

function $genMultiLineString(n) {
   /*
    *  one GeoJSON MultiLineString. Each line is short and both
    *  ends share one corner, the way $genLine does.
    *  Omitted n is 2 to 4 lines. An explicit count is capped at 8.
    */
   const coordinates = [];
   const count = $geoCount(n);
   for (let i = 0; i < count; i++)
      coordinates.push($genLine().coordinates);
   return { "type": "MultiLineString", "coordinates": coordinates };
}

function $genMultiPolygon(n, withHole) {
   /*
    *  one GeoJSON MultiPolygon. Each polygon is a counterclockwise
    *  triangle from one southwest corner, the way $genPolygon winds it.
    *  $genMultiPolygon(true) adds a clockwise hole inside each triangle.
    *  Omitted n is 2 to 4 polygons. An explicit count is capped at 8.
    */
   let count = n;
   let hole = !!withHole;
   if (typeof n === 'boolean') {
      hole = n;
      count = null;
   }
   const coordinates = [];
   const polygons = $geoCount(count);
   for (let i = 0; i < polygons; i++)
      coordinates.push($genPolygon(hole).coordinates);
   return { "type": "MultiPolygon", "coordinates": coordinates };
}

function $genRandAlpha(len = 1) {
   /*
    *  generate random alpha-character string
    */
   const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
   return $genRandFrom(len, () => chars.charAt($getRandInt(0, chars.length)));
}

function $genRandSymbol() {
   /*
    *  generate random symbol
    */
   const symbol = '!#%&\'()+,-;=@[]^_`{}~¡¢£¤¥¦§¨©ª«¬­®¯°±²³´µ¶·¸¹º»¼½¾¿ÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖ×ØÙÚÛÜÝÞßàáâãäåæçèéêëìíîïðñòóôõö÷øùúûüýþÿ';

   return symbol.charAt($floor($rand() * symbol.length));
}

function $genRandCurrency() {
   /*
    *  one currency symbol. Peso and zloty are separate entries.
    */
   const currencies = ['$', '€', '₡', '£', '₪', '₹', '¥', '₩', '₦', '₱', 'zł', '₲', '฿', '₴', '₫'];

   return currencies[$getRandInt(0, currencies.length)];
}

function $genArrayElements(len) {
   /*
    *  generate array of random strings
    */
   const array = [];
   for (let i = 0; i < len; i++) {
      array.push($genRandStr($getRandIntInc(4, 12)));
   }

   return array;
}

function $genLuhnNumber(input) {
   /*
    *  append a Luhn check digit
    *  the rightmost payload digit is doubled, because the check digit sits to its right
    */
   const digits = String(input).split('').map(Number);
   let sum = 0;
   let shouldDouble = true;

   for (let i = digits.length - 1; i >= 0; i--) {
      let digit = digits[i];
      if (shouldDouble) {
         digit *= 2;
         if (digit > 9)
            digit -= 9;
      }
      sum += digit;
      shouldDouble = !shouldDouble;
   }

   const checkDigit = (10 - (sum % 10)) % 10;
   return String(input) + checkDigit;
}

function $genIin({ iin }) {
   /*
    *  basic fake IIN generator
    */

   const countryCode = $getRandCountry()['numeric code'];
   return ((iin[$getRandIntInc(0, (iin.length - 1))]).toString() + countryCode.replace(/^0+/, '') + $getRandInt(0, Math.pow(10, 6))).toString().padEnd(8, '0').substring(0, 8);
}

function $genPan(len = 7) {
   /*
    *  fake PAN of len digits, including leading zeros
    */
   let n = $floor(+len);
   if (!(n > 0))
      n = 7;
   let pan = '';
   for (let i = 0; i < n; i++)
      pan += $getRandInt(0, 10);
   return pan;
}

function $genRandCardNumber(type = 'rnd', card = '') {
   /*
    *  basic fake card generator
    */

   const cards = [
      { "type": "amex", "iin": [34, 37], "digits": 15, "weight": 10 },
      { "type": "discover", "iin": [6011, ...$range(644, 649, 1), 65], "digits": 16, "weight": 5 },
      { "type": "mastercard", "iin": [...$range(51, 55, 1), ...$range(2221, 2720, 1)], "digits": 16, "weight": 25 },
      { "type": "visa", "iin": [4], "digits": 16, "weight": 50 }
   ];

   if (type == 'rnd') {
      type = cards[$getRandRatioInt(cards.map(entry => entry.weight))].type;
   }
   card = cards.find(entry => entry.type == type);
   // BIN prefix (IIN + country code, 8 digits) + PAN + Luhn check digit.
   // The PAN fills card.digits, so amex is 15 and the others are 16.
   const iin = $genIin(card);
   const digits = (card.digits > 0) ? $floor(+card.digits) : iin.length + 8;
   const bodyLen = (digits > iin.length) ? digits - 1 : iin.length;
   const panLen = bodyLen - iin.length;
   const pan = panLen > 0 ? $genPan(panLen) : '';
   return $genLuhnNumber((iin + pan).slice(0, bodyLen));
}

function $range(start, stop, step) {
   /*
    *  return array of inclusive number range
    */
   return Array.from(
      { "length": (stop - start) / step + 1 },
      (_, idx) => start + idx * step
   );
};

function $getRandCountry() {
   /*
    *  return country code
    */

   const codes = [
      { "name": "Afghanistan", "alpha-2 code": "AF", "alpha-3 code": "AFG", "numeric code": "004" },
      { "name": "Albania", "alpha-2 code": "AL", "alpha-3 code": "ALB", "numeric code": "008" },
      { "name": "Antarctica", "alpha-2 code": "AQ", "alpha-3 code": "ATA", "numeric code": "010" },
      { "name": "Algeria", "alpha-2 code": "DZ", "alpha-3 code": "DZA", "numeric code": "012" },
      { "name": "American Samoa", "alpha-2 code": "AS", "alpha-3 code": "ASM", "numeric code": "016" },
      { "name": "Andorra", "alpha-2 code": "AD", "alpha-3 code": "AND", "numeric code": "020" },
      { "name": "Angola", "alpha-2 code": "AO", "alpha-3 code": "AGO", "numeric code": "024" },
      { "name": "Antigua and Barbuda", "alpha-2 code": "AG", "alpha-3 code": "ATG", "numeric code": "028" },
      { "name": "Azerbaijan", "alpha-2 code": "AZ", "alpha-3 code": "AZE", "numeric code": "031" },
      { "name": "Argentina", "alpha-2 code": "AR", "alpha-3 code": "ARG", "numeric code": "032" },
      { "name": "Australia", "alpha-2 code": "AU", "alpha-3 code": "AUS", "numeric code": "036" },
      { "name": "Austria", "alpha-2 code": "AT", "alpha-3 code": "AUT", "numeric code": "040" },
      { "name": "Bahamas", "alpha-2 code": "BS", "alpha-3 code": "BHS", "numeric code": "044" },
      { "name": "Bahrain", "alpha-2 code": "BH", "alpha-3 code": "BHR", "numeric code": "048" },
      { "name": "Bangladesh", "alpha-2 code": "BD", "alpha-3 code": "BGD", "numeric code": "050" },
      { "name": "Armenia", "alpha-2 code": "AM", "alpha-3 code": "ARM", "numeric code": "051" },
      { "name": "Barbados", "alpha-2 code": "BB", "alpha-3 code": "BRB", "numeric code": "052" },
      { "name": "Belgium", "alpha-2 code": "BE", "alpha-3 code": "BEL", "numeric code": "056" },
      { "name": "Bermuda", "alpha-2 code": "BM", "alpha-3 code": "BMU", "numeric code": "060" },
      { "name": "Bhutan", "alpha-2 code": "BT", "alpha-3 code": "BTN", "numeric code": "064" },
      { "name": "Bolivia", "alpha-2 code": "BO", "alpha-3 code": "BOL", "numeric code": "068" },
      { "name": "Bosnia and Herzegovina", "alpha-2 code": "BA", "alpha-3 code": "BIH", "numeric code": "070" },
      { "name": "Botswana", "alpha-2 code": "BW", "alpha-3 code": "BWA", "numeric code": "072" },
      { "name": "Bouvet Island", "alpha-2 code": "BV", "alpha-3 code": "BVT", "numeric code": "074" },
      { "name": "Brazil", "alpha-2 code": "BR", "alpha-3 code": "BRA", "numeric code": "076" },
      { "name": "Belize", "alpha-2 code": "BZ", "alpha-3 code": "BLZ", "numeric code": "084" },
      { "name": "British Indian Ocean Territory", "alpha-2 code": "IO", "alpha-3 code": "IOT", "numeric code": "086" },
      { "name": "Solomon Islands", "alpha-2 code": "SB", "alpha-3 code": "SLB", "numeric code": "090" },
      { "name": "Virgin Islands (British)", "alpha-2 code": "VG", "alpha-3 code": "VGB", "numeric code": "092" },
      { "name": "Brunei Darussalam", "alpha-2 code": "BN", "alpha-3 code": "BRN", "numeric code": "096" },
      { "name": "Bulgaria", "alpha-2 code": "BG", "alpha-3 code": "BGR", "numeric code": "100" },
      { "name": "Myanmar", "alpha-2 code": "MM", "alpha-3 code": "MMR", "numeric code": "104" },
      { "name": "Burundi", "alpha-2 code": "BI", "alpha-3 code": "BDI", "numeric code": "108" },
      { "name": "Belarus", "alpha-2 code": "BY", "alpha-3 code": "BLR", "numeric code": "112" },
      { "name": "Cambodia", "alpha-2 code": "KH", "alpha-3 code": "KHM", "numeric code": "116" },
      { "name": "Cameroon", "alpha-2 code": "CM", "alpha-3 code": "CMR", "numeric code": "120" },
      { "name": "Canada", "alpha-2 code": "CA", "alpha-3 code": "CAN", "numeric code": "124" },
      { "name": "Cabo Verde", "alpha-2 code": "CV", "alpha-3 code": "CPV", "numeric code": "132" },
      { "name": "Cayman Islands", "alpha-2 code": "KY", "alpha-3 code": "CYM", "numeric code": "136" },
      { "name": "Central African Republic", "alpha-2 code": "CF", "alpha-3 code": "CAF", "numeric code": "140" },
      { "name": "Sri Lanka", "alpha-2 code": "LK", "alpha-3 code": "LKA", "numeric code": "144" },
      { "name": "Chad", "alpha-2 code": "TD", "alpha-3 code": "TCD", "numeric code": "148" },
      { "name": "Chile", "alpha-2 code": "CL", "alpha-3 code": "CHL", "numeric code": "152" },
      { "name": "China", "alpha-2 code": "CN", "alpha-3 code": "CHN", "numeric code": "156" },
      { "name": "Taiwan", "alpha-2 code": "TW", "alpha-3 code": "TWN", "numeric code": "158" },
      { "name": "Christmas Island", "alpha-2 code": "CX", "alpha-3 code": "CXR", "numeric code": "162" },
      { "name": "Cocos (Keeling) Islands", "alpha-2 code": "CC", "alpha-3 code": "CCK", "numeric code": "166" },
      { "name": "Colombia", "alpha-2 code": "CO", "alpha-3 code": "COL", "numeric code": "170" },
      { "name": "Comoros", "alpha-2 code": "KM", "alpha-3 code": "COM", "numeric code": "174" },
      { "name": "Mayotte", "alpha-2 code": "YT", "alpha-3 code": "MYT", "numeric code": "175" },
      { "name": "Congo", "alpha-2 code": "CG", "alpha-3 code": "COG", "numeric code": "178" },
      { "name": "Congo, Democratic Republic of the", "alpha-2 code": "CD", "alpha-3 code": "COD", "numeric code": "180" },
      { "name": "Cook Islands", "alpha-2 code": "CK", "alpha-3 code": "COK", "numeric code": "184" },
      { "name": "Costa Rica", "alpha-2 code": "CR", "alpha-3 code": "CRI", "numeric code": "188" },
      { "name": "Croatia", "alpha-2 code": "HR", "alpha-3 code": "HRV", "numeric code": "191" },
      { "name": "Cuba", "alpha-2 code": "CU", "alpha-3 code": "CUB", "numeric code": "192" },
      { "name": "Cyprus[b]", "alpha-2 code": "CY", "alpha-3 code": "CYP", "numeric code": "196" },
      { "name": "Czechia", "alpha-2 code": "CZ", "alpha-3 code": "CZE", "numeric code": "203" },
      { "name": "Benin", "alpha-2 code": "BJ", "alpha-3 code": "BEN", "numeric code": "204" },
      { "name": "Denmark", "alpha-2 code": "DK", "alpha-3 code": "DNK", "numeric code": "208" },
      { "name": "Dominica", "alpha-2 code": "DM", "alpha-3 code": "DMA", "numeric code": "212" },
      { "name": "Dominican Republic", "alpha-2 code": "DO", "alpha-3 code": "DOM", "numeric code": "214" },
      { "name": "Ecuador", "alpha-2 code": "EC", "alpha-3 code": "ECU", "numeric code": "218" },
      { "name": "El Salvador", "alpha-2 code": "SV", "alpha-3 code": "SLV", "numeric code": "222" },
      { "name": "Equatorial Guinea", "alpha-2 code": "GQ", "alpha-3 code": "GNQ", "numeric code": "226" },
      { "name": "Ethiopia", "alpha-2 code": "ET", "alpha-3 code": "ETH", "numeric code": "231" },
      { "name": "Eritrea", "alpha-2 code": "ER", "alpha-3 code": "ERI", "numeric code": "232" },
      { "name": "Estonia", "alpha-2 code": "EE", "alpha-3 code": "EST", "numeric code": "233" },
      { "name": "Faroe Islands", "alpha-2 code": "FO", "alpha-3 code": "FRO", "numeric code": "234" },
      { "name": "Falkland Islands", "alpha-2 code": "FK", "alpha-3 code": "FLK", "numeric code": "238" },
      { "name": "South Georgia and the South Sandwich Islands", "alpha-2 code": "GS", "alpha-3 code": "SGS", "numeric code": "239" },
      { "name": "Fiji", "alpha-2 code": "FJ", "alpha-3 code": "FJI", "numeric code": "242" },
      { "name": "Finland", "alpha-2 code": "FI", "alpha-3 code": "FIN", "numeric code": "246" },
      { "name": "Åland Islands", "alpha-2 code": "AX", "alpha-3 code": "ALA", "numeric code": "248" },
      { "name": "France", "alpha-2 code": "FR", "alpha-3 code": "FRA", "numeric code": "250" },
      { "name": "French Guiana", "alpha-2 code": "GF", "alpha-3 code": "GUF", "numeric code": "254" },
      { "name": "French Polynesia", "alpha-2 code": "PF", "alpha-3 code": "PYF", "numeric code": "258" },
      { "name": "French Southern Territories", "alpha-2 code": "TF", "alpha-3 code": "ATF", "numeric code": "260" },
      { "name": "Djibouti", "alpha-2 code": "DJ", "alpha-3 code": "DJI", "numeric code": "262" },
      { "name": "Gabon", "alpha-2 code": "GA", "alpha-3 code": "GAB", "numeric code": "266" },
      { "name": "Georgia", "alpha-2 code": "GE", "alpha-3 code": "GEO", "numeric code": "268" },
      { "name": "Gambia", "alpha-2 code": "GM", "alpha-3 code": "GMB", "numeric code": "270" },
      { "name": "Palestine", "alpha-2 code": "PS", "alpha-3 code": "PSE", "numeric code": "275" },
      { "name": "Germany", "alpha-2 code": "DE", "alpha-3 code": "DEU", "numeric code": "276" },
      { "name": "Ghana", "alpha-2 code": "GH", "alpha-3 code": "GHA", "numeric code": "288" },
      { "name": "Gibraltar", "alpha-2 code": "GI", "alpha-3 code": "GIB", "numeric code": "292" },
      { "name": "Kiribati", "alpha-2 code": "KI", "alpha-3 code": "KIR", "numeric code": "296" },
      { "name": "Greece", "alpha-2 code": "GR", "alpha-3 code": "GRC", "numeric code": "300" },
      { "name": "Greenland", "alpha-2 code": "GL", "alpha-3 code": "GRL", "numeric code": "304" },
      { "name": "Grenada", "alpha-2 code": "GD", "alpha-3 code": "GRD", "numeric code": "308" },
      { "name": "Guadeloupe", "alpha-2 code": "GP", "alpha-3 code": "GLP", "numeric code": "312" },
      { "name": "Guam", "alpha-2 code": "GU", "alpha-3 code": "GUM", "numeric code": "316" },
      { "name": "Guatemala", "alpha-2 code": "GT", "alpha-3 code": "GTM", "numeric code": "320" },
      { "name": "Guinea", "alpha-2 code": "GN", "alpha-3 code": "GIN", "numeric code": "324" },
      { "name": "Guyana", "alpha-2 code": "GY", "alpha-3 code": "GUY", "numeric code": "328" },
      { "name": "Haiti", "alpha-2 code": "HT", "alpha-3 code": "HTI", "numeric code": "332" },
      { "name": "Heard Island and McDonald Islands", "alpha-2 code": "HM", "alpha-3 code": "HMD", "numeric code": "334" },
      { "name": "Holy See", "alpha-2 code": "VA", "alpha-3 code": "VAT", "numeric code": "336" },
      { "name": "Honduras", "alpha-2 code": "HN", "alpha-3 code": "HND", "numeric code": "340" },
      { "name": "Hong Kong", "alpha-2 code": "HK", "alpha-3 code": "HKG", "numeric code": "344" },
      { "name": "Hungary", "alpha-2 code": "HU", "alpha-3 code": "HUN", "numeric code": "348" },
      { "name": "Iceland", "alpha-2 code": "IS", "alpha-3 code": "ISL", "numeric code": "352" },
      { "name": "India", "alpha-2 code": "IN", "alpha-3 code": "IND", "numeric code": "356" },
      { "name": "Indonesia", "alpha-2 code": "ID", "alpha-3 code": "IDN", "numeric code": "360" },
      { "name": "Iran", "alpha-2 code": "IR", "alpha-3 code": "IRN", "numeric code": "364" },
      { "name": "Iraq", "alpha-2 code": "IQ", "alpha-3 code": "IRQ", "numeric code": "368" },
      { "name": "Ireland", "alpha-2 code": "IE", "alpha-3 code": "IRL", "numeric code": "372" },
      { "name": "Israel", "alpha-2 code": "IL", "alpha-3 code": "ISR", "numeric code": "376" },
      { "name": "Italy", "alpha-2 code": "IT", "alpha-3 code": "ITA", "numeric code": "380" },
      { "name": "Côte d'Ivoire", "alpha-2 code": "CI", "alpha-3 code": "CIV", "numeric code": "384" },
      { "name": "Jamaica", "alpha-2 code": "JM", "alpha-3 code": "JAM", "numeric code": "388" },
      { "name": "Japan", "alpha-2 code": "JP", "alpha-3 code": "JPN", "numeric code": "392" },
      { "name": "Kazakhstan", "alpha-2 code": "KZ", "alpha-3 code": "KAZ", "numeric code": "398" },
      { "name": "Jordan", "alpha-2 code": "JO", "alpha-3 code": "JOR", "numeric code": "400" },
      { "name": "Kenya", "alpha-2 code": "KE", "alpha-3 code": "KEN", "numeric code": "404" },
      { "name": "North Korea", "alpha-2 code": "KP", "alpha-3 code": "PRK", "numeric code": "408" },
      { "name": "South Korea", "alpha-2 code": "KR", "alpha-3 code": "KOR", "numeric code": "410" },
      { "name": "Kuwait", "alpha-2 code": "KW", "alpha-3 code": "KWT", "numeric code": "414" },
      { "name": "Kyrgyzstan", "alpha-2 code": "KG", "alpha-3 code": "KGZ", "numeric code": "417" },
      { "name": "Lao People's Democratic Republic", "alpha-2 code": "LA", "alpha-3 code": "LAO", "numeric code": "418" },
      { "name": "Lebanon", "alpha-2 code": "LB", "alpha-3 code": "LBN", "numeric code": "422" },
      { "name": "Lesotho", "alpha-2 code": "LS", "alpha-3 code": "LSO", "numeric code": "426" },
      { "name": "Latvia", "alpha-2 code": "LV", "alpha-3 code": "LVA", "numeric code": "428" },
      { "name": "Liberia", "alpha-2 code": "LR", "alpha-3 code": "LBR", "numeric code": "430" },
      { "name": "Libya", "alpha-2 code": "LY", "alpha-3 code": "LBY", "numeric code": "434" },
      { "name": "Liechtenstein", "alpha-2 code": "LI", "alpha-3 code": "LIE", "numeric code": "438" },
      { "name": "Lithuania", "alpha-2 code": "LT", "alpha-3 code": "LTU", "numeric code": "440" },
      { "name": "Luxembourg", "alpha-2 code": "LU", "alpha-3 code": "LUX", "numeric code": "442" },
      { "name": "Macao", "alpha-2 code": "MO", "alpha-3 code": "MAC", "numeric code": "446" },
      { "name": "Madagascar", "alpha-2 code": "MG", "alpha-3 code": "MDG", "numeric code": "450" },
      { "name": "Malawi", "alpha-2 code": "MW", "alpha-3 code": "MWI", "numeric code": "454" },
      { "name": "Malaysia", "alpha-2 code": "MY", "alpha-3 code": "MYS", "numeric code": "458" },
      { "name": "Maldives", "alpha-2 code": "MV", "alpha-3 code": "MDV", "numeric code": "462" },
      { "name": "Mali", "alpha-2 code": "ML", "alpha-3 code": "MLI", "numeric code": "466" },
      { "name": "Malta", "alpha-2 code": "MT", "alpha-3 code": "MLT", "numeric code": "470" },
      { "name": "Martinique", "alpha-2 code": "MQ", "alpha-3 code": "MTQ", "numeric code": "474" },
      { "name": "Mauritania", "alpha-2 code": "MR", "alpha-3 code": "MRT", "numeric code": "478" },
      { "name": "Mauritius", "alpha-2 code": "MU", "alpha-3 code": "MUS", "numeric code": "480" },
      { "name": "Mexico", "alpha-2 code": "MX", "alpha-3 code": "MEX", "numeric code": "484" },
      { "name": "Monaco", "alpha-2 code": "MC", "alpha-3 code": "MCO", "numeric code": "492" },
      { "name": "Mongolia", "alpha-2 code": "MN", "alpha-3 code": "MNG", "numeric code": "496" },
      { "name": "Moldova", "alpha-2 code": "MD", "alpha-3 code": "MDA", "numeric code": "498" },
      { "name": "Montenegro", "alpha-2 code": "ME", "alpha-3 code": "MNE", "numeric code": "499" },
      { "name": "Montserrat", "alpha-2 code": "MS", "alpha-3 code": "MSR", "numeric code": "500" },
      { "name": "Morocco", "alpha-2 code": "MA", "alpha-3 code": "MAR", "numeric code": "504" },
      { "name": "Mozambique", "alpha-2 code": "MZ", "alpha-3 code": "MOZ", "numeric code": "508" },
      { "name": "Oman", "alpha-2 code": "OM", "alpha-3 code": "OMN", "numeric code": "512" },
      { "name": "Namibia", "alpha-2 code": "NA", "alpha-3 code": "NAM", "numeric code": "516" },
      { "name": "Nauru", "alpha-2 code": "NR", "alpha-3 code": "NRU", "numeric code": "520" },
      { "name": "Nepal", "alpha-2 code": "NP", "alpha-3 code": "NPL", "numeric code": "524" },
      { "name": "Netherlands", "alpha-2 code": "NL", "alpha-3 code": "NLD", "numeric code": "528" },
      { "name": "Curaçao", "alpha-2 code": "CW", "alpha-3 code": "CUW", "numeric code": "531" },
      { "name": "Aruba", "alpha-2 code": "AW", "alpha-3 code": "ABW", "numeric code": "533" },
      { "name": "Sint Maarten", "alpha-2 code": "SX", "alpha-3 code": "SXM", "numeric code": "534" },
      { "name": "Bonaire, Sint Eustatius and Saba", "alpha-2 code": "BQ", "alpha-3 code": "BES", "numeric code": "535" },
      { "name": "New Caledonia", "alpha-2 code": "NC", "alpha-3 code": "NCL", "numeric code": "540" },
      { "name": "Vanuatu", "alpha-2 code": "VU", "alpha-3 code": "VUT", "numeric code": "548" },
      { "name": "New Zealand", "alpha-2 code": "NZ", "alpha-3 code": "NZL", "numeric code": "554" },
      { "name": "Nicaragua", "alpha-2 code": "NI", "alpha-3 code": "NIC", "numeric code": "558" },
      { "name": "Niger", "alpha-2 code": "NE", "alpha-3 code": "NER", "numeric code": "562" },
      { "name": "Nigeria", "alpha-2 code": "NG", "alpha-3 code": "NGA", "numeric code": "566" },
      { "name": "Niue", "alpha-2 code": "NU", "alpha-3 code": "NIU", "numeric code": "570" },
      { "name": "Norfolk Island", "alpha-2 code": "NF", "alpha-3 code": "NFK", "numeric code": "574" },
      { "name": "Norway", "alpha-2 code": "NO", "alpha-3 code": "NOR", "numeric code": "578" },
      { "name": "Northern Mariana Islands", "alpha-2 code": "MP", "alpha-3 code": "MNP", "numeric code": "580" },
      { "name": "United States Minor Outlying Islands", "alpha-2 code": "UM", "alpha-3 code": "UMI", "numeric code": "581" },
      { "name": "Micronesia", "alpha-2 code": "FM", "alpha-3 code": "FSM", "numeric code": "583" },
      { "name": "Marshall Islands", "alpha-2 code": "MH", "alpha-3 code": "MHL", "numeric code": "584" },
      { "name": "Palau", "alpha-2 code": "PW", "alpha-3 code": "PLW", "numeric code": "585" },
      { "name": "Pakistan", "alpha-2 code": "PK", "alpha-3 code": "PAK", "numeric code": "586" },
      { "name": "Panama", "alpha-2 code": "PA", "alpha-3 code": "PAN", "numeric code": "591" },
      { "name": "Papua New Guinea", "alpha-2 code": "PG", "alpha-3 code": "PNG", "numeric code": "598" },
      { "name": "Paraguay", "alpha-2 code": "PY", "alpha-3 code": "PRY", "numeric code": "600" },
      { "name": "Peru", "alpha-2 code": "PE", "alpha-3 code": "PER", "numeric code": "604" },
      { "name": "Philippines", "alpha-2 code": "PH", "alpha-3 code": "PHL", "numeric code": "608" },
      { "name": "Pitcairn", "alpha-2 code": "PN", "alpha-3 code": "PCN", "numeric code": "612" },
      { "name": "Poland", "alpha-2 code": "PL", "alpha-3 code": "POL", "numeric code": "616" },
      { "name": "Portugal", "alpha-2 code": "PT", "alpha-3 code": "PRT", "numeric code": "620" },
      { "name": "Guinea-Bissau", "alpha-2 code": "GW", "alpha-3 code": "GNB", "numeric code": "624" },
      { "name": "Timor-Leste", "alpha-2 code": "TL", "alpha-3 code": "TLS", "numeric code": "626" },
      { "name": "Puerto Rico", "alpha-2 code": "PR", "alpha-3 code": "PRI", "numeric code": "630" },
      { "name": "Qatar", "alpha-2 code": "QA", "alpha-3 code": "QAT", "numeric code": "634" },
      { "name": "Réunion", "alpha-2 code": "RE", "alpha-3 code": "REU", "numeric code": "638" },
      { "name": "Romania", "alpha-2 code": "RO", "alpha-3 code": "ROU", "numeric code": "642" },
      { "name": "Russian Federation", "alpha-2 code": "RU", "alpha-3 code": "RUS", "numeric code": "643" },
      { "name": "Rwanda", "alpha-2 code": "RW", "alpha-3 code": "RWA", "numeric code": "646" },
      { "name": "Saint Barthélemy", "alpha-2 code": "BL", "alpha-3 code": "BLM", "numeric code": "652" },
      { "name": "Saint Helena, Ascension and Tristan da Cunha", "alpha-2 code": "SH", "alpha-3 code": "SHN", "numeric code": "654" },
      { "name": "Saint Kitts and Nevis", "alpha-2 code": "KN", "alpha-3 code": "KNA", "numeric code": "659" },
      { "name": "Anguilla", "alpha-2 code": "AI", "alpha-3 code": "AIA", "numeric code": "660" },
      { "name": "Saint Lucia", "alpha-2 code": "LC", "alpha-3 code": "LCA", "numeric code": "662" },
      { "name": "Saint Martin", "alpha-2 code": "MF", "alpha-3 code": "MAF", "numeric code": "663" },
      { "name": "Saint Pierre and Miquelon", "alpha-2 code": "PM", "alpha-3 code": "SPM", "numeric code": "666" },
      { "name": "Saint Vincent and the Grenadines", "alpha-2 code": "VC", "alpha-3 code": "VCT", "numeric code": "670" },
      { "name": "San Marino", "alpha-2 code": "SM", "alpha-3 code": "SMR", "numeric code": "674" },
      { "name": "Sao Tome and Principe", "alpha-2 code": "ST", "alpha-3 code": "STP", "numeric code": "678" },
      { "name": "Saudi Arabia", "alpha-2 code": "SA", "alpha-3 code": "SAU", "numeric code": "682" },
      { "name": "Senegal", "alpha-2 code": "SN", "alpha-3 code": "SEN", "numeric code": "686" },
      { "name": "Serbia", "alpha-2 code": "RS", "alpha-3 code": "SRB", "numeric code": "688" },
      { "name": "Seychelles", "alpha-2 code": "SC", "alpha-3 code": "SYC", "numeric code": "690" },
      { "name": "Sierra Leone", "alpha-2 code": "SL", "alpha-3 code": "SLE", "numeric code": "694" },
      { "name": "Singapore", "alpha-2 code": "SG", "alpha-3 code": "SGP", "numeric code": "702" },
      { "name": "Slovakia", "alpha-2 code": "SK", "alpha-3 code": "SVK", "numeric code": "703" },
      { "name": "Viet Nam", "alpha-2 code": "VN", "alpha-3 code": "VNM", "numeric code": "704" },
      { "name": "Slovenia", "alpha-2 code": "SI", "alpha-3 code": "SVN", "numeric code": "705" },
      { "name": "Somalia", "alpha-2 code": "SO", "alpha-3 code": "SOM", "numeric code": "706" },
      { "name": "South Africa", "alpha-2 code": "ZA", "alpha-3 code": "ZAF", "numeric code": "710" },
      { "name": "Zimbabwe", "alpha-2 code": "ZW", "alpha-3 code": "ZWE", "numeric code": "716" },
      { "name": "Spain", "alpha-2 code": "ES", "alpha-3 code": "ESP", "numeric code": "724" },
      { "name": "South Sudan", "alpha-2 code": "SS", "alpha-3 code": "SSD", "numeric code": "728" },
      { "name": "Sudan", "alpha-2 code": "SD", "alpha-3 code": "SDN", "numeric code": "729" },
      { "name": "Western Sahara", "alpha-2 code": "EH", "alpha-3 code": "ESH", "numeric code": "732" },
      { "name": "Suriname", "alpha-2 code": "SR", "alpha-3 code": "SUR", "numeric code": "740" },
      { "name": "Svalbard and Jan Mayen", "alpha-2 code": "SJ", "alpha-3 code": "SJM", "numeric code": "744" },
      { "name": "Eswatini", "alpha-2 code": "SZ", "alpha-3 code": "SWZ", "numeric code": "748" },
      { "name": "Sweden", "alpha-2 code": "SE", "alpha-3 code": "SWE", "numeric code": "752" },
      { "name": "Switzerland", "alpha-2 code": "CH", "alpha-3 code": "CHE", "numeric code": "756" },
      { "name": "Syrian Arab Republic", "alpha-2 code": "SY", "alpha-3 code": "SYR", "numeric code": "760" },
      { "name": "Tajikistan", "alpha-2 code": "TJ", "alpha-3 code": "TJK", "numeric code": "762" },
      { "name": "Thailand", "alpha-2 code": "TH", "alpha-3 code": "THA", "numeric code": "764" },
      { "name": "Togo", "alpha-2 code": "TG", "alpha-3 code": "TGO", "numeric code": "768" },
      { "name": "Tokelau", "alpha-2 code": "TK", "alpha-3 code": "TKL", "numeric code": "772" },
      { "name": "Tonga", "alpha-2 code": "TO", "alpha-3 code": "TON", "numeric code": "776" },
      { "name": "Trinidad and Tobago", "alpha-2 code": "TT", "alpha-3 code": "TTO", "numeric code": "780" },
      { "name": "United Arab Emirates", "alpha-2 code": "AE", "alpha-3 code": "ARE", "numeric code": "784" },
      { "name": "Tunisia", "alpha-2 code": "TN", "alpha-3 code": "TUN", "numeric code": "788" },
      { "name": "Türkiye", "alpha-2 code": "TR", "alpha-3 code": "TUR", "numeric code": "792" },
      { "name": "Turkmenistan", "alpha-2 code": "TM", "alpha-3 code": "TKM", "numeric code": "795" },
      { "name": "Turks and Caicos Islands", "alpha-2 code": "TC", "alpha-3 code": "TCA", "numeric code": "796" },
      { "name": "Tuvalu", "alpha-2 code": "TV", "alpha-3 code": "TUV", "numeric code": "798" },
      { "name": "Uganda", "alpha-2 code": "UG", "alpha-3 code": "UGA", "numeric code": "800" },
      { "name": "Ukraine", "alpha-2 code": "UA", "alpha-3 code": "UKR", "numeric code": "804" },
      { "name": "North Macedonia", "alpha-2 code": "MK", "alpha-3 code": "MKD", "numeric code": "807" },
      { "name": "Egypt", "alpha-2 code": "EG", "alpha-3 code": "EGY", "numeric code": "818" },
      { "name": "United Kingdom of Great Britain and Northern Ireland", "alpha-2 code": "GB", "alpha-3 code": "GBR", "numeric code": "826" },
      { "name": "Guernsey", "alpha-2 code": "GG", "alpha-3 code": "GGY", "numeric code": "831" },
      { "name": "Jersey", "alpha-2 code": "JE", "alpha-3 code": "JEY", "numeric code": "832" },
      { "name": "Isle of Man", "alpha-2 code": "IM", "alpha-3 code": "IMN", "numeric code": "833" },
      { "name": "Tanzania, United Republic of", "alpha-2 code": "TZ", "alpha-3 code": "TZA", "numeric code": "834" },
      { "name": "United States of America", "alpha-2 code": "US", "alpha-3 code": "USA", "numeric code": "840" },
      { "name": "Virgin Islands (U.S.)", "alpha-2 code": "VI", "alpha-3 code": "VIR", "numeric code": "850" },
      { "name": "Burkina Faso", "alpha-2 code": "BF", "alpha-3 code": "BFA", "numeric code": "854" },
      { "name": "Uruguay", "alpha-2 code": "UY", "alpha-3 code": "URY", "numeric code": "858" },
      { "name": "Uzbekistan", "alpha-2 code": "UZ", "alpha-3 code": "UZB", "numeric code": "860" },
      { "name": "Venezuela", "alpha-2 code": "VE", "alpha-3 code": "VEN", "numeric code": "862" },
      { "name": "Wallis and Futuna", "alpha-2 code": "WF", "alpha-3 code": "WLF", "numeric code": "876" },
      { "name": "Samoa", "alpha-2 code": "WS", "alpha-3 code": "WSM", "numeric code": "882" },
      { "name": "Yemen", "alpha-2 code": "YE", "alpha-3 code": "YEM", "numeric code": "887" },
      { "name": "Zambia", "alpha-2 code": "ZM", "alpha-3 code": "ZMB", "numeric code": "894" }
   ];

   return codes[$getRandIntInc(0, codes.length - 1)];
}

function $bool(chance = 0.5) {
   /*
    *  return true/false
    */
   return $rand() < chance;
}

const benfordBins = 4096; // power of two: a uint32 maps onto the table with no modulo bias
const benfordSignificand = new Float64Array(benfordBins);
for (let benfordBin = 0; benfordBin < benfordBins; benfordBin++)
   benfordSignificand[benfordBin] = Math.pow(10, (benfordBin + 0.5) / benfordBins);

const benfordRandBuf = new Uint32Array(1024);
let benfordRandAt = benfordRandBuf.length;

function benfordUint32() {
   /*
    *  One uint32 from a refilled crypto buffer.
    */
   if (benfordRandAt >= benfordRandBuf.length) {
      crypto.webcrypto.getRandomValues(benfordRandBuf);
      benfordRandAt = 0;
   }
   return benfordRandBuf[benfordRandAt++];
}

function $benford(expMin = 0, expMax = 6) {
   /*
    *  Positive magnitude whose significand follows Benford's law.
    *  expMin and expMax are inclusive powers of ten.
    *  The draw is in [10^expMin, 10^(expMax+1)).
    *  A schema "=" expression calls this directly.
    */
   let lo = +expMin;
   let hi = +expMax;
   if (!Number.isFinite(lo)) lo = 0;
   if (!Number.isFinite(hi)) hi = 6;
   lo = $floor(lo);
   hi = $floor(hi);
   if (hi < lo) {
      const swap = lo;
      lo = hi;
      hi = swap;
   }
   // significand is in [1, 10); keep sig * 10^exp finite and normal
   if (lo < -307) lo = -307;
   if (lo > 307) lo = 307;
   if (hi > 307) hi = 307;
   if (hi < -307) hi = -307;
   if (hi < lo) hi = lo;

   const sig = benfordSignificand[benfordUint32() % benfordBins];
   const span = hi - lo + 1;
   let offset = 0;
   if (span > 1) {
      // rejection keeps the exponent uniform when span does not divide 2^32
      const limit = 0x100000000 - (0x100000000 % span);
      let unit = benfordUint32();
      while (unit >= limit)
         unit = benfordUint32();
      offset = unit % span;
   }
   return sig * Math.pow(10, lo + offset);
}

// EOF
