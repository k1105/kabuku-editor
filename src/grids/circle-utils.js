import { createCell } from '../core/cell.js';

/**
 * Shared dot-cell construction for the circle-family grids
 * (CircleGrid / EllipseGrid / FibonacciGrid).
 */

/** A circle cell centered at (x, y). */
export function circleCell(x, y, r) {
  const path = new Path2D();
  path.arc(x, y, r, 0, Math.PI * 2);
  return createCell({
    path,
    center: { x, y },
    geometry: { type: 'circle', cx: x, cy: y, r },
  });
}

/** Same, but null when the dot would cross the canvas edge. */
export function circleCellInBounds(x, y, r, width, height) {
  if (x - r < 0 || x + r > width || y - r < 0 || y + r > height) return null;
  return circleCell(x, y, r);
}
