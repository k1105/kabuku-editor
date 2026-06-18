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
 * @returns {{id: string, path: Path2D, center: {x: number, y: number}, filled: boolean, manualOverride: boolean, geometry?: Object, orientation: ?number, coherence: number, orientationSource: ?string}}
 *
 * orientation: stroke tangent angle in [0,180) (0=horizontal, 90=vertical),
 *   or null when the cell has no assigned direction (isotropic). See orientation.js.
 * coherence: 0..1 confidence of that angle (low at junctions / hand-drawn blobs).
 * orientationSource: 'image' | 'propagated' | 'manual' | null.
 */
export function createCell({ path, center, filled = false, geometry = null }) {
  return {
    id: `cell_${cellIdCounter++}`,
    path,
    center,
    filled,
    manualOverride: false,
    geometry,
    orientation: null,
    coherence: 0,
    orientationSource: null,
  };
}

/**
 * Max squared center distance (~20px) for matching a saved/old cell onto a
 * freshly generated grid — shared by regenerateCells (param tweaks) and
 * applySavedCells (load from store) so both restore fills identically.
 */
export const CELL_MATCH_DIST_SQ = 400;

/** Nearest cell to `center` by squared Euclidean distance. */
export function nearestCell(cells, center) {
  let minDist = Infinity;
  let nearest = null;
  for (const c of cells) {
    const dx = c.center.x - center.x;
    const dy = c.center.y - center.y;
    const dist = dx * dx + dy * dy;
    if (dist < minDist) {
      minDist = dist;
      nearest = c;
    }
  }
  return { cell: nearest, distSq: minDist };
}
