/**
 * Preview rendering pipeline for the animation editor: display zoom, the
 * frame cache, the shared frame renderer (scrub frames are pixel-identical to
 * exported frames), the fast slider-drag path, and cache bookkeeping.
 *
 * `state` is the page's accessor state object (animation / currentTime /
 * frameCache / displayZoom — `animation` is reassigned on JSON import, so it
 * must always be read through the getter). `env` holds the page's stable
 * references; `deps` the page-level hooks.
 */
import { sampleAnimation } from '../../animation/animation.js';
import { computeFrameCacheShape, createFrameRenderer, computeLayout, DEFAULT_CANVAS_WIDTH, DEFAULT_CANVAS_HEIGHT } from '../../animation/render.js';
import { stretchMatrix } from '../../core/transform-math.js';
import { RENDER_SIZE } from '../../compose/glyph-cache.js';

export function createPreviewRenderer({ canvas, ctx, mainArea, state, env, deps }) {
  const { project, global, charIds, sourceImageCache } = env;
  // === Rendering ===

  function canvasW() { return Math.max(1, Math.round(state.animation.canvasWidth || DEFAULT_CANVAS_WIDTH)); }
  function canvasH() { return Math.max(1, Math.round(state.animation.canvasHeight || DEFAULT_CANVAS_HEIGHT)); }

  /**
   * Size the on-screen canvas element via CSS (its internal resolution is
   * always canvasW×canvasH). 'fit' scales the whole canvas into the view with
   * padding; a numeric zoom maps 1→100%.
   */
  function applyDisplayZoom() {
    const cw = canvasW(), ch = canvasH();
    let scale;
    if (state.displayZoom === 'fit') {
      const padPx = 24;
      const availW = Math.max(1, mainArea.clientWidth - padPx * 2);
      const availH = Math.max(1, mainArea.clientHeight - padPx * 2);
      scale = Math.min(availW / cw, availH / ch);
      if (!Number.isFinite(scale) || scale <= 0) scale = 1;
    } else {
      scale = state.displayZoom;
    }
    canvas.style.width = (cw * scale) + 'px';
    canvas.style.height = (ch * scale) + 'px';
  }

  // Re-fit when the view area resizes (only matters in 'fit' mode).
  const viewResizeObserver = new ResizeObserver(() => {
    if (state.displayZoom === 'fit') applyDisplayZoom();
  });
  viewResizeObserver.observe(mainArea);

  function overrideWith(key, val) {
    const p = sampleAnimation(state.animation, state.currentTime);
    p[key] = val;
    return p;
  }

  // Lazily-built single-frame renderer, shared with the Render/export path so
  // scrub-time frames are pixel-identical to exported frames. Layers depend on
  // the (static) font snapshot, not on params, so the renderer is reused across
  // redraws; only a canvas-size change forces a rebuild (work canvas dims).
  let frameRenderer = null;
  let frameRendererSig = null;
  // The renderer caches per-glyph source images and static cells, both of which
  // depend on the input text and on which grid params are animated. Rebuild it
  // when that structure changes (not on mere value edits — dynamic cells are
  // keyed by sampled params, so new values reuse the same renderer).
  function rendererSignature() {
    const gridKeys = Object.keys(state.animation.tracks || {})
      .filter(k => k.startsWith('grid.') && state.animation.tracks[k]?.length)
      .sort()
      .join(',');
    // Include text keyframe values: a keyframe can introduce a glyph absent from
    // the base text, and the renderer pre-loads per-glyph sources (auto-mesh) up
    // front, so its source set must be invalidated when the text track changes.
    const textKf = (state.animation.textTrack || []).map(kf => kf.value).join('');
    return `${state.animation.text || ''}|${gridKeys}|${textKf}`;
  }
  function getFrameRenderer() {
    const sig = rendererSignature();
    if (!frameRenderer
        || frameRenderer.width !== canvasW()
        || frameRenderer.height !== canvasH()
        || sig !== frameRendererSig) {
      frameRenderer = createFrameRenderer(state.animation, { project, global, charIds });
      frameRendererSig = sig;
      // Warm the per-glyph source images used by per-frame auto-mesh. Until
      // they're ready renderInto draws static cells; once loaded, drop the
      // (static) cached frames and redraw so the meshed result shows.
      if (frameRenderer.isReady && !frameRenderer.isReady()) {
        frameRenderer.ready().then(() => { deps.markDirty(); redrawPreview(); });
      }
    }
    return frameRenderer;
  }

  function layoutFor(params) {
    return computeLayout(params, state.animation, charIds, global);
  }

  function prepareCanvas(cw, ch) {
    canvas.width = cw;
    canvas.height = ch;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, cw, ch);
  }

  function drawMissingAt(gx, gy, size) {
    ctx.fillStyle = '#f0f0f0';
    ctx.fillRect(gx, gy, size, size);
    ctx.strokeStyle = '#bbb';
    ctx.lineWidth = 1;
    ctx.strokeRect(gx, gy, size, size);
  }

  /** Apply camera transform (pan + rotation + zoom) around the canvas center. */
  function applyCameraTransform(targetCtx, cw, ch, p) {
    const cx = cw / 2;
    const cy = ch / 2;
    targetCtx.translate(cx + (p.cameraX || 0), cy + (p.cameraY || 0));
    targetCtx.rotate(((p.cameraRotation || 0) * Math.PI) / 180);
    const dist = p.cameraDistance != null ? p.cameraDistance : 1;
    targetCtx.scale(dist, dist);
    targetCtx.translate(-cx, -cy);
  }

  /**
   * Seed `state.frameCache` with shape (width/height/fps/totalFrames) when it's
   * missing — runs the first-pass dimension scan from renderFrames. Lets
   * scrub-time drawFull() write into the cache at the same uniform
   * dimensions as Render-button output.
   */
  function ensureFrameCacheShape() {
    if (state.frameCache?.frames?.length) return;
    const shape = computeFrameCacheShape(state.animation);
    state.frameCache = {
      fps: shape.fps,
      totalFrames: shape.totalFrames,
      width: shape.width,
      height: shape.height,
      frames: new Array(shape.totalFrames).fill(null),
    };
    deps.updateFrameCacheIndicator(state.frameCache);
  }

  /** Full pipeline draw (slow). Renders one frame through the SAME renderer as
   *  the Render button / export (createFrameRenderer), stores it in the cache
   *  at the current frame index, then blits to the on-screen canvas. Because it
   *  shares the render path, scrub-time frames and exported frames are
   *  pixel-identical — no separate approximation. */
  function drawFull(params) {
    ensureFrameCacheShape();
    const cacheW = state.frameCache.width;
    const cacheH = state.frameCache.height;
    const off = document.createElement('canvas');
    off.width = cacheW;
    off.height = cacheH;
    const octx = off.getContext('2d');
    getFrameRenderer().renderInto(octx, params, layoutFor(params));

    // Cache at the current time slot (only when empty — Render-button frames
    // win over scrub-time captures, though both paths now produce identical
    // pixels).
    const idx = Math.min(state.frameCache.frames.length - 1,
      Math.max(0, Math.round(state.currentTime * state.frameCache.fps)));
    if (!state.frameCache.frames[idx]) {
      state.frameCache.frames[idx] = off;
      deps.updateFrameCacheIndicator(state.frameCache);
    }

    canvas.style.transform = '';
    canvas.width = cacheW;
    canvas.height = cacheH;
    ctx.drawImage(off, 0, 0);
  }

  /** Fast preview using source images. Draws into the same uniform cache
   *  canvas dimensions as drawFull / cached frames so the page canvas size
   *  doesn't change between playback / scrub / Render paths. */
  function redrawFast(params) {
    const p = params || sampleAnimation(state.animation, state.currentTime);
    ensureFrameCacheShape();
    const cacheW = state.frameCache.width;
    const cacheH = state.frameCache.height;
    const layout = layoutFor(p);
    prepareCanvas(cacheW, cacheH);
    const dx = Math.floor((cacheW - layout.cw) / 2);
    const dy = Math.floor((cacheH - layout.ch) / 2);
    const { a, b, d } = stretchMatrix(p.stretchAngle, p.stretchAmount);
    // Image stretch pivots on glyph center, not on baseline — font metrics
    // are reference guides only and editing them must not shift the underlay.
    ctx.save();
    applyCameraTransform(ctx, cacheW, cacheH, p);
    for (const pos of layout.positions) {
      const gx = dx + layout.pad + pos.x;
      const gy = dy + layout.pad + pos.y;
      const cx = gx + p.fontSize / 2;
      const cy = gy + p.fontSize / 2;
      if (pos.missing) { drawMissingAt(gx, gy, p.fontSize); continue; }
      const srcImg = sourceImageCache.get(pos.charId);
      if (!srcImg) continue;
      const cd = project.characters[pos.charId] || {};
      const imgScale = cd.imageScale ?? 1;
      const imgOffPx = p.fontSize / RENDER_SIZE;
      const imgDx = (cd.imageOffsetX ?? 0) * imgOffPx;
      const imgDy = (cd.imageOffsetY ?? 0) * imgOffPx;
      const drawSize = p.fontSize * imgScale;
      const ix = gx + (p.fontSize - drawSize) / 2 + imgDx;
      const iy = gy + (p.fontSize - drawSize) / 2 + imgDy;
      ctx.save();
      ctx.globalCompositeOperation = 'multiply';
      ctx.transform(a, b, b, d, cx - (a * cx + b * cy), cy - (b * cx + d * cy));
      ctx.drawImage(srcImg, ix, iy, drawSize, drawSize);
      ctx.restore();
    }
    ctx.restore();
  }

  function getCachedFrameAt(time) {
    if (!state.frameCache?.frames?.length) return null;
    const idx = Math.min(state.frameCache.frames.length - 1,
      Math.max(0, Math.round(time * state.frameCache.fps)));
    return state.frameCache.frames[idx] || null;
  }

  function drawCachedFrame(frame) {
    canvas.width = frame.width;
    canvas.height = frame.height;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, frame.width, frame.height);
    ctx.drawImage(frame, 0, 0);
  }

  function redrawPreview() {
    // Always prefer cache when a frame is present at the current time.
    // Edits drop the whole cache (markDirty), so a hit here is guaranteed
    // to match the current state.animation state.
    const cached = getCachedFrameAt(state.currentTime);
    if (cached) {
      drawCachedFrame(cached);
      return;
    }
    const params = sampleAnimation(state.animation, state.currentTime);
    // Playback and scrubbing both render each frame through the full per-cell
    // pipeline (drawFull) — identical to the exported output, no base-image
    // stretch approximation. Frames are cached as they're produced, so a second
    // pass plays back from cache. (redrawFast survives only for live slider
    // dragging, where transient responsiveness matters more than fidelity.)
    drawFull(params);
  }


  function isFrameCacheComplete() {
    if (!state.frameCache?.frames?.length) return false;
    const expected = Math.max(1, Math.round(state.animation.duration * state.animation.fps));
    if (state.frameCache.fps !== state.animation.fps) return false;
    if (state.frameCache.frames.length !== expected) return false;
    return state.frameCache.frames.every(f => !!f);
  }


  return {
    applyDisplayZoom,
    redrawFast,
    redrawPreview,
    overrideWith,
    isFrameCacheComplete,
    /** Detach the view ResizeObserver (call on page teardown). */
    destroy: () => viewResizeObserver.disconnect(),
  };
}
