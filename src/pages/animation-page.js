import { loadProject, getGlobal, resolveTransform, saveAnimation, getAnimation, createDefaultAnimation, ANIMATED_PARAM_KEYS } from '../core/project.js';
import { layoutText, layoutBounds } from '../compose/text-layout.js';
import { createGlyphCache, computeCacheScale } from '../compose/glyph-cache.js';
import { sampleAnimation, upsertKeyframe, clampTime, nextKeyframeTime, prevKeyframeTime } from '../animation/animation.js';
import { createTimelineUI } from '../animation/timeline-ui.js';
import { renderFrames } from '../animation/render.js';
import { exportPngSequence, exportGif } from '../animation/export.js';

const ANIMATED_SLIDER_DEFS = [
  { key: 'fontSize', label: 'Font Size', min: 16, max: 256, step: 1 },
  { key: 'textBoxWidth', label: 'Box Width', min: 200, max: 2000, step: 10 },
  { key: 'kerning', label: 'Kerning', min: -40, max: 100, step: 1 },
  { key: 'lineHeight', label: 'Line Height', min: 0.4, max: 6.0, step: 0.1 },
  { key: 'stretchAngle', label: 'Stretch Angle', min: 0, max: 180, step: 1 },
  { key: 'stretchAmount', label: 'Stretch Amount', min: 0, max: 2, step: 0.05 },
  { key: 'baseGap', label: 'Gap', min: 0, max: 20, step: 0.5 },
  { key: 'gapDirectionWeight', label: 'Gap Dir', min: 0, max: 1, step: 0.05 },
  { key: 'metaballRadius', label: 'Blur', min: 0, max: 30, step: 1 },
];

const CAMERA_SLIDER_DEFS = [
  { key: 'cameraX', label: 'X', min: -1000, max: 1000, step: 1 },
  { key: 'cameraY', label: 'Y', min: -1000, max: 1000, step: 1 },
  { key: 'cameraDistance', label: 'Distance', min: 0.1, max: 5, step: 0.05 },
];

