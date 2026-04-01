let cellIdCounter = 0;

/**
 * @param {Object} opts
 * @param {Path2D} opts.path
 * @param {{x: number, y: number}} opts.center
 * @param {boolean} [opts.filled]
 * @returns {{id: string, path: Path2D, center: {x: number, y: number}, filled: boolean, manualOverride: boolean}}
 */
export function createCell({ path, center, filled = false }) {
  return {
    id: `cell_${cellIdCounter++}`,
    path,
    center,
    filled,
    manualOverride: false,
  };
}
