/**
 * Per-cell stroke orientation (接線の傾き).
 *
 * Each filled cell can carry the tangent angle of the character skeleton it
 * sits on. The angle is an *undirected line direction* in [0, 180): 0 = a
 * horizontal stroke, 90 = a vertical stroke (so 「十」's 横棒 → 0, 縦棒 → 90).
 *
 * Two ways an angle is assigned:
 *   1. Image-derived (`source: 'image'`): the structure tensor of the base
 *      reference image, sampled in a window around the cell center. This is the
 *      primary source whenever a base image is present.
 *   2. Propagated (`source: 'propagated'`): for hand-painted cells that fall
 *      outside the image strokes, the orientation diffuses from nearby filled
 *      cells that already have one (倍角空間での重み付き平均).
 *   3. Manual (`source: 'manual'`): a per-cell user override. Protected from
 *      both recompute paths above.
 *
 * Angles must never be averaged directly (0 == 180 wraps around); always
 * accumulate in the double-angle vector (cos2θ, sin2θ) / the tensor and decode
 * at the end.
 */

const MIN_COHERENCE = 0.15; // below this the local structure is a junction/blob → no single direction
const TRACE_EPS = 1e-6; // flat (no-gradient) region guard

/** Wrap a degree value into the undirected-line range [0, 180). */
export function normalizeAngle180(deg) {
  return ((deg % 180) + 180) % 180;
}

/**
 * Angular distance between two undirected lines, in [0, 90].
 * 0 = parallel, 90 = orthogonal. Use this to combine a cell orientation with
 * the global stretch angle (e.g. fade deformation for orthogonal cells).
 */
export function angularDelta180(a, b) {
  const d = Math.abs(normalizeAngle180(a) - normalizeAngle180(b));
  return Math.min(d, 180 - d);
}

/** Approximate cell pitch (center-to-center spacing) from the cell centers. */
export function estimatePitch(cells) {
  if (!cells || cells.length < 2) return 16;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const c of cells) {
    const { x, y } = c.center;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const area = Math.max(1, maxX - minX) * Math.max(1, maxY - minY);
  return Math.sqrt(area / cells.length);
}

/** Set a per-cell manual override. Survives both recompute paths. */
export function setCellOrientationManual(cell, angleDeg) {
  cell.orientation = normalizeAngle180(angleDeg);
  cell.coherence = 1;
  cell.orientationSource = 'manual';
}

/** Drop a manual override so the next auto pass can recompute it. */
export function clearCellOrientationOverride(cell) {
  if (cell.orientationSource === 'manual') cell.orientationSource = null;
}

/**
 * Compute image-derived orientations for the filled cells, in place.
 *
 * @param {Uint8ClampedArray} data - RGBA pixels of the base reference image
 * @param {number} W
 * @param {number} H
 * @param {Array} cells - cells whose `center` is in the same px space as the image
 * @param {Object} [opts]
 * @param {number} [opts.windowRadius] - sampling half-window in px (default ≈ cell pitch)
 */
export function computeCellOrientations(data, W, H, cells, opts = {}) {
  const radius = Math.max(2, Math.min(24, Math.round(opts.windowRadius ?? estimatePitch(cells))));
  const sigma = radius / 2;
  const twoSigma2 = 2 * sigma * sigma;

  const brightness = (x, y) => {
    if (x < 0 || x >= W || y < 0 || y >= H) return 255; // outside image = white bg
    const i = (y * W + x) * 4;
    return (data[i] + data[i + 1] + data[i + 2]) / 3;
  };

  for (const cell of cells) {
    if (!cell.filled) continue;
    if (cell.orientationSource === 'manual') continue;

    const cx = Math.round(cell.center.x);
    const cy = Math.round(cell.center.y);
    let Jxx = 0, Jyy = 0, Jxy = 0;

    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const w = Math.exp(-(dx * dx + dy * dy) / twoSigma2);
        const x = cx + dx;
        const y = cy + dy;
        // central differences
        const ix = (brightness(x + 1, y) - brightness(x - 1, y)) / 2;
        const iy = (brightness(x, y + 1) - brightness(x, y - 1)) / 2;
        Jxx += w * ix * ix;
        Jyy += w * iy * iy;
        Jxy += w * ix * iy;
      }
    }

    const trace = Jxx + Jyy;
    if (trace < TRACE_EPS) continue; // flat region: keep any existing (e.g. propagated) value
    const coherence = Math.sqrt((Jxx - Jyy) * (Jxx - Jyy) + 4 * Jxy * Jxy) / trace;
    if (coherence < MIN_COHERENCE) continue; // junction/blob: no single direction, leave as-is

    // Dominant gradient orientation; stroke tangent is perpendicular to it.
    const gradAngle = 0.5 * Math.atan2(2 * Jxy, Jxx - Jyy);
    const tangentDeg = normalizeAngle180((gradAngle + Math.PI / 2) * 180 / Math.PI);
    cell.orientation = tangentDeg;
    cell.coherence = coherence;
    cell.orientationSource = 'image';
  }
}