export function renderAnimationPage(app) {
  const project = loadProject();
  const global = getGlobal();
  project.global = global;
  const charIds = new Set(Object.keys(project.characters));
  const glyphCache = createGlyphCache();
  const sourceImageCache = new Map();

  let animation = getAnimation();
  if (!animation.text) animation.text = Object.keys(project.characters).join('');

  // Ensure every animated track has at least one keyframe at t=0.
  let tracksFilled = false;
  for (const key of ANIMATED_PARAM_KEYS) {
    if (!animation.tracks[key]) animation.tracks[key] = [];
    if (animation.tracks[key].length === 0) {
      const v = animation.baseValues?.[key] ?? 0;
      animation.tracks[key].push({ time: 0, value: v, easing: 'linear' });
      tracksFilled = true;
    }
  }
  if (tracksFilled) saveAnimation(animation);

  // State
  let currentTime = 0;
  let playing = false;
  let playStartWallTime = 0;
  let playStartAnimTime = 0;
  let rafId = null;
  let renderedFrames = null; // { frames: HTMLCanvasElement[], fps, width, height } or null
  let renderDirty = true;
  let showingRendered = false;

  function persist() {
    saveAnimation(animation);
  }

  function markDirty() {
    renderDirty = true;
    showingRendered = false;
  }

  // Preload source images
  function getSourceImage(charId) {
    if (sourceImageCache.has(charId)) return sourceImageCache.get(charId);
    const cd = project.characters[charId];
    if (!cd?.imagePath) return null;
    const img = new Image();
    img.src = cd.imagePath;
    img.onload = () => { sourceImageCache.set(charId, img); redrawPreview(); };
    sourceImageCache.set(charId, null);
    return null;
  }
  for (const cid of Object.keys(project.characters)) getSourceImage(cid);

  // === Header ===
  const header = document.createElement('div');
  header.className = 'header';
  const backBtn = document.createElement('button');
  backBtn.textContent = 'Back';
  backBtn.addEventListener('click', () => { location.hash = '#/'; });
  const title = document.createElement('h1');
  title.textContent = 'Animation';
  header.appendChild(backBtn);
  header.appendChild(title);

  // === Page ===
  const page = document.createElement('div');
  page.className = 'edit-page anim-page';

  // --- Sidebar ---
  const sidebar = document.createElement('div');
  sidebar.className = 'sidebar';

  // Text group (non-animated)
  const textGroup = document.createElement('div');
  textGroup.className = 'param-group';
  const textTitle = document.createElement('h3');
  textTitle.textContent = 'Text';
  textTitle.style.marginTop = '0';
  const textarea = document.createElement('textarea');
  textarea.className = 'compose-textarea';
  textarea.value = animation.text;
  textarea.addEventListener('input', () => {
    animation.text = textarea.value;
    persist();
    markDirty();
    redrawPreview();
  });
  textGroup.appendChild(textTitle);
  textGroup.appendChild(textarea);

  const modeRow = document.createElement('div');
  modeRow.className = 'param-row';
  const modeLbl = document.createElement('label');
  modeLbl.textContent = 'Direction';
  const modeWrap = document.createElement('div');
  modeWrap.className = 'writing-mode-toggle';
  const hBtn = document.createElement('button');
  hBtn.className = 'tool-btn' + (animation.writingMode === 'horizontal' ? ' active' : '');
  hBtn.textContent = 'Horizontal';
  const vBtn = document.createElement('button');
  vBtn.className = 'tool-btn' + (animation.writingMode === 'vertical' ? ' active' : '');
  vBtn.textContent = 'Vertical';
  hBtn.addEventListener('click', () => {
    animation.writingMode = 'horizontal';
    hBtn.classList.add('active'); vBtn.classList.remove('active');
    persist(); markDirty(); redrawPreview();
  });
  vBtn.addEventListener('click', () => {
    animation.writingMode = 'vertical';
    vBtn.classList.add('active'); hBtn.classList.remove('active');
    persist(); markDirty(); redrawPreview();
  });
  modeWrap.appendChild(hBtn);
  modeWrap.appendChild(vBtn);
  modeRow.appendChild(modeLbl);
  modeRow.appendChild(modeWrap);
  textGroup.appendChild(modeRow);
  sidebar.appendChild(textGroup);

  // Animated param sliders
  const paramsGroup = document.createElement('div');
  paramsGroup.className = 'param-group';
  const paramsTitle = document.createElement('h3');
  paramsTitle.textContent = 'Animated Parameters';
  paramsGroup.appendChild(paramsTitle);

  const sliderInputs = {}; // key -> {input, valSpan}

  function addAnimatedSliders(parent, defs) {
    for (const def of defs) {
      const row = document.createElement('div');
      row.className = 'param-row';
      const label = document.createElement('label');
      label.textContent = def.label;
      const input = document.createElement('input');
      input.type = 'range';
      input.min = def.min;
      input.max = def.max;
      input.step = def.step;
      const initial = sampleAnimation(animation, currentTime)[def.key];
      input.value = initial;
      const valSpan = document.createElement('span');
      valSpan.className = 'value';
      valSpan.textContent = Number(initial).toFixed(def.step < 1 ? 2 : 0);

      input.addEventListener('input', () => {
        const v = parseFloat(input.value);
        valSpan.textContent = def.step < 1 ? v.toFixed(2) : String(v);
        redrawFast(overrideWith(def.key, v));
      });
      input.addEventListener('change', () => {
        const v = parseFloat(input.value);
        upsertKeyframe(animation.tracks[def.key], currentTime, v);
        persist();
        markDirty();
        timeline.render();
        redrawPreview();
      });

      row.appendChild(label);
      row.appendChild(input);
      row.appendChild(valSpan);
      parent.appendChild(row);

      sliderInputs[def.key] = { input, valSpan, def };
    }
  }

  addAnimatedSliders(paramsGroup, ANIMATED_SLIDER_DEFS);
  sidebar.appendChild(paramsGroup);

  // CAMERA group
  const cameraGroup = document.createElement('div');
  cameraGroup.className = 'param-group';
  const cameraTitle = document.createElement('h3');
  cameraTitle.textContent = 'CAMERA';
  cameraGroup.appendChild(cameraTitle);
  addAnimatedSliders(cameraGroup, CAMERA_SLIDER_DEFS);
  sidebar.appendChild(cameraGroup);

  // Duration + FPS + playback controls
  const playbackGroup = document.createElement('div');
  playbackGroup.className = 'param-group';
  const playbackTitle = document.createElement('h3');
  playbackTitle.textContent = 'Playback';
  playbackGroup.appendChild(playbackTitle);

  function addNumberField(parent, label, value, min, max, step, onChange) {
    const row = document.createElement('div');
    row.className = 'param-row';
    const lbl = document.createElement('label');
    lbl.textContent = label;
    const input = document.createElement('input');
    input.type = 'number';
    input.min = min;
    input.max = max;
    input.step = step;
    input.value = value;
    input.addEventListener('change', () => {
      const v = parseFloat(input.value);
      if (!Number.isFinite(v)) return;
      onChange(v);
    });
    row.appendChild(lbl);
    row.appendChild(input);
    parent.appendChild(row);
    return input;
  }

  addNumberField(playbackGroup, 'Duration (s)', animation.duration, 0.5, 120, 0.5, (v) => {
    animation.duration = v;
    if (currentTime > v) currentTime = v;
    persist(); markDirty(); timeline.render(); updateSlidersFromTime();
  });
  addNumberField(playbackGroup, 'FPS', animation.fps, 1, 60, 1, (v) => {
    animation.fps = Math.round(v);
    persist(); markDirty();
  });

  const btnRow = document.createElement('div');
  btnRow.className = 'anim-button-row';
  const playBtn = document.createElement('button');
  playBtn.className = 'tool-btn';
  playBtn.textContent = 'Play';
  playBtn.title = 'Play / Pause (Space)';
  playBtn.addEventListener('click', () => togglePlay());
  const renderBtn = document.createElement('button');
  renderBtn.className = 'tool-btn';
  renderBtn.textContent = 'Render';
  renderBtn.addEventListener('click', () => doRender());
  btnRow.appendChild(playBtn);
  btnRow.appendChild(renderBtn);
  playbackGroup.appendChild(btnRow);

  const progressWrap = document.createElement('div');
  progressWrap.className = 'import-progress';
  progressWrap.style.display = 'none';
  const progressTrack = document.createElement('div');
  progressTrack.className = 'import-progress-track';
  const progressBar = document.createElement('div');
  progressBar.className = 'import-progress-bar';
  progressTrack.appendChild(progressBar);
  const progressText = document.createElement('span');
  progressText.className = 'import-progress-text';
  progressWrap.appendChild(progressTrack);
  progressWrap.appendChild(progressText);
  playbackGroup.appendChild(progressWrap);

  sidebar.appendChild(playbackGroup);

  // Export group
  const exportGroup = document.createElement('div');
  exportGroup.className = 'param-group';
  const exportTitle = document.createElement('h3');
  exportTitle.textContent = 'Export';
  exportGroup.appendChild(exportTitle);

  const exportRow = document.createElement('div');
  exportRow.className = 'anim-button-row';
  const pngBtn = document.createElement('button');
  pngBtn.className = 'tool-btn';
  pngBtn.textContent = 'PNG Seq';
  pngBtn.addEventListener('click', () => doExportPng());
  const gifBtn = document.createElement('button');
  gifBtn.className = 'tool-btn';
  gifBtn.textContent = 'GIF';
  gifBtn.addEventListener('click', () => doExportGif());
  exportRow.appendChild(pngBtn);
  exportRow.appendChild(gifBtn);
  exportGroup.appendChild(exportRow);

  const jsonRow = document.createElement('div');
  jsonRow.className = 'anim-button-row';
  const jsonExport = document.createElement('button');
  jsonExport.className = 'tool-btn';
  jsonExport.textContent = 'Export JSON';
  jsonExport.addEventListener('click', () => doJsonExport());
  const jsonImport = document.createElement('button');
  jsonImport.className = 'tool-btn';
  jsonImport.textContent = 'Import JSON';
  jsonImport.addEventListener('click', () => doJsonImport());
  jsonRow.appendChild(jsonExport);
  jsonRow.appendChild(jsonImport);
  exportGroup.appendChild(jsonRow);

  sidebar.appendChild(exportGroup);

  // --- Main area ---
  const mainArea = document.createElement('div');
  mainArea.className = 'compose-canvas-area anim-canvas-area';
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  mainArea.appendChild(canvas);

  // --- Bottom timeline ---
  const timelineWrap = document.createElement('div');
  timelineWrap.className = 'anim-timeline-wrap';

  const timeDisplay = document.createElement('div');
  timeDisplay.className = 'anim-time-display';
  timelineWrap.appendChild(timeDisplay);

  const timeline = createTimelineUI(animation, {
    onSeek: (t) => {
      currentTime = clampTime(t, animation.duration);
      updateSlidersFromTime();
      timeline.renderPlayhead();
      updateTimeDisplay();
      redrawPreview();
    },
    onChange: () => { persist(); markDirty(); },
    getCurrentTime: () => currentTime,
  });
  timelineWrap.appendChild(timeline.el);

  // Assemble
  const leftCol = document.createElement('div');
  leftCol.className = 'anim-main-col';
  leftCol.appendChild(mainArea);
  leftCol.appendChild(timelineWrap);

  page.appendChild(sidebar);
  page.appendChild(leftCol);

  app.appendChild(header);
  app.appendChild(page);

  // === Rendering ===

  function overrideWith(key, val) {
    const p = sampleAnimation(animation, currentTime);
    p[key] = val;
    return p;
  }

  function getTransformFromParams(p) {
    return {
      stretchAngle: p.stretchAngle,
      stretchAmount: p.stretchAmount,
      baseGap: p.baseGap,
      gapDirectionWeight: p.gapDirectionWeight,
      metaballStrength: global.metaballStrength ?? 1,
      metaballRadius: p.metaballRadius,
    };
  }

  function computeLayout(params) {
    const positions = layoutText(animation.text, charIds, {
      fontSize: params.fontSize,
      textBoxWidth: params.textBoxWidth,
      kerning: params.kerning,
      lineHeight: params.lineHeight,
      writingMode: animation.writingMode,
    });
    const cacheScale = computeCacheScale(getTransformFromParams(params));
    const drawSize = params.fontSize * cacheScale;
    const drawOffset = (drawSize - params.fontSize) / 2;
    const pad = 32 + drawOffset;
    const bounds = layoutBounds(positions, params.fontSize);
    const cw = Math.max(bounds.width + pad * 2, 200);
    const ch = Math.max(bounds.height + pad * 2, 200);
    return { positions, pad, cw, ch, drawSize, drawOffset, params };
  }

  function prepareCanvas(cw, ch) {
    canvas.width = cw;
    canvas.height = ch;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, cw, ch);
  }

  function drawMissingAt(gx, gy, size) {
    ctx.fillStyle = '#f0f0f0';
    ctx.fillRect(gx, gy, size, size);
    ctx.strokeStyle = '#bbb';
    ctx.lineWidth = 1;
    ctx.strokeRect(gx, gy, size, size);
  }

  /** Apply camera transform (pan + zoom) around the canvas center. */
  function applyCameraTransform(targetCtx, cw, ch, p) {
    const cx = cw / 2;
    const cy = ch / 2;
    targetCtx.translate(cx + (p.cameraX || 0), cy + (p.cameraY || 0));
    const dist = p.cameraDistance != null ? p.cameraDistance : 1;
    targetCtx.scale(dist, dist);
    targetCtx.translate(-cx, -cy);
  }

  /** Full pipeline draw (slow) */
  function drawFull(params) {
    canvas.style.transform = '';
    const layout = computeLayout(params);
    prepareCanvas(layout.cw, layout.ch);
    const { positions, pad, drawSize, drawOffset, cw, ch } = layout;
    const transform = getTransformFromParams(params);
    ctx.save();
    applyCameraTransform(ctx, cw, ch, params);
    for (const pos of positions) {
      const gx = pad + pos.x;
      const gy = pad + pos.y;
      if (pos.missing) { drawMissingAt(gx, gy, params.fontSize); continue; }
      const charData = project.characters[pos.charId];
      const charTransform = resolveTransform({ ...global, ...transform }, charData?.transformOverrides || {});
      const cached = glyphCache.get(pos.charId, charData, global, charTransform);
      if (cached) ctx.drawImage(cached, gx - drawOffset, gy - drawOffset, drawSize, drawSize);
    }
    ctx.restore();
  }

  /** Fast preview using source images */
  function redrawFast(params) {
    const p = params || sampleAnimation(animation, currentTime);
    const layout = computeLayout(p);
    prepareCanvas(layout.cw, layout.ch);
    const { positions, pad, cw, ch } = layout;
    const rad = (p.stretchAngle * Math.PI) / 180;
    const s = 1 + p.stretchAmount;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const a = cos * cos * s + sin * sin;
    const b = cos * sin * (s - 1);
    const d = sin * sin * s + cos * cos;
    ctx.save();
    applyCameraTransform(ctx, cw, ch, p);
    for (const pos of positions) {
      const gx = pad + pos.x;
      const gy = pad + pos.y;
      const cx = gx + p.fontSize / 2;
      const cy = gy + p.fontSize / 2;
      if (pos.missing) { drawMissingAt(gx, gy, p.fontSize); continue; }
      const srcImg = sourceImageCache.get(pos.charId);
      if (!srcImg) continue;
      ctx.save();
      ctx.globalCompositeOperation = 'multiply';
      ctx.transform(a, b, b, d, cx - (a * cx + b * cy), cy - (b * cx + d * cy));
      ctx.drawImage(srcImg, gx, gy, p.fontSize, p.fontSize);
      ctx.restore();
    }
    ctx.restore();
  }

  function drawRenderedFrameAt(time) {
    if (!renderedFrames) return false;
    const idx = Math.min(renderedFrames.frames.length - 1,
      Math.max(0, Math.round(time * renderedFrames.fps)));
    const frame = renderedFrames.frames[idx];
    if (!frame) return false;
    canvas.width = frame.width;
    canvas.height = frame.height;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, frame.width, frame.height);
    ctx.drawImage(frame, 0, 0);
    return true;
  }

  function redrawPreview() {
    if (showingRendered && renderedFrames) {
      if (drawRenderedFrameAt(currentTime)) return;
    }
    redrawFast(sampleAnimation(animation, currentTime));
  }

  function updateSlidersFromTime() {
    const p = sampleAnimation(animation, currentTime);
    for (const key of ANIMATED_PARAM_KEYS) {
      const ref = sliderInputs[key];
      if (!ref) continue;
      ref.input.value = p[key];
      ref.valSpan.textContent = ref.def.step < 1 ? Number(p[key]).toFixed(2) : String(Math.round(p[key]));
    }
  }

  function updateTimeDisplay() {
    timeDisplay.textContent = `${currentTime.toFixed(2)}s / ${animation.duration.toFixed(2)}s`;
  }

  // === Playback ===
  function togglePlay() {
    if (playing) pausePlayback();
    else startPlayback();
  }
  function startPlayback() {
    if (currentTime >= animation.duration) currentTime = 0;
    playing = true;
    playBtn.textContent = 'Pause';
    playStartWallTime = performance.now();
    playStartAnimTime = currentTime;
    const tick = () => {
      if (!playing) return;
      const elapsed = (performance.now() - playStartWallTime) / 1000;
      currentTime = playStartAnimTime + elapsed;
      if (currentTime >= animation.duration) {
        currentTime = animation.duration;
        updateSlidersFromTime();
        timeline.renderPlayhead();
        updateTimeDisplay();
        redrawPreview();
        pausePlayback();
        return;
      }
      updateSlidersFromTime();
      timeline.renderPlayhead();
      updateTimeDisplay();
      redrawPreview();
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
  }
  function pausePlayback() {
    playing = false;
    playBtn.textContent = 'Play';
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    // On pause, if a render exists, ensure the preview shows the rendered frame.
    redrawPreview();
  }

  function seekTo(t) {
    currentTime = clampTime(t, animation.duration);
    updateSlidersFromTime();
    timeline.renderPlayhead();
    updateTimeDisplay();
    redrawPreview();
  }

  // Keyboard shortcuts:
  //   Space        — toggle play/pause
  //   Shift+Up     — jump to previous keyframe
  //   Shift+Down   — jump to next keyframe
  // Ignore when typing in a text field or focused on a button (so that BUTTON's
  // default Space→click isn't doubled by our handler).
  function onKeyDown(e) {
    const t = e.target;
    const tag = t?.tagName;
    const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t?.isContentEditable;

    if (e.code === 'Space') {
      if (typing || tag === 'BUTTON') return;
      e.preventDefault();
      togglePlay();
      return;
    }
    if (e.shiftKey && (e.code === 'ArrowUp' || e.code === 'ArrowDown')) {
      if (typing) return;
      e.preventDefault();
      const target = e.code === 'ArrowDown'
        ? nextKeyframeTime(animation, currentTime)
        : prevKeyframeTime(animation, currentTime);
      if (target != null) seekTo(target);
    }
  }
  document.addEventListener('keydown', onKeyDown);
  // Detach on hashchange so we don't leak across pages
  window.addEventListener('hashchange', function detach() {
    document.removeEventListener('keydown', onKeyDown);
    timeline.destroy?.();
    window.removeEventListener('hashchange', detach);
  });

  // === Render ===
  async function doRender() {
    renderBtn.disabled = true;
    renderBtn.textContent = 'Rendering...';
    progressWrap.style.display = '';
    progressBar.style.width = '0%';
    progressText.textContent = '0%';
    try {
      const result = await renderFrames(animation, {
        project, global, charIds, glyphCache,
        onProgress: (done, total) => {
          const pct = Math.round((done / total) * 100);
          progressBar.style.width = pct + '%';
          progressText.textContent = `${done} / ${total}`;
        },
      });
      renderedFrames = result;
      renderDirty = false;
      showingRendered = true;
      redrawPreview();
    } catch (e) {
      console.error('Render failed:', e);
      alert('Render failed: ' + e.message);
    } finally {
      progressWrap.style.display = 'none';
      renderBtn.disabled = false;
      renderBtn.textContent = 'Render';
    }
  }

  // === Export ===
  async function ensureRendered() {
    if (!renderedFrames || renderDirty) {
      await doRender();
    }
    return renderedFrames;
  }

  async function doExportPng() {
    pngBtn.disabled = true;
    try {
      const r = await ensureRendered();
      if (!r) return;
      await exportPngSequence(r);
    } catch (e) {
      console.error(e);
      alert('PNG export failed: ' + e.message);
    } finally {
      pngBtn.disabled = false;
    }
  }

  async function doExportGif() {
    gifBtn.disabled = true;
    const prevText = gifBtn.textContent;
    gifBtn.textContent = 'Encoding...';
    try {
      const r = await ensureRendered();
      if (!r) return;
      await exportGif(r);
    } catch (e) {
      console.error(e);
      alert('GIF export failed: ' + e.message);
    } finally {
      gifBtn.disabled = false;
      gifBtn.textContent = prevText;
    }
  }

  function doJsonExport() {
    const blob = new Blob([JSON.stringify(animation, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'kabuku_animation.json';
    a.click();
    URL.revokeObjectURL(url);
  }

  function doJsonImport() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.addEventListener('change', async () => {
      const file = input.files[0];
      if (!file) return;
      try {
        const text = await file.text();
        const data = JSON.parse(text);
        // Merge with defaults to ensure all tracks exist
        const base = createDefaultAnimation();
        const merged = { ...base, ...data, tracks: { ...base.tracks, ...(data.tracks || {}) }, baseValues: { ...base.baseValues, ...(data.baseValues || {}) } };
        animation = merged;
        saveAnimation(animation);
        // Refresh UI
        location.reload();
      } catch (e) {
        alert('Import failed: ' + e.message);
      }
    });
    input.click();
  }

  // Init
  updateSlidersFromTime();
  updateTimeDisplay();
  requestAnimationFrame(() => {
    timeline.render();
    redrawPreview();
  });
}
