import { resolveTransform, saveCharacter, serializeLayerOverrides } from '../core/project.js';
import { stretchMatrix } from '../core/transform-math.js';
import { commit as historyCommit } from '../core/history.js';
import { layoutText } from './text-layout.js';
import { computeCacheScale, RENDER_SIZE } from './glyph-cache.js';
import { buildRuntimeLayers } from '../core/layer-builder.js';
import { createLayer, regenerateCells } from '../core/layer.js';
import { getGrid } from '../grids/grid-plugin.js';
import { autoMesh } from '../core/mesh.js';
import { propagateOrientation, setCellOrientationManual } from '../core/orientation.js';
import { uploadCharacterImage } from '../core/storage.js';
import { renderCanvas, drawSourceImage } from '../render/canvas-renderer.js';
import { createLayerPanel } from '../ui/layer-panel.js';
import { createParamsPanel, createTransformPanel } from '../ui/params-panel.js';
import { createToolbar } from '../ui/toolbar.js';
import { createStretchControl } from '../ui/preview-controls.js';
import { createParamRow } from '../ui/param-row.js';
import { ensureFontLoaded, renderCharToContext } from '../render/font/font-import.js';
import { fileToDataURL, loadImage } from '../utils/file-io.js';
import { createSourceImageLoader } from './source-image.js';

/**
 * Compose (組版) view, embeddable as a panel inside the glyph editor.
 *
 * Returns the center canvas area and the sidebar control column as detached DOM
 * nodes plus a `redraw()` so the host can mount them and refresh on demand. It
 * shares the host's live `project` / `global` objects so paint edits made here
 * show up in the glyph strip (via `onCharEdited`) and vice versa.
 *
 *   createComposeView({ project, global, onCharEdited })
 *     → { centerEl, sidebarEl, redraw, invalidate, isEditing, destroy }
 */
