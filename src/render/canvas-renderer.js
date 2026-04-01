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

  const ox = (width - glyphSize) / 2;
  const oy = (height - glyphSize) / 2;

  ctx.clearRect(0, 0, width, height);

  // ── 1. Cell fills (back-most) ──
  for (const layer of layers) {
    if (!layer.visible) continue;
    ctx.globalAlpha = layer.opacity;

    for (const cell of layer.cells) {
      if (!cell.filled) continue;

      let pos = { ...cell.center };
      if (t.stretchAmount) {
        pos = applyStretch(pos, t.stretchAngle || 0, t.stretchAmount, glyphSize, glyphSize);
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

  // ── 2. Source image — multiply blend (middle) ──
  if (!preview && opts.backgroundImage) {
    ctx.save();
    ctx.globalAlpha = opts.backgroundOpacity ?? 0.3;
    ctx.globalCompositeOperation = 'multiply';

    const gcx = ox + glyphSize / 2;
    const gcy = oy + glyphSize / 2;

    if (t.stretchAmount) {
      const rad = (t.stretchAngle || 0) * Math.PI / 180;
      ctx.translate(gcx, gcy);
      ctx.rotate(rad);
      ctx.scale(1 + t.stretchAmount, 1);
      ctx.rotate(-rad);
      ctx.translate(-gcx, -gcy);
    }

    ctx.drawImage(opts.backgroundImage, ox, oy, glyphSize, glyphSize);
    ctx.restore();
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
  }

  // ── 3. Cell outlines + glyph boundary (front-most) ──
  if (!preview) {
    for (const layer of layers) {
      if (!layer.visible) continue;
      ctx.globalAlpha = layer.opacity;

      for (const cell of layer.cells) {
        let pos = { ...cell.center };
        if (t.stretchAmount) {
          pos = applyStretch(pos, t.stretchAngle || 0, t.stretchAmount, glyphSize, glyphSize);
        }
        if (t.baseGap) {
          pos = applyGap(pos, t.stretchAngle || 0, t.baseGap, t.gapDirectionWeight || 0, glyphSize, glyphSize);
        }

        const dx = (pos.x - cell.center.x) + ox;
        const dy = (pos.y - cell.center.y) + oy;

        ctx.save();
        ctx.translate(dx, dy);
        ctx.strokeStyle = '#ccc';
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
  }

  ctx.globalAlpha = 1;
}
