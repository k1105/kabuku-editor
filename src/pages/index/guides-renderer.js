/**
 * Guides-pane rendering pipeline for the font editor: offscreen render of the
 * selected glyph (per-cell transform + metaball filter) blitted into the
 * display canvas at the current zoom. The offscreen context doubles as the
 * paint hit-test context (exposed as `offCtx`).
 *
 * `state` is the page's accessor state object (pageState) — NOT named `ctx`
 * here because the render helpers take CanvasRenderingContext2D params named
 * `ctx`, which would shadow it. `deps` supplies isLocalContext() and the
 * KanjiVG overlay drawing hook.
 */
import { resolveTransform } from '../../core/project.js';
import { buildRuntimeLayers } from '../../core/layer-builder.js';
import { renderCanvas, metricsLabelMargin } from '../../render/canvas-renderer.js';
import { computeCacheScale } from '../../compose/glyph-cache.js';
import { GLYPH_SIZE } from './constants.js';

export function createGuidesRenderer({ displayCanvas, displayCtx, state, deps }) {
  // Guides-view offscreen buffer. offCtxL doubles as the hit-test context in
  // handlePaint.
  const offCanvasL = document.createElement('canvas');
  offCanvasL.width = GLYPH_SIZE;
  offCanvasL.height = GLYPH_SIZE;
  const offCtxL = offCanvasL.getContext('2d');

  // Resolve the layers + base transform for the selected glyph.
  function currentRender() {
    if (deps.isLocalContext()) {
      return { layers: state.localLayers, transform: state.localTransform };
    }
    const cd = state.project.characters[state.selectedCharId];
    return {
      layers: buildRuntimeLayers(state.global, cd, GLYPH_SIZE),
      transform: resolveTransform(state.global, cd.transformOverrides || {}),
    };
  }

  function clearDisplay(canvas, ctx) {
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  // Cheap step: paint an already-rendered offscreen buffer into a display canvas
  // at the given zoom. Zoom does NOT affect the offscreen, so changing scale
  // only needs this, not a re-render. The offscreen is square and the glyph is
  // centered in it, so centering the offscreen in the display yields a
  // zoom-independent glyph center (relied on by handlePaint).
  function blit(canvas, ctx, offCanvas, scale) {
    clearDisplay(canvas, ctx);
    const size = offCanvas.width;
    const dw = size * scale;
    const dh = size * scale;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(offCanvas, (canvas.width - dw) / 2, (canvas.height - dh) / 2, dw, dh);
  }

  // Heavy step: render the glyph into an offscreen buffer (this runs the
  // per-cell transform + the metaball blur/contrast filter), then blit it.
  //
  // The offscreen grows with the current transform so stretched / blurred
  // content that overshoots the glyph boundary isn't clipped. The editor uses
  // true per-cell stretch (metrics guides must stay un-skewed, so we can't use
  // the image-affine approximation compose/animation employ). Slider-bounded
  // stretchAmount keeps memory in check (~100 MB worst case at GLYPH_SIZE=1024,
  // stretch=2). Extra margin is added for metrics labels drawn just outside the
  // glyph; preview panes skip guides so they need no margin.
  function renderTarget(canvas, ctx, offCanvas, offCtx, { layers, transform, preview, showBackground, scale, activeLayerIndex, overlayActiveFill, emphasizeBackground }) {
    const stretchFactor = 1 + 2 * (transform.stretchAmount || 0);
    const cacheScale = stretchFactor + (computeCacheScale(transform) - 1);
    const baseSize = Math.ceil(GLYPH_SIZE * cacheScale);
    const labelMargin = (!preview && state.global.fontMetrics) ? metricsLabelMargin(GLYPH_SIZE) * 2 : 0;
    const canvasSize = baseSize + labelMargin;
    if (offCanvas.width !== canvasSize || offCanvas.height !== canvasSize) {
      offCanvas.width = canvasSize;
      offCanvas.height = canvasSize;
    }
    offCtx.fillStyle = '#fff';
    offCtx.fillRect(0, 0, canvasSize, canvasSize);
    const cd = state.project.characters[state.selectedCharId];
    renderCanvas(offCtx, layers, {
      backgroundImage: showBackground ? state.backgroundImage : null,
      backgroundOpacity: state.bgOpacity,
      transform,
      glyphSize: GLYPH_SIZE,
      preview,
      fontMetrics: state.global.fontMetrics,
      activeLayerIndex,
      overlayActiveFill,
      emphasizeBackground,
      imageTransform: {
        imageOffsetX: cd?.imageOffsetX ?? 0,
        imageOffsetY: cd?.imageOffsetY ?? 0,
        imageScale: cd?.imageScale ?? 1,
      },
    });
    blit(canvas, ctx, offCanvas, scale);
  }

  // Guides view: drop stretch only (gap/blur kept), show every guide + the
  // source image — the paintable reference.
  function renderLeft(rc = currentRender()) {
    // Preview mode: hide grid/guides + background image and apply the live
    // stretch so the user sees the finished glyph alone.
    if (state.previewMode) {
      // rc.transform may be a cached (local-context) resolve, so pull the live
      // stretch off `global` — the stretch sliders only ever write there.
      const transform = {
        ...rc.transform,
        stretchAngle: state.global.stretchAngle ?? 0,
        stretchAmount: state.global.stretchAmount ?? 0,
      };
      renderTarget(displayCanvas, displayCtx, offCanvasL, offCtxL, {
        layers: rc.layers, transform, preview: true, showBackground: false, scale: state.scaleL,
        activeLayerIndex: null, overlayActiveFill: false,
      });
      return;
    }
    const leftTransform = { ...rc.transform, stretchAmount: 0, stretchAngle: 0 };
    // When the base-image layer (下地) is active in the Pen panel, drop the grid
    // red highlight and emphasize the source image instead (bold image + faint
    // grids) so its placement is easy to adjust.
    const baseActive = state.panel === 'pen' && state.baseLayerActive;
    renderTarget(displayCanvas, displayCtx, offCanvasL, offCtxL, {
      layers: rc.layers, transform: leftTransform, preview: false, showBackground: true, scale: state.scaleL,
      // Active-layer highlight: red grid outline (+ red fill overlay in the
      // per-character / local editor) so it's clear which layer is being painted.
      activeLayerIndex: baseActive ? null : (deps.isLocalContext() ? state.activeLocalLayerIdx : state.activeGlobalLayerIdx),
      // Only the Pen panel paints, so reserve the red fill overlay for it.
      overlayActiveFill: state.panel === 'pen' && !baseActive,
      emphasizeBackground: baseActive,
    });
  }

  function redraw() {
    if (!state.selectedCharId) {
      clearDisplay(displayCanvas, displayCtx);
      return;
    }
    renderLeft();
    deps.drawOverlay();
  }

  return {
    redraw,
    renderLeft,
    offCtx: offCtxL,
    /** Re-blit the existing offscreen at the current zoom (cheap path). */
    blitCurrent: () => blit(displayCanvas, displayCtx, offCanvasL, state.scaleL),
  };
}
