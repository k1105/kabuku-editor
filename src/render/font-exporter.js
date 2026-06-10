import opentype from 'opentype.js';
import { cellDisplacement } from './transform-utils.js';
import { resolveTransform } from '../core/project.js';
import { EM_SIZE, fontVerticalMetrics, glyphName, collectGlyphEntries } from './font/glyph-collect.js';

const KAPPA = 0.5522847498307936; // unit-circle bezier control offset

/**
 * Export the current project as a static OTF at the given transform state.
 * Glyphs whose charId is not a single Unicode codepoint are skipped with a
 * warning (returned in `skipped`).
 *
 * @param {Object} project - loaded project (characters + global)
 * @param {Object} [opts]
 * @param {Object} [opts.transform] - { stretchAngle, stretchAmount, baseGap, gapDirectionWeight }
 *   Defaults to the global transform (no per-character overrides).
 * @returns {{ font: Object, skipped: string[] }}
 */
export function buildFont(project, opts = {}) {
  const global = project.global;
  const fontInfo = global.fontInfo || {};
  const fontMetrics = global.fontMetrics || {};
  const transform = opts.transform || resolveTransform(global, {});

  // Font-unit reference: baseline at y=0, ascent above (positive), descent below.
  // kabuku's canvas Y is down with baseline at `baselineRatio * EM_SIZE`.
  // Convert: fontY = baselineY_canvas - canvasY.
  const { ascender, descender } = fontVerticalMetrics(fontMetrics);

  const { entries, skipped, hasUserSpace } = collectGlyphEntries(project);
  const glyphs = [];

  // .notdef is required as the first glyph.
  glyphs.push(new opentype.Glyph({
    name: '.notdef',
    unicode: 0,
    advanceWidth: EM_SIZE,
    path: notdefPath(ascender, descender),
  }));

  // Provide a default space glyph (U+0020) if the project doesn't define one.
  if (!hasUserSpace) {
    glyphs.push(new opentype.Glyph({
      name: 'space',
      unicode: 0x0020,
      advanceWidth: Math.round(EM_SIZE * 0.5),
      path: new opentype.Path(),
    }));
  }

  for (const { codepoint, layers } of entries) {
    const path = buildGlyphPath(layers, transform, fontMetrics);
    glyphs.push(new opentype.Glyph({
      name: glyphName(codepoint),
      unicode: codepoint,
      advanceWidth: EM_SIZE,
      path,
    }));
  }

  const font = new opentype.Font({
    familyName: fontInfo.familyName || 'Kabuku',
    styleName: fontInfo.styleName || 'Regular',
    unitsPerEm: EM_SIZE,
    ascender,
    descender,
    designer: '',
    designerURL: '',
    manufacturer: '',
    manufacturerURL: '',
    license: '',
    licenseURL: '',
    version: fontInfo.version || '1.000',
    description: '',
    copyright: fontInfo.copyright || '',
    trademark: '',
    glyphs,
  });

  return { font, skipped };
}

/**
 * Build the font and return its bytes (OTF/CFF). Caller saves them.
 * @returns {{ bytes: Uint8Array, skipped: string[] }}
 */
export function buildFontBytes(project, opts = {}) {
  const { font, skipped } = buildFont(project, opts);
  const buf = font.toArrayBuffer();
  return { bytes: new Uint8Array(buf), skipped };
}

/**
 * Legacy convenience: build and trigger a download.
 */
export function downloadFont(project, opts = {}) {
  const { font, skipped } = buildFont(project, opts);
  const familyName = (project.global.fontInfo?.familyName || 'Kabuku').replace(/\s+/g, '');
  const styleName = (project.global.fontInfo?.styleName || 'Regular').replace(/\s+/g, '');
  font.download(`${familyName}-${styleName}.otf`);
  return { skipped };
}

// ─── glyph construction ─────────────────────────────────────────────────────

function buildGlyphPath(layers, transform, fontMetrics) {
  const path = new opentype.Path();
  const baselineY = (fontMetrics.baseline ?? 0.8) * EM_SIZE;

  for (const layer of layers) {
    if (!layer.visible) continue;
    for (const cell of layer.cells) {
      if (!cell.filled) continue;
      const { dx, dy } = cellDisplacement(cell.center, transform, EM_SIZE, EM_SIZE, baselineY);
      appendCellSubpath(path, cell, dx, dy, baselineY);
    }
  }
  return path;
}

/**
 * Append a closed subpath for one cell. Coordinates are converted from
 * canvas-Y-down to font-Y-up with baseline at y=0.
 */
function appendCellSubpath(path, cell, dx, dy, baselineY) {
  const g = cell.geometry;
  if (!g) return;

  // Y-up conversion helper
  const fy = (canvasY) => baselineY - canvasY;

  switch (g.type) {
    case 'rect': {
      const x0 = g.x + dx;
      const x1 = x0 + g.width;
      const y0 = fy(g.y + dy);            // top edge in canvas → larger Y in font
      const y1 = fy(g.y + dy + g.height); // bottom edge in canvas → smaller Y in font
      // Wind clockwise in font coords (TT-style outer): start top-left, go right-down-left.
      // In Y-up font space, "top-left" = (x0, y0) where y0 > y1.
      path.moveTo(x0, y0);
      path.lineTo(x1, y0);
      path.lineTo(x1, y1);
      path.lineTo(x0, y1);
      path.close();
      return;
    }
    case 'circle': {
      const cx = g.cx + dx;
      const cy = fy(g.cy + dy);
      const r = g.r;
      const k = r * KAPPA;
      // Standard 4-cubic circle, clockwise in Y-up: right → top → left → bottom → right
      path.moveTo(cx + r, cy);
      path.curveTo(cx + r, cy + k, cx + k, cy + r, cx, cy + r);
      path.curveTo(cx - k, cy + r, cx - r, cy + k, cx - r, cy);
      path.curveTo(cx - r, cy - k, cx - k, cy - r, cx, cy - r);
      path.curveTo(cx + k, cy - r, cx + r, cy - k, cx + r, cy);
      path.close();
      return;
    }
    case 'polygon': {
      if (!g.points || g.points.length < 3) return;
      // Source polygon is in canvas Y-down. After Y-flip the winding reverses,
      // so traverse in reverse order to keep clockwise winding in font space.
      const pts = g.points;
      const last = pts.length - 1;
      path.moveTo(pts[last].x + dx, fy(pts[last].y + dy));
      for (let i = last - 1; i >= 0; i--) {
        path.lineTo(pts[i].x + dx, fy(pts[i].y + dy));
      }
      path.close();
      return;
    }
  }
}

/**
 * Simple .notdef: a hollow rectangle filling most of the em square. The inner
 * counter is wound the opposite direction so it punches a hole.
 */
function notdefPath(ascender, descender) {
  const path = new opentype.Path();
  const margin = EM_SIZE * 0.1;
  const x0 = margin, x1 = EM_SIZE - margin;
  const y0 = ascender - margin;
  const y1 = descender + margin;
  // Outer (clockwise in Y-up)
  path.moveTo(x0, y0);
  path.lineTo(x1, y0);
  path.lineTo(x1, y1);
  path.lineTo(x0, y1);
  path.close();
  // Inner counter (counter-clockwise = hole)
  const inset = EM_SIZE * 0.05;
  const ix0 = x0 + inset, ix1 = x1 - inset;
  const iy0 = y0 - inset, iy1 = y1 + inset;
  path.moveTo(ix0, y0 - inset);
  path.lineTo(ix0, iy1);
  path.lineTo(ix1, iy1);
  path.lineTo(ix1, iy0);
  path.close();
  return path;
}

