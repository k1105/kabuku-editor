import { layoutText, layoutBounds } from '../compose/text-layout.js';
import { computeCacheScale, RENDER_SIZE } from '../compose/glyph-cache.js';
import { resolveTransform } from '../core/project.js';
import { buildRuntimeLayers } from '../core/layer-builder.js';
import { applyStretch } from '../transform/stretch.js';
import { applyGap } from '../transform/gap.js';
import { applyMetaballFilter } from '../transform/metaball.js';
import { sampleAnimation } from './animation.js';

function transformFromParams(p, global) {
  return {
    stretchAngle: p.stretchAngle,
    stretchAmount: p.stretchAmount,
    baseGap: p.baseGap,
    gapDirectionWeight: p.gapDirectionWeight,
    metaballStrength: global.metaballStrength ?? 1,
    metaballRadius: p.metaballRadius,
  };
}

function computeLayout(params, animation, charIds, global) {
  const positions = layoutText(animation.text, charIds, {
    fontSize: params.fontSize,
    textBoxWidth: params.textBoxWidth,
    kerning: params.kerning,
    lineHeight: params.lineHeight,
    writingMode: animation.writingMode,
  });
  // cacheScale is stretch-independent now (only gap/blur margin), so layout
  // dimensions don't grow with stretchAmount. Stretched cells that fall
  // outside the frame are simply clipped at draw time.
  const cacheScale = computeCacheScale(transformFromParams(params, global));
  const drawSize = params.fontSize * cacheScale;
  const drawOffset = (drawSize - params.fontSize) / 2;
  const pad = 32 + drawOffset;
  const bounds = layoutBounds(positions, params.fontSize);
  const cw = Math.max(bounds.width + pad * 2, 200);
  const ch = Math.max(bounds.height + pad * 2, 200);
  return { positions, pad, cw, ch, drawSize, drawOffset };
}

/**
 * Compute the uniform cache canvas dimensions for an animation — runs the
 * same first pass as renderFrames(), but stops before rendering. Used to
 * seed the frame cache so live scrubbing can write entries at the same
 * dimensions as the Render-button output.
 */
export function computeFrameCacheShape(animation, ctx) {
  const { charIds, global } = ctx;
  const fps = animation.fps;
  const totalFrames = Math.max(1, Math.round(animation.duration * fps));
  let maxW = 0, maxH = 0;
  for (let i = 0; i < totalFrames; i++) {
    const t = i / fps;
    const params = sampleAnimation(animation, t);
    const layout = computeLayout(params, animation, charIds, global);
    if (layout.cw > maxW) maxW = layout.cw;
    if (layout.ch > maxH) maxH = layout.ch;
  }
  return { fps, totalFrames, width: Math.ceil(maxW), height: Math.ceil(maxH) };
}

function paramsEqual(a, b) {
  if (!a || !b) return false;
  for (const k in a) {
    if (a[k] !== b[k]) return false;
  }
  for (const k in b) {
    if (!(k in a)) return false;
  }
  return true;
}

/**
 * Render one glyph's cells (with full per-cell stretch + gap) into a work
 * canvas, apply metaball blur within that canvas, then composite onto the
 * frame canvas. Work canvas is frame-sized and reused across glyphs — the
 * per-glyph metaball locality is preserved because each glyph is processed
 * in isolation on the cleared work canvas, while memory stays bounded by
 * the frame dimensions (independent of stretchAmount).
 *
 * Cells are positioned at the glyph's output coordinates (gx, gy) and drawn
 * via ctx.scale(fontSize/RENDER_SIZE) so vector paths anti-alias at output
 * resolution. Blur is scaled by fontSize/RENDER_SIZE so its on-screen extent
 * matches the legacy "render at RENDER_SIZE, then downscale" path.
 */
