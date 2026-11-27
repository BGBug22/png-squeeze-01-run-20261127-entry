// Rewrites each stored RGBA screenshot (/input/<id>/image.png) as the smallest lossless 8-bit PNG it can find and
// puts it at /output/<id>/image.png. Work is budgeted by fixed effort settings, never by the clock.
import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateRawSync, deflateSync, inflateSync } from 'node:zlib';

const IN = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUT = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// ---- checksums ----
const CRCT = new Int32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  CRCT[i] = c;
}
function crc(buf, from, to) {
  let c = -1;
  for (let i = from; i < to; i++) c = CRCT[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return ~c >>> 0;
}
function adler(buf, len) {
  let a = 1, b = 0, i = 0;
  while (i < len) {
    const stop = Math.min(len, i + 3800);
    for (; i < stop; i++) { a += buf[i]; b += a; }
    a %= 65521; b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

// ---- work memory, sized once for the largest filtered image and reused for every screenshot ----
let CAP = 0, RGBA, RGBA32, PIXB, FILT, CAND, BEST;
function reserve(w, h) {
  const n = h * (w * 4 + 1);
  if (n <= CAP) return;
  CAP = n;
  // the pixel and filter buffers are dead once a filter plan is picked, so the parser's tables reuse their memory
  const ab = new ArrayBuffer(8 * n + 16), px = w * h;
  RGBA = new Uint8Array(ab, 0, px * 4); RGBA32 = new Uint32Array(ab, 0, px);
  PIXB = new Uint8Array(ab, px * 4, px * 3);
  FILT = [0, 1, 2, 3, 4].map((k) => new Uint8Array(ab, px * 7 + k * n, n));
  CAND = new Uint8Array(n); BEST = new Uint8Array(n);
  reserveCoder(n, ab);
}

// ---- reading the stored PNG ----
function readStored(file) {
  let at = 8, w = 0, h = 0, kind = -1;
  const parts = [];
  while (at + 12 <= file.length) {
    const len = file.readUInt32BE(at), tag = file.toString('latin1', at + 4, at + 8);
    if (tag === 'IHDR') { w = file.readUInt32BE(at + 8); h = file.readUInt32BE(at + 12); kind = file[at + 16] === 8 && file[at + 20] === 0 ? file[at + 17] : -1; }
    else if (tag === 'IDAT') parts.push(file.subarray(at + 8, at + 8 + len));
    at += len + 12;
  }
  if (kind !== 6) throw new Error('not an 8-bit RGBA image');
  reserve(w, h);
  const raw = inflateSync(parts.length === 1 ? parts[0] : Buffer.concat(parts), { chunkSize: 1 << 22 });
  const row = w * 4;
  if (raw.length !== h * (row + 1)) throw new Error('unexpected pixel data length');
  for (let y = 0; y < h; y++) {
    const o = y * (row + 1);
    if (raw[o] !== 0) throw new Error('filtered input row');
    RGBA.set(raw.subarray(o + 1, o + 1 + row), y * row);
  }
  return { w, h };
}

// ---- choosing the narrowest colour type that keeps every channel exact ----
function narrow(w, h) {
  const count = w * h, seen = new Map();
  let opaque = true, grey = true, few = true, last = RGBA32[0], run = 0;
  for (let i = 0; i < count; i++) {
    const v = RGBA32[i];
    if (v === last) { run++; continue; }
    if (few) { seen.set(last, (seen.get(last) ?? 0) + run); if (seen.size > 256) few = false; }
    last = v; run = 1;
  }
  if (few) { seen.set(last, (seen.get(last) ?? 0) + run); if (seen.size > 256) few = false; }
  for (let i = 0, j = 0; i < count; i++, j += 4) {
    if (RGBA[j + 3] !== 255) opaque = false;
    if (RGBA[j] !== RGBA[j + 1] || RGBA[j] !== RGBA[j + 2]) grey = false;
    if (!opaque && !grey) break;
  }
  if (grey && opaque) {
    for (let i = 0, j = 0; i < count; i++, j += 4) PIXB[i] = RGBA[j];
    return { type: 0, bpp: 1 };
  }
  if (few) {
    // see-through colours first so tRNS stays short, then the most used first so the backdrop lands on index 0
    const tint = [...seen.keys()].sort((p, q) => {
      const tp = p >>> 24 === 255 ? 1 : 0, tq = q >>> 24 === 255 ? 1 : 0;
      return tp - tq || seen.get(q) - seen.get(p) || p - q;
    });
    const slot = new Map();
    tint.forEach((v, k) => slot.set(v, k));
    let prev = RGBA32[0] ^ 1, at = 0;
    for (let i = 0; i < count; i++) {
      const v = RGBA32[i];
      if (v !== prev) { prev = v; at = slot.get(v); }
      PIXB[i] = at;
    }
    const plte = Buffer.alloc(tint.length * 3);
    let clear = 0;
    tint.forEach((v, k) => {
      plte[k * 3] = v & 255; plte[k * 3 + 1] = (v >>> 8) & 255; plte[k * 3 + 2] = (v >>> 16) & 255;
      if (v >>> 24 !== 255) clear = k + 1;
    });
    const trns = Buffer.alloc(clear);
    for (let k = 0; k < clear; k++) trns[k] = tint[k] >>> 24;
    return { type: 3, bpp: 1, plte, trns };
  }
  if (grey) {
    for (let i = 0, j = 0; i < count; i++, j += 4) { PIXB[2 * i] = RGBA[j]; PIXB[2 * i + 1] = RGBA[j + 3]; }
    return { type: 4, bpp: 2 };
  }
  if (opaque) {
    for (let i = 0, j = 0, k = 0; i < count; i++, j += 4, k += 3) { PIXB[k] = RGBA[j]; PIXB[k + 1] = RGBA[j + 1]; PIXB[k + 2] = RGBA[j + 2]; }
    return { type: 2, bpp: 3 };
  }
  return { type: 6, bpp: 4 };
}

// ---- the five PNG filters, each kept as a whole filtered image so rows can be mixed freely ----
function filterAll(line, h, bpp) {
  const [f0, f1, f2, f3, f4] = FILT, step = line + 1, PIX = bpp === 4 ? RGBA : PIXB;
  for (let y = 0; y < h; y++) {
    const o = y * step, r = y * line, up = r - line;
    f0[o] = 0; f1[o] = 1; f2[o] = 2; f3[o] = 3; f4[o] = 4;
    for (let x = 0; x < line; x++) {
      const v = PIX[r + x], a = x >= bpp ? PIX[r + x - bpp] : 0, b = y ? PIX[up + x] : 0, c = y && x >= bpp ? PIX[up + x - bpp] : 0;
      const p = a + b - c, pa = p > a ? p - a : a - p, pb = p > b ? p - b : b - p, pc = p > c ? p - c : c - p;
      const t = o + 1 + x;
      f0[t] = v; f1[t] = v - a; f2[t] = v - b; f3[t] = v - ((a + b) >> 1);
      f4[t] = v - (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
    }
  }
}

// ---- row filter choice: price every row under every filter, then walk the cheapest path with a switch fee ----
function priceRows(step, h, back) {
  const price = new Float64Array(h * 5);
  for (let f = 0; f < 5; f++) {
    const img = FILT[f];
    for (let y = 0; y < h; y++) {
      const o = y * step, from = Math.max(0, o - back * step);
      const opt = { level: 6, windowBits: 14, memLevel: 7, chunkSize: 2048, dictionary: y ? img.subarray(from, o) : undefined };
      price[y * 5 + f] = deflateRawSync(img.subarray(o, o + step), opt).length;
    }
  }
  return price;
}
function cheapestPath(price, h, fee) {
  const from = new Uint8Array(h * 5), pick = new Uint8Array(h);
  let acc = new Float64Array(5), nxt = new Float64Array(5);
  for (let f = 0; f < 5; f++) acc[f] = price[f];
  for (let y = 1; y < h; y++) {
    let low = 0;
    for (let f = 1; f < 5; f++) if (acc[f] < acc[low]) low = f;
    for (let f = 0; f < 5; f++) {
      const stay = acc[f] <= acc[low] + fee;
      nxt[f] = (stay ? acc[f] : acc[low] + fee) + price[y * 5 + f];
      from[y * 5 + f] = stay ? f : low;
    }
    const t = acc; acc = nxt; nxt = t;
  }
  let f = 0;
  for (let g = 1; g < 5; g++) if (acc[g] < acc[f]) f = g;
  for (let y = h - 1; y >= 0; y--) { pick[y] = f; f = from[y * 5 + f]; }
  return pick;
}
function assemble(pick, step, h, into) {
  for (let y = 0; y < h; y++) { const o = y * step; into.set(FILT[pick[y]].subarray(o, o + step), o); }
}

// ---- writing the PNG ----
function chunk(tag, body) {
  const out = Buffer.alloc(body.length + 12);
  out.writeUInt32BE(body.length, 0); out.write(tag, 4, 'latin1'); out.set(body, 8);
  out.writeUInt32BE(crc(out, 4, body.length + 8), body.length + 8);
  return out;
}
function writePng(w, h, form, stream) {
  const head = Buffer.alloc(13);
  head.writeUInt32BE(w, 0); head.writeUInt32BE(h, 4); head[8] = 8; head[9] = form.type;
  const list = [Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', head)];
  if (form.type === 3) { list.push(chunk('PLTE', form.plte)); if (form.trns.length) list.push(chunk('tRNS', form.trns)); }
  list.push(chunk('IDAT', stream), chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(list);
}

// ---- DEFLATE alphabets ----
const LBASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LXB = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DBASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DXB = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
const LSYM = new Uint8Array(259), DSYM = new Uint8Array(32769);
for (let s = 0; s < 29; s++) for (let l = LBASE[s]; l < (s < 28 ? LBASE[s + 1] : 259); l++) LSYM[l] = s;
for (let s = 0; s < 30; s++) for (let d = DBASE[s]; d < (s < 29 ? DBASE[s + 1] : 32769); d++) DSYM[d] = s;
const fixedLen = (s) => (s < 144 ? 8 : s < 256 ? 9 : s < 280 ? 7 : 8);

// ---- coder memory ----
const ALPHA = 316, MAXB = 1500, MAXE = 8;
let PREV, HEAD, REP, RUNA, RUNB, NUM, POOL, ML, MD, COST, SL, SD, OB;
const HIST = new Uint32Array((MAXB + 2) * ALPHA), BP = new Int32Array(MAXB + 3), DH = new Uint32Array(32769);
function reserveCoder(n, ab) {
  PREV = new Uint16Array(n); HEAD = new Int32Array(1 << 17);
  REP = new Uint16Array(n + 1); RUNA = new Uint16Array(n + 1); RUNB = new Uint16Array(n + 1);
  NUM = new Uint8Array(n + 1); POOL = Math.floor(n * 3.5); ML = new Uint16Array(POOL); MD = new Uint16Array(POOL);
  COST = new Float32Array(ab, 0, n + 1); SL = new Uint16Array(ab, 4 * n + 4, n + 1); SD = new Uint16Array(ab, 6 * n + 6, n + 1);
  OB = new Uint8Array(n + (n >>> 3) + 4096);
}

// ---- match search: one pass, results kept for every later parse ----
// A position inside a pixel run is chained with others that have the same run left, so the chain leads to places
// where the run ends the same way instead of wading through the run itself.
function findMatches(data, n, bpp, step, depth) {
  REP[n] = 0;
  for (let i = n - 1; i >= 0; i--) REP[i] = i + bpp < n && data[i] === data[i + bpp] ? (REP[i + 1] < 65535 ? REP[i + 1] + 1 : 65535) : 0;
  for (let i = n - 1, t = 0; i >= 0; i--) { t = i >= step && data[i] === data[i - step] ? (t < 258 ? t + 1 : 258) : 0; RUNA[i] = t; }
  HEAD.fill(-1);
  const keyOf = (i) => {
    const r = REP[i];
    return (Math.imul(data[i] | (data[i + 1] << 8) | (data[i + 2] << 16), 0x9e3779b1) + Math.imul(r > 2 ? (r > 255 ? 255 : r) : 0, 0x85ebca6b)) >>> 15;
  };
  let q = 0, i = 0, pl = 0, pd = 0, room = MAXE;
  while (i < n) {
    const maxL = n - i < 258 ? n - i : 258;
    let cnt = 0, best = 2, bd = 0;
    if (maxL >= 3) {
      if (q + MAXE + (n - i) >= POOL) room = 1;
      let r = i >= bpp ? REP[i - bpp] : 0;
      if (r > maxL) r = maxL;
      if (r >= 3) { ML[q] = r; MD[q] = bpp; cnt = 1; best = r; bd = bpp; }
      const s = RUNA[i];
      if (best < maxL) {
        let p = HEAD[keyOf(i)], steps = s === 258 ? 8 : depth;
        const floor = i > 32768 ? i - 32768 : 0;
        while (p >= floor && steps-- > 0) {
          if (data[p + best] === data[i + best]) {
            let k = i - p === pd && pl > 1 ? pl - 1 : 0;
            while (k < maxL && data[p + k] === data[i + k]) k++;
            if (k > best) {
              if (cnt < room) cnt++;
              ML[q + cnt - 1] = k; MD[q + cnt - 1] = i - p; best = k; bd = i - p;
              if (k === maxL) break;
            }
          }
          const gap = PREV[p];
          if (!gap) break;
          p -= gap;
        }
      }
      if (s > best) { if (cnt < room) cnt++; ML[q + cnt - 1] = s; MD[q + cnt - 1] = step; best = s; bd = step; }
      const key = keyOf(i), gap = i - HEAD[key];
      PREV[i] = HEAD[key] >= 0 && gap < 65536 ? gap : 0; HEAD[key] = i;
    }
    if (best === 258) {
      // a full-length match: take it and jump, every later parse jumps the same way
      ML[q] = 258; MD[q] = bd; NUM[i] = 1; q++;
      for (let j = i + 1, stop = Math.min(i + 258, n - 2); j < stop; j++) { const key = keyOf(j), gap = j - HEAD[key]; PREV[j] = HEAD[key] >= 0 && gap < 65536 ? gap : 0; HEAD[key] = j; }
      i += 258; pl = 0;
    } else { NUM[i] = cnt; q += cnt; pl = best > 2 ? best : 0; pd = bd; i++; }
  }
}

// ---- symbol prices ----
const LIT = new Float64Array(256), LENC = new Float64Array(259), DISTC = new Float64Array(32769), PL = new Float64Array(286), PD = new Float64Array(30);
function priceFrom(o) {
  if (o < 0) { for (let s = 0; s < 286; s++) PL[s] = fixedLen(s); PD.fill(5); }
  else {
    let tl = 143, td = 15;
    for (let s = 0; s < 286; s++) tl += HIST[o + s];
    for (let s = 0; s < 30; s++) td += HIST[o + 286 + s];
    const al = Math.log2(tl), ad = Math.log2(td);
    for (let s = 0; s < 286; s++) PL[s] = al - Math.log2(HIST[o + s] + 0.5);
    for (let s = 0; s < 30; s++) PD[s] = ad - Math.log2(HIST[o + 286 + s] + 0.5);
  }
  for (let b = 0; b < 256; b++) LIT[b] = PL[b];
  for (let l = 3; l < 259; l++) LENC[l] = PL[257 + LSYM[l]] + LXB[LSYM[l]];
  for (let s = 0; s < 30; s++) DISTC.fill(PD[s] + DXB[s], DBASE[s], s < 29 ? DBASE[s + 1] : 32769);
}

// ---- shortest-path parse over the kept matches; `far` is a second favourite distance (0 when there is none) ----
function parse(data, n, fixed, step, far) {
  COST.fill(Infinity, 0, n + 1); COST[0] = 0;
  let i = 0, q = 0, k = 0, edge = 0;
  while (i < n) {
    if (i >= edge) { while (BP[k + 1] <= i) k++; priceFrom(fixed ? -1 : k * ALPHA); edge = BP[k + 1]; }
    const cnt = NUM[i], base = COST[i], fa = RUNA[i], fb = far ? RUNB[i] : 0;
    if (cnt === 1 && ML[q] === 258) {
      let d = MD[q], dc = DISTC[d];
      if (fa === 258 && DISTC[step] < dc) { d = step; dc = DISTC[step]; }
      if (fb === 258 && DISTC[far] < dc) { d = far; dc = DISTC[far]; }
      const j = i + 258, v = base + LENC[258] + dc;
      if (v < COST[j]) { COST[j] = v; SL[j] = 258; SD[j] = d; }
      q++; i = j;
      continue;
    }
    const v = base + LIT[data[i]];
    if (v < COST[i + 1]) { COST[i + 1] = v; SL[i + 1] = 1; }
    let lo = 3;
    for (let e = q, end = q + cnt; e <= end; e++) {
      let hi, d, dc;
      if (e < end) { hi = ML[e]; d = MD[e]; dc = DISTC[d]; }
      else { hi = fa > fb ? fa : fb; if (hi < lo) break; d = 0; dc = Infinity; }
      while (lo <= hi) {
        let bd = d, bc = dc, stop = hi;
        if (fa >= lo && DISTC[step] < bc) { bc = DISTC[step]; bd = step; stop = fa < hi ? fa : hi; }
        if (fb >= lo && DISTC[far] < bc) { bc = DISTC[far]; bd = far; stop = fb < hi ? fb : hi; }
        const t = base + bc;
        for (; lo <= stop; lo++) { const w = t + LENC[lo], j = i + lo; if (w < COST[j]) { COST[j] = w; SL[j] = lo; SD[j] = bd; } }
      }
    }
    q += cnt; i++;
  }
  // turn the arrival records into forward steps, in place
  for (let j = n, L = SL[n], D = SD[n]; j > 0;) { const p = j - L, nl = SL[p], nd = SD[p]; SL[p] = L; SD[p] = D; j = p; L = nl; D = nd; }
}
function tally(data, n, nb) {
  HIST.fill(0, 0, nb * ALPHA);
  for (let p = 0, k = 0; p < n;) {
    while (BP[k + 1] <= p) k++;
    const o = k * ALPHA, L = SL[p];
    if (L === 1) { HIST[o + data[p]]++; p++; } else { HIST[o + 257 + LSYM[L]]++; HIST[o + 286 + DSYM[SD[p]]]++; p += L; }
  }
  for (let k = 0; k < nb; k++) HIST[k * ALPHA + 256] = 1;
}
function favourite(data, n, bpp, step) {
  DH.fill(0);
  for (let p = 0; p < n;) { const L = SL[p]; if (L > 1) DH[SD[p]]++; p += L; }
  let far = 0, top = 15;
  for (let d = bpp + 1; d < 32769; d++) if (d !== step && DH[d] > top) { top = DH[d]; far = d; }
  if (far) for (let i = n - 1, t = 0; i >= 0; i--) { t = i >= far && data[i] === data[i - far] ? (t < 258 ? t + 1 : 258) : 0; RUNB[i] = t; }
  return far;
}

// ---- Huffman code lengths with a length cap ----
const HK = new Float64Array(288), HW = new Float64Array(576), HP = new Int32Array(576), HD = new Int32Array(576), HC = new Int32Array(16);
function codeLengths(f, o, n, cap, out) {
  let m = 0;
  for (let s = 0; s < n; s++) { out[s] = 0; const v = f[o + s]; if (v) HK[m++] = v * 512 + s; }
  if (m < 2) { const s = m ? HK[0] % 512 : 0; out[s] = 1; out[s ? 0 : 1] = 1; return; }
  HK.subarray(0, m).sort();
  for (let i = 0; i < m; i++) HW[i] = Math.floor(HK[i] / 512);
  for (let e = m, a = 0, b = m; e < 2 * m - 1; e++) {
    let w = 0;
    for (let t = 0; t < 2; t++) {
      if (a < m && (b >= e || HW[a] <= HW[b])) { w += HW[a]; HP[a++] = e; } else { w += HW[b]; HP[b++] = e; }
    }
    HW[e] = w;
  }
  HC.fill(0); HD[2 * m - 2] = 0;
  for (let i = 2 * m - 3; i >= 0; i--) { const d = HD[HP[i]] + 1; HD[i] = d; if (i < m) HC[d < cap ? d : cap]++; }
  let total = 0;
  for (let d = 1; d <= cap; d++) total += HC[d] << (cap - d);
  while (total > 1 << cap) {
    HC[cap]--;
    for (let d = cap - 1; d > 0; d--) if (HC[d]) { HC[d]--; HC[d + 1] += 2; break; }
    total--;
  }
  for (let d = cap, i = 0; d > 0; d--) for (let c = HC[d]; c > 0; c--) out[HK[i++] % 512] = d;
}

// ---- exact size of one block, leaving its code lengths and header tokens behind for the writer ----
const LN = new Uint8Array(286), DN = new Uint8Array(30), CN = new Uint8Array(19), CF = new Uint32Array(19), CAT = new Uint8Array(ALPHA), TS = new Uint8Array(320), TX = new Uint8Array(320);
let tokens = 0, hlit = 0, hdist = 0, hclen = 0, useFixed = false;
function blockBits(h, o) {
  codeLengths(h, o, 286, 15, LN); codeLengths(h, o + 286, 30, 15, DN);
  hlit = 286; while (hlit > 257 && !LN[hlit - 1]) hlit--;
  hdist = 30; while (hdist > 1 && !DN[hdist - 1]) hdist--;
  let extra = 0, dyn = 0, fix = 0;
  for (let s = 0; s < 286; s++) { const v = h[o + s]; if (v) { dyn += v * LN[s]; fix += v * fixedLen(s); if (s > 264) extra += v * LXB[s - 257]; } }
  for (let s = 0; s < 30; s++) { const v = h[o + 286 + s]; if (v) { dyn += v * DN[s]; fix += v * 5; extra += v * DXB[s]; } }
  for (let i = 0; i < hlit; i++) CAT[i] = LN[i];
  for (let i = 0; i < hdist; i++) CAT[hlit + i] = DN[i];
  tokens = 0; CF.fill(0);
  let xb = 0;
  for (let i = 0, T = hlit + hdist; i < T;) {
    const v = CAT[i];
    let run = 1;
    while (i + run < T && CAT[i + run] === v) run++;
    i += run;
    if (!v) {
      while (run >= 11) { const k = run < 138 ? run : 138; TS[tokens] = 18; TX[tokens++] = k - 11; CF[18]++; xb += 7; run -= k; }
      if (run >= 3) { TS[tokens] = 17; TX[tokens++] = run - 3; CF[17]++; xb += 3; run = 0; }
    } else {
      TS[tokens++] = v; CF[v]++; run--;
      while (run >= 3) { const k = run < 6 ? run : 6; TS[tokens] = 16; TX[tokens++] = k - 3; CF[16]++; xb += 2; run -= k; }
    }
    while (run-- > 0) { TS[tokens++] = v; CF[v]++; }
  }
  codeLengths(CF, 0, 19, 7, CN);
  hclen = 19; while (hclen > 4 && !CN[ORDER[hclen - 1]]) hclen--;
  dyn += 14 + 3 * hclen + xb;
  for (let s = 0; s < 19; s++) dyn += CF[s] * CN[s];
  useFixed = fix < dyn;
  return 3 + extra + (useFixed ? fix : dyn);
}
function totalBits(nb) { let t = 0; for (let k = 0; k < nb; k++) t += blockBits(HIST, k * ALPHA); return t; }

// ---- block splitting: start from small slices of the symbol stream and keep merging the pair that saves most ----
const NXB = new Int32Array(MAXB + 2), PVB = new Int32Array(MAXB + 2), COB = new Float64Array(MAXB + 2), SVB = new Float64Array(MAXB + 2), MCB = new Float64Array(MAXB + 2), TH = new Uint32Array(ALPHA);
function split(data, n) {
  let syms = 0;
  for (let p = 0; p < n; p += SL[p]) syms++;
  const per = Math.max(64, Math.ceil(syms / MAXB));
  let nb = 0;
  BP[0] = 0;
  for (let p = 0, c = 0; p < n; p += SL[p]) { if (c === per) { BP[++nb] = p; c = 0; } c++; }
  BP[++nb] = n;
  tally(data, n, nb);
  const pair = (i) => {
    const a = i * ALPHA, b = NXB[i] * ALPHA;
    for (let s = 0; s < ALPHA; s++) TH[s] = HIST[a + s] + HIST[b + s];
    TH[256] = 1;
    MCB[i] = blockBits(TH, 0); SVB[i] = COB[i] + COB[NXB[i]] - MCB[i];
  };
  for (let i = 0; i < nb; i++) { NXB[i] = i + 1; PVB[i] = i - 1; COB[i] = blockBits(HIST, i * ALPHA); }
  for (let i = 0; i + 1 < nb; i++) pair(i);
  for (;;) {
    let at = -1, gain = 0;
    for (let i = 0; NXB[i] < nb; i = NXB[i]) if (SVB[i] > gain) { gain = SVB[i]; at = i; }
    if (at < 0) break;
    const j = NXB[at], a = at * ALPHA, b = j * ALPHA;
    for (let s = 0; s < ALPHA; s++) HIST[a + s] += HIST[b + s];
    HIST[a + 256] = 1; COB[at] = MCB[at]; NXB[at] = NXB[j];
    if (NXB[j] < nb) { PVB[NXB[j]] = at; pair(at); }
    if (at > 0) pair(PVB[at]);
  }
  let m = 0;
  for (let i = 0; i < nb; i = NXB[i]) BP[m++] = BP[i];
  BP[m] = n;
  return m;
}

// ---- bit writer ----
const BLC = new Int32Array(16), NXT = new Int32Array(16);
const LCODE = new Uint16Array(288), DCODE = new Uint16Array(30), CCODE = new Uint16Array(19);
const FLEN = new Uint8Array(288), FDLEN = new Uint8Array(30).fill(5), FCODE = new Uint16Array(288), FDCODE = new Uint16Array(30);
function assign(len, n, code) {
  BLC.fill(0);
  for (let s = 0; s < n; s++) BLC[len[s]]++;
  BLC[0] = 0;
  for (let b = 1, c = 0; b < 16; b++) { c = (c + BLC[b - 1]) << 1; NXT[b] = c; }
  for (let s = 0; s < n; s++) {
    const l = len[s];
    if (!l) continue;
    let v = NXT[l]++, r = 0;
    for (let k = 0; k < l; k++) { r = (r << 1) | (v & 1); v >>= 1; }
    code[s] = r;
  }
}
for (let s = 0; s < 288; s++) FLEN[s] = fixedLen(s);
assign(FLEN, 288, FCODE); assign(FDLEN, 30, FDCODE);
let op = 0, acc = 0, fill = 0;
function put(v, bits) {
  acc |= v << fill; fill += bits;
  while (fill >= 8) { OB[op++] = acc & 255; acc >>>= 8; fill -= 8; }
}
function emit(data, nb) {
  op = 2; acc = 0; fill = 0;
  for (let k = 0, p = 0; k < nb; k++) {
    blockBits(HIST, k * ALPHA);
    let ll = FLEN, lc = FCODE, dl = FDLEN, dc = FDCODE;
    put(k === nb - 1 ? 1 : 0, 1);
    if (useFixed) put(1, 2);
    else {
      put(2, 2); put(hlit - 257, 5); put(hdist - 1, 5); put(hclen - 4, 4);
      for (let i = 0; i < hclen; i++) put(CN[ORDER[i]], 3);
      assign(CN, 19, CCODE);
      for (let t = 0; t < tokens; t++) { const s = TS[t]; put(CCODE[s], CN[s]); if (s > 15) put(TX[t], s === 16 ? 2 : s === 17 ? 3 : 7); }
      assign(LN, 286, LCODE); assign(DN, 30, DCODE);
      ll = LN; lc = LCODE; dl = DN; dc = DCODE;
    }
    for (const stop = BP[k + 1]; p < stop;) {
      const L = SL[p];
      if (L === 1) { const b = data[p]; put(lc[b], ll[b]); p++; continue; }
      const s = LSYM[L], d = SD[p], t = DSYM[d];
      put(lc[257 + s], ll[257 + s]); if (LXB[s]) put(L - LBASE[s], LXB[s]);
      put(dc[t], dl[t]); if (DXB[t]) put(d - DBASE[t], DXB[t]);
      p += L;
    }
    put(lc[256], ll[256]);
  }
  if (fill) OB[op++] = acc & 255;
  return op;
}

let WORK = 3e8;
// ---- the coder: a quick size estimate for comparing filter plans, or the full effort for the final stream ----
function code(data, n, bpp, step, depth, rounds) {
  findMatches(data, n, bpp, step, depth);
  BP[0] = 0; BP[1] = n;
  parse(data, n, true, step, 0); tally(data, n, 1);
  const far = favourite(data, n, bpp, step);
  parse(data, n, false, step, far); tally(data, n, 1);
  if (!rounds) return blockBits(HIST, 0);
  parse(data, n, false, step, far); tally(data, n, 1);
  const nb = split(data, n);
  tally(data, n, nb);
  let least = totalBits(nb), size = emit(data, nb);
  // more parse rounds while they still pay, inside a fixed allowance of work for the whole set
  for (let r = 0, idle = 0; r < rounds && idle < 2 && (r < 2 || WORK > 0); r++) {
    WORK -= n;
    parse(data, n, false, step, far); tally(data, n, nb);
    const bits = totalBits(nb);
    idle = least - bits > least / 5000 ? 0 : idle + 1;
    if (bits < least) { least = bits; size = emit(data, nb); }
  }
  return size;
}
function pack(data, n, bpp, step) {
  const size = code(data, n, bpp, step, 192 * Math.round(CAP / n), 40);
  OB[0] = 0x78; OB[1] = 0xda;
  const sum = adler(data, n);
  OB[size] = sum >>> 24; OB[size + 1] = (sum >>> 16) & 255; OB[size + 2] = (sum >>> 8) & 255; OB[size + 3] = sum & 255;
  const own = Buffer.from(OB.buffer, 0, size + 4), plain = Buffer.from(data.buffer, data.byteOffset, n);
  const ref = deflateSync(plain, { level: 9, memLevel: 9 });
  let good = false;
  try { good = inflateSync(own, { chunkSize: 1 << 22 }).equals(plain); } catch {}
  return good && own.length < ref.length ? own : ref;
}

function squeeze(file) {
  const { w, h } = readStored(file);
  const form = narrow(w, h), line = w * form.bpp, step = line + 1, n = step * h;
  filterAll(line, h, form.bpp);
  const price = priceRows(step, h, Math.max(1, Math.floor(8000 / step)));
  const plans = [cheapestPath(price, h, 80), cheapestPath(price, h, 200), new Uint8Array(h)];
  let bestBits = Infinity, bestPlan = null;
  const tried = [];
  const consider = (plan) => {
    if (tried.some((t) => t.every((v, y) => v === plan[y]))) return;
    tried.push(plan);
    assemble(plan, step, h, CAND);
    const bits = deflateRawSync(CAND.subarray(0, n), { level: 7, memLevel: 9 }).length;
    if (bits < bestBits) { bestBits = bits; bestPlan = plan; const t = BEST; BEST = CAND; CAND = t; }
  };
  plans.forEach(consider);
  // a row that repeats the one above it becomes a run of zeros under Up
  const twin = Uint8Array.from(bestPlan);
  for (let y = 1; y < h; y++) {
    let same = true;
    for (let x = 0, o = y * step + 1; x < line; x++) if (FILT[0][o + x] !== FILT[0][o + x - step]) { same = false; break; }
    if (same) twin[y] = 2;
  }
  consider(twin);
  return writePng(w, h, form, pack(BEST, n, form.bpp, step));
}

for (const id of readdirSync(IN).sort()) {
  mkdirSync(join(OUT, id), { recursive: true });
  const src = join(IN, id, 'image.png'), dst = join(OUT, id, 'image.png');
  try { writeFileSync(dst, squeeze(readFileSync(src))); }
  catch { copyFileSync(src, dst); }
}
