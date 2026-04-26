import { layoutText, layoutBounds } from '../compose/text-layout.js';
import { computeCacheScale } from '../compose/glyph-cache.js';
import { resolveTransform } from '../core/project.js';
import { sampleAnimation } from './animation.js';

function transformFromParams(p, global) {
  return {
    stretchAngle: p.stretchAngle,
    stretchAmount: p.stretchAmount,
    baseGap: p.baseGap,
    gapDirectionWeight: p.gapDirectionWeight,
    metaballStrength: global.metaballStrength ?? 1,
    metaballRadius: p.metaballRadius,
  };
}

function computeLayout(params, animation, charIds, global) {
  const positions = layoutText(animation.text, charIds, {
    fontSize: params.fontSize,
    textBoxWidth: params.textBoxWidth,
    kerning: params.kerning,
    lineHeight: params.lineHeight,
    writingMode: animation.writingMode,
  });
  const cacheScale = computeCacheScale(transformFromParams(params, global));
  const drawSize = params.fontSize * cacheScale;
  const drawOffset = (drawSize - params.fontSize) / 2;
  const pad = 32 + drawOffset;
  const bounds = layoutBounds(positions, params.fontSize);
  const cw = Math.max(bounds.width + pad * 2, 200);
  const ch = Math.max(bounds.height + pad * 2, 200);
  return { positions, pad, cw, ch, drawSize, drawOffset };
}

function paramsEqual(a, b) {
  if (!a || !b) return false;
  for (const k in a) {
    if (a[k] !== b[k]) return false;
  }
  for (const k in b) {
    if (!(k in a)) return false;
  }
  return true;
}

/**
 * Render all animation frames to offscreen canvases.
 * Returns { frames, fps, width, height }.
 */
export async function renderFrames(animation, ctx) {
  const { project, global, charIds, glyphCache, onProgress } = ctx;
  const fps = animation.fps;
  const totalFrames = Math.max(1, Math.round(animation.duration * fps));

  // First pass: find maximum canvas dimensions across all frames
  let maxW = 0, maxH = 0;
  const perFrame = [];
  for (let i = 0; i < totalFrames; i++) {
    const t = i / fps;
    const params = sampleAnimation(animation, t);
    const layout = computeLayout(params, animation, charIds, global);
    if (layout.cw > maxW) maxW = layout.cw;
    if (layout.ch > maxH) maxH = layout.ch;
    perFrame.push({ params, layout });
  }
  maxW = Math.ceil(maxW);
  maxH = Math.ceil(maxH);

  const frames = [];
  for (let i = 0; i < totalFrames; i++) {
    const { params, layout } = perFrame[i];

    // If params are identical to the previous frame, reuse its canvas reference.
    // Output is pixel-identical, so PNG/GIF encoders can re-read the same bitmap.
    if (i > 0 && paramsEqual(params, perFrame[i - 1].params)) {
      frames.push(frames[i - 1]);
      onProgress?.(i + 1, totalFrames);
      if (i % 4 === 3) await new Promise(r => setTimeout(r, 0));
      continue;
    }

    // Glyph cache is keyed by charId only, so per-frame transforms would otherwise
    // use a stale cached bitmap. Invalidate so each frame renders glyphs fresh.
    glyphCache.invalidateAll();

    const off = document.createElement('canvas');
    off.width = maxW;
    off.height = maxH;
    const octx = off.getContext('2d');
    octx.fillStyle = '#fff';
    octx.fillRect(0, 0, maxW, maxH);

    // Center the content
    const dx = Math.floor((maxW - layout.cw) / 2);
    const dy = Math.floor((maxH - layout.ch) / 2);

    // Apply camera transform around the frame center
    octx.save();
    const fcx = maxW / 2;
    const fcy = maxH / 2;
    octx.translate(fcx + (params.cameraX || 0), fcy + (params.cameraY || 0));
    const dist = params.cameraDistance != null ? params.cameraDistance : 1;
    octx.scale(dist, dist);
    octx.translate(-fcx, -fcy);

    const transform = transformFromParams(params, global);
    for (const pos of layout.positions) {
      const gx = dx + layout.pad + pos.x;
      const gy = dy + layout.pad + pos.y;
      if (pos.missing) {
        octx.fillStyle = '#f0f0f0';
        octx.fillRect(gx, gy, params.fontSize, params.fontSize);
        octx.strokeStyle = '#bbb';
        octx.lineWidth = 1;
        octx.strokeRect(gx, gy, params.fontSize, params.fontSize);
        continue;
      }
      const charData = project.characters[pos.charId];
      const charTransform = resolveTransform({ ...global, ...transform }, charData?.transformOverrides || {});
      const cached = glyphCache.get(pos.charId, charData, global, charTransform);
      if (cached) {
        octx.drawImage(cached, gx - layout.drawOffset, gy - layout.drawOffset, layout.drawSize, layout.drawSize);
      }
    }
    octx.restore();

    frames.push(off);
    onProgress?.(i + 1, totalFrames);

    // Yield to browser every few frames
    if (i % 4 === 3) await new Promise(r => setTimeout(r, 0));
  }
  // After rendering, cache is populated with the last frame's glyphs only;
  // clear it so subsequent compose-style usage starts fresh.
  glyphCache.invalidateAll();

  return { frames, fps, width: maxW, height: maxH };
}
