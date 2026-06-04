/**
 * The 2×2 stretch matrix `rotate(angle) · scaleX(1 + amount) · rotate(-angle)`.
 *
 * The matrix is symmetric, so it is fully described by three numbers:
 *
 *     | a  b |
 *     | b  d |
 *
 * Apply it to a point (dx, dy) as:
 *     nx = a * dx + b * dy
 *     ny = b * dx + d * dy
 *
 * @param {number} angleDeg  stretch axis angle in degrees
 * @param {number} amount    stretch amount (0 = identity)
 * @returns {{ a: number, b: number, d: number }}
 */
export function stretchMatrix(angleDeg, amount) {
  const rad = ((angleDeg ?? 0) * Math.PI) / 180;
  const s = 1 + (amount ?? 0);
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return {
    a: cos * cos * s + sin * sin,
    b: cos * sin * (s - 1),
    d: sin * sin * s + cos * cos,
  };
}
