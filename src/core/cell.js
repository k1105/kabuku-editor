let cellIdCounter = 0;

/**
 * @param {Object} opts
 * @param {Path2D} opts.path
 * @param {{x: number, y: number}} opts.center
 * @param {boolean} [opts.filled]
 * @param {Object} [opts.geometry] - shape metadata for vector export.
 *   { type: 'rect', x, y, width, height }
 *   { type: 'circle', cx, cy, r }
 *   { type: 'polygon', points: [{x, y}, ...] }
 * @returns {{id: string, path: Path2D, center: {x: number, y: number}, filled: boolean, manualOverride: boolean, geometry?: Object}}
 */
export function createCell({ path, center, filled = false, geometry = null }) {
  return {
    id: `cell_${cellIdCounter++}`,
    path,
    center,
    filled,
    manualOverride: false,
    geometry,
  };
}
