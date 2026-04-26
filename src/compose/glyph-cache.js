import { buildRuntimeLayers } from '../core/layer-builder.js';
import { renderCanvas } from '../render/canvas-renderer.js';

const RENDER_SIZE = 1024;

export { RENDER_SIZE };

/**
 * Scale factor (relative to glyph size) needed to contain the glyph
 * after the current transform without cropping.
 *
 * Stretch is now anchored to the baseline (off-center pivot), so the worst-case
 * bbox is asymmetric and larger than the symmetric center-pivot case. Use a
 * conservative `1 + 2*A` bound that covers any baseline position in [0,1].
 * Gap and blur add a constant pixel margin on top.
 */
export function computeCacheScale(transform) {
  const A = transform?.stretchAmount || 0;
  const gap = transform?.baseGap || 0;
  const blur = transform?.metaballRadius || 0;
  const stretchFactor = 1 + 2 * A;
  // Safety margin: cell extent (up to ~32px), gap, blur bleed, anti-aliasing
  const extraPx = 64 + gap * 2 + blur * 4;
  return stretchFactor + extraPx / RENDER_SIZE;
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

      renderCanvas(offCtx, layers, {
        transform,
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