function renderGlyphOntoFrame(octx, workCanvas, workCtx, gx, gy, fontSize, layers, charTransform, global) {
  workCtx.clearRect(0, 0, workCanvas.width, workCanvas.height);

  const baselineLocalY = (global?.fontMetrics?.baseline != null)
    ? RENDER_SIZE * global.fontMetrics.baseline
    : RENDER_SIZE / 2;
  const scale = fontSize / RENDER_SIZE;

  workCtx.save();
  workCtx.translate(gx, gy);
  workCtx.scale(scale, scale);

  for (const layer of layers) {
    if (!layer.visible) continue;
    workCtx.globalAlpha = layer.opacity;
    for (const cell of layer.cells) {
      if (!cell.filled) continue;
      let pos = cell.center;
      if (charTransform.stretchAmount) {
        pos = applyStretch(pos, charTransform.stretchAngle || 0, charTransform.stretchAmount, RENDER_SIZE, RENDER_SIZE, baselineLocalY);
      }
      if (charTransform.baseGap) {
        pos = applyGap(pos, charTransform.stretchAngle || 0, charTransform.baseGap, charTransform.gapDirectionWeight || 0, RENDER_SIZE, RENDER_SIZE);
      }
      const cdx = pos.x - cell.center.x;
      const cdy = pos.y - cell.center.y;
      workCtx.save();
      workCtx.translate(cdx, cdy);
      workCtx.fillStyle = '#000';
      workCtx.fill(cell.path);
      workCtx.restore();
    }
  }
  workCtx.globalAlpha = 1;
  workCtx.restore();

  // Blur radius in glyph-local px (RENDER_SIZE space); scale to output px so
  // the visual blur matches the value the user sees in the slider regardless
  // of fontSize.
  const blur = (charTransform.metaballRadius || 0) * scale;
  if (blur > 0) {
    applyMetaballFilter(workCtx, blur, 100);
  }

  octx.drawImage(workCanvas, 0, 0);
}

/**
 * Render animation frames to offscreen canvases.
 *
 * Each glyph is drawn directly into a frame-sized work offscreen at its
 * output position, then composited onto the frame canvas. Per-glyph
 * metaball locality is preserved; memory is bounded by frame dimensions
 * (independent of stretchAmount). Cells stretched beyond the frame are
 * clipped naturally at the work canvas edge.
 *
 * Supports an external per-frame cache: when `ctx.cache` is provided, already
 * populated entries are skipped (no re-render), newly produced frames are
 * stored back into `cache.frames[i]`, and `ctx.onCacheUpdate()` fires after
 * each entry lands so the caller can refresh UI (e.g. the timeline indicator).
 *
 * Returns { frames, fps, width, height }. `frames` is the full ordered list
 * — the cache and the return value share canvas references for in-place
 * frames, so re-running render after editing only re-paints missing entries.
 */
