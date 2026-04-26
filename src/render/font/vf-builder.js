/**
 * Build a complete 1-axis variable TTF binary from a kabuku project.
 *
 * Axis: STRC (Stretch), 0..1, default 0.
 * Default master = no transform; variation peak (1.0) = stretch at the chosen
 * `angle` with amount 1.0.
 *
 * Per-glyph workflow:
 *   1. Build runtime layers from project (deterministic)
 *   2. Iterate filled cells in stable order; emit a closed contour per cell
 *   3. Generate two masters' point sets:
 *        a) default — cell at original center
 *        b) at peak — cell shifted by applyStretch(angle, amount=1)
 *   4. glyf carries the default master points
 *   5. gvar carries (peak_points - default_points) plus 4 phantom-point deltas
 *      (we leave phantom point deltas at zero; advance widths don't change)
 */

import { applyStretch } from '../../transform/stretch.js';
import { buildRuntimeLayers } from '../../core/layer-builder.js';
import { resolveCodepoint } from '../../core/project.js';
import { cellGeometryToContours } from './glyph-points.js';
import { buildSfnt } from './binary.js';
import {
  makeHead, makeHhea, makeMaxp, makeOS2, makePost, makeName, makeCmap, makeHmtx,
} from './tables.js';
import { encodeSimpleGlyph, buildGlyfAndLoca } from './glyf.js';
import { makeFvar, makeGvar } from './vf-tables.js';
import { makeStat } from './stat.js';
import { zipSync } from 'fflate';

export const DEFAULT_FAMILY_ANGLES = [0, 30, 45, 60, 90, 120, 135, 150];

const EM_SIZE = 1024;

/**
 * @param {Object} project
 * @param {Object} opts
 * @param {number} opts.angle - stretch angle in degrees (master direction)
 * @param {string} [opts.styleName] - subfamily name (e.g. "Angle 45")
 * @param {boolean} [opts.family] - if true, include STAT table and use multi-file
 *   family naming (typographic family/subfamily IDs 16/17 are paired with a
 *   per-file ID 1 to keep legacy 4-style limits happy).
 * @returns {{ binary: Uint8Array, skipped: string[] }}
 */
