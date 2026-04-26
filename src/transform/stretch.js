/**
 * Apply aspect ratio stretch transform to cell centers.
 * Returns new positions without modifying originals.
 *
 * Pivot is (canvasWidth/2, baselineY) — horizontal centered, vertical anchored
 * to the baseline so vertical stretches grow upward only and the glyph stays
 * sitting on the baseline (required for typographic consistency in an
 * anamorphic font where glyphs may extend past asc/desc).
 *
 * @param {{x: number, y: number}} center - original center
 * @param {number} angle - stretch direction in degrees (0-180)
 * @param {number} amount - stretch amount (0 = none, 1 = double)
 * @param {number} canvasWidth
 * @param {number} canvasHeight
 * @param {number} [baselineY] - baseline Y in canvas px; defaults to canvasHeight/2
 * @returns {{x: number, y: number}} transformed center
 */
export function applyStretch(center, angle, amount, canvasWidth, canvasHeight, baselineY) {
  if (amount === 0) return center;

  const cx = canvasWidth / 2;
  const cy = baselineY ?? canvasHeight / 2;
  const rad = (angle * Math.PI) / 180;

  // Translate to origin
  let x = center.x - cx;
  let y = center.y - cy;

  // Rotate to align stretch direction with X axis
  const cos = Math.cos(-rad);
  const sin = Math.sin(-rad);
  let rx = x * cos - y * sin;
  let ry = x * sin + y * cos;

  // Scale along X (stretch direction)
  rx *= (1 + amount);

  // Rotate back
  const cos2 = Math.cos(rad);
  const sin2 = Math.sin(rad);
  x = rx * cos2 - ry * sin2;
  y = rx * sin2 + ry * cos2;

  return { x: x + cx, y: y + cy };
}
