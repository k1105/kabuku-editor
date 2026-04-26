/**
 * glyf and loca table writers.
 *
 * Each glyph in glyf is either an "empty glyph" (numContours = 0, nothing else)
 * or a simple glyph encoding contours, points, flags, and packed coordinates.
 */

import { BinaryWriter } from './binary.js';

// Simple-glyph flag bits (OpenType: glyf SimpleGlyphFlags)
const FLAG_ON_CURVE = 0x01;
const FLAG_X_SHORT = 0x02;
const FLAG_Y_SHORT = 0x04;
const FLAG_REPEAT = 0x08;
const FLAG_X_SAME_OR_POSITIVE = 0x10; // when X_SHORT: positive sign; else: same as previous
const FLAG_Y_SAME_OR_POSITIVE = 0x20;

/**
 * Encode a single simple glyph.
 *
 * @param {Object} glyph - { contours, xMin, xMax, yMin, yMax, advanceWidth, lsb }
 *   contours: Array<Array<{x, y, onCurve}>> in absolute font units.
 *   bbox/advance fields are computed by the caller (we recompute bbox here).
 * @returns {{ bytes: Uint8Array, xMin, xMax, yMin, yMax, numPoints }}
 */
export function encodeSimpleGlyph(contours) {
  // Empty glyph (no contours) — emit as an empty body (0 bytes).
  // The loca offset for this glyph equals the previous glyph's end offset.
  const totalPoints = contours.reduce((s, c) => s + c.length, 0);
  if (totalPoints === 0) {
    return { bytes: new Uint8Array(0), xMin: 0, yMin: 0, xMax: 0, yMax: 0, numPoints: 0 };
  }

  let xMin = Infinity, yMin = Infinity, xMax = -Infinity, yMax = -Infinity;
  const flatPts = [];
  const endPts = [];
  for (const contour of contours) {
    for (const p of contour) {
      flatPts.push(p);
      if (p.x < xMin) xMin = p.x;
      if (p.x > xMax) xMax = p.x;
      if (p.y < yMin) yMin = p.y;
      if (p.y > yMax) yMax = p.y;
    }
    endPts.push(flatPts.length - 1);
  }

  const w = new BinaryWriter(64 + flatPts.length * 5);
  w.i16(contours.length);  // numberOfContours (positive = simple)
  w.fword(xMin);
  w.fword(yMin);
  w.fword(xMax);
  w.fword(yMax);

  for (const e of endPts) w.u16(e);
  w.u16(0); // instructionLength

  // Flags + coordinates: pack with run-length encoding for flags, and use
  // short forms for coordinate deltas. We do the simple, safe encoding:
  //   - Flag short forms when delta fits in [-255, +255]
  //   - No flag-repeat compression (correct without optimization)
  //   - Coordinates as deltas from the previous point

  const flagBytes = [];
  const xCoordBytes = []; // raw coord delta bytes (short or long)
  const yCoordBytes = [];

  let prevX = 0, prevY = 0;
  for (const p of flatPts) {
    const dx = p.x - prevX;
    const dy = p.y - prevY;
    let flag = p.onCurve ? FLAG_ON_CURVE : 0;

    if (dx === 0) {
      flag |= FLAG_X_SAME_OR_POSITIVE; // "same as previous"
    } else if (dx >= -255 && dx <= 255) {
      flag |= FLAG_X_SHORT;
      if (dx > 0) flag |= FLAG_X_SAME_OR_POSITIVE;
      xCoordBytes.push(Math.abs(dx));
    } else {
      // long, signed 16-bit
      const v = dx < 0 ? dx + 0x10000 : dx;
      xCoordBytes.push((v >>> 8) & 0xff);
      xCoordBytes.push(v & 0xff);
    }

    if (dy === 0) {
      flag |= FLAG_Y_SAME_OR_POSITIVE;
    } else if (dy >= -255 && dy <= 255) {
      flag |= FLAG_Y_SHORT;
      if (dy > 0) flag |= FLAG_Y_SAME_OR_POSITIVE;
      yCoordBytes.push(Math.abs(dy));
    } else {
      const v = dy < 0 ? dy + 0x10000 : dy;
      yCoordBytes.push((v >>> 8) & 0xff);
      yCoordBytes.push(v & 0xff);
    }

    flagBytes.push(flag);
    prevX = p.x;
    prevY = p.y;
  }

  // Run-length encode identical consecutive flags using the REPEAT bit.
  let i = 0;
  while (i < flagBytes.length) {
    const f = flagBytes[i];
    let runLen = 1;
    while (i + runLen < flagBytes.length && flagBytes[i + runLen] === f && runLen < 255) {
      runLen++;
    }
    if (runLen > 1) {
      w.u8(f | FLAG_REPEAT);
      w.u8(runLen - 1);
    } else {
      w.u8(f);
    }
    i += runLen;
  }

  for (const b of xCoordBytes) w.u8(b);
  for (const b of yCoordBytes) w.u8(b);

  return {
    bytes: w.toUint8Array(),
    xMin, yMin, xMax, yMax,
    numPoints: flatPts.length,
  };
}

/**
 * Build glyf and loca tables from an array of encoded glyphs (Uint8Array each).
 * Each glyph body must be 4-byte-aligned in glyf? Actually OpenType only
 * requires that loca offsets be 2-byte aligned for short format and don't
 * matter for long format. Most fonts use long format and do not pad inner
 * glyph bodies. We use long format and pack with no inter-glyph padding.
 *
 * @param {Uint8Array[]} glyphBodies
 * @returns {{ glyf: Uint8Array, loca: Uint8Array, indexToLocFormat: 0|1 }}
 */
export function buildGlyfAndLoca(glyphBodies) {
  // Each glyph offset must be a multiple of 2 (we use long format -> arbitrary).
  // We'll align each glyph to 4 bytes for safety with both formats.
  const offsets = [];
  let total = 0;
  const padded = glyphBodies.map(body => {
    offsets.push(total);
    const pad = (4 - (body.length % 4)) % 4;
    total += body.length + pad;
    return { body, pad };
  });
  offsets.push(total); // end offset for last glyph

  const glyf = new Uint8Array(total);
  let cursor = 0;
  for (const { body, pad } of padded) {
    glyf.set(body, cursor);
    cursor += body.length + pad;
  }

  // Short format stores offset/2 in a u16, so max addressable = 0xFFFF * 2 = 131070.
  // Switch to long format if any glyph's offset exceeds that.
  const useLong = total > 0x1FFFE;
  const lw = new BinaryWriter(useLong ? offsets.length * 4 : offsets.length * 2);
  if (useLong) {
    for (const o of offsets) lw.u32(o);
  } else {
    for (const o of offsets) lw.u16(o / 2);
  }

  return { glyf, loca: lw.toUint8Array(), indexToLocFormat: useLong ? 1 : 0 };
}
