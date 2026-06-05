import { loadImageCached } from '../core/image-cache.js';
import { renderFontSourceToCanvas } from '../render/font/font-import.js';
import { renderKanjiVGSourceToCanvas } from '../render/font/kanjivg-import.js';

/**
 * Builds a per-charId source-image loader backed by `cache` (a Map).
 *
 * Image-imported chars use their data-URL imagePath; font-imported chars
 * (fontSource only, no imagePath) are rasterized via Google Fonts so the
 * stretch-preview underlay tracks them too.
 *
 * Returns `getSourceImage(charId)` — the cached Image/canvas, or null while it
 * loads (loading is async; `onLoad` fires afterwards to trigger a redraw).
 *
 * @param {object}   opts
 * @param {Map}      opts.cache       charId -> Image|canvas|null
 * @param {object}   opts.project     project with .characters
 * @param {object}   opts.global      global params (provides fontMetrics)
 * @param {number}   opts.renderSize  raster size for font sources
 * @param {Function} opts.onLoad      called after an async image finishes
 */
export function createSourceImageLoader({ cache, project, global, renderSize, onLoad }) {
  return function getSourceImage(charId) {
    if (cache.has(charId)) return cache.get(charId);
    const cd = project.characters[charId];
    if (cd?.imagePath) {
      cache.set(charId, null);
      loadImageCached(cd.imagePath).then((img) => {
        if (!img) return;
        cache.set(charId, img);
        onLoad?.();
      });
      return null;
    }
    if (cd?.fontSource) {
      cache.set(charId, null);
      renderFontSourceToCanvas(cd.fontSource, renderSize, global.fontMetrics)
        .then((cv) => { cache.set(charId, cv); onLoad?.(); })
        .catch(() => {});
      return null;
    }
    if (cd?.kanjivgSource) {
      cache.set(charId, null);
      renderKanjiVGSourceToCanvas(cd.kanjivgSource, renderSize, global.kanjivgStrokeWidth)
        .then((cv) => { cache.set(charId, cv); onLoad?.(); })
        .catch(() => {});
      return null;
    }
    return null;
  };
}
