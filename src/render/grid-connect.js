import { cellDisplacement, cellScaleFactor } from './transform-utils.js';

/**
 * Grid connect (グリッド接続) for PixelGrid layers: filled cells that sit
 * consecutively on the lattice along the direction orthogonal to the stretch
 * are bridged with quads, so a run of cells reads as one continuous segment
 * instead of a dotted trail once the transform pulls the cells apart.
 *
 * The bridge geometry is computed here once (per-cell displacement + scale
 * applied) and consumed by every output path — canvas renderer, animation
 * renderer, SVG exporter and font exporter — so exports match the screen.
 */

// Lattice steps for the four principal directions, index = angle / 45°.
// Canvas is Y-down, so 45° points down-right → step (+1, +1).
const STEPS = [
  { di: 1, dj: 0 },  // 0°   horizontal
  { di: 1, dj: 1 },  // 45°  down-right
  { di: 0, dj: 1 },  // 90°  vertical
  { di: -1, dj: 1 }, // 135° down-left
];

/** Whether the layer opts into grid connect (PixelGrid-only param). */
export function isConnectEnabled(layer) {
  return layer?.gridPlugin?.name === 'PixelGrid' && (layer.gridParams?.connect ?? 0) >= 0.5;
}

/** Lattice step for the 45°-quantized direction nearest to `angle` (deg). */
export function connectionStep(angle) {
  const norm = ((angle % 180) + 180) % 180;
  return STEPS[Math.round(norm / 45) % 4];
}

/** Cell pitch (px) inferred from a cell's geometry (rect side / circle diameter). */
function cellSize(cell) {
  const g = cell.geometry;
  if (!g) return 0;
  if (g.type === 'rect') return g.width;
  if (g.type === 'circle') return g.r * 2;
  return 0;
}

/**
 * Adjacent filled-cell pairs along the connect direction, in original
 * (undisplaced) grid space. Cells are indexed on the lattice by rounding
 * center offsets from the minimum filled center, so float centers map to
 * exact integer grid coords.
 *
 * @param {Array} cells - layer cells (filled + unfilled)
 * @param {number} angle - reference direction in degrees (quantized to 45°)
 * @returns {Array<[Object, Object]>} pairs [cellA, cellB], B = A + step
 */
export function connectorPairs(cells, angle) {
  const filled = cells.filter((c) => c.filled);
  if (filled.length < 2) return [];
  const size = cellSize(filled[0]);
  if (!(size > 0)) return [];

  let minX = Infinity, minY = Infinity;
  for (const c of filled) {
    if (c.center.x < minX) minX = c.center.x;
    if (c.center.y < minY) minY = c.center.y;
  }
  const col = (c) => Math.round((c.center.x - minX) / size);
  const row = (c) => Math.round((c.center.y - minY) / size);

  const byIndex = new Map();
  for (const c of filled) byIndex.set(`${col(c)},${row(c)}`, c);

  const { di, dj } = connectionStep(angle);
  const pairs = [];
  for (const c of filled) {
    const neighbor = byIndex.get(`${col(c) + di},${row(c) + dj}`);
    if (neighbor) pairs.push([c, neighbor]);
  }
  return pairs;
}

/** Connect direction (deg) for a transform: orthogonal to the stretch. */
function connectAngle(t) {
  return (t.scaleRefAngle ?? t.stretchAngle ?? 0) + 90;
}

const EMPTY_SET = new Set();

/**
 * Cells whose own shape is hidden by grid connect: the interior cells of a
 * run (a connect neighbor on both sides). Their shape is nominally covered by
 * the bridge quads, but pokes out wherever the displaced run bends or the
 * neighbors' per-cell scale differs, so only the run's endpoints (and
 * isolated cells) keep their shape. Every output path consults this set so
 * exports match the screen.
 *
 * Version-gated: only active when `t.connectHideInterior` is set (projects at
 * VERSION ≥ 9 — see core/project.js). Older projects keep drawing every cell.
 *
 * @param {Object} layer - runtime layer (gridPlugin, gridParams, cells)
 * @param {Object} t - shared transform (scaleRefAngle / stretchAngle / connectHideInterior)
 * @returns {Set<Object>} cells to skip when drawing cell shapes
 */
export function connectHiddenCells(layer, t) {
  if (!t?.connectHideInterior || !isConnectEnabled(layer)) return EMPTY_SET;
  const hasNext = new Set();
  const hasPrev = new Set();
  for (const [a, b] of connectorPairs(layer.cells, connectAngle(t))) {
    hasNext.add(a);
    hasPrev.add(b);
  }
  const hidden = new Set();
  for (const c of hasNext) if (hasPrev.has(c)) hidden.add(c);
  return hidden;
}

/**
 * Bridge quads for one layer, in glyph-local coordinates with the stretch/gap
 * displacement already applied. Each quad spans between the displaced centers
 * of an adjacent pair, with per-end half-widths matching each cell's rendered
 * size (cell pitch × per-cell orientation scale), so the bridge stays flush
 * with the cells it connects.
 *
 * Point order matches the exporters' polygon winding convention (same as the
 * grid cells'), so font/SVG output unions correctly with the cell shapes.
 *
 * @param {Object} layer - runtime layer (gridPlugin, gridParams, cells, scale*)
 * @param {Object} t - shared transform (stretch/gap; scaleRefAngle optional)
 * @param {number} width  - glyph box width
 * @param {number} height - glyph box height
 * @param {number} baselineY - stretch pivot Y (glyph-local px)
 * @returns {Array<{points: Array<{x: number, y: number}>}>}
 */
export function connectorQuads(layer, t, width, height, baselineY) {
  if (!isConnectEnabled(layer)) return [];
  // Runs orthogonal to the stretch direction are the ones to connect.
  const angle = connectAngle(t);
  const layerT = {
    ...t,
    scaleParallel: layer.scaleParallel ?? 1,
    scaleOrthogonal: layer.scaleOrthogonal ?? 1,
  };
  const quads = [];
  for (const [a, b] of connectorPairs(layer.cells, angle)) {
    const pa = cellDisplacement(a.center, t, width, height, baselineY).pos;
    const pb = cellDisplacement(b.center, t, width, height, baselineY).pos;
    const len = Math.hypot(pb.x - pa.x, pb.y - pa.y);
    if (len === 0) continue;
    const px = -(pb.y - pa.y) / len;
    const py = (pb.x - pa.x) / len;
    const ra = Math.abs(cellScaleFactor(a, layerT)) * cellSize(a) / 2;
    const rb = Math.abs(cellScaleFactor(b, layerT)) * cellSize(b) / 2;
    quads.push({
      points: [
        { x: pa.x + px * ra, y: pa.y + py * ra },
        { x: pb.x + px * rb, y: pb.y + py * rb },
        { x: pb.x - px * rb, y: pb.y - py * rb },
        { x: pa.x - px * ra, y: pa.y - py * ra },
      ],
    });
  }
  return quads;
}

/** Fill one quad's points as a closed path on a 2D context. */
export function fillQuad(ctx, points) {
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
  ctx.closePath();
  ctx.fill();
}