export function buildVariableTTF(project, opts) {
  const angle = opts.angle ?? 0;
  const styleName = opts.styleName || `Angle ${angle}`;
  const familyMode = !!opts.family;
  const fontInfo = project.global.fontInfo || {};
  const familyName = fontInfo.familyName || 'Kabuku';
  const fontMetrics = project.global.fontMetrics || {};
  const baselineY = (fontMetrics.baseline ?? 0.8) * EM_SIZE;
  const ascender = Math.round(baselineY);
  const descender = -Math.round(EM_SIZE - baselineY);

  const skipped = [];

  // ── Collect glyph specs in glyph-index order ──
  // Index 0: .notdef   (required)
  // Index 1: space     (synthesized when project doesn't define it)
  // Index 2..: user glyphs whose charId is a single Unicode codepoint
  const glyphSpecs = [];

  glyphSpecs.push({
    name: '.notdef',
    codepoint: null,
    contoursDefault: notdefContours(ascender, descender),
    contoursPeak: notdefContours(ascender, descender),
    advanceWidth: EM_SIZE,
  });

  const charIds = Object.keys(project.characters || {});
  const hasUserSpace = charIds.includes(' ');
  if (!hasUserSpace) {
    glyphSpecs.push({
      name: 'space',
      codepoint: 0x20,
      contoursDefault: [],
      contoursPeak: [],
      advanceWidth: Math.round(EM_SIZE * 0.5),
    });
  }

  for (const charId of charIds) {
    const cp = resolveCodepoint(charId);
    if (cp == null) {
      skipped.push(charId);
      continue;
    }
    const charData = project.characters[charId];
    const layers = buildRuntimeLayers(project.global, charData, EM_SIZE);

    const contoursDefault = [];
    const contoursPeak = [];

    for (const layer of layers) {
      if (!layer.visible) continue;
      for (const cell of layer.cells) {
        if (!cell.filled || !cell.geometry) continue;

        // Default master: no transform
        const defC = cellGeometryToContours(cell.geometry, 0, 0, baselineY);
        // Peak master: apply stretch at given angle, amount=1
        const peakPos = applyStretch(
          { x: cell.center.x, y: cell.center.y },
          angle, 1.0, EM_SIZE, EM_SIZE, baselineY
        );
        const dx = peakPos.x - cell.center.x;
        const dy = peakPos.y - cell.center.y;
        const peakC = cellGeometryToContours(cell.geometry, dx, dy, baselineY);

        // Sanity: per-cell point count must match across masters.
        for (let i = 0; i < defC.length; i++) {
          if (defC[i].length !== peakC[i].length) {
            throw new Error(`Master point-count mismatch in cell ${cell.id}`);
          }
        }
        contoursDefault.push(...defC);
        contoursPeak.push(...peakC);
      }
    }

    glyphSpecs.push({
      name: glyphName(cp),
      codepoint: cp,
      contoursDefault,
      contoursPeak,
      advanceWidth: EM_SIZE,
    });
  }

  // ── Encode glyf bodies (default master) ──
  const encoded = glyphSpecs.map(s => encodeSimpleGlyph(s.contoursDefault));
  const glyphBodies = encoded.map(e => e.bytes);
  const { glyf, loca, indexToLocFormat } = buildGlyfAndLoca(glyphBodies);

  // ── Compute global metrics ──
  let xMin = Infinity, yMin = Infinity, xMax = -Infinity, yMax = -Infinity;
  let maxPoints = 0, maxContours = 0;
  let advanceWidthMax = 0;
  for (let i = 0; i < glyphSpecs.length; i++) {
    const e = encoded[i];
    if (e.numPoints > 0) {
      if (e.xMin < xMin) xMin = e.xMin;
      if (e.yMin < yMin) yMin = e.yMin;
      if (e.xMax > xMax) xMax = e.xMax;
      if (e.yMax > yMax) yMax = e.yMax;
    }
    if (e.numPoints > maxPoints) maxPoints = e.numPoints;
    const contourCount = glyphSpecs[i].contoursDefault.length;
    if (contourCount > maxContours) maxContours = contourCount;
    if (glyphSpecs[i].advanceWidth > advanceWidthMax) advanceWidthMax = glyphSpecs[i].advanceWidth;
  }
  if (!isFinite(xMin)) { xMin = 0; yMin = 0; xMax = 0; yMax = 0; }

  // ── hmtx metrics ──
  const metrics = glyphSpecs.map(s => ({ advanceWidth: s.advanceWidth, lsb: 0 }));
  const numberOfHMetrics = metrics.length;

  // ── Build per-glyph gvar variations ──
  const variations = glyphSpecs.map((s, idx) => {
    const e = encoded[idx];
    if (e.numPoints === 0) return { variations: [] };
    // Compute deltas: peak - default, both flattened across contours.
    const flatDef = flattenPoints(s.contoursDefault);
    const flatPeak = flattenPoints(s.contoursPeak);
    if (flatDef.length !== flatPeak.length) {
      throw new Error(`Point count mismatch for glyph ${s.name}`);
    }
    const dxs = new Array(flatDef.length + 4).fill(0);
    const dys = new Array(flatDef.length + 4).fill(0);
    for (let i = 0; i < flatDef.length; i++) {
      dxs[i] = flatPeak[i].x - flatDef[i].x;
      dys[i] = flatPeak[i].y - flatDef[i].y;
    }
    // Last 4 entries are phantom points (lsb, advance, top-side, bottom-side
    // bearings). For us they don't change → already zero.
    return {
      variations: [{ peak: [1.0], deltas: { x: dxs, y: dys } }],
    };
  });

  // ── Build standard tables ──
  const codepointToGlyph = {};
  glyphSpecs.forEach((s, i) => {
    if (s.codepoint != null) codepointToGlyph[s.codepoint] = i;
  });

  const cpKeys = Object.keys(codepointToGlyph).map(Number);
  const usFirstCharIndex = cpKeys.length > 0 ? Math.min(...cpKeys) : 0xFFFD;
  const usLastCharIndex = cpKeys.length > 0 ? Math.min(0xFFFF, Math.max(...cpKeys)) : 0xFFFD;

  // Name records (IDs 1, 2, 3, 4, 5, 6, 16, 17, 25, 256...)
  const versionStr = (fontInfo.version || '1.000').match(/[\d.]+/)?.[0] || '1.000';
  const psFamily = familyName.replace(/\s+/g, '');
  const psStyle = styleName.replace(/\s+/g, '');
  const stretchAxisNameID = 256;
  const angleAxisNameID = 258;
  const angleValueNameID = 259; // STAT label for this file's angle position

  // For family mode: ID 1 differs per file so legacy apps can still see each
  // file as a single-style "family" without colliding on RBIBI; modern apps
  // use ID 16/17 + STAT to merge them into one typographic family.
  const legacyFamily = familyMode ? `${familyName} ${styleName}` : familyName;
  const legacySubfamily = 'Regular';

  // Build name records — both Mac (1,0,0) and Windows (3,1,0x409) for max compat.
  const baseRecords = [
    { nameID: 0, value: fontInfo.copyright || '' },
    { nameID: 1, value: legacyFamily },
    { nameID: 2, value: legacySubfamily },
    { nameID: 3, value: `${familyName}-${styleName}-${Date.now()}` }, // unique ID
    { nameID: 4, value: `${familyName} ${styleName}` },
    { nameID: 5, value: `Version ${versionStr}` },
    { nameID: 6, value: `${psFamily}-${psStyle}` },
    { nameID: 16, value: familyName },                // Typographic Family (preferred)
    { nameID: 17, value: styleName },                 // Typographic Subfamily
    { nameID: 25, value: psFamily },                  // Variations PostScript Name Prefix
    { nameID: stretchAxisNameID, value: 'Stretch' },
  ];
  if (familyMode) {
    baseRecords.push(
      { nameID: angleAxisNameID, value: 'Angle' },
      { nameID: angleValueNameID, value: styleName }, // e.g. "Angle 45"
    );
  }

  const nameRecords = [];
  for (const r of baseRecords.filter(r => r.value && r.value.length > 0)) {
    nameRecords.push({ platformID: 3, encodingID: 1, languageID: 0x0409, ...r });
    nameRecords.push({ platformID: 1, encodingID: 0, languageID: 0, ...r });
  }

  // ── Assemble standard tables ──
  const headBytes = makeHead({
    unitsPerEm: EM_SIZE,
    xMin, yMin, xMax, yMax,
    indexToLocFormat,
  });
  const hheaBytes = makeHhea({
    ascender, descender, lineGap: 0,
    advanceWidthMax,
    xMin, xMax,
    numberOfHMetrics,
  });
  const maxpBytes = makeMaxp({
    numGlyphs: glyphSpecs.length,
    maxPoints,
    maxContours,
  });
  const os2Bytes = makeOS2({
    xAvgCharWidth: Math.round(EM_SIZE * 0.5),
    usWeightClass: 400, usWidthClass: 5,
    unitsPerEm: EM_SIZE,
    ascender, descender,
    usFirstCharIndex, usLastCharIndex,
    fsSelection: 0xC0, // USE_TYPO_METRICS | REGULAR
  });
  const postBytes = makePost();
  const cmapBytes = makeCmap(codepointToGlyph);
  const hmtxBytes = makeHmtx(metrics, numberOfHMetrics);
  const nameBytes = makeName(nameRecords);

  // ── Variable font tables ──
  // No named instances. A duplicate named instance ("Stretched") across all
  // angle files in family mode causes Adobe to dedup them and show only the
  // first file's data when any "Stretched" entry is picked. Users can use the
  // STRC axis slider directly.
  const fvarBytes = makeFvar(
    [{ tag: 'STRC', nameID: stretchAxisNameID, minValue: 0, defaultValue: 0, maxValue: 1 }],
    []
  );
  const gvarBytes = makeGvar({ axisCount: 1, glyphs: variations });

  // ── STAT (family-mode only) ──
  // Cross-file dimension: discrete Angle axis (one position per file).
  // Within-file dimension: continuous Stretch axis (matches fvar).
  let statBytes = null;
  if (familyMode) {
    statBytes = makeStat({
      designAxes: [
        { tag: 'ANGL', nameID: angleAxisNameID, ordering: 0 },
        { tag: 'STRC', nameID: stretchAxisNameID, ordering: 1 },
      ],
      axisValues: [
        { axisIndex: 0, value: angle, nameID: angleValueNameID, elidable: false },
        { axisIndex: 1, value: 0,     nameID: 2 /* "Regular" */, elidable: true },
      ],
      elidedFallbackNameID: 2,
    });
  }

  // ── Pack into sfnt ──
  const tables = [
    { tag: 'head', bytes: headBytes },
    { tag: 'hhea', bytes: hheaBytes },
    { tag: 'maxp', bytes: maxpBytes },
    { tag: 'OS/2', bytes: os2Bytes },
    { tag: 'cmap', bytes: cmapBytes },
    { tag: 'name', bytes: nameBytes },
    { tag: 'post', bytes: postBytes },
    { tag: 'hmtx', bytes: hmtxBytes },
    { tag: 'glyf', bytes: glyf },
    { tag: 'loca', bytes: loca },
    { tag: 'fvar', bytes: fvarBytes },
    { tag: 'gvar', bytes: gvarBytes },
  ];
  if (statBytes) tables.push({ tag: 'STAT', bytes: statBytes });

  const binary = buildSfnt(tables, '\x00\x01\x00\x00'); // TTF magic
  return { binary, skipped };
}

