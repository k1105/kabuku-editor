/**
 * Variable font tables: fvar and gvar.
 *
 * Scope is limited to a single-axis VF (matches our "STRC stretch" axis).
 * The default master is the static glyph; one variation tuple per glyph
 * carries the deltas at the axis's extreme value.
 */

import { BinaryWriter } from './binary.js';

// ─── fvar ───────────────────────────────────────────────────────────────────

/**
 * @param {Object[]} axes - [{ tag (4ch), nameID, minValue, defaultValue, maxValue, flags? }]
 * @param {Object[]} instances - [{ subfamilyNameID, postScriptNameID?, coords: [...] }]
 *                               coords array length must equal axes.length.
 */
export function makeFvar(axes, instances) {
  const axisSize = 20;
  const instanceSize = 4 + axes.length * 4 + (instances[0]?.postScriptNameID != null ? 2 : 0);
  // Use one consistent instance size — include postScriptNameID for all if any.
  const includePsName = instances.some(i => i.postScriptNameID != null);
  const instanceRecSize = 4 + axes.length * 4 + (includePsName ? 2 : 0);

  const headerSize = 16;
  const total = headerSize + axes.length * axisSize + instances.length * instanceRecSize;

  const w = new BinaryWriter(total);
  w.u16(1); w.u16(0);                     // version 1.0
  w.u16(headerSize);                      // axesArrayOffset
  w.u16(2);                               // reserved (count of pairs in axisCount field group)
  w.u16(axes.length);                     // axisCount
  w.u16(axisSize);                        // axisSize
  w.u16(instances.length);                // instanceCount
  w.u16(instanceRecSize);                 // instanceSize

  for (const a of axes) {
    w.tag(a.tag);
    w.fixed(a.minValue);
    w.fixed(a.defaultValue);
    w.fixed(a.maxValue);
    w.u16(a.flags || 0);
    w.u16(a.nameID);
  }
  for (const inst of instances) {
    w.u16(inst.subfamilyNameID);
    w.u16(0);                             // flags
    for (const c of inst.coords) w.fixed(c);
    if (includePsName) w.u16(inst.postScriptNameID || 0);
  }
  return w.toUint8Array();
}

// ─── gvar ───────────────────────────────────────────────────────────────────

// Tuple variation header flags
const EMBEDDED_PEAK_TUPLE = 0x8000;
const INTERMEDIATE_REGION = 0x4000;
const PRIVATE_POINT_NUMBERS = 0x2000;
const TUPLE_INDEX_MASK = 0x0FFF;

// Glyph header flags
const GVAR_SHARED_POINT_NUMBERS = 0x80;
const GVAR_FLAGS_RESERVED = 0x7F;

// Point-numbers packing flags
const POINTS_ARE_WORDS = 0x80;
const POINTS_RUN_COUNT_MASK = 0x7F;

// Delta packing flags
const DELTAS_ARE_ZERO = 0x80;
const DELTAS_ARE_WORDS = 0x40;
const DELTAS_RUN_COUNT_MASK = 0x3F;

/**
 * Build the gvar table.
 *
 * @param {Object} opts
 * @param {number} opts.axisCount
 * @param {Object[]} opts.glyphs - per glyph (in glyf order): { variations: [{ peak: number[], deltas: {x: number[], y: number[]} }] }
 *   Each variation peak is in normalized axis space ([-1, 0, 1]).
 *   deltas.x / deltas.y arrays must have **length = numPoints + 4** (4 phantom points).
 *   For an empty variation set, pass `variations: []`.
 */
export function makeGvar(opts) {
  const { axisCount, glyphs } = opts;
  const numGlyphs = glyphs.length;

  // Per-glyph variation data: each body is padded to its own 4-byte boundary,
  // so the bytes stored for glyph i = body.length + intra-glyph pad.
  const glyphBodies = glyphs.map(g => buildGlyphVariationData(g.variations, axisCount));
  const paddedSizes = glyphBodies.map(b => b.length + ((4 - b.length % 4) % 4));

  const offsets = [];
  let total = 0;
  for (const size of paddedSizes) {
    offsets.push(total);
    total += size;
  }
  offsets.push(total); // sentinel end offset

  // Choose offset format: 0 = u16 (offset / 2), 1 = u32
  const useLong = total > 0x1FFFF;
  const offsetSize = useLong ? 4 : 2;

  // Header: 4 (version) + 2*4 (axisCount, sharedTupleCount, sharedTuplesOffset, glyphCount) + 2 (flags) + 4 (glyphVariationDataArrayOffset) = 20
  const headerSize = 20;
  const offsetTableSize = (numGlyphs + 1) * offsetSize;
  const sharedTuplesOffset = headerSize + offsetTableSize; // we have 0 shared tuples; leave offset pointing here
  const dataArrayOffset = sharedTuplesOffset; // shared tuples are empty so data starts here

  const finalSize = dataArrayOffset + total;
  const w = new BinaryWriter(finalSize);

  // Header
  w.u16(1); w.u16(0);             // version 1.0
  w.u16(axisCount);
  w.u16(0);                       // sharedTupleCount
  w.u32(sharedTuplesOffset);
  w.u16(numGlyphs);
  w.u16(useLong ? 1 : 0);         // flags: bit 0 = long offsets
  w.u32(dataArrayOffset);

  // Offsets
  for (const o of offsets) {
    if (useLong) w.u32(o);
    else w.u16(o / 2);
  }
  // Shared tuples are zero, so nothing to emit.

  // Glyph bodies — each padded to 4-byte boundary based on its own length.
  for (let i = 0; i < glyphBodies.length; i++) {
    const body = glyphBodies[i];
    w.bytes(body);
    const pad = paddedSizes[i] - body.length;
    for (let p = 0; p < pad; p++) w.u8(0);
  }
  return w.toUint8Array();
}

