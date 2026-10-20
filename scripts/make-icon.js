#!/usr/bin/env node
/*
 * reMona (AICleaner) — application icon generator.
 *
 * Produces `build/icon.png` (512x512 RGBA), which electron-builder converts
 * to the Windows .ico at package time. Drawing is procedural so the icon can
 * be regenerated without binary assets in the repository history:
 *
 *   node scripts/make-icon.js
 *
 * Shape: a rounded app tile with the product gradient, a progress ring with a
 * gap (the "sweep" of a scan) and a four-point spark in the middle (the AI
 * accent). Rendered at 2x and downsampled for clean anti-aliased edges.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 512;
const SS = 2; // supersampling factor
const N = SIZE * SS;

/* ----------------------------------------------------------------- colours */

const BG_TOP = [13, 17, 32];
const BG_BOTTOM = [6, 8, 13];
const CYAN = [34, 211, 238];
const INDIGO = [99, 102, 241];
const VIOLET = [168, 85, 247];
const INK = [238, 242, 249];

const mix = (a, b, t) => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];

/** Three-stop brand gradient: 0 → cyan, 0.5 → indigo, 1 → violet. */
function brand(t) {
  const c = Math.min(1, Math.max(0, t));
  return c < 0.5 ? mix(CYAN, INDIGO, c / 0.5) : mix(INDIGO, VIOLET, (c - 0.5) / 0.5);
}

/* ------------------------------------------------------------- geometry */

const CX = N / 2;
const CY = N / 2 - N * 0.012;
const R_OUT = N * 0.296;   // ring centre radius
const R_THICK = N * 0.049; // ring stroke width
const RING_FROM = -Math.PI * 0.62; // start angle, gap sits top-left
const RING_SWEEP = Math.PI * 1.60;
const TILE_RADIUS = N * 0.224;

/** Signed distance to a rounded rectangle centred on the canvas. */
function sdTile(x, y, half, radius) {
  const qx = Math.abs(x - N / 2) - (half - radius);
  const qy = Math.abs(y - N / 2) - (half - radius);
  const ax = Math.max(qx, 0);
  const ay = Math.max(qy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - radius;
}

/** Radius of the four-point spark at angle `a` (maxima on both axes). */
function sparkRadius(a) {
  const c = Math.abs(Math.cos(2 * a));
  return N * 0.168 * (0.035 + 0.965 * Math.pow(c, 1.75));
}

/** Angular distance from `a` to the ring's start, wrapped to [0, 2π). */
function angFromStart(a) {
  const d = (a - RING_FROM) % (Math.PI * 2);
  return d < 0 ? d + Math.PI * 2 : d;
}

/* ----------------------------------------------------------------- pixels */

const px = new Float64Array(N * N * 4);

for (let y = 0; y < N; y++) {
  for (let x = 0; x < N; x++) {
    const i = (y * N + x) * 4;
    const cx = x + 0.5;
    const cy = y + 0.5;

    // --- tile: rounded square with a vertical gradient
    const dTile = sdTile(cx, cy, N * 0.5, TILE_RADIUS);
    const tileA = Math.min(1, Math.max(0, 0.5 - dTile));
    if (tileA <= 0) continue;

    const vt = Math.min(1, Math.max(0, cy / N));
    let r = BG_TOP[0] + (BG_BOTTOM[0] - BG_TOP[0]) * vt;
    let g = BG_TOP[1] + (BG_BOTTOM[1] - BG_TOP[1]) * vt;
    let b = BG_TOP[2] + (BG_BOTTOM[2] - BG_TOP[2]) * vt;

    // --- soft brand glow behind the ring
    const dx = cx - CX;
    const dy = cy - CY;
    const dist = Math.hypot(dx, dy);
    const glow = Math.max(0, 1 - dist / (N * 0.46));
    const glowC = brand(0.42);
    const gk = glow * glow * 0.30;
    r += (glowC[0] - r) * gk;
    g += (glowC[1] - g) * gk;
    b += (glowC[2] - b) * gk;

    // --- progress ring
    const a = Math.atan2(dy, dx);
    const rel = angFromStart(a < 0 ? a + Math.PI * 2 : a);
    if (rel <= RING_SWEEP) {
      const dRing = Math.abs(dist - R_OUT) - R_THICK * 0.5;
      let ringA = Math.min(1, Math.max(0, 0.5 - dRing * SS));
      // round caps at both ends of the sweep
      for (const capA of [0, RING_SWEEP]) {
        const ex = CX + Math.cos(RING_FROM + capA) * R_OUT;
        const ey = CY + Math.sin(RING_FROM + capA) * R_OUT;
        const dCap = Math.hypot(cx - ex, cy - ey) - R_THICK * 0.5;
        ringA = Math.max(ringA, Math.min(1, Math.max(0, 0.5 - dCap * SS)));
      }
      if (ringA > 0) {
        const ringC = brand(rel / RING_SWEEP);
        r += (ringC[0] - r) * ringA;
        g += (ringC[1] - g) * ringA;
        b += (ringC[2] - b) * ringA;
      }
    }

    // --- centre spark (soft white, slight glow inside the ring)
    const coreDist = Math.hypot(dx, dy);
    const rSpark = sparkRadius(a);
    const sparkA = Math.min(1, Math.max(0, (rSpark - coreDist) * SS * 0.55 + 0.5));
    if (sparkA > 0) {
      const sparkC = mix(INK, brand(0.5), Math.min(1, coreDist / rSpark) * 0.45);
      r += (sparkC[0] - r) * sparkA;
      g += (sparkC[1] - g) * sparkA;
      b += (sparkC[2] - b) * sparkA;
    }

    px[i] = r;
    px[i + 1] = g;
    px[i + 2] = b;
    px[i + 3] = tileA * 255;
  }
}

/* ----------------------------------------------------------- downsample */

const out = Buffer.alloc(SIZE * SIZE * 4);
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    let r = 0;
    let g = 0;
    let b = 0;
    let a = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const i = ((y * SS + sy) * N + (x * SS + sx)) * 4;
        const w = px[i + 3] / 255;
        r += px[i] * w;
        g += px[i + 1] * w;
        b += px[i + 2] * w;
        a += px[i + 3];
      }
    }
    const wsum = a / 255 || 1;
    const o = (y * SIZE + x) * 4;
    out[o] = Math.round(r / wsum);
    out[o + 1] = Math.round(g / wsum);
    out[o + 2] = Math.round(b / wsum);
    out[o + 3] = Math.round(a / (SS * SS));
  }
}

/* --------------------------------------------------------------- PNG out */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // colour type: RGBA
ihdr[10] = 0;
ihdr[11] = 0;
ihdr[12] = 0;

const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0; // filter: none
  out.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

const dest = path.join(__dirname, '..', 'build', 'icon.png');
fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.writeFileSync(dest, png);
console.log(`icon written: ${dest} (${SIZE}x${SIZE}, ${(png.length / 1024).toFixed(1)} KB)`);
