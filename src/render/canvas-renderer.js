import { applyStretch } from '../transform/stretch.js';
import { applyGap } from '../transform/gap.js';
import { applyMetaballFilter } from '../transform/metaball.js';

/**
 * Render layers to canvas.
 *
 * Drawing order:
 *   1. (back)  Cell fills → blur+contrast (metaball)
 *   2. (mid)   Source image — multiply blend
 *   3. (front) Cell outlines + glyph boundary
 */
export function renderCanvas(ctx, layers, opts = {}) {
  const t = opts.transform || {};
  const glyphSize = opts.glyphSize || 512;
  const width = ctx.canvas.width;
  const height = ctx.canvas.height;
  const preview = !!opts.preview;

  // Active-layer highlight: the active layer's grid outline is drawn red, and
  // (when overlayActiveFill is set — i.e. the per-character editor) its filled
  // cells get a red overlay above the metaball blur so the user can see which
  // cells belong to the layer they're painting.
  const activeLayerIndex = opts.activeLayerIndex;
  const overlayActiveFill = !!opts.overlayActiveFill;
  const ACTIVE_GRID_COLOR = '#ff0000';

  // Base-layer (下地) emphasis: when the source-image layer is the active
  // selection, draw the image bold (opaque, normal blend) and let the grids
  // recede to faint outlines so the user can focus on image placement.
  const emphasizeBackground = !!opts.emphasizeBackground;

  // Glyph origin within ctx.canvas. Defaults to auto-center; callers that
  // place the glyph at a specific position (e.g. animation direct render)
  // can override.
  const ox = opts.originX != null ? opts.originX : (width - glyphSize) / 2;
  const oy = opts.originY != null ? opts.originY : (height - glyphSize) / 2;

  // Stretch pivot Y in glyph-local px (relative to glyph top edge).
  // Defaults to glyphSize/2 if no metrics provided so behavior matches the old
  // center-stretch when fontMetrics is absent.
  const baselineLocalY = (opts.fontMetrics?.baseline != null)
    ? glyphSize * opts.fontMetrics.baseline
    : glyphSize / 2;

  ctx.clearRect(0, 0, width, height);

  // ── 1. Cell fills (back-most) ──
  for (const layer of layers) {
    if (!layer.visible) continue;
    ctx.globalAlpha = layer.opacity;

    for (const cell of layer.cells) {
      if (!cell.filled) continue;

      let pos = { ...cell.center };
      if (t.stretchAmount) {
        pos = applyStretch(pos, t.stretchAngle || 0, t.stretchAmount, glyphSize, glyphSize, baselineLocalY);
      }
      if (t.baseGap) {
        pos = applyGap(pos, t.stretchAngle || 0, t.baseGap, t.gapDirectionWeight || 0, glyphSize, glyphSize);
      }

      const dx = (pos.x - cell.center.x) + ox;
      const dy = (pos.y - cell.center.y) + oy;

      ctx.save();
      ctx.translate(dx, dy);
      ctx.fillStyle = '#000';
      ctx.fill(cell.path);
      ctx.restore();
    }
  }

  ctx.globalAlpha = 1;

  // Apply blur + contrast to the cell fills (auto-contrast when blur > 0)
  if (t.metaballRadius > 0) {
    applyMetaballFilter(ctx, t.metaballRadius, 100);
  }

  // Emphasized: the base image is drawn at full opacity, which would otherwise
  // bury the cell fills. Snapshot the fill mask and clear it so the image draws
  // on a clean canvas; the fills are re-drawn faintly ON TOP afterwards so they
  // stay visible as a light guide.
  let savedFills = null;
  if (emphasizeBackground) {
    savedFills = new OffscreenCanvas(width, height);
    savedFills.getContext('2d').drawImage(ctx.canvas, 0, 0);
    ctx.clearRect(0, 0, width, height);
  }

  // ── 2. Source image — blended (middle) ──
  if (!preview && opts.backgroundImage) {
    ctx.save();
    // Emphasized: show the base image at full opacity with normal blend so it
    // dominates. Normal: a faint multiply underlay tinting the cell fills.
    ctx.globalAlpha = emphasizeBackground ? 1 : (opts.backgroundOpacity ?? 0.3);
    ctx.globalCompositeOperation = emphasizeBackground ? 'source-over' : 'multiply';

    // Image stretch pivots on baseline (matching the cells) so the underlay
    // and glyph stay aligned as stretch increases. Pivoting at glyph center
    // here would drift relative to the cells whenever baseline != 0.5.
    const gcx = ox + glyphSize / 2;
    const gcy = oy + baselineLocalY;

    if (t.stretchAmount) {
      const rad = (t.stretchAngle || 0) * Math.PI / 180;
      ctx.translate(gcx, gcy);
      ctx.rotate(rad);
      ctx.scale(1 + t.stretchAmount, 1);
      ctx.rotate(-rad);
      ctx.translate(-gcx, -gcy);
    }

    drawSourceImage(ctx, opts.backgroundImage, ox, oy, glyphSize, opts.imageTransform);
    ctx.restore();
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
  }

  // Emphasized: re-draw the snapshotted fill mask faintly over the base image so
  // the cell fills remain visible as a light guide.
  if (savedFills) {
    ctx.save();
    ctx.globalAlpha = 0.35;
    ctx.drawImage(savedFills, 0, 0);
    ctx.restore();
  }

  // ── 3. Cell outlines + glyph boundary (front-most) ──
  if (!preview) {
    // Active-layer filled-cell overlay (editing aid). Drawn above the metaball
    // blur — recoloring the black fills themselves wouldn't survive the filter,
    // which rewrites every pixel to black based on brightness.
    if (overlayActiveFill && activeLayerIndex != null) {
      const layer = layers[activeLayerIndex];
      if (layer && layer.visible) {
        ctx.globalAlpha = layer.opacity;
        for (const cell of layer.cells) {
          if (!cell.filled) continue;

          let pos = { ...cell.center };
          if (t.stretchAmount) {
            pos = applyStretch(pos, t.stretchAngle || 0, t.stretchAmount, glyphSize, glyphSize, baselineLocalY);
          }
          if (t.baseGap) {
            pos = applyGap(pos, t.stretchAngle || 0, t.baseGap, t.gapDirectionWeight || 0, glyphSize, glyphSize);
          }

          const dx = (pos.x - cell.center.x) + ox;
          const dy = (pos.y - cell.center.y) + oy;

          ctx.save();
          ctx.translate(dx, dy);
          ctx.fillStyle = 'rgba(255, 0, 0, 0.55)';
          ctx.fill(cell.path);
          ctx.restore();
        }
        ctx.globalAlpha = 1;
      }
    }

    for (let li = 0; li < layers.length; li++) {
      const layer = layers[li];
      if (!layer.visible) continue;
      ctx.globalAlpha = layer.opacity;
      const strokeColor = li === activeLayerIndex ? ACTIVE_GRID_COLOR : '#ccc';

      for (const cell of layer.cells) {
        let pos = { ...cell.center };
        if (t.stretchAmount) {
          pos = applyStretch(pos, t.stretchAngle || 0, t.stretchAmount, glyphSize, glyphSize, baselineLocalY);
        }
        if (t.baseGap) {
          pos = applyGap(pos, t.stretchAngle || 0, t.baseGap, t.gapDirectionWeight || 0, glyphSize, glyphSize);
        }

        const dx = (pos.x - cell.center.x) + ox;
        const dy = (pos.y - cell.center.y) + oy;

        ctx.save();
        ctx.translate(dx, dy);
        ctx.strokeStyle = strokeColor;
        ctx.lineWidth = 0.5;
        ctx.stroke(cell.path);
        ctx.restore();
      }
    }

    ctx.globalAlpha = 1;

    // Glyph boundary
    ctx.strokeStyle = '#555';
    ctx.lineWidth = 1;
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(ox, oy, glyphSize, glyphSize);
    ctx.setLineDash([]);

    // Font metrics guide lines
    if (opts.fontMetrics) {
      drawMetricsGuides(ctx, ox, oy, glyphSize, opts.fontMetrics);
    }
  }

  ctx.globalAlpha = 1;
}

