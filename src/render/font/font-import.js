/**
 * Font-based glyph generation.
 *
 * Loads a Google Fonts family via the CSS API, then renders each requested
 * character into an offscreen canvas. The caller is expected to feed each
 * canvas through autoMesh to populate cell-fill state — same pipeline as the
 * image-file import, just with the source pixels coming from `fillText`
 * instead of an uploaded PNG.
 */

import { isLocalFont, ensureLocalFontRegistered } from './local-font.js';

const GOOGLE_CSS_BASE = 'https://fonts.googleapis.com/css2';
const linkCache = new Map(); // family -> <link> element

/**
 * Ensure `family` is rasterizable, routing to the right source: a
 * locally-imported font file (FontFace from IndexedDB) or a Google Fonts
 * family (CSS API). All glyph-generation/render call sites should use this
 * instead of loadGoogleFont so imported fonts work everywhere.
 */
export async function ensureFontLoaded(family, sampleText = '') {
  if (await isLocalFont(family)) {
    await ensureLocalFontRegistered(family, sampleText);
  } else {
    await loadGoogleFont(family, sampleText);
  }
}

/**
 * Inject (once per family) a Google Fonts CSS link and resolve when the
 * requested glyphs are rasterizable.
 *
 * Intentionally omits the `text=` subset parameter: that returns a single
 * optimized woff2 with only the chars listed at injection time, which breaks
 * later on-demand renders (Auto Mesh All, thumbnail refresh) for any glyph
 * not in the original set. Without `text=`, Google's CSS exposes subsets via
 * unicode-range and the browser fetches the right woff2 chunk lazily when a
 * new codepoint is requested via `document.fonts.load(...)`.
 */
export async function loadGoogleFont(family, sampleText = '') {
  const trimmed = family.trim();
  if (!trimmed) throw new Error('Font family is required');

  if (!linkCache.has(trimmed)) {
    const params = new URLSearchParams();
    params.set('family', trimmed);
    params.set('display', 'block');
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = `${GOOGLE_CSS_BASE}?${params.toString()}`;
    document.head.appendChild(link);
    linkCache.set(trimmed, link);
    await new Promise((resolve, reject) => {
      link.addEventListener('load', resolve, { once: true });
      link.addEventListener('error', () => reject(new Error(
        `Failed to load Google Fonts CSS for "${trimmed}". ` +
        `Verify the family name (case-sensitive) on fonts.google.com.`
      )), { once: true });
    });
  }

  const sample = sampleText && sampleText.length > 0 ? sampleText : '\u00A0';
  const probe = `${RENDER_FONT_PX}px "${cssEscapeFamily(trimmed)}"`;
  // Chunk so we don't hit browser limits on a single load() string.
  const CHUNK = 256;
  for (let i = 0; i < sample.length; i += CHUNK) {
    await document.fonts.load(probe, sample.slice(i, i + CHUNK));
  }
  await document.fonts.ready;
}

const RENDER_FONT_PX = 1024; // intentionally matches GLYPH_SIZE for 1:1 metrics

function cssEscapeFamily(family) {
  // Quote-safe: family names from Google can contain spaces but not quotes.
  return family.replace(/"/g, '\\"');
}

// Fixed metrics used to rasterize font-imported source images. Locked to the
// defaults so editing the project's metrics (which are reference guides the
// user aligns to an existing image) never re-sizes or re-positions the
// underlay character. Without this, raising Ascender would shrink emHeight
// and the imported character would visibly get smaller.
const SOURCE_RENDER_METRICS = { ascender: 0.05, baseline: 0.80, descender: 0.95 };

/**
 * Render a single character onto the supplied 2D context. The context's
 * canvas should be a square of `glyphSize × glyphSize` and is fully cleared
 * before drawing.
 *
 * Always uses SOURCE_RENDER_METRICS so the rasterized glyph is a stable
 * reference; the project's user-edited metrics only drive the on-canvas
 * guide lines.
 */
export function renderCharToContext(ctx, char, family, glyphSize) {
  const m = SOURCE_RENDER_METRICS;
  const emHeight = (m.descender - m.ascender) * glyphSize;

  ctx.save();
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, glyphSize, glyphSize);
  ctx.fillStyle = '#000';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.font = `${Math.round(emHeight)}px "${cssEscapeFamily(family)}"`;
  ctx.fillText(char, glyphSize / 2, m.baseline * glyphSize);
  ctx.restore();
}

/**
 * Render a `fontSource` ({family, char}) to a fresh canvas at glyphSize,
 * loading the Google Fonts family on demand. Used as the source-image stand-in
 * for font-imported glyphs (no `imagePath`) in editor/typeset/animation views.
 *
 * `fontMetrics` is accepted for backward compatibility but ignored — the
 * underlay rasterization is intentionally pinned to fixed metrics so editing
 * the project's metrics doesn't resize the imported character.
 */
export async function renderFontSourceToCanvas(fontSource, glyphSize, _fontMetrics) {
  const { family, char } = fontSource;
  await ensureFontLoaded(family, char);
  const cv = document.createElement('canvas');
  cv.width = glyphSize;
  cv.height = glyphSize;
  renderCharToContext(cv.getContext('2d'), char, family, glyphSize);
  return cv;
}
