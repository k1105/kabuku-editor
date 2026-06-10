import { buildRuntimeLayers } from '../../core/layer-builder.js';
import { resolveCodepoint } from '../../core/project.js';

/**
 * Shared glyph-collection front end for the static (OTF, font-exporter.js)
 * and variable (TTF, vf-builder.js) exporters. Both walk the project the same
 * way — resolve a codepoint per charId, skip multi-codepoint ids, build
 * runtime layers at EM size — and only diverge in what they emit per glyph
 * (an opentype.Path vs. two masters' contour sets).
 */

/** 1 kabuku px = 1 font unit (matches GLYPH_SIZE). */
export const EM_SIZE = 1024;

/**
 * Vertical metrics in font units derived from the project's baseline ratio.
 * Baseline sits at y=0 in font space; ascent above (positive), descent below.
 */
export function fontVerticalMetrics(fontMetrics) {
  const baselineY = (fontMetrics.baseline ?? 0.8) * EM_SIZE;
  return {
    baselineY,
    ascender: Math.round(baselineY),
    descender: -Math.round(EM_SIZE - baselineY),
  };
}

/** Generate a postScript-safe glyph name from a Unicode codepoint. */
export function glyphName(codepoint) {
  // Use uniXXXX for BMP, uXXXXXX for non-BMP. opentype.js will sanitize.
  if (codepoint <= 0xFFFF) {
    return 'uni' + codepoint.toString(16).toUpperCase().padStart(4, '0');
  }
  return 'u' + codepoint.toString(16).toUpperCase().padStart(6, '0');
}

/**
 * Resolve every exportable glyph in the project.
 *
 * @returns {{
 *   entries: Array<{charId: string, codepoint: number, layers: Object[]}>,
 *   skipped: string[],     // charIds that aren't a single Unicode codepoint
 *   hasUserSpace: boolean, // project defines its own U+0020 glyph
 * }}
 */
export function collectGlyphEntries(project) {
  const skipped = [];
  const entries = [];
  const charIds = Object.keys(project.characters || {});
  const hasUserSpace = charIds.includes(' ');
  for (const charId of charIds) {
    const codepoint = resolveCodepoint(charId);
    if (codepoint == null) {
      skipped.push(charId);
      continue;
    }
    entries.push({
      charId,
      codepoint,
      layers: buildRuntimeLayers(project.global, project.characters[charId], EM_SIZE),
    });
  }
  return { entries, skipped, hasUserSpace };
}