/**
 * Draw a source image into the glyph box with center-anchored scale + offset.
 * `imageTransform` = { imageOffsetX, imageOffsetY, imageScale } in glyph-space px.
 * Used by both the renderer and Auto Mesh sampling so the image alignment is
 * consistent between what the user sees and what gets meshed.
 */
export function drawSourceImage(ctx, img, ox, oy, glyphSize, imageTransform) {
  const t = imageTransform || {};
  const scale = t.imageScale ?? 1;
  const dx = t.imageOffsetX ?? 0;
  const dy = t.imageOffsetY ?? 0;
  const size = glyphSize * scale;
  const x = ox + (glyphSize - size) / 2 + dx;
  const y = oy + (glyphSize - size) / 2 + dy;
  ctx.drawImage(img, x, y, size, size);
}

const METRICS_LINES = [
  { key: 'ascender',  label: 'asc',  color: '#3b82f6' },
  { key: 'xHeight',   label: 'x',    color: '#10b981' },
  { key: 'baseline',  label: 'base', color: '#ef4444' },
  { key: 'descender', label: 'desc', color: '#a855f7' },
];

function drawMetricsGuides(ctx, ox, oy, glyphSize, metrics) {
  ctx.save();
  const fontPx = Math.max(10, Math.round(glyphSize * 0.025));
  const labelGap = Math.max(4, Math.round(glyphSize * 0.01));
  ctx.lineWidth = Math.max(1, glyphSize / 512);
  ctx.font = `${fontPx}px sans-serif`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  for (const def of METRICS_LINES) {
    const ratio = metrics[def.key];
    if (typeof ratio !== 'number') continue;
    const y = oy + glyphSize * ratio;
    ctx.strokeStyle = def.color;
    ctx.beginPath();
    ctx.moveTo(ox, y);
    ctx.lineTo(ox + glyphSize, y);
    ctx.stroke();
    ctx.fillStyle = def.color;
    ctx.fillText(def.label, ox + glyphSize + labelGap, y);
  }
  ctx.restore();
}

/**
 * Pixel margin needed on each side of the glyph (within the offscreen canvas)
 * to fit the metrics labels drawn outside the glyph's right edge without
 * clipping. Callers can use this to size the canvas accordingly.
 */
export function metricsLabelMargin(glyphSize) {
  const fontPx = Math.max(10, Math.round(glyphSize * 0.025));
  const labelGap = Math.max(4, Math.round(glyphSize * 0.01));
  // Worst-case label is "desc" / "base" — estimate ~3.5× fontPx in width.
  return labelGap + Math.ceil(fontPx * 3.5);
}