/**
 * Build the variation data for one glyph: header + per-tuple variation data.
 * Returns the bytes (or empty Uint8Array if no variations).
 */
function buildGlyphVariationData(variations, axisCount) {
  if (!variations || variations.length === 0) {
    return new Uint8Array(0);
  }

  // Build each tuple's serialized data first.
  const tupleHeaders = [];
  const tupleBodies = [];
  for (const v of variations) {
    const body = buildTupleBody(v.deltas);
    tupleBodies.push(body);
    tupleHeaders.push({ peak: v.peak, dataSize: body.length });
  }

  // Per-glyph header layout:
  //   u16  tupleVariationCount   (top bit: SHARED_POINT_NUMBERS; lower bits = count)
  //   u16  dataOffset            (offset to serialized data, from start of glyph header)
  //   tupleVariationHeader[count]:
  //     u16 variationDataSize
  //     u16 tupleIndex
  //     [F2DOT14 * axisCount peakTuple] if EMBEDDED_PEAK_TUPLE
  //     [F2DOT14 * axisCount intermediate start, end] if INTERMEDIATE_REGION
  //   serialized data (private point numbers + packed deltas) per tuple

  const headerHeaderSize = 4;
  const perTupleHeaderSize = 4 + 2 * axisCount; // includes embedded peak tuple
  const headersSize = headerHeaderSize + tupleHeaders.length * perTupleHeaderSize;

  // Total tuple data size
  const totalDataSize = tupleBodies.reduce((s, b) => s + b.length, 0);

  const w = new BinaryWriter(headersSize + totalDataSize);
  w.u16(tupleHeaders.length);     // tupleVariationCount (no shared points)
  w.u16(headersSize);              // dataOffset

  for (const h of tupleHeaders) {
    w.u16(h.dataSize);             // variationDataSize
    w.u16(EMBEDDED_PEAK_TUPLE | PRIVATE_POINT_NUMBERS); // private points + embedded peak
    for (let i = 0; i < axisCount; i++) {
      w.f2dot14(h.peak[i] || 0);
    }
  }
  for (const b of tupleBodies) w.bytes(b);
  return w.toUint8Array();
}

/**
 * Serialize the per-tuple data: packed point numbers (we use ALL_POINTS=0)
 * + packed X deltas + packed Y deltas.
 *
 * For simplicity we always emit "all points" (zero byte for the point-numbers
 * count, which means "all points covered"). Deltas are then packed verbatim.
 */
function buildTupleBody(deltas) {
  const w = new BinaryWriter(deltas.x.length * 2 + 8);
  // Point-numbers prefix: a single byte 0x00 means "all points apply"
  w.u8(0);
  packDeltas(w, deltas.x);
  packDeltas(w, deltas.y);
  return w.toUint8Array();
}

/**
 * Run-length encode an array of integer deltas using the gvar packing rules:
 *  - DELTAS_ARE_ZERO (0x80): next N+1 deltas are all zero (no payload bytes)
 *  - DELTAS_ARE_WORDS (0x40): next N+1 deltas as int16
 *  - else: next N+1 deltas as int8
 */
function packDeltas(w, deltas) {
  let i = 0;
  while (i < deltas.length) {
    // Try zero run
    if (deltas[i] === 0) {
      let runEnd = i;
      while (runEnd < deltas.length && deltas[runEnd] === 0 && runEnd - i < 64) runEnd++;
      const count = runEnd - i;
      w.u8(DELTAS_ARE_ZERO | (count - 1));
      i = runEnd;
      continue;
    }

    // Decide between byte run and word run by looking at the next delta
    const isWord = (v) => v < -128 || v > 127;
    if (!isWord(deltas[i])) {
      let runEnd = i;
      while (runEnd < deltas.length && !isWord(deltas[runEnd]) && deltas[runEnd] !== 0 && runEnd - i < 64) runEnd++;
      const count = runEnd - i;
      w.u8(count - 1); // byte form, no flag bits
      for (let k = i; k < runEnd; k++) {
        const v = deltas[k];
        w.u8(v < 0 ? v + 256 : v);
      }
      i = runEnd;
    } else {
      let runEnd = i;
      while (runEnd < deltas.length && isWord(deltas[runEnd]) && deltas[runEnd] !== 0 && runEnd - i < 64) runEnd++;
      const count = runEnd - i;
      w.u8(DELTAS_ARE_WORDS | (count - 1));
      for (let k = i; k < runEnd; k++) {
        const v = deltas[k];
        w.i16(v);
      }
      i = runEnd;
    }
  }
}
