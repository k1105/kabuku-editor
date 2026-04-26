/**
 * Convert a kabuku cell (with `geometry` metadata) into glyf-table-style
 * point data: a list of {x, y, onCurve} per contour.
 *
 * - rect → 4 on-curve points
 * - polygon → N on-curve points
 * - circle → 8 quadratic Bezier curves (8 on-curve + 8 off-curve = 16 points).
 *   Approximation error vs. true circle ≈ 0.027% — sufficient for type.
 *
 * Coordinates are converted from canvas-Y-down to font-Y-up:
 *   fontY = baselineY_canvas - canvasY
 *
 * Critical for VF: the **point count and ordering must be identical across
 * every master**. Since stretch only translates cell centers (not the cell's
 * intrinsic shape), we just emit the same shape with shifted coordinates.
 *
 * Rect/polygon winding is reversed when flipping Y to keep clockwise winding
 * in font space.
 */

const KAPPA_QUAD = 1 / Math.cos(Math.PI / 8); // sec(π/8) ≈ 1.0824
const CIRCLE_SEGMENTS = 8;

/**
 * Build the contours for a single cell at a given (dx, dy) displacement.
 * @param {Object} geometry - cell.geometry
 * @param {number} dx - X shift in canvas units
 * @param {number} dy - Y shift in canvas units
 * @param {number} baselineY - canvas-Y of the baseline (used for Y-flip)
 * @returns {Array<Array<{x: number, y: number, onCurve: boolean}>>} contours
 */
export function cellGeometryToContours(geometry, dx, dy, baselineY) {
  if (!geometry) return [];
  const fy = (cy) => baselineY - cy;
  const round = (v) => Math.round(v);

  switch (geometry.type) {
    case 'rect': {
      const x0 = round(geometry.x + dx);
      const x1 = round(geometry.x + dx + geometry.width);
      const yTop = round(fy(geometry.y + dy));            // higher fontY
      const yBot = round(fy(geometry.y + dy + geometry.height)); // lower fontY
      // Clockwise in Y-up: top-left → top-right → bottom-right → bottom-left
      return [[
        { x: x0, y: yTop, onCurve: true },
        { x: x1, y: yTop, onCurve: true },
        { x: x1, y: yBot, onCurve: true },
        { x: x0, y: yBot, onCurve: true },
      ]];
    }
    case 'circle': {
      const cx = geometry.cx + dx;
      const cy = fy(geometry.cy + dy);
      const r = geometry.r;
      const rOff = r * KAPPA_QUAD;
      const N = CIRCLE_SEGMENTS;
      const pts = [];
      // Alternate on-curve / off-curve points around the circle, clockwise.
      // On-curve at angle 2πk/N, off-curve at (2k+1)π/N.
      for (let k = 0; k < N; k++) {
        const aOn = (2 * Math.PI * k) / N;
        pts.push({
          x: round(cx + r * Math.cos(aOn)),
          y: round(cy + r * Math.sin(aOn)),
          onCurve: true,
        });
        const aOff = (Math.PI * (2 * k + 1)) / N;
        pts.push({
          x: round(cx + rOff * Math.cos(aOff)),
          y: round(cy + rOff * Math.sin(aOff)),
          onCurve: false,
        });
      }
      return [pts];
    }
    case 'polygon': {
      if (!geometry.points || geometry.points.length < 3) return [];
      // Source is Y-down; reverse to keep CW winding in Y-up font space.
      const pts = geometry.points;
      const out = [];
      for (let i = pts.length - 1; i >= 0; i--) {
        out.push({
          x: round(pts[i].x + dx),
          y: round(fy(pts[i].y + dy)),
          onCurve: true,
        });
      }
      return [out];
    }
    default:
      return [];
  }
}

/**
 * Estimate the number of glyf points a cell will produce. Used to pre-allocate
 * delta buffers for gvar.
 */
export function cellPointCount(geometry) {
  if (!geometry) return 0;
  if (geometry.type === 'rect') return 4;
  if (geometry.type === 'circle') return CIRCLE_SEGMENTS * 2;
  if (geometry.type === 'polygon') return geometry.points?.length || 0;
  return 0;
}
