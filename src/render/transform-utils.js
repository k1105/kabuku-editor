import { applyStretch } from '../transform/stretch.js';
import { applyGap } from '../transform/gap.js';
import { angularDelta180 } from '../core/orientation.js';

/**
 * Cell displacement from the stretch + gap transforms, in glyph-local px.
 *
 * Single source of truth shared by the canvas renderer, the animation
 * renderer, the SVG exporter and the font exporter — every output path must
 * place cells identically or exports drift from what the user sees.
 *
 * Gating mirrors the historical call sites: a falsy `stretchAmount` /
 * `baseGap` skips that step entirely (applyStretch only special-cases
 * `amount === 0`, so passing `undefined` through would produce NaN).
 *
 * @param {{x: number, y: number}} center - cell center (glyph-local px)
 * @param {Object} t - transform { stretchAngle, stretchAmount, baseGap, gapDirectionWeight }
 * @param {number} width  - glyph box width
 * @param {number} height - glyph box height
 * @param {number} baselineY - stretch pivot Y (glyph-local px)
 * @returns {{dx: number, dy: number, pos: {x: number, y: number}}}
 */
export function cellDisplacement(center, t, width, height, baselineY) {
  let pos = { x: center.x, y: center.y };
  if (t.stretchAmount) {
    pos = applyStretch(pos, t.stretchAngle || 0, t.stretchAmount, width, height, baselineY);
  }
  if (t.baseGap) {
    pos = applyGap(pos, t.stretchAngle || 0, t.baseGap, t.gapDirectionWeight || 0, width, height);
  }
  return { dx: pos.x - center.x, dy: pos.y - center.y, pos };
}

/**
 * Per-cell uniform scale factor from the cell's stroke orientation vs the
 * stretch direction. Orthogonal cells get `scaleOrthogonal`, parallel cells
 * `scaleParallel`, interpolated by (なす角 / 90). Returns 1 (identity) when the
 * range is 1/1, or when the cell has no orientation (isolated cell).
 *
 * The factor may be negative (the range endpoints are unclamped): a cell then
 * shrinks to 0 at the zero-crossing angle and grows mirrored beyond it.
 *
 * The reference direction is `scaleRefAngle` when present, else `stretchAngle`.
 * The editing view drops stretch (stretchAngle→0 for gap) but still wants the
 * scale measured against the real stretch direction, so it passes scaleRefAngle.
 *
 * @param {Object} cell - needs `orientation` (deg in [0,180) or null)
 * @param {Object} t - transform { stretchAngle, scaleRefAngle?, scaleParallel, scaleOrthogonal }
 * @returns {number}
 */
export function cellScaleFactor(cell, t) {
  const sPar = t.scaleParallel ?? 1;
  const sOrt = t.scaleOrthogonal ?? 1;
  if (sPar === 1 && sOrt === 1) return 1;
  if (cell.orientation == null) return 1;
  const refAngle = t.scaleRefAngle ?? t.stretchAngle ?? 0;
  const delta = angularDelta180(cell.orientation, refAngle); // 0..90
  return sPar + (sOrt - sPar) * (delta / 90);
}

/**
 * Scale a cell's geometry (rect / circle / polygon) about `center` by `s`,
 * returning a new geometry object. Used by the vector exporters so OTF/SVG
 * output matches the canvas renderer's per-cell scale. Negative `s` mirrors;
 * rect/circle dimensions are normalized to stay positive.
 *
 * @param {Object} geometry - { type, ... } or null
 * @param {{x:number,y:number}} center
 * @param {number} s
 * @returns {Object} new geometry (or the original when s === 1 / no geometry)
 */
export function scaleGeometryAboutCenter(geometry, center, s) {
  if (!geometry || s === 1) return geometry;
  const sx = (v) => center.x + (v - center.x) * s;
  const sy = (v) => center.y + (v - center.y) * s;
  switch (geometry.type) {
    case 'rect': {
      let x = sx(geometry.x), y = sy(geometry.y);
      let width = geometry.width * s, height = geometry.height * s;
      if (width < 0) { x += width; width = -width; }
      if (height < 0) { y += height; height = -height; }
      return { ...geometry, x, y, width, height };
    }
    case 'circle':
      return { ...geometry, cx: sx(geometry.cx), cy: sy(geometry.cy), r: Math.abs(geometry.r * s) };
    case 'polygon':
      return { ...geometry, points: geometry.points.map((p) => ({ x: sx(p.x), y: sy(p.y) })) };
    default:
      return geometry;
  }
}
