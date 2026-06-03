import { layoutText, layoutBounds } from '../compose/text-layout.js';
import { computeCacheScale, RENDER_SIZE } from '../compose/glyph-cache.js';
import { resolveTransform } from '../core/project.js';
import { buildRuntimeLayers } from '../core/layer-builder.js';
import { getGrid } from '../grids/grid-plugin.js';
import { autoMesh } from '../core/mesh.js';
import { loadImageCached } from '../core/image-cache.js';
import { drawSourceImage } from '../render/canvas-renderer.js';
import { renderFontSourceToCanvas } from '../render/font/font-import.js';
import { applyStretch } from '../transform/stretch.js';
import { applyGap } from '../transform/gap.js';
import { applyMetaballFilter } from '../transform/metaball.js';
import { sampleAnimation } from './animation.js';

// Threshold for per-frame auto-mesh of animated-grid glyphs. Matches the
// editor's "Auto Mesh All" default (index-page.js) so animated frames mesh the
// same way a static glyph would.
const AUTO_MESH_THRESHOLD = 0.5;

/**
 * Parse animated grid-param tracks out of an animation. Track keys have the
 * shape `grid.<layerIndex>.<paramKey>` (see animation-page.js). Returns the set
 * of layer indices that have at least one animated param plus, per layer, the
 * list of animated param keys.
 */
function parseAnimatedGrid(tracks) {
  const layers = new Set();
  const byLayer = new Map();
  for (const key of Object.keys(tracks || {})) {
    const m = /^grid\.(\d+)\.(.+)$/.exec(key);
    if (!m) continue;
    if (!tracks[key] || tracks[key].length === 0) continue;
    const idx = parseInt(m[1], 10);
    const param = m[2];
    layers.add(idx);
    if (!byLayer.has(idx)) byLayer.set(idx, []);
    byLayer.get(idx).push(param);
  }
  return { layers, byLayer };
}

/** Stable, quantized signature of grid params for dynamic-cell caching. Values
 *  are rounded to 2 decimals so smoothly-interpolated frames that land on the
 *  same effective grid reuse the cached (already auto-meshed) cells. */
function gridParamsSignature(params) {
  return Object.keys(params).sort()
    .map(k => `${k}:${Math.round((params[k] ?? 0) * 100)}`)
    .join(',');
}

// Animation frames use a fixed canvas regardless of character count, so the
// output dimensions stay constant while content is centered within the frame.
// The size is configurable per-animation (animation.canvasWidth/Height); these
// are the fallback defaults when unset.
export const DEFAULT_CANVAS_WIDTH = 1920;
export const DEFAULT_CANVAS_HEIGHT = 1080;

function canvasWidthOf(animation) {
  return Math.max(1, Math.round(animation.canvasWidth || DEFAULT_CANVAS_WIDTH));
}
function canvasHeightOf(animation) {
  return Math.max(1, Math.round(animation.canvasHeight || DEFAULT_CANVAS_HEIGHT));
}

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

