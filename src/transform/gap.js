/**
 * Apply direction-dependent gap to cell center positions.
 * Cells are pushed away from the canvas center, with more gap
 * in the stretch direction.
 *
 * @param {{x: number, y: number}} center
 * @param {number} stretchAngle - degrees
 * @param {number} baseGap
 * @param {number} weight - direction weight (0-1)
 * @param {number} canvasWidth
 * @param {number} canvasHeight
 * @returns {{x: number, y: number}}
 */
export function applyGap(center, stretchAngle, baseGap, weight, canvasWidth, canvasHeight) {
  if (baseGap === 0) return center;

  const cx = canvasWidth / 2;
  const cy = canvasHeight / 2;
  const dx = center.x - cx;
  const dy = center.y - cy;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist === 0) return center;

  const cellAngle = Math.atan2(dy, dx);
  const stretchRad = (stretchAngle * Math.PI) / 180;

  // Direction-dependent gap: more gap along stretch direction
  const cosD = Math.cos(cellAngle - stretchRad);
  const gap = baseGap * (cosD * cosD * weight + (1 - weight));

  // Push outward from center
  const scale = 1 + (gap / dist);
  return {
    x: cx + dx * scale,
    y: cy + dy * scale,
  };
}