/**
 * Build a multi-file VF family — one TTF per discrete angle, all sharing the
 * same Typographic Family (name ID 16) and a consistent STAT axis layout so
 * Adobe / system font menus group them as one family with a style picker.
 *
 * @param {Object} project
 * @param {Object} [opts]
 * @param {number[]} [opts.angles] - angles in degrees (default 0/30/45/60/90/120/135/150)
 * @returns {{ files: Array<{name: string, bytes: Uint8Array}>, skipped: string[] }}
 */
export function buildVariableFontFamily(project, opts = {}) {
  const angles = opts.angles || DEFAULT_FAMILY_ANGLES;
  const familyName = project.global?.fontInfo?.familyName || 'Kabuku';
  const psFamily = familyName.replace(/\s+/g, '');

  const files = [];
  const skippedSet = new Set();

  for (const angle of angles) {
    const styleName = `Angle ${angle}`;
    const { binary, skipped } = buildVariableTTF(project, {
      angle,
      styleName,
      family: true,
    });
    files.push({
      name: `${psFamily}-Angle${angle}.ttf`,
      bytes: binary,
    });
    for (const s of skipped) skippedSet.add(s);
  }

  return { files, skipped: [...skippedSet] };
}

/**
 * Build the family and return the packaged ZIP bytes plus metadata.
 * @returns {{ zip: Uint8Array, skipped: string[], fileCount: number }}
 */
