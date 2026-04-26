/**
 * Standard TTF table writers: head, hhea, maxp, OS/2, post, name, cmap, hmtx.
 *
 * Kept intentionally minimal: all tables target a single VF face that lives
 * inside a multi-file family. Style attributes (italic / weight) come from
 * the caller.
 */

import { BinaryWriter } from './binary.js';

// ─── head ───────────────────────────────────────────────────────────────────

/**
 * @param {Object} opts
 * @param {number} opts.unitsPerEm
 * @param {number} opts.xMin global glyph bbox
 * @param {number} opts.yMin
 * @param {number} opts.xMax
 * @param {number} opts.yMax
 * @param {0|1} opts.indexToLocFormat - matches loca format
 */
export function makeHead(opts) {
  const w = new BinaryWriter(54);
  // Seconds from 1904-01-01 to 1970-01-01 = 2082844800
  const created = 2082844800 + Math.floor(Date.now() / 1000);
  const modified = created;

  w.fixed(1.0);                 // version 1.0
  w.fixed(1.0);                 // fontRevision
  w.u32(0);                     // checkSumAdjustment (patched later by sfnt builder)
  w.u32(0x5F0F3CF5);            // magicNumber
  w.u16(0x0003);                // flags: bit0 = baseline at y=0, bit1 = lsb at x=0
  w.u16(opts.unitsPerEm);       // unitsPerEm
  w.longDateTime(created);
  w.longDateTime(modified);
  w.fword(opts.xMin);
  w.fword(opts.yMin);
  w.fword(opts.xMax);
  w.fword(opts.yMax);
  w.u16(0);                     // macStyle: regular (italic / bold via OS/2 instead)
  w.u16(8);                     // lowestRecPPEM
  w.i16(2);                     // fontDirectionHint (deprecated; 2 = legacy default)
  w.u16(opts.indexToLocFormat); // 0 short, 1 long
  w.u16(0);                     // glyphDataFormat
  return w.toUint8Array();
}

// ─── hhea ───────────────────────────────────────────────────────────────────

export function makeHhea(opts) {
  const w = new BinaryWriter(36);
  w.fixed(1.0);
  w.fword(opts.ascender);
  w.fword(opts.descender);
  w.fword(opts.lineGap || 0);
  w.ufword(opts.advanceWidthMax);
  w.fword(opts.xMin);            // minLeftSideBearing
  w.fword(opts.xMin);            // minRightSideBearing
  w.fword(opts.xMax);            // xMaxExtent
  w.i16(1);                      // caretSlopeRise
  w.i16(0);                      // caretSlopeRun
  w.fword(0);                    // caretOffset
  w.i16(0); w.i16(0); w.i16(0); w.i16(0); // reserved
  w.i16(0);                      // metricDataFormat
  w.u16(opts.numberOfHMetrics);
  return w.toUint8Array();
}

// ─── maxp ───────────────────────────────────────────────────────────────────

/** TT-flavored maxp version 1.0. */
export function makeMaxp(opts) {
  const w = new BinaryWriter(32);
  w.fixed(1.0);
  w.u16(opts.numGlyphs);
  w.u16(opts.maxPoints);
  w.u16(opts.maxContours);
  w.u16(0);  // maxCompositePoints
  w.u16(0);  // maxCompositeContours
  w.u16(2);  // maxZones
  w.u16(0);  // maxTwilightPoints
  w.u16(0);  // maxStorage
  w.u16(0);  // maxFunctionDefs
  w.u16(0);  // maxInstructionDefs
  w.u16(0);  // maxStackElements
  w.u16(0);  // maxSizeOfInstructions
  w.u16(0);  // maxComponentElements
  w.u16(0);  // maxComponentDepth
  return w.toUint8Array();
}

// ─── OS/2 ───────────────────────────────────────────────────────────────────