export function createComposeView({ project, global, onCharEdited, onCharsAdded } = {}) {
  // Per-charId stretched-glyph cache, invalidated on transform release.
  // We bake stretch into the rasterized bitmap (per-cell repositioning) rather
  // than applying a draw-time image affine, so cells keep their round shape
  // instead of squashing into ellipses.
  const stretchedGlyphCache = new Map();
  const sourceImageCache = new Map(); // charId -> Image (base images for stretch preview)

  const getSourceImage = createSourceImageLoader({
    cache: sourceImageCache, project, global,
    renderSize: RENDER_SIZE,
    onLoad: () => redraw(),
  });

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

  // Inline glyph editing (Glyphs-style in-place zoom): double-click a glyph to
  // zoom the canvas into it and paint its cells directly in the composition.
  let editingCharId = null;
  let editingIndex = -1;   // which layout position is focused
  let editLayers = [];
  let activeEditLayerIdx = 0;  // layer being painted / shown in the grid params panel
  let currentTool = 'paint';   // 'paint' | 'erase' | 'orient'
  let editBgOpacity = 0.3;     // reference-image underlay opacity while editing
  let editZoom = 1;        // canvas re-render scale while editing (crisp, not CSS)
  let zoomAnim = null;     // in-flight FLIP transition (Web Animations API)
  let lastLayout = null;   // most recent (unscaled) computeLayout()
  let isPainting = false;
  let paintValue = false;  // fill/erase target for the active gesture
  let paintedThisGesture = false;

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

  // --- Sidebar (detached column the host mounts into its sidebar body) ---
  const sidebarEl = document.createElement('div');
  sidebarEl.className = 'compose-sidebar-body';

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
  textGroup.appendChild(textTitle);
  textGroup.appendChild(textarea);

  // Batch-create any glyphs referenced by the composition text that don't yet
  // exist in the project, rasterizing each from a Google Font and auto-meshing
  // it — same pipeline as the index page's font import.
  const missingBtn = document.createElement('button');
  missingBtn.className = 'tool-btn';
  missingBtn.textContent = '欠損文字を作成';
  missingBtn.style.marginTop = '8px';
  missingBtn.addEventListener('click', createMissingChars);
  textGroup.appendChild(missingBtn);

  sidebarEl.appendChild(textGroup);

  // Typography controls
  const typoGroup = document.createElement('div');
  typoGroup.className = 'param-group';
  const typoTitle = document.createElement('h3');
  typoTitle.textContent = 'Typography';
  typoGroup.appendChild(typoTitle);

  function addSlider(parent, label, value, min, max, step, onInput, onChange, opts = {}) {
    const { row, api } = createParamRow(label, {
      min, max, step, value,
      hardMin: opts.hardMin,
      hardMax: opts.hardMax,
      onInput,
      onChange,
    });
    parent.appendChild(row);
    return api.slider;
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

  sidebarEl.appendChild(typoGroup);

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

  sidebarEl.appendChild(stretchGroup);

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

  sidebarEl.appendChild(transformGroup);

  // Per-glyph layer/grid editing panel — populated only while a glyph is
  // focused (in-place editing). Sits at the top of the sidebar so the active
  // glyph's controls are front and centre when you double-click in.
  const editPanel = document.createElement('div');
  editPanel.className = 'compose-edit-panel';
  sidebarEl.insertBefore(editPanel, sidebarEl.firstChild);

  // --- Center area (the scrollable canvas viewport the host mounts) ---
  const centerEl = document.createElement('div');
  centerEl.className = 'compose-canvas-area index-compose-area';

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  centerEl.appendChild(canvas);

  // === Rendering (shared layout) ===

  /** Compute shared layout + canvas sizing.
   *  Stretch is baked per-cell into each glyph offscreen at draw time, so the
   *  AABB walks each glyph's exact stretched corners (around its baseline
   *  pivot) — no double application of the stretch matrix. Vertical padding
   *  is taken symmetrically around the row baselines so the page area's
   *  flexbox-centered canvas keeps the baseline at a stable viewport Y as
   *  stretchAmount changes. */
  function computeLayout() {
    const charIds = new Set(Object.keys(project.characters));
    const positions = layoutText(inputText, charIds, {
      fontSize, textBoxWidth, kerning, lineHeight, writingMode,
    });
    const cacheScale = totalCacheScale(getTransform());
    const drawSize = fontSize * cacheScale;
    const drawOffset = (drawSize - fontSize) / 2;
    const basePad = 32;

    const { a, b, d } = stretchMatrix(global.stretchAngle, global.stretchAmount);
    const baselineRatio = global?.fontMetrics?.baseline ?? 0.5;
    const above = fontSize * baselineRatio;          // glyph extent above baseline
    const below = fontSize * (1 - baselineRatio);    // glyph extent below baseline
    const halfW = fontSize / 2;
    const cornersDx = [-halfW, halfW];
    const cornersDy = [-above, below];

    let minX = Infinity, minBaselineY = Infinity, maxX = -Infinity, maxBaselineY = -Infinity;
    let aboveExt = 0;  // max distance the stretched glyph reaches above its row baseline
    let belowExt = 0;  // ... and below

    for (const pos of positions) {
      const px = pos.x + halfW;
      const py = pos.y + above; // row baseline Y in layout space
      if (py < minBaselineY) minBaselineY = py;
      if (py > maxBaselineY) maxBaselineY = py;

      for (const dx of cornersDx) {
        for (const dy of cornersDy) {
          const nx = px + a * dx + b * dy;
          const ny = py + b * dx + d * dy;
          if (nx < minX) minX = nx;
          if (nx > maxX) maxX = nx;
          const distFromBaseline = ny - py;
          if (-distFromBaseline > aboveExt) aboveExt = -distFromBaseline;
          if (distFromBaseline > belowExt) belowExt = distFromBaseline;
        }
      }
    }

    if (positions.length === 0) {
      minX = 0; maxX = fontSize;
      minBaselineY = above; maxBaselineY = above;
      aboveExt = above; belowExt = below;
    }

    // Bounded-params (gap/blur) margin around the glyph extent.
    const marginPx = fontSize * (computeCacheScale(getTransform()) - 1) / 2;
    aboveExt += marginPx;
    belowExt += marginPx;
    const lateralPad = marginPx;

    // Symmetric vertical padding around the row baselines: pad above the first
    // baseline and below the last baseline by the SAME amount, picked to fit
    // the larger of (stretched above, stretched below). This keeps the canvas
    // growing symmetrically around the baselines so the centered viewport
    // doesn't shift the baseline as stretch changes.
    const vPad = Math.max(aboveExt, belowExt) + basePad;
    const minY = minBaselineY - vPad;
    const maxY = maxBaselineY + vPad;

    const offX = basePad + lateralPad - minX;
    const offY = -minY;
    const cw = Math.max(Math.ceil((maxX - minX) + (basePad + lateralPad) * 2), 200);
    const ch = Math.max(Math.ceil(maxY - minY), 200);
    return { positions, offX, offY, cw, ch, drawSize, drawOffset };
  }

  function prepareCanvas(layout, zoom = 1) {
    canvas.width = Math.ceil(layout.cw * zoom);
    canvas.height = Math.ceil(layout.ch * zoom);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(zoom, 0, 0, zoom, 0, 0);  // draw in unscaled layout coords
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
    lastLayout = layout;
    const Z = editingCharId ? editZoom : 1;
    prepareCanvas(layout, Z);
    const { positions, offX, offY, drawSize, drawOffset } = layout;

    for (let i = 0; i < positions.length; i++) {
      const pos = positions[i];
      const gx = offX + pos.x;
      const gy = offY + pos.y;

      // The focused glyph is drawn un-stretched with guides so it's paintable.
      if (editingCharId && i === editingIndex) {
        drawFocusGlyph(gx, gy);
        continue;
      }

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

    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  /** Lightweight preview: source images with stretch transform, same layout as redraw */
  function redrawFast() {
    if (editingCharId) { redraw(); return; }  // keep edit guides crisp while editing
    const layout = computeLayout();
    lastLayout = layout;
    prepareCanvas(layout);
    const { positions, offX, offY } = layout;

    // Stretch matrix: rotate(angle) * scaleX(1+amount) * rotate(-angle)
    const { a, b, d } = stretchMatrix(global.stretchAngle, global.stretchAmount);

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

  // === Inline glyph editing (Glyphs-style in-place zoom) ===
  // Double-click a composed glyph: the whole canvas re-renders at a zoom factor
  // (real raster scale, crisp — not a CSS upscale) and scrolls to centre that
  // glyph, which is drawn un-stretched with cell guides so you paint it right
  // in the composition. Neighbours keep their true relative positions. ESC
  // zooms back out. No popup.
  const RENDER = RENDER_SIZE;
  const editOff = document.createElement('canvas');  // offscreen for the focused glyph
  editOff.width = RENDER;
  editOff.height = RENDER;
  const editOffCtx = editOff.getContext('2d');

  // Transform used while painting the focused glyph. We drop stretch and gap so
  // the painted cells stay aligned with the (un-transformed) hit-test paths, but
  // keep the metaball blur so the focused glyph matches how it reads in the
  // composition (blur only filters in place — it doesn't move cell centers).
  function editTransform() {
    const cd = project.characters[editingCharId];
    const t = resolveTransform(
      { ...global, baseGap, gapDirectionWeight, metaballRadius },
      cd?.transformOverrides || {}
    );
    return { ...t, stretchAmount: 0, stretchAngle: 0, baseGap: 0, gapDirectionWeight: 0 };
  }

  // Render the focused glyph (un-stretched, with blur + guides) into the
  // offscreen, with the reference image (if any) as a paintable underlay.
  function renderEditOff() {
    const cd = project.characters[editingCharId] || {};
    const bg = getSourceImage(editingCharId);  // image- or font-sourced underlay
    editOffCtx.fillStyle = '#fff';
    editOffCtx.fillRect(0, 0, RENDER, RENDER);
    renderCanvas(editOffCtx, editLayers, {
      transform: editTransform(),
      glyphSize: RENDER,
      preview: false,           // cell outlines + glyph boundary as guides
      fontMetrics: global.fontMetrics,
      backgroundImage: bg,
      backgroundOpacity: editBgOpacity,
      imageTransform: {
        imageOffsetX: cd.imageOffsetX ?? 0,
        imageOffsetY: cd.imageOffsetY ?? 0,
        imageScale: cd.imageScale ?? 1,
      },
    });
  }

  // Draw the focused glyph at its layout box. Assumes ctx is already scaled by
  // editZoom, so (gx, gy) are unscaled layout coordinates.
  function drawFocusGlyph(gx, gy) {
    renderEditOff();
    ctx.fillStyle = '#fff';
    ctx.fillRect(gx, gy, fontSize, fontSize);
    ctx.drawImage(editOff, gx, gy, fontSize, fontSize);
    ctx.strokeStyle = '#2563eb';
    ctx.lineWidth = 2 / editZoom;   // ≈2px on screen regardless of zoom
    ctx.strokeRect(gx, gy, fontSize, fontSize);
  }

  // Fast path: repaint only the focused glyph box (during paint strokes).
  function redrawFocusGlyph() {
    const pos = lastLayout?.positions[editingIndex];
    if (!pos) return;
    ctx.setTransform(editZoom, 0, 0, editZoom, 0, 0);
    drawFocusGlyph(lastLayout.offX + pos.x, lastLayout.offY + pos.y);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  // Map a pointer event to the focused glyph's local space (0..RENDER).
  function canvasToGlyph(e) {
    const pos = lastLayout?.positions[editingIndex];
    if (!pos) return null;
    const rect = canvas.getBoundingClientRect();
    const sx = canvas.width / rect.width;
    const sy = canvas.height / rect.height;
    const lx = (e.clientX - rect.left) * sx / editZoom;
    const ly = (e.clientY - rect.top) * sy / editZoom;
    return {
      x: (lx - (lastLayout.offX + pos.x)) * RENDER / fontSize,
      y: (ly - (lastLayout.offY + pos.y)) * RENDER / fontSize,
    };
  }

  // Cell under the glyph-space point, in the active layer (matches the
  // character editor, which paints into the selected layer only).
  function hitCell(p) {
    if (!p || p.x < 0 || p.y < 0 || p.x > RENDER || p.y > RENDER) return null;
    const layer = editLayers[activeEditLayerIdx];
    if (!layer) return null;
    for (const cell of layer.cells) {
      if (editOffCtx.isPointInPath(cell.path, p.x, p.y)) return cell;
    }
    return null;
  }

  function applyPaint(e) {
    const cell = hitCell(canvasToGlyph(e));
    if (cell && cell.filled !== paintValue) {
      cell.filled = paintValue;
      cell.manualOverride = true;
      if (paintValue) {
        // 案A: a freshly painted cell inherits its stroke angle from oriented
        // neighbors (unless the user has manually overridden it).
        const layer = editLayers[activeEditLayerIdx];
        if (layer) propagateOrientation(layer.cells, cell);
      }
      paintedThisGesture = true;
      redrawFocusGlyph();
    }
  }

  // Orient tool: click a filled cell, type its stroke angle (degrees). Empty
  // input clears the manual override so the next auto pass recomputes it.
  function applyOrient(e) {
    const cell = hitCell(canvasToGlyph(e));
    if (!cell || !cell.filled) return;
    const current = cell.orientation != null ? Math.round(cell.orientation) : '';
    const input = prompt('このセルの角度（度・0=水平, 90=垂直）。空欄で自動に戻す:', String(current));
    if (input === null) return;   // cancelled
    const trimmed = input.trim();
    if (trimmed === '') {
      cell.orientation = null;
      cell.coherence = 0;
      cell.orientationSource = null;
    } else {
      const deg = Number(trimmed);
      if (!Number.isFinite(deg)) return;
      setCellOrientationManual(cell, deg);
    }
    redrawFocusGlyph();
    saveEditingChar();
    historyCommit('compose-orient');
  }

  function onPaintDown(e) {
    if (!editingCharId) return;
    if (currentTool === 'orient') { applyOrient(e); return; }
    // Only the fill tools mutate cell.filled — guard against any other tool
    // accidentally erasing (paintValue would otherwise be false).
    if (currentTool !== 'paint' && currentTool !== 'erase') return;
    isPainting = true;
    paintedThisGesture = false;
    paintValue = currentTool === 'paint';   // fixed for the whole gesture
    applyPaint(e);
  }

  function onPaintMove(e) {
    if (!isPainting) return;
    applyPaint(e);
  }

  function onPaintUp() {
    if (!isPainting) return;
    isPainting = false;
    if (paintedThisGesture) {
      saveEditingChar();
      historyCommit('compose-paint');
      redraw();   // propagate the edit to any other instances of this glyph
    }
  }

  // Mirror of index-page's saveLocalChar so the composition + character editor
  // read back the same serialized overrides.
  function saveEditingChar() {
    const cd = project.characters[editingCharId] || {};
    const tOv = cd.transformOverrides && Object.keys(cd.transformOverrides).length > 0
      ? cd.transformOverrides : undefined;
    const next = {
      imagePath: cd.imagePath || '',
      layerOverrides: serializeLayerOverrides(editLayers, global),
      transformOverrides: tOv,
    };
    if (cd.imageOffsetX !== undefined) next.imageOffsetX = cd.imageOffsetX;
    if (cd.imageOffsetY !== undefined) next.imageOffsetY = cd.imageOffsetY;
    if (cd.imageScale !== undefined) next.imageScale = cd.imageScale;
    if (cd.fontSource) next.fontSource = cd.fontSource;
    if (cd.kanjivgSource) next.kanjivgSource = cd.kanjivgSource;
    saveCharacter(editingCharId, next);
    project.characters[editingCharId] = { ...cd, ...next };
    // Invalidate the baked bitmap so other instances of this glyph update.
    stretchedGlyphCache.delete(editingCharId);
    onCharEdited?.(editingCharId);
  }

  // Pick the base font for newly created glyphs by reusing whatever family
  // existing font-imported characters were made with (most common wins), so
  // generated glyphs match the rest of the set. Falls back to the project's
  // default add-glyph family.
  function detectFontFamily() {
    const counts = new Map();
    for (const cd of Object.values(project.characters)) {
      const fam = cd?.fontSource?.family;
      if (!fam) continue;
      counts.set(fam, (counts.get(fam) || 0) + 1);
    }
    let best = null, bestN = 0;
    for (const [fam, n] of counts) {
      if (n > bestN) { best = fam; bestN = n; }
    }
    return best || 'Noto Sans JP';
  }

  // Batch-create every glyph referenced by the composition text that isn't yet
  // in the project: rasterize it from the detected font family and auto-mesh it
  // against the default layers — the same pipeline as the index page's
  // importFromFont, just driven from the compose textarea.
  async function createMissingChars() {
    const WHITESPACE = new Set([' ', '　', '\t', '\n', '\r']);
    const existing = new Set(Object.keys(project.characters));
    const missing = [];
    for (const ch of inputText) {
      if (WHITESPACE.has(ch) || existing.has(ch) || missing.includes(ch)) continue;
      missing.push(ch);
    }
    if (missing.length === 0) {
      alert('欠損文字はありません。');
      return;
    }

    const family = detectFontFamily();
    const origLabel = missingBtn.textContent;
    missingBtn.disabled = true;
    try {
      await ensureFontLoaded(family, missing.join(''));
    } catch (e) {
      console.error(e);
      alert(`フォント「${family}」の読み込みに失敗しました: ${e.message || e}`);
      missingBtn.disabled = false;
      missingBtn.textContent = origLabel;
      return;
    }

    const off = document.createElement('canvas');
    off.width = RENDER;
    off.height = RENDER;
    const offCtx = off.getContext('2d');

    const created = [];
    for (let i = 0; i < missing.length; i++) {
      const ch = missing[i];
      missingBtn.textContent = `作成中… ${i + 1}/${missing.length}`;
      const layers = [];
      for (const gl of global.defaultLayers || []) {
        const gridPlugin = getGrid(gl.gridName);
        if (!gridPlugin) continue;
        const layer = createLayer(gridPlugin, { ...(gl.gridParams || {}) });
        layer.name = gl.name || gl.gridName;
        regenerateCells(layer, RENDER, RENDER);
        layers.push(layer);
      }
      renderCharToContext(offCtx, ch, family, RENDER);
      for (const layer of layers) autoMesh(offCtx, layer.cells, 0.5);
      const charData = {
        layerOverrides: serializeLayerOverrides(layers, global),
        fontSource: { family, char: ch },
      };
      project.characters[ch] = charData;
      saveCharacter(ch, charData);
      getSourceImage(ch);   // warm the stretch-preview underlay
      created.push(ch);
      // Yield so the progress label paints between glyphs.
      await new Promise(r => requestAnimationFrame(r));
    }

    onCharsAdded?.(created);
    historyCommit('compose-create-missing');
    missingBtn.disabled = false;
    missingBtn.textContent = origLabel;
    redraw();
  }

  function centerScrollOnFocus() {
    const pos = lastLayout?.positions[editingIndex];
    if (!pos) return;
    const cx = (lastLayout.offX + pos.x + fontSize / 2) * editZoom;
    const cy = (lastLayout.offY + pos.y + fontSize / 2) * editZoom;
    centerEl.scrollLeft = cx - centerEl.clientWidth / 2;
    centerEl.scrollTop = cy - centerEl.clientHeight / 2;
  }

  function computeEditZoom(layout) {
    const area = centerEl.getBoundingClientRect();
    const target = Math.min(area.width, area.height) * 0.5;  // focus ≈ half the viewport
    let z = target / fontSize;
    const maxDim = 8192;                                     // canvas-size guard
    z = Math.min(z, maxDim / layout.cw, maxDim / layout.ch);
    return Math.max(2, Math.min(z, 10));
  }

  const prefersReducedMotion = window.matchMedia
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // FLIP: capture where the canvas sits now, apply the new (crisp) zoom/scroll
  // state, then animate from the old appearance back to the new one. The final
  // frame is the real raster render, so only the in-flight tween is a CSS
  // scale — the resting state stays sharp. Encodes both translate (scroll) and
  // scale (zoom) deltas in one transform.
  function animateZoomTransition(applyNewState) {
    const first = canvas.getBoundingClientRect();
    applyNewState();
    const last = canvas.getBoundingClientRect();
    if (prefersReducedMotion || !last.width || !first.width) return;

    const s = first.width / last.width;
    const tx = first.left - last.left;
    const ty = first.top - last.top;
    if (!isFinite(s) || s <= 0 || (Math.abs(tx) < 0.5 && Math.abs(ty) < 0.5 && Math.abs(s - 1) < 0.001)) return;

    if (zoomAnim) zoomAnim.cancel();
    canvas.style.transformOrigin = '0 0';
    zoomAnim = canvas.animate(
      [
        { transform: `translate(${tx}px, ${ty}px) scale(${s})` },
        { transform: 'none' },
      ],
      { duration: 260, easing: 'cubic-bezier(0.4, 0, 0.2, 1)' }
    );
    zoomAnim.onfinish = zoomAnim.oncancel = () => {
      canvas.style.transformOrigin = '';
      zoomAnim = null;
    };
  }

  function openEditor(charId, index) {
    const charData = project.characters[charId];
    if (!charData) return;
    const layers = buildRuntimeLayers(global, charData, RENDER);
    if (layers.length === 0) return;
    editLayers = layers;
    editingCharId = charId;
    editingIndex = index;
    activeEditLayerIdx = 0;
    editZoom = computeEditZoom(lastLayout || computeLayout());
    canvas.style.cursor = 'crosshair';
    setComposeControlsVisible(false);   // hide composition settings while editing
    renderEditPanel();
    animateZoomTransition(() => { redraw(); centerScrollOnFocus(); });
  }

  function closeEditor() {
    if (!editingCharId) return;
    editingCharId = null;
    editingIndex = -1;
    editLayers = [];
    isPainting = false;
    editPanel.innerHTML = '';
    canvas.style.cursor = '';
    setComposeControlsVisible(true);
    animateZoomTransition(() => { redraw(); });   // zoom back out to the composition
  }

  // While a glyph is focused, the sidebar shows only that glyph's editing
  // controls — the composition settings (text, typography, stretch, transform)
  // are hidden so the panel reads like the character editor's per-glyph panel.
  function setComposeControlsVisible(visible) {
    const display = visible ? '' : 'none';
    for (const g of [textGroup, typoGroup, stretchGroup, transformGroup]) g.style.display = display;
  }

  // --- Per-glyph editing panel ---
  // Mirrors the character editor's per-glyph (Local) panel: layers are
  // read-only (select / visibility / opacity — no add/delete, those are
  // structural and live in the character editor), grid params + transform are
  // edited as this glyph's overrides (reset badge clears them), plus tools.
  function renderEditPanel() {
    editPanel.innerHTML = '';
    if (!editingCharId) return;
    const cd = project.characters[editingCharId];
    if (!cd) return;

    const head = document.createElement('div');
    head.className = 'param-group compose-edit-head';
    const h = document.createElement('h3');
    h.textContent = `Editing: ${editingCharId}`;
    head.appendChild(h);
    editPanel.appendChild(head);

    // Per-layer baseline = the layer's global gridParams; overrides are diffed
    // against this so the override badge stays accurate.
    const layerBaseline = (idx) => global.defaultLayers?.[idx]?.gridParams || {};

    // Layers (read-only: no add/delete — same as the character editor's Local panel)
    const layerPanel = createLayerPanel(editLayers, activeEditLayerIdx, {
      readOnly: true,
      onSelect(idx) {
        activeEditLayerIdx = idx;
        const layer = editLayers[idx];
        if (layer) paramsPanel.update(layer.gridPlugin.getParamDefs(), layer.gridParams, layerBaseline(idx));
        layerPanel.update(editLayers, activeEditLayerIdx);
      },
      onVisibilityChange() { saveEditingChar(); redraw(); historyCommit('compose-layer-visibility'); },
      onOpacityChange() { saveEditingChar(); redraw(); },  // commit via delegated 'change'
    });
    editPanel.appendChild(layerPanel.el);

    // Grid Parameters (local override)
    const activeLayer = editLayers[activeEditLayerIdx];
    const paramsPanel = createParamsPanel(
      activeLayer ? activeLayer.gridPlugin.getParamDefs() : [],
      activeLayer ? activeLayer.gridParams : {},
      layerBaseline(activeEditLayerIdx),
      {
        localOnly: true,
        onLocalChange(key, val) {
          const layer = editLayers[activeEditLayerIdx];
          if (!layer) return;
          layer.gridParams[key] = val;
          const baseline = layerBaseline(activeEditLayerIdx);
          if (val === baseline[key]) {
            if (layer.gridParamOverrides) delete layer.gridParamOverrides[key];
          } else {
            if (!layer.gridParamOverrides) layer.gridParamOverrides = {};
            layer.gridParamOverrides[key] = val;
          }
          regenerateCells(layer, RENDER, RENDER);
          redraw();
          saveEditingChar();
        },
        onGlobalChange() {},
        onReset(key) {
          const layer = editLayers[activeEditLayerIdx];
          if (!layer) return;
          const baseline = layerBaseline(activeEditLayerIdx);
          layer.gridParams[key] = baseline[key];
          if (layer.gridParamOverrides) delete layer.gridParamOverrides[key];
          regenerateCells(layer, RENDER, RENDER);
          redraw();
          saveEditingChar();
        },
      }
    );
    editPanel.appendChild(paramsPanel.el);

    // Transform (local override) — per-glyph Gap / Gap Dir / Blur
    const localTransformOverrides = { ...(cd.transformOverrides || {}) };
    const localTransform = resolveTransform(global, localTransformOverrides);
    const transformPanel = createTransformPanel(localTransform, global, {
      localOnly: true,
      onLocalChange(key, val) {
        localTransform[key] = val;
        if (val === global[key]) delete localTransformOverrides[key];
        else localTransformOverrides[key] = val;
        cd.transformOverrides = Object.keys(localTransformOverrides).length ? { ...localTransformOverrides } : undefined;
        redraw();
        saveEditingChar();
      },
      onGlobalChange() {},
      onReset(key) {
        localTransform[key] = global[key];
        delete localTransformOverrides[key];
        cd.transformOverrides = Object.keys(localTransformOverrides).length ? { ...localTransformOverrides } : undefined;
        transformPanel.render();
        redraw();
        saveEditingChar();
      },
    });
    editPanel.appendChild(transformPanel.el);

    // Tools (paint / erase / angle)
    const toolbar = createToolbar((tool) => { currentTool = tool; });
    editPanel.appendChild(toolbar.el);

    // Source Image + Auto Mesh
    const imgSection = document.createElement('div');
    imgSection.className = 'param-group';
    const imgTitle = document.createElement('h3');
    imgTitle.textContent = 'Source Image';
    imgSection.appendChild(imgTitle);

    const imgBtn = document.createElement('button');
    imgBtn.className = 'tool-btn';
    imgBtn.textContent = 'Load Image';
    imgBtn.addEventListener('click', loadEditImage);
    imgSection.appendChild(imgBtn);

    const meshBtn = document.createElement('button');
    meshBtn.className = 'tool-btn';
    meshBtn.textContent = 'Auto Mesh';
    meshBtn.style.marginLeft = '4px';
    meshBtn.addEventListener('click', () => doEditAutoMesh(threshApi.getValue()));
    imgSection.appendChild(meshBtn);

    const { row: threshRow, api: threshApi } = createParamRow('Threshold', {
      min: 0, max: 1, step: 0.05, value: 0.5, hardMin: 0, hardMax: 1,
    });
    threshRow.style.marginTop = '8px';
    imgSection.appendChild(threshRow);

    const { row: bgOpRow } = createParamRow('BG Opacity', {
      min: 0, max: 1, step: 0.05, value: editBgOpacity, hardMin: 0, hardMax: 1,
      onInput: (v) => { editBgOpacity = v; redraw(); },
    });
    imgSection.appendChild(bgOpRow);

    // Image transform (per-glyph offset & scale to align the reference image)
    const imgTransformDefs = [
      { key: 'imageOffsetX', label: 'Image X', min: -RENDER, max: RENDER, default: 0, step: 1 },
      { key: 'imageOffsetY', label: 'Image Y', min: -RENDER, max: RENDER, default: 0, step: 1 },
      { key: 'imageScale',   label: 'Image Scale', min: 0.1, max: 3, default: 1, step: 0.01 },
    ];
    for (const def of imgTransformDefs) {
      const badge = document.createElement('button');
      badge.type = 'button';
      badge.className = 'override-badge';
      const { row, api, label } = createParamRow(def.label, {
        min: def.min, max: def.max, step: def.step,
        value: cd[def.key] ?? def.default,
        formatter: (v) => def.step < 0.1 ? v.toFixed(2) : (Number.isInteger(v) ? String(v) : v.toFixed(2)),
        onInput: (v) => {
          const c = project.characters[editingCharId];
          if (!c) return;
          if (v === def.default) delete c[def.key];
          else c[def.key] = v;
          syncOverrideUI();
          redraw();
        },
        onChange: () => { saveEditingChar(); },
      }, { badge });
      function syncOverrideUI() {
        const c = project.characters[editingCharId] || {};
        const overridden = (c[def.key] ?? def.default) !== def.default;
        label.classList.toggle('overridden', overridden);
        badge.classList.toggle('is-off', !overridden);
        badge.title = overridden ? 'Click to reset override' : '';
        badge.tabIndex = overridden ? 0 : -1;
      }
      badge.addEventListener('click', () => {
        if (!label.classList.contains('overridden')) return;
        const c = project.characters[editingCharId];
        if (!c) return;
        delete c[def.key];
        api.setValue(def.default);
        syncOverrideUI();
        redraw();
        saveEditingChar();
      });
      imgSection.appendChild(row);
      syncOverrideUI();
    }

    // KanjiVG stroke width (per-character override of global.kanjivgStrokeWidth).
    // Re-run Auto Mesh after changing it to update cell fills.
    if (cd.kanjivgSource) {
      const def = { label: 'Stroke', min: 1, max: 20, step: 0.5, default: global.kanjivgStrokeWidth };
      const badge = document.createElement('button');
      badge.type = 'button';
      badge.className = 'override-badge';
      const reRenderUnderlay = () => { sourceImageCache.delete(editingCharId); getSourceImage(editingCharId); };
      const { row, api, label } = createParamRow(def.label, {
        min: def.min, max: def.max, step: def.step,
        value: cd.kanjivgSource.strokeWidth ?? def.default,
        formatter: (v) => v.toFixed(1),
        onInput: (v) => {
          const c = project.characters[editingCharId];
          if (!c?.kanjivgSource) return;
          if (v === def.default) {
            const { strokeWidth, ...rest } = c.kanjivgSource;
            c.kanjivgSource = rest;
          } else {
            c.kanjivgSource = { ...c.kanjivgSource, strokeWidth: v };
          }
          syncOverrideUI();
          reRenderUnderlay();
        },
        onChange: () => { saveEditingChar(); },
      }, { badge });
      function syncOverrideUI() {
        const c = project.characters[editingCharId] || {};
        const overridden = c.kanjivgSource?.strokeWidth !== undefined;
        label.classList.toggle('overridden', overridden);
        badge.classList.toggle('is-off', !overridden);
        badge.title = overridden ? 'Click to reset override' : '';
        badge.tabIndex = overridden ? 0 : -1;
      }
      badge.addEventListener('click', () => {
        const c = project.characters[editingCharId];
        if (!c?.kanjivgSource || c.kanjivgSource.strokeWidth === undefined) return;
        const { strokeWidth, ...rest } = c.kanjivgSource;
        c.kanjivgSource = rest;
        api.setValue(def.default);
        syncOverrideUI();
        reRenderUnderlay();
        saveEditingChar();
      });
      imgSection.appendChild(row);
      syncOverrideUI();
    }

    editPanel.appendChild(imgSection);
  }

  // Load a reference image for the focused glyph (preview immediately, upload in
  // the background) — mirrors the character editor's loadLocalImage.
  function loadEditImage() {
    if (!editingCharId) return;
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/png,image/jpeg';
    input.addEventListener('change', async () => {
      const file = input.files[0];
      if (!file) return;
      const targetId = editingCharId;
      const dataUrl = await fileToDataURL(file);
      const previewImg = await loadImage(dataUrl);
      if (editingCharId === targetId) {
        sourceImageCache.set(targetId, previewImg);
        redraw();
      }
      let url;
      try {
        url = await uploadCharacterImage({ charId: targetId, file });
      } catch (e) {
        console.error(e);
        alert(`画像のアップロードに失敗しました: ${e.message}`);
        return;
      }
      const cd = project.characters[targetId] || {};
      cd.imagePath = url;
      project.characters[targetId] = cd;
      if (editingCharId === targetId) saveEditingChar();
      historyCommit('compose-load-image');
    });
    input.click();
  }

  // Sample the reference image against the active glyph's cells (mirrors the
  // character editor's doAutoMesh).
  function doEditAutoMesh(threshold) {
    if (!editingCharId) return;
    const bg = getSourceImage(editingCharId);
    if (!bg) { alert('先に画像を読み込んでください。'); return; }
    const off = document.createElement('canvas');
    off.width = RENDER;
    off.height = RENDER;
    const offCtx = off.getContext('2d');
    offCtx.fillStyle = '#fff';   // areas outside the image count as background
    offCtx.fillRect(0, 0, RENDER, RENDER);
    const cd = project.characters[editingCharId] || {};
    drawSourceImage(offCtx, bg, 0, 0, RENDER, {
      imageOffsetX: cd.imageOffsetX ?? 0,
      imageOffsetY: cd.imageOffsetY ?? 0,
      imageScale: cd.imageScale ?? 1,
    });
    if (editLayers.length === 0) return;
    for (const layer of editLayers) autoMesh(offCtx, layer.cells, threshold);
    redraw();
    saveEditingChar();
    historyCommit('compose-auto-mesh');
  }

  function onEditKey(e) {
    if (editingCharId && e.key === 'Escape') { e.preventDefault(); closeEditor(); }
  }
  document.addEventListener('keydown', onEditKey);

  canvas.addEventListener('mousedown', onPaintDown);
  canvas.addEventListener('mousemove', onPaintMove);
  window.addEventListener('mouseup', onPaintUp);

  // Double-click a composed glyph → zoom in and focus it (or switch focus).
  canvas.addEventListener('dblclick', (e) => {
    if (!lastLayout) return;
    const rect = canvas.getBoundingClientRect();
    const sx = canvas.width / rect.width;
    const sy = canvas.height / rect.height;
    const z = editingCharId ? editZoom : 1;
    const lx = (e.clientX - rect.left) * sx / z;
    const ly = (e.clientY - rect.top) * sy / z;
    const { positions, offX, offY } = lastLayout;
    for (let i = 0; i < positions.length; i++) {
      const pos = positions[i];
      if (pos.missing || !project.characters[pos.charId]) continue;
      const gx = offX + pos.x;
      const gy = offY + pos.y;
      if (lx >= gx && lx <= gx + fontSize && ly >= gy && ly <= gy + fontSize) {
        openEditor(pos.charId, i);
        return;
      }
    }
  });

  // Editing the text exits the in-place editor.
  textarea.addEventListener('input', () => { if (editingCharId) closeEditor(); });

  // Tear down document/window listeners when the host page is replaced.
  function destroy() {
    document.removeEventListener('keydown', onEditKey);
    window.removeEventListener('mouseup', onPaintUp);
  }
  window.addEventListener('hashchange', function onHashChange() {
    if (editingCharId) closeEditor();
    window.removeEventListener('hashchange', onHashChange);
    destroy();
  });

  // Re-pull glyphs that appeared since the view was built and drop baked
  // bitmaps so host-side edits (paint, overrides) show on the next draw. Also
  // re-sync the stretch sliders, since the host (preview panel, undo/redo) can
  // change global stretch out from under this view.
  function invalidate() {
    stretchedGlyphCache.clear();
    stretchControl.syncFromGlobal();
    for (const cid of Object.keys(project.characters)) {
      if (!sourceImageCache.has(cid)) getSourceImage(cid);
    }
  }

  return {
    centerEl,
    sidebarEl,
    redraw,
    invalidate,
    isEditing: () => !!editingCharId,
    destroy,
  };
}
