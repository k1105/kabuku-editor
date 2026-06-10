/**
 * KanjiVG-based glyph generation.
 *
 * KanjiVG ships one SVG per character (kanji, kana, and half-width ASCII
 * alphanumerics) whose paths are stroke *centerlines* on a 109×109 canvas —
 * there is no fill, the shapes only become visible when stroked. We fetch the
 * SVG on demand from the jsdelivr CDN, then rasterize it into an offscreen
 * canvas by stroking every path at a caller-chosen width. The resulting canvas
 * is fed through the exact same autoMesh pipeline as image-file and font
 * imports — the only difference is where the source pixels come from.
 *
 * "Arbitrary stroke width" is the whole point: KanjiVG gives us skeleton paths,
 * so the weight of the base glyph is a free parameter the user controls.
 */

// jsdelivr serves the KanjiVG GitHub repo directly; same CDN-on-demand approach
// as the Google Fonts import (no repo bloat from bundling ~11k SVGs).
const CDN_BASE = 'https://cdn.jsdelivr.net/gh/KanjiVG/kanjivg@master/kanji';

// KanjiVG's native coordinate system. Stroke width is expressed in these units
// (so a value of ~3 matches KanjiVG's own reference rendering) and scaled up to
// the target glyph size at draw time. Exported so the path editor can map
// between 109-space and glyph-space.
export const KVG_VIEWBOX = 109;

// char -> Promise<{ paths: string[] }>. Cached so undo/redo, re-mesh, and the
// stretch-preview underlay don't re-fetch the same SVG.
const svgCache = new Map();

/** 5-digit zero-padded lowercase hex codepoint, e.g. '海' -> '06d77'. */
function codepointHex(char) {
  return char.codePointAt(0).toString(16).padStart(5, '0');
}

/**
 * Fetch + parse a character's KanjiVG SVG, returning the list of stroke path
 * `d` strings. Rejects with a KanjiVGNotFound-flagged error when the CDN has no
 * entry for the character (404/403) so callers can skip-and-continue.
 */
export async function loadKanjiVGPaths(char) {
  if (svgCache.has(char)) return svgCache.get(char);
  const promise = (async () => {
    const url = `${CDN_BASE}/${codepointHex(char)}.svg`;
    let res;
    try {
      res = await fetch(url);
    } catch (e) {
      throw new Error(`KanjiVG fetch failed for "${char}": ${e.message || e}`, { cause: e });
    }
    if (!res.ok) {
      const err = new Error(`"${char}" is not in KanjiVG (HTTP ${res.status}).`);
      err.kanjivgNotFound = true;
      throw err;
    }
    const text = await res.text();
    const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
    if (doc.querySelector('parsererror')) {
      throw new Error(`Failed to parse KanjiVG SVG for "${char}".`);
    }
    // Stroke paths only; the `<text>` stroke-order numbers are not <path>s, so
    // querySelectorAll('path') already excludes them.
    const paths = Array.from(doc.querySelectorAll('path'))
      .map((p) => p.getAttribute('d'))
      .filter(Boolean);
    if (paths.length === 0) {
      throw new Error(`KanjiVG SVG for "${char}" had no stroke paths.`);
    }
    return { paths };
  })();
  // Don't cache rejections — a transient network failure shouldn't permanently
  // poison the character.
  promise.catch(() => svgCache.delete(char));
  svgCache.set(char, promise);
  return promise;
}

/**
 * Stroke the supplied KanjiVG paths onto a 2D context. The context's canvas
 * should be a square of `glyphSize × glyphSize`; it is fully cleared (white)
 * before drawing. `strokeWidth` is in KanjiVG (109-unit) space.
 */
export function renderKanjiVGToContext(ctx, paths, glyphSize, strokeWidth) {
  ctx.save();
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, glyphSize, glyphSize);
  ctx.scale(glyphSize / KVG_VIEWBOX, glyphSize / KVG_VIEWBOX);
  ctx.strokeStyle = '#000';
  ctx.lineWidth = strokeWidth;
  // Round joins/caps match KanjiVG's own brush-like reference rendering and
  // avoid spiky miters at sharp stroke corners.
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  for (const d of paths) {
    ctx.stroke(new Path2D(d));
  }
  ctx.restore();
}

/**
 * Stroke an explicit set of KanjiVG path `d` strings onto a fresh canvas,
 * synchronously (no network). Used while the user is dragging the path editor,
 * and by renderKanjiVGSourceToCanvas when the source carries edited paths.
 */
export function renderEditedKanjiVGToCanvas(paths, glyphSize, strokeWidth) {
  const cv = document.createElement('canvas');
  cv.width = glyphSize;
  cv.height = glyphSize;
  renderKanjiVGToContext(cv.getContext('2d'), paths, glyphSize, strokeWidth);
  return cv;
}

/**
 * Render a `kanjivgSource` ({ char, strokeWidth?, editedPaths? }) to a fresh
 * canvas at glyphSize. When `editedPaths` is present those paths are stroked
 * directly (no fetch); otherwise the character's SVG is fetched on demand.
 * `defaultStrokeWidth` is the global fallback used when the source carries no
 * per-character override.
 */
export async function renderKanjiVGSourceToCanvas(kanjivgSource, glyphSize, defaultStrokeWidth) {
  const { char, strokeWidth, editedPaths } = kanjivgSource;
  const width = strokeWidth ?? defaultStrokeWidth;
  const paths = (editedPaths && editedPaths.length)
    ? editedPaths
    : (await loadKanjiVGPaths(char)).paths;
  return renderEditedKanjiVGToCanvas(paths, glyphSize, width);
}