export function buildVariableFontFamilyZip(project, opts = {}) {
  const { files, skipped } = buildVariableFontFamily(project, opts);
  const zipEntries = {};
  for (const f of files) zipEntries[f.name] = f.bytes;
  const zip = zipSync(zipEntries);
  return { zip, skipped, fileCount: files.length };
}

/**
 * Legacy convenience: build the family and trigger a ZIP download.
 */
export function downloadVariableFontFamily(project, opts = {}) {
  const { zip, skipped, fileCount } = buildVariableFontFamilyZip(project, opts);
  const blob = new Blob([zip], { type: 'application/zip' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const fam = (project.global.fontInfo?.familyName || 'Kabuku').replace(/\s+/g, '');
  a.href = url;
  a.download = `${fam}-VF-Family.zip`;
  a.click();
  URL.revokeObjectURL(url);
  return { skipped, fileCount };
}

/**
 * Trigger a browser download.
 */
export function downloadVariableTTF(project, opts = {}) {
  const { binary, skipped } = buildVariableTTF(project, opts);
  const blob = new Blob([binary], { type: 'font/ttf' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const fam = (project.global.fontInfo?.familyName || 'Kabuku').replace(/\s+/g, '');
  const sty = (opts.styleName || `Angle${opts.angle ?? 0}`).replace(/\s+/g, '');
  a.href = url;
  a.download = `${fam}-${sty}.ttf`;
  a.click();
  URL.revokeObjectURL(url);
  return { skipped };
}

// ─── helpers ────────────────────────────────────────────────────────────────

function flattenPoints(contours) {
  const out = [];
  for (const c of contours) {
    for (const p of c) out.push(p);
  }
  return out;
}

function notdefContours(ascender, descender) {
  // Simple hollow rectangle: outer CW, inner CCW
  const margin = Math.round(EM_SIZE * 0.1);
  const x0 = margin, x1 = EM_SIZE - margin;
  const y0 = ascender - margin;
  const y1 = descender + margin;
  const inset = Math.round(EM_SIZE * 0.05);
  const ix0 = x0 + inset, ix1 = x1 - inset;
  const iy0 = y0 - inset, iy1 = y1 + inset;
  return [
    [
      { x: x0, y: y0, onCurve: true },
      { x: x1, y: y0, onCurve: true },
      { x: x1, y: y1, onCurve: true },
      { x: x0, y: y1, onCurve: true },
    ],
    [
      { x: ix0, y: iy0, onCurve: true },
      { x: ix0, y: iy1, onCurve: true },
      { x: ix1, y: iy1, onCurve: true },
      { x: ix1, y: iy0, onCurve: true },
    ],
  ];
}

function glyphName(codepoint) {
  if (codepoint <= 0xFFFF) {
    return 'uni' + codepoint.toString(16).toUpperCase().padStart(4, '0');
  }
  return 'u' + codepoint.toString(16).toUpperCase().padStart(6, '0');
}
