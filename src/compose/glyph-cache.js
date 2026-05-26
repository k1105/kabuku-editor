import { buildRuntimeLayers } from '../core/layer-builder.js';
import { renderCanvas } from '../render/canvas-renderer.js';

const RENDER_SIZE = 1024;

export { RENDER_SIZE };

/**
 * Scale factor (relative to glyph size) needed to contain the glyph
 * after the current transform without cropping.
 *
 * Stretch is NOT included here — it would make the cache canvas grow
 * unboundedly with stretchAmount. Stretch is applied as a draw-time affine
 * on the cached (unstretched) bitmap by callers, accepting the visual
 * approximation that cells stretch into ellipses rather than maintaining
 * round shapes at displaced positions.
 *
 * Only bounded params (gap, blur) contribute to the cache margin.
 */
export function computeCacheScale(transform) {
  const gap = transform?.baseGap || 0;
  const blur = transform?.metaballRadius || 0;
  // Safety margin: cell extent (up to ~32px), gap, blur bleed, anti-aliasing
  const extraPx = 64 + gap * 2 + blur * 4;
  return 1 + extraPx / RENDER_SIZE;
}

/**
 * Creates a glyph bitmap cache.
 * Cache canvas size grows with the current transform so that stretched glyphs
 * are never clipped at the edges of the offscreen canvas.
 */
export function createGlyphCache() {
  const cache = new Map();

  return {
    /**
     * Get (or render) a cached glyph bitmap.
     * @param {string} charId
     * @param {object} charData - character data from project
     * @param {object} global - global settings
     * @param {object} transform - resolved transform (stretch, gap, metaball)
     * @returns {HTMLCanvasElement|null}
     */
    get(charId, charData, global, transform) {
      if (cache.has(charId)) return cache.get(charId);
      if (!charData) return null;

      const layers = buildRuntimeLayers(global, charData, RENDER_SIZE);
      if (layers.length === 0) return null;

      const scale = computeCacheScale(transform);
      const canvasSize = Math.ceil(RENDER_SIZE * scale);
      const offscreen = document.createElement('canvas');
      offscreen.width = canvasSize;
      offscreen.height = canvasSize;
      const offCtx = offscreen.getContext('2d');

      // Stretch is applied as a draw-time affine by callers, not baked in.
      const cacheTransform = { ...transform, stretchAmount: 0, stretchAngle: 0 };

      renderCanvas(offCtx, layers, {
        transform: cacheTransform,
        glyphSize: RENDER_SIZE,
        preview: true,
        fontMetrics: global?.fontMetrics,
      });

      cache.set(charId, offscreen);
      return offscreen;
    },

    invalidateAll() {
      cache.clear();
    },

    invalidate(charId) {
      cache.delete(charId);
    },

    get size() {
      return cache.size;
    },
  };
}
