import { applyStretch } from '../transform/stretch.js';
import { applyGap } from '../transform/gap.js';

/**
 * Export a single layer to SVG.
 * @param {Object} layer
 * @param {number} width  - glyph box width
 * @param {number} height - glyph box height
 * @param {Object} [opts] - { transform, fontMetrics }
 */
export function exportLayerToSVG(layer, width, height, opts = {}) {
  const placed = placeCells(layer, width, height, opts);
  const blur = (opts.transform?.metaballRadius) || 0;
  const bbox = computeBBox([{ placed, blur }], width, height);
  const body = renderLayerBody(placed, bbox, blur);
  return wrapSVG(body, bbox);
}

/**
 * Export all visible layers to SVG.
 * @param {Object[]} layers
 * @param {number} width
 * @param {number} height
 * @param {Object} [opts] - { transform, fontMetrics }
 */
export function exportAllLayersToSVG(layers, width, height, opts = {}) {
  const visible = layers.filter(l => l.visible);
  const placedPerLayer = visible.map(l => placeCells(l, width, height, opts));
  const blur = (opts.transform?.metaballRadius) || 0;
  const bbox = computeBBox(placedPerLayer.map(p => ({ placed: p, blur })), width, height);

  const groups = [];
  for (let i = 0; i < visible.length; i++) {
    const layer = visible[i];
    const body = renderLayerBody(placedPerLayer[i], bbox, blur);
    if (!body) continue;
    groups.push(`  <g opacity="${layer.opacity}" id="${layer.id}">
${indent(body, '    ')}
  </g>`);
  }
  return wrapSVG(groups.join('\n'), bbox);
}

