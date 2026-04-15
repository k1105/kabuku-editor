import { buildRuntimeLayers } from '../core/layer-builder.js';
import { renderCanvas } from '../render/canvas-renderer.js';
import { resolveTransform } from '../core/project.js';

const RENDER_SIZE = 512;

/**
 * Creates a glyph bitmap cache.
 * Each character is rendered once at 512x512 and stored as an offscreen canvas.
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

      const offscreen = document.createElement('canvas');
      offscreen.width = RENDER_SIZE;
      offscreen.height = RENDER_SIZE;
      const offCtx = offscreen.getContext('2d');

      renderCanvas(offCtx, layers, {
        transform,
        glyphSize: RENDER_SIZE,
        preview: true,
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
