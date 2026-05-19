/**
 * Process-wide cache of decoded `HTMLImageElement`s keyed by `src`.
 *
 * Glyph base images are stored as long base64 data URLs in Firestore. Without
 * caching, every re-render / undo / redo creates fresh `new Image()` elements
 * and re-decodes the same bytes — slow with many glyphs.
 *
 * Entries are evicted in insertion order once the cache exceeds MAX_ENTRIES,
 * giving rough LRU behaviour without an explicit access counter.
 */
const MAX_ENTRIES = 256;
const cache = new Map(); // src -> Promise<HTMLImageElement | null>

/**
 * Load an image by src, reusing the cached decode when available.
 * Resolves to `null` on load error so callers can degrade gracefully.
 */
export function loadImageCached(src) {
  if (!src) return Promise.resolve(null);
  const hit = cache.get(src);
  if (hit) {
    cache.delete(src);
    cache.set(src, hit);
    return hit;
  }
  const promise = new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
  cache.set(src, promise);
  if (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
  return promise;
}