function wrapSVG(body, bbox) {
  const w = bbox.maxX - bbox.minX;
  const h = bbox.maxY - bbox.minY;
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${num(w)}" height="${num(h)}" viewBox="${num(bbox.minX)} ${num(bbox.minY)} ${num(w)} ${num(h)}">
${body}
</svg>`;
}

function indent(s, pad) {
  return s.split('\n').map(line => line ? pad + line : line).join('\n');
}

/** Resolve transformed positions and effective radii for filled cells. */
function placeCells(layer, width, height, opts) {
  const t = opts.transform || {};
  const baselineY = (opts.fontMetrics?.baseline != null)
    ? height * opts.fontMetrics.baseline
    : height / 2;
  const filled = layer.cells.filter(c => c.filled);
  return filled.map(cell => {
    let pos = { x: cell.center.x, y: cell.center.y };
    if (t.stretchAmount) {
      pos = applyStretch(pos, t.stretchAngle || 0, t.stretchAmount, width, height, baselineY);
    }
    if (t.baseGap) {
      pos = applyGap(pos, t.stretchAngle || 0, t.baseGap, t.gapDirectionWeight || 0, width, height);
    }
    const dx = pos.x - cell.center.x;
    const dy = pos.y - cell.center.y;
    return { cell, dx, dy, pos, radius: cellRadius(cell) };
  });
}

/**
 * Bounding box across all layers, including a blur padding for metaball mode.
 * Always includes the glyph box [0,0,width,height] as a baseline so empty
 * layers don't collapse the viewBox.
 */
function computeBBox(layerPlacements, width, height) {
  let minX = 0, minY = 0, maxX = width, maxY = height;
  for (const { placed, blur } of layerPlacements) {
    const pad = blur || 0;
    for (const p of placed) {
      const ext = geometryExtent(p.cell.geometry, p.dx, p.dy);
      if (ext) {
        if (ext.minX - pad < minX) minX = ext.minX - pad;
        if (ext.minY - pad < minY) minY = ext.minY - pad;
        if (ext.maxX + pad > maxX) maxX = ext.maxX + pad;
        if (ext.maxY + pad > maxY) maxY = ext.maxY + pad;
      } else {
        const r = p.radius + pad;
        if (p.pos.x - r < minX) minX = p.pos.x - r;
        if (p.pos.y - r < minY) minY = p.pos.y - r;
        if (p.pos.x + r > maxX) maxX = p.pos.x + r;
        if (p.pos.y + r > maxY) maxY = p.pos.y + r;
      }
    }
  }
  return {
    minX: Math.floor(minX) - 1,
    minY: Math.floor(minY) - 1,
    maxX: Math.ceil(maxX) + 1,
    maxY: Math.ceil(maxY) + 1,
  };
}

function geometryExtent(g, dx, dy) {
  if (!g) return null;
  if (g.type === 'rect') {
    return {
      minX: g.x + dx, minY: g.y + dy,
      maxX: g.x + dx + g.width, maxY: g.y + dy + g.height,
    };
  }
  if (g.type === 'circle') {
    return {
      minX: g.cx + dx - g.r, minY: g.cy + dy - g.r,
      maxX: g.cx + dx + g.r, maxY: g.cy + dy + g.r,
    };
  }
  if (g.type === 'polygon') {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of g.points) {
      const x = p.x + dx, y = p.y + dy;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
    return { minX, minY, maxX, maxY };
  }
  return null;
}

/**
 * Returns the inner SVG (no <g> wrapper) for a layer's placed cells, or '' if
 * empty. If blurRadius > 0, emits a vector metaball isocontour instead of
 * individual cell shapes.
 */
function renderLayerBody(placed, bbox, blurRadius) {
  if (placed.length === 0) return '';
  if (blurRadius > 0) {
    return renderMetaballPath(placed, bbox, blurRadius);
  }
  const shapes = placed
    .map(({ cell, dx, dy }) => geometryToSVG(cell.geometry, dx, dy))
    .filter(Boolean);
  if (shapes.length === 0) return '';
  return `<g fill="#000">\n${shapes.map(s => '  ' + s).join('\n')}\n</g>`;
}

function geometryToSVG(geometry, dx = 0, dy = 0) {
  if (!geometry) return null;
  switch (geometry.type) {
    case 'rect': {
      return `<rect x="${num(geometry.x + dx)}" y="${num(geometry.y + dy)}" width="${num(geometry.width)}" height="${num(geometry.height)}"/>`;
    }
    case 'circle': {
      return `<circle cx="${num(geometry.cx + dx)}" cy="${num(geometry.cy + dy)}" r="${num(geometry.r)}"/>`;
    }
    case 'polygon': {
      const pts = geometry.points
        .map(p => `${num(p.x + dx)},${num(p.y + dy)}`)
        .join(' ');
      return `<polygon points="${pts}"/>`;
    }
    default:
      return null;
  }
}

/** Approximate radius of a cell from its geometry (fallback for metaball bbox). */
function cellRadius(cell) {
  const g = cell.geometry;
  if (!g) return 6;
  if (g.type === 'circle') return g.r;
  if (g.type === 'rect') return Math.max(g.width, g.height) * 0.5;
  if (g.type === 'polygon') {
    let max = 0;
    for (const p of g.points) {
      const dx = p.x - cell.center.x;
      const dy = p.y - cell.center.y;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d > max) max = d;
    }
    return max || 6;
  }
  return 6;
}

function num(v) {
  return Math.round(v * 100) / 100;
}

// ─── Vector metaball via marching squares ───────────────────────────────────

/**
 * Match the canvas renderer's metaball pipeline (blur + contrast → threshold)
 * by rasterizing cells into a bbox-sized offscreen canvas, applying the same
 * blur filter, then tracing the 50% brightness isoline with marching squares.
 * Coordinates are emitted in glyph-local units so they align with viewBox.
 */
function renderMetaballPath(placed, bbox, blurRadius) {
  const bw = Math.max(1, Math.ceil(bbox.maxX - bbox.minX));
  const bh = Math.max(1, Math.ceil(bbox.maxY - bbox.minY));

  const off = new OffscreenCanvas(bw, bh);
  const offCtx = off.getContext('2d');
  offCtx.fillStyle = '#fff';
  offCtx.fillRect(0, 0, bw, bh);
  offCtx.fillStyle = '#000';
  // Map glyph-local coords into the offscreen canvas (origin at bbox.min)
  offCtx.translate(-bbox.minX, -bbox.minY);
  for (const p of placed) {
    drawGeometryToCtx(offCtx, p.cell.geometry, p.dx, p.dy);
  }

  const filtered = new OffscreenCanvas(bw, bh);
  const fCtx = filtered.getContext('2d');
  fCtx.filter = `blur(${blurRadius}px)`;
  fCtx.drawImage(off, 0, 0);

  const img = fCtx.getImageData(0, 0, bw, bh);
  const data = img.data;

  // ~512 samples on the long axis is plenty for a smooth contour.
  const step = Math.max(1, Math.round(Math.max(bw, bh) / 512));
  const nx = Math.floor((bw - 1) / step) + 1;
  const ny = Math.floor((bh - 1) / step) + 1;

  // Field = brightness inverted (dark/inside the blob > threshold).
  // contrast(100) clamps to a 50%-bright iso → field threshold = 127.
  const field = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) {
    const py = Math.min(j * step, bh - 1);
    for (let i = 0; i < nx; i++) {
      const px = Math.min(i * step, bw - 1);
      const idx = (py * bw + px) * 4;
      const brightness = (data[idx] + data[idx + 1] + data[idx + 2]) / 3;
      field[j * nx + i] = 255 - brightness;
    }
  }

  const threshold = 127;
  const segments = [];
  const ox = bbox.minX, oy = bbox.minY;
  for (let j = 0; j < ny - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const v0 = field[j * nx + i];
      const v1 = field[j * nx + (i + 1)];
      const v2 = field[(j + 1) * nx + (i + 1)];
      const v3 = field[(j + 1) * nx + i];
      let code = 0;
      if (v0 > threshold) code |= 1;
      if (v1 > threshold) code |= 2;
      if (v2 > threshold) code |= 4;
      if (v3 > threshold) code |= 8;
      if (code === 0 || code === 15) continue;

      const x0 = i * step + ox, y0 = j * step + oy;
      const x1 = (i + 1) * step + ox, y1 = (j + 1) * step + oy;

      const top    = () => [lerp(x0, x1, (threshold - v0) / (v1 - v0)), y0];
      const right  = () => [x1, lerp(y0, y1, (threshold - v1) / (v2 - v1))];
      const bottom = () => [lerp(x0, x1, (threshold - v3) / (v2 - v3)), y1];
      const left   = () => [x0, lerp(y0, y1, (threshold - v0) / (v3 - v0))];

      const center = (v0 + v1 + v2 + v3) * 0.25;

      switch (code) {
        case 1:  segments.push([left(), top()]); break;
        case 2:  segments.push([top(), right()]); break;
        case 3:  segments.push([left(), right()]); break;
        case 4:  segments.push([right(), bottom()]); break;
        case 5:
          if (center > threshold) {
            segments.push([left(), top()]);
            segments.push([right(), bottom()]);
          } else {
            segments.push([left(), bottom()]);
            segments.push([top(), right()]);
          }
          break;
        case 6:  segments.push([top(), bottom()]); break;
        case 7:  segments.push([left(), bottom()]); break;
        case 8:  segments.push([bottom(), left()]); break;
        case 9:  segments.push([bottom(), top()]); break;
        case 10:
          if (center > threshold) {
            segments.push([top(), right()]);
            segments.push([bottom(), left()]);
          } else {
            segments.push([top(), left()]);
            segments.push([bottom(), right()]);
          }
          break;
        case 11: segments.push([bottom(), right()]); break;
        case 12: segments.push([right(), left()]); break;
        case 13: segments.push([right(), top()]); break;
        case 14: segments.push([top(), left()]); break;
      }
    }
  }

  if (segments.length === 0) return '';

  const polylines = linkSegments(segments);
  const d = polylines.map(toPathData).join(' ');
  return `<g fill="#000" fill-rule="evenodd">\n  <path d="${d}"/>\n</g>`;
}

/** Stamp a cell's geometry onto a 2D context for offscreen rasterization. */
function drawGeometryToCtx(ctx, g, dx = 0, dy = 0) {
  if (!g) return;
  ctx.beginPath();
  if (g.type === 'rect') {
    ctx.rect(g.x + dx, g.y + dy, g.width, g.height);
  } else if (g.type === 'circle') {
    ctx.arc(g.cx + dx, g.cy + dy, g.r, 0, Math.PI * 2);
  } else if (g.type === 'polygon' && g.points.length > 0) {
    ctx.moveTo(g.points[0].x + dx, g.points[0].y + dy);
    for (let i = 1; i < g.points.length; i++) {
      ctx.lineTo(g.points[i].x + dx, g.points[i].y + dy);
    }
    ctx.closePath();
  }
  ctx.fill();
}

function lerp(a, b, t) {
  if (!isFinite(t)) return (a + b) * 0.5;
  return a + (b - a) * t;
}

/**
 * Link marching-squares line segments into closed (or open) polylines by
 * matching shared endpoints. Endpoints are quantized to a small grid to
 * tolerate floating-point noise.
 */
function linkSegments(segments) {
  const QUANT = 1000;
  const key = ([x, y]) => `${Math.round(x * QUANT)},${Math.round(y * QUANT)}`;

  const endpoints = new Map();
  for (let i = 0; i < segments.length; i++) {
    const [a, b] = segments[i];
    pushMap(endpoints, key(a), { i, end: 0 });
    pushMap(endpoints, key(b), { i, end: 1 });
  }

  const used = new Uint8Array(segments.length);
  const polylines = [];

  for (let i = 0; i < segments.length; i++) {
    if (used[i]) continue;
    used[i] = 1;
    const [a, b] = segments[i];
    const points = [a, b];

    let cur = b;
    while (true) {
      const next = findNext(endpoints, key(cur), used);
      if (!next) break;
      used[next.i] = 1;
      const seg = segments[next.i];
      const other = next.end === 0 ? seg[1] : seg[0];
      points.push(other);
      cur = other;
      if (key(cur) === key(a)) break;
    }

    cur = a;
    while (key(cur) !== key(points[points.length - 1])) {
      const next = findNext(endpoints, key(cur), used);
      if (!next) break;
      used[next.i] = 1;
      const seg = segments[next.i];
      const other = next.end === 0 ? seg[1] : seg[0];
      points.unshift(other);
      cur = other;
    }

    polylines.push(points);
  }

  return polylines;
}

function pushMap(map, k, v) {
  let arr = map.get(k);
  if (!arr) { arr = []; map.set(k, arr); }
  arr.push(v);
}

function findNext(endpoints, k, used) {
  const arr = endpoints.get(k);
  if (!arr) return null;
  for (const e of arr) {
    if (!used[e.i]) return e;
  }
  return null;
}

function toPathData(points) {
  if (points.length < 2) return '';
  const closed = points.length > 2 &&
    Math.abs(points[0][0] - points[points.length - 1][0]) < 0.01 &&
    Math.abs(points[0][1] - points[points.length - 1][1]) < 0.01;
  const pts = closed ? points.slice(0, -1) : points;
  let d = `M${num(pts[0][0])},${num(pts[0][1])}`;
  for (let i = 1; i < pts.length; i++) {
    d += ` L${num(pts[i][0])},${num(pts[i][1])}`;
  }
  if (closed) d += ' Z';
  return d;
}

export function downloadSVG(svgString, filename) {
  const blob = new Blob([svgString], { type: 'image/svg+xml' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
