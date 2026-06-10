import { applyStretch } from '../transform/stretch.js';
import { applyGap } from '../transform/gap.js';

/**
 * Cell displacement from the stretch + gap transforms, in glyph-local px.
 *
 * Single source of truth shared by the canvas renderer, the animation
 * renderer, the SVG exporter and the font exporter — every output path must
 * place cells identically or exports drift from what the user sees.
 *
 * Gating mirrors the historical call sites: a falsy `stretchAmount` /
 * `baseGap` skips that step entirely (applyStretch only special-cases
 * `amount === 0`, so passing `undefined` through would produce NaN).
 *
 * @param {{x: number, y: number}} center - cell center (glyph-local px)
 * @param {Object} t - transform { stretchAngle, stretchAmount, baseGap, gapDirectionWeight }
 * @param {number} width  - glyph box width
 * @param {number} height - glyph box height
 * @param {number} baselineY - stretch pivot Y (glyph-local px)
 * @returns {{dx: number, dy: number, pos: {x: number, y: number}}}
 */
export function cellDisplacement(center, t, width, height, baselineY) {
  let pos = { x: center.x, y: center.y };
  if (t.stretchAmount) {
    pos = applyStretch(pos, t.stretchAngle || 0, t.stretchAmount, width, height, baselineY);
  }
  if (t.baseGap) {
    pos = applyGap(pos, t.stretchAngle || 0, t.baseGap, t.gapDirectionWeight || 0, width, height);
  }
  return { dx: pos.x - center.x, dy: pos.y - center.y, pos };
}