export function makeOS2(opts) {
  const w = new BinaryWriter(96);
  w.u16(4);                       // version
  w.i16(opts.xAvgCharWidth);
  w.u16(opts.usWeightClass || 400);
  w.u16(opts.usWidthClass || 5);
  w.u16(0);                       // fsType: installable embedding
  // Subscript / superscript / strikeout (reasonable defaults relative to em)
  const em = opts.unitsPerEm;
  w.i16(Math.round(em * 0.65));   // ySubscriptXSize
  w.i16(Math.round(em * 0.6));    // ySubscriptYSize
  w.i16(0);                       // ySubscriptXOffset
  w.i16(Math.round(em * 0.075));  // ySubscriptYOffset
  w.i16(Math.round(em * 0.65));   // ySuperscriptXSize
  w.i16(Math.round(em * 0.6));    // ySuperscriptYSize
  w.i16(0);                       // ySuperscriptXOffset
  w.i16(Math.round(em * 0.48));   // ySuperscriptYOffset
  w.i16(Math.round(em * 0.05));   // yStrikeoutSize
  w.i16(Math.round(em * 0.26));   // yStrikeoutPosition
  w.i16(0);                       // sFamilyClass
  // panose (10 bytes) — all zero
  for (let i = 0; i < 10; i++) w.u8(0);
  // ulUnicodeRange1..4 — declare basic latin support; precise mask not critical
  w.u32(opts.unicodeRange1 || 0x00000001); // bit 0 = Basic Latin
  w.u32(opts.unicodeRange2 || 0);
  w.u32(opts.unicodeRange3 || 0);
  w.u32(opts.unicodeRange4 || 0);
  w.tag('KBKU');                  // achVendID (4 bytes)
  w.u16(opts.fsSelection || 0x0040); // 0x40 = REGULAR
  w.u16(opts.usFirstCharIndex);
  w.u16(opts.usLastCharIndex);
  w.fword(opts.ascender);         // sTypoAscender
  w.fword(opts.descender);        // sTypoDescender
  w.fword(0);                     // sTypoLineGap
  w.ufword(opts.ascender);        // usWinAscent
  w.ufword(Math.abs(opts.descender)); // usWinDescent
  w.u32(1);                       // ulCodePageRange1: Latin 1
  w.u32(0);                       // ulCodePageRange2
  w.fword(Math.round(em * 0.5));  // sxHeight
  w.fword(Math.round(em * 0.7));  // sCapHeight
  w.u16(0);                       // usDefaultChar
  w.u16(0x20);                    // usBreakChar (space)
  w.u16(0);                       // usMaxContext
  return w.toUint8Array();
}

// ─── post ───────────────────────────────────────────────────────────────────

/** post version 3.0 — no per-glyph names (saves space). */
export function makePost() {
  const w = new BinaryWriter(32);
  w.fixed(3.0);
  w.fixed(0);                     // italicAngle
  w.fword(-100);                  // underlinePosition
  w.fword(50);                    // underlineThickness
  w.u32(0);                       // isFixedPitch (0 = proportional)
  w.u32(0);                       // minMemType42
  w.u32(0);                       // maxMemType42
  w.u32(0);                       // minMemType1
  w.u32(0);                       // maxMemType1
  return w.toUint8Array();
}

// ─── name ───────────────────────────────────────────────────────────────────

/**
 * @param {Object[]} records - [{platformID, encodingID, languageID, nameID, value: string}]
 * @returns {Uint8Array}
 */
export function makeName(records) {
  const encode = (str, platformID) => {
    if (platformID === 1) {
      // Mac Roman — restrict to ASCII for safety
      const bytes = new Uint8Array(str.length);
      for (let i = 0; i < str.length; i++) bytes[i] = str.charCodeAt(i) & 0xff;
      return bytes;
    }
    // UTF-16BE for Windows / Unicode platforms
    const bytes = new Uint8Array(str.length * 2);
    for (let i = 0; i < str.length; i++) {
      const c = str.charCodeAt(i);
      bytes[i * 2] = (c >> 8) & 0xff;
      bytes[i * 2 + 1] = c & 0xff;
    }
    return bytes;
  };

  // Sort first per spec: (platformID, encodingID, languageID, nameID)
  const sorted = records.slice().sort((a, b) =>
    a.platformID - b.platformID ||
    a.encodingID - b.encodingID ||
    a.languageID - b.languageID ||
    a.nameID - b.nameID
  );

  // Encode and assign storage offsets in sorted order.
  let storageSize = 0;
  const items = sorted.map(r => {
    const bytes = encode(r.value, r.platformID);
    const item = { ...r, bytes, offset: storageSize };
    storageSize += bytes.length;
    return item;
  });

  const headerSize = 6 + items.length * 12;
  const total = headerSize + storageSize;

  const w = new BinaryWriter(total);
  w.u16(0);                       // format 0
  w.u16(items.length);            // count
  w.u16(headerSize);              // string-storage offset

  for (const r of items) {
    w.u16(r.platformID);
    w.u16(r.encodingID);
    w.u16(r.languageID);
    w.u16(r.nameID);
    w.u16(r.bytes.length);
    w.u16(r.offset);
  }
  for (const r of items) {
    w.bytes(r.bytes);
  }
  return w.toUint8Array();
}

// ─── cmap ───────────────────────────────────────────────────────────────────

/**
 * Build a cmap with format-4 (BMP) and format-12 (full Unicode) subtables.
 * Both are populated from a {codepoint: glyphIndex} map.
 */