export function computeLayout(params, animation, charIds, global) {
  const positions = layoutText(animation.text, charIds, {
    fontSize: params.fontSize,
    // Animation text never wraps — it grows infinitely (line breaks only on an
    // explicit '\n'), and the whole block is centered on the canvas. (The
    // compose page still wraps via its own finite textBoxWidth.)
    textBoxWidth: Infinity,
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
 * Compute the uniform cache canvas dimensions for an animation. Used to seed
 * the frame cache so live scrubbing writes entries at the same dimensions as
 * the Render-button output. The canvas size is fixed per-animation and
 * independent of character count.
 */
export function computeFrameCacheShape(animation) {
  const fps = animation.fps;
  const totalFrames = Math.max(1, Math.round(animation.duration * fps));
  // Fixed canvas size — independent of character count. Content is centered
  // within these dimensions at draw time.
  return { fps, totalFrames, width: canvasWidthOf(animation), height: canvasHeightOf(animation) };
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
 * Create a reusable single-frame renderer for an animation. Owns the
 * runtime-layer cache (cell paths are transform-independent, so they're built
 * once per character) and a single frame-sized work canvas.
 *
 * `renderInto(octx, params, layout)` is the SINGLE source of truth for frame
 * pixels: it fills the background, centers the content within the fixed frame,
 * applies the camera transform, and draws every glyph with full per-cell
 * stretch/gap + metaball blur. Both renderFrames() (the Render button / export)
 * and live scrub-time preview call it, so on-screen frames and exported output
 * are pixel-identical — no second, approximate draw path.
 */
export function createFrameRenderer(animation, ctx) {
  const { project, global } = ctx;
  const width = canvasWidthOf(animation);
  const height = canvasHeightOf(animation);

  // Pre-build runtime layers per charId. Project geometry doesn't change during
  // a render/scrub session, so cell paths are reused across every frame.
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

  // === Animated grid params ===
  // When grid params are keyframed, a glyph's cell grid changes shape per frame,
  // so the manual fill/erase (manualOverride) can't be carried across — instead
  // we regenerate cells per frame and re-run auto-mesh against the glyph's
  // source image. This is bounded to the *input* characters (only chars laid
  // out by the text are ever processed below), keeping the cost manageable.
  const animatedGrid = parseAnimatedGrid(animation.tracks);
  const hasAnimatedGrid = animatedGrid.layers.size > 0;
  const defaultLayers = global.defaultLayers || [];

  // Per-input-char source image rasterized at RENDER_SIZE, used as the auto-mesh
  // sampling target. Loaded asynchronously; until ready, renderInto falls back
  // to the static (manual) cells so something always draws.
  const sourceCtxByChar = new Map();
  let _sourcesLoaded = !hasAnimatedGrid;
  let _readyPromise = null;
  async function loadSources() {
    const chars = new Set();
    for (const ch of (animation.text || '')) {
      if (project.characters[ch]) chars.add(ch);
    }
    await Promise.all([...chars].map(async (cid) => {
      const cd = project.characters[cid];
      let source = null;
      if (cd?.imagePath) {
        source = await loadImageCached(cd.imagePath);
      } else if (cd?.fontSource) {
        try { source = await renderFontSourceToCanvas(cd.fontSource, RENDER_SIZE, global.fontMetrics); }
        catch { source = null; }
      }
      if (!source) { sourceCtxByChar.set(cid, null); return; }
      const off = document.createElement('canvas');
      off.width = RENDER_SIZE;
      off.height = RENDER_SIZE;
      const sctx = off.getContext('2d', { willReadFrequently: true });
      sctx.fillStyle = '#fff';
      sctx.fillRect(0, 0, RENDER_SIZE, RENDER_SIZE);
      drawSourceImage(sctx, source, 0, 0, RENDER_SIZE, {
        imageOffsetX: cd?.imageOffsetX ?? 0,
        imageOffsetY: cd?.imageOffsetY ?? 0,
        imageScale: cd?.imageScale ?? 1,
      });
      sourceCtxByChar.set(cid, sctx);
    }));
    _sourcesLoaded = true;
  }
  function ready() {
    if (!hasAnimatedGrid) return Promise.resolve();
    if (!_readyPromise) _readyPromise = loadSources();
    return _readyPromise;
  }
  function isReady() { return _sourcesLoaded; }

  // Cache of per-frame generated + auto-meshed cells, keyed by char + layer +
  // quantized grid-param signature so identical frames don't recompute.
  const dynCellCache = new Map();
  function dynamicCellsFor(charId, layerIdx, gridName, effParams) {
    const sctx = sourceCtxByChar.get(charId);
    if (!sctx) return null; // no source (not loaded / failed) → caller uses static
    const cacheKey = `${charId}|${layerIdx}|${gridName}|${gridParamsSignature(effParams)}`;
    let cells = dynCellCache.get(cacheKey);
    if (cells) return cells;
    const gridPlugin = getGrid(gridName);
    if (!gridPlugin) return null;
    cells = gridPlugin.generateCells(RENDER_SIZE, RENDER_SIZE, effParams);
    autoMesh(sctx, cells, AUTO_MESH_THRESHOLD);
    dynCellCache.set(cacheKey, cells);
    return cells;
  }

  /** Resolve the layers to draw for one glyph at the given sampled params.
   *  Layers without animated grid params keep their static (manual) cells; for
   *  animated layers, cells are regenerated + auto-meshed for this frame. */
  function effectiveLayers(charId, params) {
    const staticLayers = getLayersFor(charId);
    if (!staticLayers) return null;
    if (!hasAnimatedGrid || !_sourcesLoaded) return staticLayers;
    // Index alignment with defaultLayers is required to map animated params back
    // to the right layer; bail to static if buildRuntimeLayers dropped a layer.
    if (staticLayers.length !== defaultLayers.length) return staticLayers;
    return staticLayers.map((layer, idx) => {
      if (!animatedGrid.layers.has(idx)) return layer;
      const gl = defaultLayers[idx];
      if (!gl) return layer;
      const effParams = { ...(gl.gridParams || {}) };
      for (const pk of animatedGrid.byLayer.get(idx)) {
        const tk = `grid.${idx}.${pk}`;
        if (params[tk] != null) effParams[pk] = params[tk];
      }
      const cells = dynamicCellsFor(charId, idx, gl.gridName, effParams);
      if (!cells) return layer;
      return { ...layer, cells };
    });
  }

  // Single work canvas reused across all glyphs + frames. Size matches the
  // frame canvas so a stretched cell that lands anywhere within the visible
  // frame still rasterizes; cells beyond the frame are clipped naturally.
  const workCanvas = document.createElement('canvas');
  workCanvas.width = width;
  workCanvas.height = height;
  const workCtx = workCanvas.getContext('2d');

  function renderInto(octx, params, layout) {
    octx.fillStyle = '#fff';
    octx.fillRect(0, 0, width, height);

    // Center the content within the fixed frame.
    const dx = Math.floor((width - layout.cw) / 2);
    const dy = Math.floor((height - layout.ch) / 2);

    // Apply camera transform around the frame center.
    octx.save();
    const fcx = width / 2;
    const fcy = height / 2;
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
      const layers = effectiveLayers(pos.charId, params);
      if (!layers) continue;
      renderGlyphOntoFrame(octx, workCanvas, workCtx, gx, gy, params.fontSize, layers, charTransform, global);
    }
    octx.restore();
  }

  return { width, height, renderInto, ready, isReady };
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
  const { global, charIds, onProgress, cache, onCacheUpdate } = ctx;
  const fps = animation.fps;
  const totalFrames = Math.max(1, Math.round(animation.duration * fps));

  // Shared single-frame renderer — same path used by live scrub preview, so
  // exported frames and on-screen frames are pixel-identical.
  const renderer = createFrameRenderer(animation, ctx);
  // Load per-glyph source images first when grid params are animated, so the
  // per-frame auto-mesh has its sampling targets ready (no-op otherwise).
  await renderer.ready();
  const maxW = renderer.width;
  const maxH = renderer.height;

  // First pass: compute per-frame content layout (used for centering offsets).
  const perFrame = [];
  for (let i = 0; i < totalFrames; i++) {
    const t = i / fps;
    const params = sampleAnimation(animation, t);
    const layout = computeLayout(params, animation, charIds, global);
    perFrame.push({ params, layout });
  }

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
    renderer.renderInto(octx, params, layout);

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