export async function renderFrames(animation, ctx) {
  const { project, global, charIds, onProgress, cache, onCacheUpdate } = ctx;
  const fps = animation.fps;
  const totalFrames = Math.max(1, Math.round(animation.duration * fps));

  // First pass: find maximum canvas dimensions across all frames
  let maxW = 0, maxH = 0;
  const perFrame = [];
  for (let i = 0; i < totalFrames; i++) {
    const t = i / fps;
    const params = sampleAnimation(animation, t);
    const layout = computeLayout(params, animation, charIds, global);
    if (layout.cw > maxW) maxW = layout.cw;
    if (layout.ch > maxH) maxH = layout.ch;
    perFrame.push({ params, layout });
  }
  maxW = Math.ceil(maxW);
  maxH = Math.ceil(maxH);

  // Prepare external cache (if any). Reset its shape when fps/totalFrames or
  // canvas dimensions don't match — those changes invalidate every entry.
  if (cache) {
    const shapeChanged = cache.fps !== fps
      || cache.totalFrames !== totalFrames
      || cache.width !== maxW
      || cache.height !== maxH;
    if (shapeChanged || !Array.isArray(cache.frames) || cache.frames.length !== totalFrames) {
      cache.fps = fps;
      cache.totalFrames = totalFrames;
      cache.width = maxW;
      cache.height = maxH;
      cache.frames = new Array(totalFrames).fill(null);
    }
    onCacheUpdate?.();
  }

  // Pre-build runtime layers per charId. Project geometry doesn't change
  // during render, so we can reuse the cell paths across every frame.
  const layersByChar = new Map();
  function getLayersFor(charId) {
    if (layersByChar.has(charId)) return layersByChar.get(charId);
    const charData = project.characters[charId];
    if (!charData) {
      layersByChar.set(charId, null);
      return null;
    }
    const layers = buildRuntimeLayers(global, charData, RENDER_SIZE);
    layersByChar.set(charId, layers.length > 0 ? layers : null);
    return layersByChar.get(charId);
  }

  // Single work canvas reused across all glyphs + frames. Size matches the
  // frame canvas so a stretched cell that lands anywhere within the visible
  // frame still rasterizes; cells beyond the frame are clipped naturally.
  const workCanvas = document.createElement('canvas');
  workCanvas.width = maxW;
  workCanvas.height = maxH;
  const workCtx = workCanvas.getContext('2d');

  const frames = new Array(totalFrames);
  for (let i = 0; i < totalFrames; i++) {
    // Reuse cached entry when present — no re-render needed.
    if (cache?.frames?.[i]) {
      frames[i] = cache.frames[i];
      onProgress?.(i + 1, totalFrames);
      if (i % 16 === 15) await new Promise(r => setTimeout(r, 0));
      continue;
    }

    const { params, layout } = perFrame[i];

    // If params are identical to the previous frame, reuse its canvas reference.
    // Output is pixel-identical, so PNG/GIF encoders can re-read the same bitmap.
    if (i > 0 && paramsEqual(params, perFrame[i - 1].params) && frames[i - 1]) {
      frames[i] = frames[i - 1];
      if (cache) {
        cache.frames[i] = frames[i - 1];
        onCacheUpdate?.();
      }
      onProgress?.(i + 1, totalFrames);
      if (i % 4 === 3) await new Promise(r => setTimeout(r, 0));
      continue;
    }

    const off = document.createElement('canvas');
    off.width = maxW;
    off.height = maxH;
    const octx = off.getContext('2d');
    octx.fillStyle = '#fff';
    octx.fillRect(0, 0, maxW, maxH);

    // Center the content
    const dx = Math.floor((maxW - layout.cw) / 2);
    const dy = Math.floor((maxH - layout.ch) / 2);

    // Apply camera transform around the frame center
    octx.save();
    const fcx = maxW / 2;
    const fcy = maxH / 2;
    octx.translate(fcx + (params.cameraX || 0), fcy + (params.cameraY || 0));
    const dist = params.cameraDistance != null ? params.cameraDistance : 1;
    octx.scale(dist, dist);
    octx.translate(-fcx, -fcy);

    const transform = transformFromParams(params, global);
    for (const pos of layout.positions) {
      const gx = dx + layout.pad + pos.x;
      const gy = dy + layout.pad + pos.y;
      if (pos.missing) {
        octx.fillStyle = '#f0f0f0';
        octx.fillRect(gx, gy, params.fontSize, params.fontSize);
        octx.strokeStyle = '#bbb';
        octx.lineWidth = 1;
        octx.strokeRect(gx, gy, params.fontSize, params.fontSize);
        continue;
      }
      const charData = project.characters[pos.charId];
      const charTransform = resolveTransform({ ...global, ...transform }, charData?.transformOverrides || {});
      const layers = getLayersFor(pos.charId);
      if (!layers) continue;
      renderGlyphOntoFrame(octx, workCanvas, workCtx, gx, gy, params.fontSize, layers, charTransform, global);
    }
    octx.restore();

    frames[i] = off;
    if (cache) {
      cache.frames[i] = off;
      onCacheUpdate?.();
    }
    onProgress?.(i + 1, totalFrames);

    // Yield to browser every few frames
    if (i % 4 === 3) await new Promise(r => setTimeout(r, 0));
  }

  return { frames, fps, width: maxW, height: maxH };
}