export function makeCmap(codepointToGlyph) {
  const entries = Object.entries(codepointToGlyph)
    .map(([cp, gi]) => ({ cp: +cp, gi }))
    .sort((a, b) => a.cp - b.cp);

  const bmp = entries.filter(e => e.cp <= 0xFFFF);
  const all = entries; // both BMP and supplementary

  const sub4 = makeCmapFormat4(bmp);
  const sub12 = makeCmapFormat12(all);

  // cmap header: numTables = 2; encoding records point to subtables
  const headerSize = 4 + 2 * 8;
  let offset = headerSize;
  const off4 = offset; offset += sub4.length;
  const off12 = offset; offset += sub12.length;

  const w = new BinaryWriter(offset);
  w.u16(0);   // version
  w.u16(2);   // numTables
  // Record 1: Unicode BMP (3, 1, format-4)
  w.u16(3); w.u16(1); w.u32(off4);
  // Record 2: Unicode full (3, 10, format-12)
  w.u16(3); w.u16(10); w.u32(off12);

  w.bytes(sub4);
  w.bytes(sub12);
  return w.toUint8Array();
}

function makeCmapFormat4(entries) {
  // Build segments (contiguous runs of (codepoint, glyphIndex)).
  // Always include a final segment ending at 0xFFFF mapped to glyph 0.
  const segs = [];
  let i = 0;
  while (i < entries.length) {
    const start = entries[i].cp;
    const startGi = entries[i].gi;
    let end = start;
    let j = i + 1;
    while (j < entries.length &&
           entries[j].cp === entries[j - 1].cp + 1 &&
           entries[j].gi === entries[j - 1].gi + 1) {
      end = entries[j].cp;
      j++;
    }
    segs.push({ start, end, idDelta: (startGi - start) & 0xFFFF });
    i = j;
  }
  segs.push({ start: 0xFFFF, end: 0xFFFF, idDelta: 1 });

  const segCount = segs.length;
  const segCountX2 = segCount * 2;
  const log2N = Math.floor(Math.log2(segCount));
  const searchRange = (1 << log2N) * 2;
  const entrySelector = log2N;
  const rangeShift = segCountX2 - searchRange;

  const length = 16 + 2 + segCountX2 * 4 + 2; // includes endCount, reservedPad, startCount, idDelta, idRangeOffsets (zeros)
  // 14 (header) + segCountX2 (endCode) + 2 (reservedPad) + segCountX2 (startCode) + segCountX2 (idDelta) + segCountX2 (idRangeOffset)
  const total = 14 + segCountX2 + 2 + segCountX2 + segCountX2 + segCountX2;

  const w = new BinaryWriter(total);
  w.u16(4);        // format
  w.u16(total);    // length
  w.u16(0);        // language
  w.u16(segCountX2);
  w.u16(searchRange);
  w.u16(entrySelector);
  w.u16(rangeShift);
  for (const s of segs) w.u16(s.end);
  w.u16(0);        // reservedPad
  for (const s of segs) w.u16(s.start);
  for (const s of segs) w.u16(s.idDelta);
  for (let k = 0; k < segCount; k++) w.u16(0); // idRangeOffsets all zero
  return w.toUint8Array();
}

function makeCmapFormat12(entries) {
  // Format 12: sequential map groups (cp → gi)
  const groups = [];
  let i = 0;
  while (i < entries.length) {
    const startCp = entries[i].cp;
    const startGi = entries[i].gi;
    let endCp = startCp;
    let j = i + 1;
    while (j < entries.length &&
           entries[j].cp === entries[j - 1].cp + 1 &&
           entries[j].gi === entries[j - 1].gi + 1) {
      endCp = entries[j].cp;
      j++;
    }
    groups.push({ startCp, endCp, startGi });
    i = j;
  }
  const length = 16 + groups.length * 12;
  const w = new BinaryWriter(length);
  w.u16(12);             // format
  w.u16(0);              // reserved
  w.u32(length);         // length
  w.u32(0);              // language
  w.u32(groups.length);
  for (const g of groups) {
    w.u32(g.startCp);
    w.u32(g.endCp);
    w.u32(g.startGi);
  }
  return w.toUint8Array();
}

// ─── hmtx ───────────────────────────────────────────────────────────────────

/**
 * @param {{advanceWidth: number, lsb: number}[]} metrics
 * @param {number} numberOfHMetrics - first N entries are full hMetrics; the
 *   rest are leftSideBearings only (sharing the last advanceWidth).
 */
export function makeHmtx(metrics, numberOfHMetrics) {
  const w = new BinaryWriter(numberOfHMetrics * 4 + (metrics.length - numberOfHMetrics) * 2);
  for (let i = 0; i < numberOfHMetrics; i++) {
    w.ufword(metrics[i].advanceWidth);
    w.fword(metrics[i].lsb);
  }
  for (let i = numberOfHMetrics; i < metrics.length; i++) {
    w.fword(metrics[i].lsb);
  }
  return w.toUint8Array();
}