/**
 * Weighted-average orientation of the oriented filled cells around `target`,
 * in double-angle space (so 0°/180° don't cancel). Returns {orientation,
 * coherence} or null if no oriented neighbor is in range. Pure (no mutation).
 */
function neighborOrientation(cells, target, radius) {
  const r2 = radius * radius;
  let sumCos = 0, sumSin = 0, sumW = 0;
  for (const c of cells) {
    if (c === target || !c.filled || c.orientation == null) continue;
    const dx = c.center.x - target.center.x;
    const dy = c.center.y - target.center.y;
    const dist2 = dx * dx + dy * dy;
    if (dist2 > r2) continue;
    const w = (c.coherence || 0.01) / (Math.sqrt(dist2) + 1);
    const rad = (c.orientation * Math.PI) / 180;
    sumCos += w * Math.cos(2 * rad);
    sumSin += w * Math.sin(2 * rad);
    sumW += w;
  }
  if (sumW === 0) return null;
  const angle = 0.5 * Math.atan2(sumSin, sumCos);
  return {
    orientation: normalizeAngle180((angle * 180) / Math.PI),
    coherence: Math.sqrt(sumCos * sumCos + sumSin * sumSin) / sumW, // resultant length = consistency
  };
}

/**
 * Assign an orientation to a newly painted cell by diffusing from nearby filled
 * cells that already have one (案A: 近傍伝播). No-op if the cell has a manual
 * override or no oriented neighbor is in range.
 *
 * @param {Array} cells - all cells in the layer
 * @param {Object} target - the freshly filled cell
 * @param {Object} [opts]
 * @param {number} [opts.radius] - neighbor search radius in px (default ≈ 3× pitch)
 */
export function propagateOrientation(cells, target, opts = {}) {
  if (target.orientationSource === 'manual') return;
  const radius = opts.radius ?? estimatePitch(cells) * 3;
  const res = neighborOrientation(cells, target, radius);
  if (!res) return;
  target.orientation = res.orientation;
  target.coherence = res.coherence;
  target.orientationSource = 'propagated';
}

/**
 * Fill every still-orientation-less filled cell (junctions, thick-stroke
 * interiors, hand-painted cells) by diffusing from the oriented cells, so that
 * *all* filled cells end up with an angle. Runs in rounds: each round reads the
 * previous round's state (batched apply → order-independent) and propagates one
 * ring further, until no cell changes or maxRounds is hit. Manual and existing
 * values are never overwritten.
 *
 * @param {Array} cells
 * @param {Object} [opts]
 * @param {number} [opts.radius] - neighbor search radius (default ≈ 3× pitch)
 * @param {number} [opts.maxRounds] - diffusion cap (default 8)
 */
export function fillOrientationGaps(cells, opts = {}) {
  const radius = opts.radius ?? estimatePitch(cells) * 3;
  const maxRounds = opts.maxRounds ?? 8;
  for (let round = 0; round < maxRounds; round++) {
    const gaps = cells.filter(
      (c) => c.filled && c.orientation == null && c.orientationSource !== 'manual'
    );
    if (gaps.length === 0) break;
    const updates = [];
    for (const g of gaps) {
      const res = neighborOrientation(cells, g, radius);
      if (res) updates.push([g, res]);
    }
    if (updates.length === 0) break; // isolated cells with no oriented neighbor
    for (const [g, res] of updates) {
      g.orientation = res.orientation;
      g.coherence = res.coherence;
      g.orientationSource = 'propagated';
    }
  }
}
