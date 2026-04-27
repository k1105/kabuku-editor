/**
 * Font-based glyph generation.
 *
 * Loads a Google Fonts family via the CSS API, then renders each requested
 * character into an offscreen canvas. The caller is expected to feed each
 * canvas through autoMesh to populate cell-fill state — same pipeline as the
 * image-file import, just with the source pixels coming from `fillText`
 * instead of an uploaded PNG.
 */

const GOOGLE_CSS_BASE = 'https://fonts.googleapis.com/css2';
const linkCache = new Map(); // family -> <link> element

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

/**
 * Render a single character onto the supplied 2D context. The context's
 * canvas should be a square of `glyphSize × glyphSize` and is fully cleared
 * before drawing.
 *
 * Vertical placement uses the project's font metrics (baseline ratio) so the
 * generated glyphs land in the same vertical band the rest of the editor
 * draws guides for. Font size targets the (descender − ascender) span so the
 * em-box roughly fills the metric gutter.
 */
export function renderCharToContext(ctx, char, family, glyphSize, fontMetrics) {
  const m = fontMetrics || { ascender: 0.05, baseline: 0.80, descender: 0.95 };
  const ascender = typeof m.ascender === 'number' ? m.ascender : 0.05;
  const baseline = typeof m.baseline === 'number' ? m.baseline : 0.80;
  const descender = typeof m.descender === 'number' ? m.descender : 0.95;
  const emHeight = Math.max(0.1, descender - ascender) * glyphSize;

  ctx.save();
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, glyphSize, glyphSize);
  ctx.fillStyle = '#000';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.font = `${Math.round(emHeight)}px "${cssEscapeFamily(family)}"`;
  ctx.fillText(char, glyphSize / 2, baseline * glyphSize);
  ctx.restore();
}
