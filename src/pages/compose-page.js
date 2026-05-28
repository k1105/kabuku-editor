import { loadProject, getGlobal, resolveTransform, currentFontProjectId, currentFontProjectName } from '../core/project.js';
import { layoutText } from '../compose/text-layout.js';
import { computeCacheScale, RENDER_SIZE } from '../compose/glyph-cache.js';
import { buildRuntimeLayers } from '../core/layer-builder.js';
import { renderCanvas } from '../render/canvas-renderer.js';
import { createPageHeader } from '../ui/page-header.js';
import { createStretchControl } from '../ui/preview-controls.js';
import { createSliderInput } from '../ui/slider-input.js';
import { renderFontSourceToCanvas } from '../render/font/font-import.js';
import { loadImageCached } from '../core/image-cache.js';

export function renderComposePage(app) {
  const project = loadProject();
  const global = getGlobal();
  const charIds = new Set(Object.keys(project.characters));
  // Per-charId stretched-glyph cache, invalidated on transform release.
  // We bake stretch into the rasterized bitmap (per-cell repositioning) rather
  // than applying a draw-time image affine, so cells keep their round shape
  // instead of squashing into ellipses.
  const stretchedGlyphCache = new Map();
  const sourceImageCache = new Map(); // charId -> Image (base images for stretch preview)

  /** Get or load the source image for a character. Image-imported chars use
   *  their data-URL imagePath; font-imported chars (no imagePath) are
   *  rasterized via Google Fonts so the stretch-preview underlay shows up. */
  function getSourceImage(charId) {
    if (sourceImageCache.has(charId)) return sourceImageCache.get(charId);
    const cd = project.characters[charId];
    if (cd?.imagePath) {
      sourceImageCache.set(charId, null);
      loadImageCached(cd.imagePath).then(img => {
        if (!img) return;
        sourceImageCache.set(charId, img);
        redraw();
      });
      return null;
    }
    if (cd?.fontSource) {
      sourceImageCache.set(charId, null);
      renderFontSourceToCanvas(cd.fontSource, RENDER_SIZE, global.fontMetrics)
        .then(cv => { sourceImageCache.set(charId, cv); redraw(); })
        .catch(() => {});
      return null;
    }
    return null;
  }

  // Preload all source images
  for (const cid of Object.keys(project.characters)) {
    getSourceImage(cid);
  }

  // State — default text from available characters (cap to 5 to keep initial
  // render snappy; user can extend via the textarea).
  const charIdList = Object.keys(project.characters);
  let inputText = charIdList.slice(0, 5).join('');
  let fontSize = 64;
  let textBoxWidth = 800;
  let kerning = 0;
  let lineHeight = 1.5;
  let writingMode = 'horizontal';
  // stretchAngle / stretchAmount live on `global` and are shared with the
  // index page via createStretchControl — no local copy here.
  let baseGap = global.baseGap ?? 0;
  let gapDirectionWeight = global.gapDirectionWeight ?? 0;
  let metaballRadius = global.metaballRadius ?? 8;

  function getTransform() {
    return {
      stretchAngle: global.stretchAngle ?? 0,
      stretchAmount: global.stretchAmount ?? 0,
      baseGap,
      gapDirectionWeight,
      metaballStrength: global.metaballStrength ?? 1,
      metaballRadius,
    };
  }

  /** Cache scale that fits both stretched glyphs and bounded transforms
   *  (gap/blur). Mirrors the index-page editor preview so stretched cells
   *  rendered at the offscreen edge aren't clipped. */
  function totalCacheScale(transform) {
    const stretchFactor = 1 + 2 * (transform?.stretchAmount || 0);
    return stretchFactor + (computeCacheScale(transform) - 1);
  }

  // === Header ===
  const { el: header } = createPageHeader({
    activePage: 'compose',
    fontProjectId: currentFontProjectId(),
    title: currentFontProjectName() || 'KABUKU Editor',
  });

  // === Page layout ===
  const page = document.createElement('div');
  page.className = 'edit-page';

  // --- Sidebar ---
  const sidebar = document.createElement('div');
  sidebar.className = 'sidebar';

  // Text input
  const textGroup = document.createElement('div');
  textGroup.className = 'param-group';
  const textTitle = document.createElement('h3');
  textTitle.textContent = 'Text';
  textTitle.style.marginTop = '0';
  const textarea = document.createElement('textarea');
  textarea.className = 'compose-textarea';
  textarea.value = inputText;
  textarea.addEventListener('input', () => {
    inputText = textarea.value;
    redraw();
  });
  const charListLabel = document.createElement('div');
  charListLabel.className = 'compose-char-list';
  charListLabel.textContent = charIdList.length > 0
    ? `Available: ${charIdList.join(' ')}`
    : 'No characters available. Import images first.';

  textGroup.appendChild(textTitle);
  textGroup.appendChild(textarea);
  textGroup.appendChild(charListLabel);
  sidebar.appendChild(textGroup);

  // Typography controls
  const typoGroup = document.createElement('div');
  typoGroup.className = 'param-group';
  const typoTitle = document.createElement('h3');
  typoTitle.textContent = 'Typography';
  typoGroup.appendChild(typoTitle);

  function addSlider(parent, label, value, min, max, step, onInput, onChange, opts = {}) {
    const row = document.createElement('div');
    row.className = 'param-row';
    const lbl = document.createElement('label');
    lbl.textContent = label;
    const { slider, valueInput } = createSliderInput({
      min, max, step, value,
      hardMin: opts.hardMin,
      hardMax: opts.hardMax,
      onInput,
      onChange,
    });
    row.appendChild(lbl);
    row.appendChild(slider);
    row.appendChild(valueInput);
    parent.appendChild(row);
    return slider;
  }

  addSlider(typoGroup, 'Font Size', fontSize, 16, 256, 1, (v) => {
    fontSize = v;
    redraw();
  });
  addSlider(typoGroup, 'Box Width', textBoxWidth, 200, 2000, 10, (v) => {
    textBoxWidth = v;
    redraw();
  });
  addSlider(typoGroup, 'Kerning', kerning, -40, 100, 1, (v) => {
    kerning = v;
    redraw();
  });
  addSlider(typoGroup, 'Line Height', lineHeight, 0.4, 6.0, 0.1, (v) => {
    lineHeight = v;
    redraw();
  });

  // Writing mode toggle
  const modeRow = document.createElement('div');
  modeRow.className = 'param-row';
  const modeLbl = document.createElement('label');
  modeLbl.textContent = 'Direction';
  const modeWrap = document.createElement('div');
  modeWrap.className = 'writing-mode-toggle';
  const hBtn = document.createElement('button');
  hBtn.className = 'tool-btn active';
  hBtn.textContent = 'Horizontal';
  const vBtn = document.createElement('button');
  vBtn.className = 'tool-btn';
  vBtn.textContent = 'Vertical';
  hBtn.addEventListener('click', () => {
    writingMode = 'horizontal';
    hBtn.classList.add('active');
    vBtn.classList.remove('active');
    redraw();
  });
  vBtn.addEventListener('click', () => {
    writingMode = 'vertical';
    vBtn.classList.add('active');
    hBtn.classList.remove('active');
    redraw();
  });
  modeWrap.appendChild(hBtn);
  modeWrap.appendChild(vBtn);
  modeRow.appendChild(modeLbl);
  modeRow.appendChild(modeWrap);
  typoGroup.appendChild(modeRow);

  sidebar.appendChild(typoGroup);

  // Stretch controls — shared with the index page via `global`.
  const stretchGroup = document.createElement('div');
  stretchGroup.className = 'param-group';
  const stretchTitle = document.createElement('h3');
  stretchTitle.textContent = 'Stretch';
  stretchGroup.appendChild(stretchTitle);

  const stretchControl = createStretchControl({
    global,
    onInput: () => redrawFast(),
    onRelease: () => onTransformRelease(),
  });
  for (const row of stretchControl.rows) stretchGroup.appendChild(row);

  sidebar.appendChild(stretchGroup);

  // Transform controls
  const transformGroup = document.createElement('div');
  transformGroup.className = 'param-group';
  const transformTitle = document.createElement('h3');
  transformTitle.textContent = 'Transform';
  transformGroup.appendChild(transformTitle);

  addSlider(transformGroup, 'Gap', baseGap, 0, 20, 0.5,
    (v) => { baseGap = v; },
    (v) => { baseGap = v; onTransformRelease(); }
  );
  addSlider(transformGroup, 'Gap Dir', gapDirectionWeight, 0, 1, 0.05,
    (v) => { gapDirectionWeight = v; },
    (v) => { gapDirectionWeight = v; onTransformRelease(); },
    { hardMin: 0, hardMax: 1 }
  );
  addSlider(transformGroup, 'Blur', metaballRadius, 0, 30, 1,
    (v) => { metaballRadius = v; },
    (v) => { metaballRadius = v; onTransformRelease(); }
  );

  sidebar.appendChild(transformGroup);

  // --- Main area ---
  const mainArea = document.createElement('div');
  mainArea.className = 'compose-canvas-area';

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  mainArea.appendChild(canvas);

  page.appendChild(sidebar);
  page.appendChild(mainArea);

  app.appendChild(header);
  app.appendChild(page);

  // === Rendering (shared layout) ===

  /** Compute shared layout + canvas sizing.
   *  cacheScale grows with the full transform (including stretch) so per-cell
   *  stretched glyphs aren't clipped at the offscreen edge; the AABB pass
   *  below walks every glyph's stretched corners to size the page canvas. */
  function computeLayout() {
    const positions = layoutText(inputText, charIds, {
      fontSize, textBoxWidth, kerning, lineHeight, writingMode,
    });
    const cacheScale = totalCacheScale(getTransform());
    const drawSize = fontSize * cacheScale;
    const drawOffset = (drawSize - fontSize) / 2;
    const basePad = 32;

    const rad = ((global.stretchAngle ?? 0) * Math.PI) / 180;
    const s = 1 + (global.stretchAmount ?? 0);
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const a = cos * cos * s + sin * sin;
    const b = cos * sin * (s - 1);
    const d = sin * sin * s + cos * cos;
    const baselineRatio = global?.fontMetrics?.baseline ?? 0.5;

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const pos of positions) {
      const px = pos.x + fontSize / 2;
      const py = pos.y + fontSize * baselineRatio;
      const x0 = pos.x - drawOffset;
      const x1 = pos.x + fontSize + drawOffset;
      const y0 = pos.y - drawOffset;
      const y1 = pos.y + fontSize + drawOffset;
      for (const cx of [x0, x1]) {
        for (const cy of [y0, y1]) {
          const dx = cx - px;
          const dy = cy - py;
          const nx = px + a * dx + b * dy;
          const ny = py + b * dx + d * dy;
          if (nx < minX) minX = nx;
          if (nx > maxX) maxX = nx;
          if (ny < minY) minY = ny;
          if (ny > maxY) maxY = ny;
        }
      }
    }
    if (positions.length === 0) {
      minX = 0; minY = 0; maxX = fontSize; maxY = fontSize;
    }

    const offX = basePad - minX;
    const offY = basePad - minY;
    const cw = Math.max(Math.ceil((maxX - minX) + basePad * 2), 200);
    const ch = Math.max(Math.ceil((maxY - minY) + basePad * 2), 200);
    return { positions, offX, offY, cw, ch, drawSize, drawOffset };
  }

  function prepareCanvas(layout) {
    canvas.width = layout.cw;
    canvas.height = layout.ch;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, layout.cw, layout.ch);
  }

  function drawMissing(gx, gy) {
    ctx.fillStyle = '#f0f0f0';
    ctx.fillRect(gx, gy, fontSize, fontSize);
    ctx.strokeStyle = '#bbb';
    ctx.lineWidth = 1;
    ctx.strokeRect(gx, gy, fontSize, fontSize);
    ctx.fillStyle = '#999';
    ctx.font = `${Math.round(fontSize * 0.4)}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
  }

  /** Render (and cache) a glyph bitmap with the current stretch baked in.
   *  Stretch is applied per-cell inside renderCanvas so cells keep their
   *  shape (round dots stay round) rather than squashing into ellipses, as
   *  happens when stretch is applied as a draw-time image affine. */
  function getStretchedGlyph(charId, charData, charTransform) {
    if (stretchedGlyphCache.has(charId)) return stretchedGlyphCache.get(charId);
    if (!charData) return null;
    const layers = buildRuntimeLayers(global, charData, RENDER_SIZE);
    if (layers.length === 0) return null;
    const scale = totalCacheScale(charTransform);
    const size = Math.ceil(RENDER_SIZE * scale);
    const off = document.createElement('canvas');
    off.width = size;
    off.height = size;
    const offCtx = off.getContext('2d');
    renderCanvas(offCtx, layers, {
      transform: charTransform,
      glyphSize: RENDER_SIZE,
      preview: true,
      fontMetrics: global?.fontMetrics,
    });
    stretchedGlyphCache.set(charId, off);
    return off;
  }

  function redraw() {
    canvas.style.transform = '';
    const layout = computeLayout();
    prepareCanvas(layout);
    const { positions, offX, offY, drawSize, drawOffset } = layout;

    for (const pos of positions) {
      const gx = offX + pos.x;
      const gy = offY + pos.y;

      if (pos.missing) {
        drawMissing(gx, gy);
        ctx.fillText(pos.char, gx + fontSize / 2, gy + fontSize / 2);
        continue;
      }

      const charData = project.characters[pos.charId];
      const charTransform = resolveTransform(
        { ...global, baseGap, gapDirectionWeight, metaballRadius },
        charData?.transformOverrides || {}
      );
      const cached = getStretchedGlyph(pos.charId, charData, charTransform);
      if (!cached) continue;
      ctx.drawImage(cached, gx - drawOffset, gy - drawOffset, drawSize, drawSize);
    }
  }

  /** Lightweight preview: source images with stretch transform, same layout as redraw */
  function redrawFast() {
    const layout = computeLayout();
    prepareCanvas(layout);
    const { positions, offX, offY } = layout;

    // Stretch matrix: rotate(angle) * scaleX(1+amount) * rotate(-angle)
    const rad = ((global.stretchAngle ?? 0) * Math.PI) / 180;
    const s = 1 + (global.stretchAmount ?? 0);
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const a = cos * cos * s + sin * sin;
    const b = cos * sin * (s - 1);
    const d = sin * sin * s + cos * cos;

    // Image stretch pivots on glyph center, not on baseline — font metrics
    // are reference guides only and editing them must not shift the underlay.
    for (const pos of positions) {
      const gx = offX + pos.x;
      const gy = offY + pos.y;
      const cx = gx + fontSize / 2;
      const cy = gy + fontSize / 2;

      if (pos.missing) {
        drawMissing(gx, gy);
        continue;
      }

      const srcImg = sourceImageCache.get(pos.charId);
      if (!srcImg) continue;

      const cd = project.characters[pos.charId] || {};
      const imgScale = cd.imageScale ?? 1;
      const imgOffPx = fontSize / RENDER_SIZE; // map glyph-space px → fontSize-space px
      const imgDx = (cd.imageOffsetX ?? 0) * imgOffPx;
      const imgDy = (cd.imageOffsetY ?? 0) * imgOffPx;
      const drawSize = fontSize * imgScale;
      const ix = gx + (fontSize - drawSize) / 2 + imgDx;
      const iy = gy + (fontSize - drawSize) / 2 + imgDy;

      ctx.save();
      ctx.globalCompositeOperation = 'multiply';
      // Draw source image at its natural glyph size, then stretch around center
      ctx.transform(a, b, b, d, cx - (a * cx + b * cy), cy - (b * cx + d * cy));
      ctx.drawImage(srcImg, ix, iy, drawSize, drawSize);
      ctx.restore();
    }
  }

  function onTransformRelease() {
    canvas.style.transform = '';
    stretchedGlyphCache.clear();
    redraw();
  }

  // Initial render
  requestAnimationFrame(() => redraw());
}
