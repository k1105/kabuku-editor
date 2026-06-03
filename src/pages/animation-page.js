import { createDefaultAnimation, ANIMATED_PARAM_KEYS, listFontProjects } from '../core/project.js';
import {
  getSnapshotProject, getSnapshotGlobal, getAnimation, saveAnimation,
  currentAnimationProjectName, currentAnimationProjectId, refreshSnapshotFromOrigin,
  getOriginFontProjectId, getOriginFontProjectName,
  setLinkedFontProject,
  flushNow as flushAnimationNow,
} from '../core/animation-project.js';
import { RENDER_SIZE } from '../compose/glyph-cache.js';
import { sampleAnimation, upsertKeyframe, clampTime, nextKeyframeTime, prevKeyframeTime } from '../animation/animation.js';
import { createTimelineUI } from '../animation/timeline-ui.js';
import { renderFrames, computeFrameCacheShape, createFrameRenderer, computeLayout, DEFAULT_CANVAS_WIDTH, DEFAULT_CANVAS_HEIGHT } from '../animation/render.js';
import { exportPngSequence, exportGif } from '../animation/export.js';
import { createPageHeader } from '../ui/page-header.js';
import { iconEl, iconSvg, iconButton } from '../ui/icons.js';
import { commit as historyCommit } from '../core/animation-history.js';
import { renderFontSourceToCanvas } from '../render/font/font-import.js';
import { loadImageCached } from '../core/image-cache.js';
import { createSliderInput } from '../ui/slider-input.js';
import { createLangToggle } from '../ui/i18n.js';

const ANIMATED_SLIDER_DEFS = [
  { key: 'fontSize', label: 'Font Size', min: 16, max: 256, step: 1 },
  // textBoxWidth intentionally omitted: animation text no longer wraps, so the
  // Box Width control has no effect (see computeLayout in render.js).
  { key: 'kerning', label: 'Kerning', min: -40, max: 100, step: 1 },
  { key: 'lineHeight', label: 'Line Height', min: 0.4, max: 6.0, step: 0.1 },
  { key: 'stretchAngle', label: 'Stretch Angle', min: 0, max: 180, step: 1, hardMin: 0, hardMax: 180 },
  { key: 'stretchAmount', label: 'Stretch Amount', min: 0, max: 2, step: 0.05 },
  { key: 'baseGap', label: 'Gap', min: 0, max: 20, step: 0.5 },
  { key: 'gapDirectionWeight', label: 'Gap Dir', min: 0, max: 1, step: 0.05, hardMin: 0, hardMax: 1 },
  { key: 'metaballRadius', label: 'Blur', min: 0, max: 30, step: 1 },
];

const CAMERA_SLIDER_DEFS = [
  { key: 'cameraX', label: 'X', min: -1000, max: 1000, step: 1 },
  { key: 'cameraY', label: 'Y', min: -1000, max: 1000, step: 1 },
  { key: 'cameraDistance', label: 'Distance', min: 0.1, max: 5, step: 0.05 },
];

export function renderAnimationPage(app) {
  const project = getSnapshotProject();
  const global = getSnapshotGlobal() || project.global;
  project.global = global;
  const charIds = new Set(Object.keys(project.characters));
  const sourceImageCache = new Map();

  let animation = getAnimation();
  // Cap the auto-filled text to 5 chars; with large typesets, dumping every
  // glyph here freezes the page during layout/render.
  if (!animation.text) animation.text = Object.keys(project.characters).slice(0, 5).join('');
  // Back-fill canvas size on animations created before it was configurable.
  if (animation.canvasWidth == null) animation.canvasWidth = DEFAULT_CANVAS_WIDTH;
  if (animation.canvasHeight == null) animation.canvasHeight = DEFAULT_CANVAS_HEIGHT;

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
  // Frame cache: { fps, totalFrames, width, height, frames: Array<Canvas|null> }.
  // Populated incrementally by renderFrames(); cleared by markDirty() on any
  // animation edit. redrawPreview() checks per-frame; missing entries fall
  // back to live drawing.
  let frameCache = null;
  // Editor display zoom: a number (1 = 100%) or 'fit' (scale the whole canvas
  // into the view with padding). Affects only on-screen display size, not the
  // canvas resolution or rendered output.
  let displayZoom = 'fit';

  function persist() {
    saveAnimation(animation);
  }
  // Wrap to commit a history snapshot — used at action boundaries
  // (keyframe edits, button clicks, mode changes). Continuous slider/text
  // input is captured by the document-level 'change' listener in main.js.
  function commitHistory(label) { historyCommit(label); }

  function markDirty() {
    // Any animation edit invalidates every cached frame — params/text/layout
    // changes can affect rendering at arbitrary times, so cheaper to drop the
    // whole cache than to track which frames are affected.
    frameCache = null;
    timeline?.updateFrameCacheIndicator?.(null);
  }

  // Preload source images. Image-imported chars use their data-URL imagePath;
  // font-imported chars (fontSource only, no imagePath) get rasterized via
  // Google Fonts so the underlay tracks them too.
  function getSourceImage(charId) {
    if (sourceImageCache.has(charId)) return sourceImageCache.get(charId);
    const cd = project.characters[charId];
    if (cd?.imagePath) {
      sourceImageCache.set(charId, null);
      loadImageCached(cd.imagePath).then(img => {
        if (!img) return;
        sourceImageCache.set(charId, img);
        redrawPreview();
      });
      return null;
    }
    if (cd?.fontSource) {
      sourceImageCache.set(charId, null);
      renderFontSourceToCanvas(cd.fontSource, RENDER_SIZE, global.fontMetrics)
        .then(cv => { sourceImageCache.set(charId, cv); redrawPreview(); })
        .catch(() => {});
      return null;
    }
    return null;
  }
  for (const cid of Object.keys(project.characters)) getSourceImage(cid);

  // === Header ===
  const animName = currentAnimationProjectName() || 'Animation';
  const { el: header, headerNav } = createPageHeader({
    activePage: 'animation',
    fontProjectId: null,
    title: animName,
    historyMode: 'animation',
  });

  // === Settings popup (opened via the gear icon in the nav) ===
  // Holds the less-frequently-touched setup: typeface loading, canvas size,
  // and movie duration/fps. Controls apply live (each persists on change), so
  // there's no confirm/cancel — just open and close.
  const settingsBackdrop = document.createElement('div');
  settingsBackdrop.className = 'settings-modal-backdrop';
  settingsBackdrop.style.display = 'none';
  const settingsModal = document.createElement('div');
  settingsModal.className = 'settings-modal';
  settingsBackdrop.appendChild(settingsModal);
  const settingsHead = document.createElement('div');
  settingsHead.className = 'settings-modal-head';
  const settingsTitle = document.createElement('h2');
  settingsTitle.textContent = 'Settings';
  const settingsCloseBtn = iconButton('close', 'Close', { title: 'Close' });
  settingsCloseBtn.addEventListener('click', () => closeSettings());
  settingsHead.appendChild(settingsTitle);
  settingsHead.appendChild(settingsCloseBtn);
  settingsModal.appendChild(settingsHead);
  const settingsBody = document.createElement('div');
  settingsBody.className = 'settings-modal-body';
  settingsModal.appendChild(settingsBody);

  function makeSettingsGroup(title) {
    const g = document.createElement('div');
    g.className = 'param-group';
    const h = document.createElement('h3');
    h.textContent = title;
    g.appendChild(h);
    settingsBody.appendChild(g);
    return g;
  }
  // Created up-front so child controls land in a fixed visual order regardless
  // of when they're built below.
  const sfTypeface = makeSettingsGroup('Typeface');
  const sfCanvas = makeSettingsGroup('Canvas');
  const sfMovie = makeSettingsGroup('Duration & FPS');
  const sfLanguage = makeSettingsGroup('Language');
  sfLanguage.appendChild(createLangToggle());

  function openSettings() { settingsBackdrop.style.display = 'flex'; }
  function closeSettings() { settingsBackdrop.style.display = 'none'; }
  settingsBackdrop.addEventListener('click', (e) => {
    if (e.target === settingsBackdrop) closeSettings();
  });

  const settingsBtn = iconButton('settings', 'Settings', { title: 'Settings' });
  settingsBtn.addEventListener('click', () => openSettings());
  headerNav.insertBefore(settingsBtn, headerNav.firstChild);

  // Snapshot link selector + Refresh button.
  // The selector lets the user re-link the snapshot to any existing Typeset —
  // important when the original origin has been deleted. Selecting a new
  // entry only updates the link; the snapshot itself is re-pulled only when
  // the Refresh button is clicked explicitly.
  const linkWrap = document.createElement('div');
  linkWrap.className = 'snapshot-link-wrap';

  const linkSelect = document.createElement('select');
  linkSelect.className = 'snapshot-link-select';
  linkSelect.disabled = true;
  const loadingOpt = document.createElement('option');
  loadingOpt.textContent = getOriginFontProjectName() || '(loading...)';
  loadingOpt.value = getOriginFontProjectId() || '';
  linkSelect.appendChild(loadingOpt);

  const refreshBtn = document.createElement('button');
  refreshBtn.className = 'tool-btn snapshot-refresh-btn';
  refreshBtn.title = getOriginFontProjectName()
    ? `Linked to "${getOriginFontProjectName()}" — click to re-pull the latest`
    : 'No Typeset linked';
  const refreshIcon = iconEl('refresh');
  const refreshLabel = document.createElement('span');
  refreshLabel.textContent = 'Refresh Snapshot';
  refreshBtn.appendChild(refreshIcon);
  refreshBtn.appendChild(refreshLabel);
  refreshBtn.addEventListener('click', async () => {
    if (!getOriginFontProjectId()) {
      alert('リンク先の Typeset が設定されていません。プルダウンから選択してください。');
      return;
    }
    if (!confirm('リンク中の Typeset の最新状態でスナップショットを上書きします。よろしいですか?')) return;
    refreshBtn.disabled = true;
    refreshLabel.textContent = 'Refreshing...';
    try {
      await refreshSnapshotFromOrigin(currentAnimationProjectId());
      location.reload();
    } catch (e) {
      console.error(e);
      alert(`Refresh に失敗しました: ${e.message}`);
      refreshBtn.disabled = false;
      refreshLabel.textContent = 'Refresh Snapshot';
    }
  });

  linkWrap.appendChild(linkSelect);
  linkWrap.appendChild(refreshBtn);
  sfTypeface.appendChild(linkWrap);

  (async () => {
    let list;
    try {
      list = await listFontProjects();
    } catch (e) {
      console.error('Failed to load Typeset list:', e);
      return;
    }
    const currentId = getOriginFontProjectId();
    const currentName = getOriginFontProjectName();
    const currentExists = currentId && list.some(p => p.id === currentId);

    linkSelect.innerHTML = '';
    if (!currentId) {
      const noneOpt = document.createElement('option');
      noneOpt.value = '';
      noneOpt.textContent = '(未リンク)';
      linkSelect.appendChild(noneOpt);
    } else if (!currentExists) {
      // Origin Typeset has been deleted — keep a placeholder so the user can
      // see the broken link state and pick a replacement.
      const missingOpt = document.createElement('option');
      missingOpt.value = currentId;
      missingOpt.textContent = `${currentName || '(unknown)'}（削除済み）`;
      linkSelect.appendChild(missingOpt);
    }
    for (const p of list) {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.name || '(Untitled)';
      if (p.id === currentId) opt.selected = true;
      linkSelect.appendChild(opt);
    }
    linkSelect.disabled = false;

    linkSelect.addEventListener('change', async () => {
      const newId = linkSelect.value;
      const prevId = getOriginFontProjectId() || '';
      if (!newId || newId === prevId) return;
      const newName = list.find(p => p.id === newId)?.name || '';
      if (!confirm(`スナップショットのリンク先を "${newName}" に変更します。よろしいですか?\n（内容を取り込むには Refresh Snapshot を実行してください）`)) {
        linkSelect.value = prevId;
        return;
      }
      linkSelect.disabled = true;
      try {
        await setLinkedFontProject(currentAnimationProjectId(), newId, newName);
        refreshBtn.title = `Linked to "${newName}" — click to re-pull the latest`;
      } catch (e) {
        console.error(e);
        alert(`リンク変更に失敗しました: ${e.message}`);
        linkSelect.value = prevId;
      } finally {
        linkSelect.disabled = false;
      }
    });
  })();

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
    persist(); markDirty(); redrawPreview(); commitHistory('writing-mode');
  });
  vBtn.addEventListener('click', () => {
    animation.writingMode = 'vertical';
    vBtn.classList.add('active'); hBtn.classList.remove('active');
    persist(); markDirty(); redrawPreview(); commitHistory('writing-mode');
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

  const sliderInputs = {}; // key -> { api, def }

  function addAnimatedSliders(parent, defs) {
    for (const def of defs) {
      const row = document.createElement('div');
      row.className = 'param-row';
      const label = document.createElement('label');
      label.textContent = def.label;
      const initial = sampleAnimation(animation, currentTime)[def.key];

      const api = createSliderInput({
        min: def.min, max: def.max, step: def.step,
        value: initial,
        hardMin: def.hardMin, hardMax: def.hardMax,
        onInput: (v) => {
          redrawFast(overrideWith(def.key, v));
        },
        onChange: (v) => {
          upsertKeyframe(animation.tracks[def.key], currentTime, v);
          persist();
          markDirty();
          timeline.render();
          redrawPreview();
        },
      });

      row.appendChild(label);
      row.appendChild(api.slider);
      row.appendChild(api.valueInput);
      parent.appendChild(row);

      sliderInputs[def.key] = { api, def };
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

  // Canvas size + movie duration/fps live in the settings popup (see above).
  // Output dimensions are independent of character count.
  addNumberField(sfCanvas, 'Width (px)', animation.canvasWidth, 100, 7680, 1, (v) => {
    animation.canvasWidth = Math.max(1, Math.round(v));
    persist(); markDirty(); applyDisplayZoom(); redrawPreview(); commitHistory('canvas-size');
  });
  addNumberField(sfCanvas, 'Height (px)', animation.canvasHeight, 100, 7680, 1, (v) => {
    animation.canvasHeight = Math.max(1, Math.round(v));
    persist(); markDirty(); applyDisplayZoom(); redrawPreview(); commitHistory('canvas-size');
  });

  // Duration & FPS number fields (rendered into the settings popup).
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

  addNumberField(sfMovie, 'Duration (s)', animation.duration, 0.5, 120, 0.5, (v) => {
    animation.duration = v;
    if (currentTime > v) currentTime = v;
    persist(); markDirty(); timeline.render(); updateSlidersFromTime();
  });
  addNumberField(sfMovie, 'FPS', animation.fps, 1, 60, 1, (v) => {
    animation.fps = Math.round(v);
    persist(); markDirty();
  });

  // Transport buttons (Play / Render) — icon-only, appended to the view toolbar
  // above the timeline (centered). Handlers reference togglePlay/doRender.
  const playBtn = document.createElement('button');
  playBtn.className = 'tool-btn';
  playBtn.title = 'Play / Pause (Space)';
  const playIcon = iconEl('play');
  playBtn.appendChild(playIcon);
  playBtn.addEventListener('click', () => togglePlay());
  function setPlayState(isPlaying) {
    playIcon.innerHTML = iconSvg(isPlaying ? 'pause' : 'play');
  }
  const renderBtn = document.createElement('button');
  renderBtn.className = 'tool-btn';
  renderBtn.title = 'Render';
  renderBtn.appendChild(iconEl('refresh'));
  renderBtn.addEventListener('click', () => doRender());

  // Render progress popup — a centered overlay shown only while rendering.
  const progressBackdrop = document.createElement('div');
  progressBackdrop.className = 'progress-modal-backdrop';
  progressBackdrop.style.display = 'none';
  const progressBox = document.createElement('div');
  progressBox.className = 'progress-modal';
  const progressTitle = document.createElement('div');
  progressTitle.className = 'progress-modal-title';
  progressTitle.textContent = 'Rendering…';
  const progressWrap = document.createElement('div');
  progressWrap.className = 'import-progress';
  const progressTrack = document.createElement('div');
  progressTrack.className = 'import-progress-track';
  const progressBar = document.createElement('div');
  progressBar.className = 'import-progress-bar';
  progressTrack.appendChild(progressBar);
  const progressText = document.createElement('span');
  progressText.className = 'import-progress-text';
  progressWrap.appendChild(progressTrack);
  progressWrap.appendChild(progressText);
  progressBox.appendChild(progressTitle);
  progressBox.appendChild(progressWrap);
  progressBackdrop.appendChild(progressBox);

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
  pngBtn.appendChild(iconEl('download'));
  const pngLabel = document.createElement('span');
  pngLabel.textContent = 'PNG Seq';
  pngBtn.appendChild(pngLabel);
  pngBtn.addEventListener('click', () => doExportPng());
  const gifBtn = document.createElement('button');
  gifBtn.className = 'tool-btn';
  gifBtn.appendChild(iconEl('download'));
  const gifLabel = document.createElement('span');
  gifLabel.textContent = 'GIF';
  gifBtn.appendChild(gifLabel);
  gifBtn.addEventListener('click', () => doExportGif());
  exportRow.appendChild(pngBtn);
  exportRow.appendChild(gifBtn);
  exportGroup.appendChild(exportRow);

  const jsonRow = document.createElement('div');
  jsonRow.className = 'anim-button-row';
  const jsonExport = document.createElement('button');
  jsonExport.className = 'tool-btn';
  jsonExport.appendChild(iconEl('download'));
  const jsonExportLabel = document.createElement('span');
  jsonExportLabel.textContent = 'Export JSON';
  jsonExport.appendChild(jsonExportLabel);
  jsonExport.addEventListener('click', () => doJsonExport());
  const jsonImport = document.createElement('button');
  jsonImport.className = 'tool-btn';
  jsonImport.appendChild(iconEl('upload'));
  const jsonImportLabel = document.createElement('span');
  jsonImportLabel.textContent = 'Import JSON';
  jsonImport.appendChild(jsonImportLabel);
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

  // --- View toolbar (above timeline): zoom (left) + transport (centered) ---
  const viewToolbar = document.createElement('div');
  viewToolbar.className = 'anim-view-toolbar';
  const zoomZone = document.createElement('div');
  zoomZone.className = 'anim-view-zoom';
  const zoomLbl = document.createElement('span');
  zoomLbl.className = 'anim-view-label';
  zoomLbl.textContent = 'Zoom';
  const zoomSelect = document.createElement('select');
  zoomSelect.className = 'anim-zoom-select';
  const ZOOM_OPTIONS = [
    { value: 'fit', label: '全体表示' },
    { value: '25', label: '25%' },
    { value: '50', label: '50%' },
    { value: '75', label: '75%' },
    { value: '100', label: '100%' },
    { value: '125', label: '125%' },
    { value: '150', label: '150%' },
    { value: '175', label: '175%' },
    { value: '200', label: '200%' },
  ];
  for (const o of ZOOM_OPTIONS) {
    const opt = document.createElement('option');
    opt.value = o.value;
    opt.textContent = o.label;
    zoomSelect.appendChild(opt);
  }
  zoomSelect.value = 'fit';
  zoomSelect.addEventListener('change', () => {
    displayZoom = zoomSelect.value === 'fit' ? 'fit' : parseInt(zoomSelect.value, 10) / 100;
    applyDisplayZoom();
  });
  zoomZone.appendChild(zoomLbl);
  zoomZone.appendChild(zoomSelect);

  // Centered transport (Play / Render).
  const transportZone = document.createElement('div');
  transportZone.className = 'anim-view-transport';
  transportZone.appendChild(playBtn);
  transportZone.appendChild(renderBtn);

  viewToolbar.appendChild(zoomZone);
  viewToolbar.appendChild(transportZone);

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
    onChange: () => { persist(); markDirty(); commitHistory('keyframe-edit'); },
    getCurrentTime: () => currentTime,
  });
  timelineWrap.appendChild(timeline.el);

  // Assemble
  const leftCol = document.createElement('div');
  leftCol.className = 'anim-main-col';
  leftCol.appendChild(mainArea);
  leftCol.appendChild(viewToolbar);
  leftCol.appendChild(timelineWrap);

  page.appendChild(sidebar);
  page.appendChild(leftCol);

  app.appendChild(header);
  app.appendChild(page);
  app.appendChild(settingsBackdrop);
  app.appendChild(progressBackdrop);

  // === Rendering ===

  function canvasW() { return Math.max(1, Math.round(animation.canvasWidth || DEFAULT_CANVAS_WIDTH)); }
  function canvasH() { return Math.max(1, Math.round(animation.canvasHeight || DEFAULT_CANVAS_HEIGHT)); }

  /**
   * Size the on-screen canvas element via CSS (its internal resolution is
   * always canvasW×canvasH). 'fit' scales the whole canvas into the view with
   * padding; a numeric zoom maps 1→100%.
   */
  function applyDisplayZoom() {
    const cw = canvasW(), ch = canvasH();
    let scale;
    if (displayZoom === 'fit') {
      const padPx = 24;
      const availW = Math.max(1, mainArea.clientWidth - padPx * 2);
      const availH = Math.max(1, mainArea.clientHeight - padPx * 2);
      scale = Math.min(availW / cw, availH / ch);
      if (!Number.isFinite(scale) || scale <= 0) scale = 1;
    } else {
      scale = displayZoom;
    }
    canvas.style.width = (cw * scale) + 'px';
    canvas.style.height = (ch * scale) + 'px';
  }

  // Re-fit when the view area resizes (only matters in 'fit' mode).
  const viewResizeObserver = new ResizeObserver(() => {
    if (displayZoom === 'fit') applyDisplayZoom();
  });
  viewResizeObserver.observe(mainArea);

  function overrideWith(key, val) {
    const p = sampleAnimation(animation, currentTime);
    p[key] = val;
    return p;
  }

  // Lazily-built single-frame renderer, shared with the Render/export path so
  // scrub-time frames are pixel-identical to exported frames. Layers depend on
  // the (static) font snapshot, not on params, so the renderer is reused across
  // redraws; only a canvas-size change forces a rebuild (work canvas dims).
  let frameRenderer = null;
  function getFrameRenderer() {
    if (!frameRenderer || frameRenderer.width !== canvasW() || frameRenderer.height !== canvasH()) {
      frameRenderer = createFrameRenderer(animation, { project, global, charIds });
    }
    return frameRenderer;
  }

  function layoutFor(params) {
    return computeLayout(params, animation, charIds, global);
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

  /**
   * Seed `frameCache` with shape (width/height/fps/totalFrames) when it's
   * missing — runs the first-pass dimension scan from renderFrames. Lets
   * scrub-time drawFull() write into the cache at the same uniform
   * dimensions as Render-button output.
   */
  function ensureFrameCacheShape() {
    if (frameCache?.frames?.length) return;
    const shape = computeFrameCacheShape(animation);
    frameCache = {
      fps: shape.fps,
      totalFrames: shape.totalFrames,
      width: shape.width,
      height: shape.height,
      frames: new Array(shape.totalFrames).fill(null),
    };
    timeline?.updateFrameCacheIndicator?.(frameCache);
  }

  /** Full pipeline draw (slow). Renders one frame through the SAME renderer as
   *  the Render button / export (createFrameRenderer), stores it in the cache
   *  at the current frame index, then blits to the on-screen canvas. Because it
   *  shares the render path, scrub-time frames and exported frames are
   *  pixel-identical — no separate approximation. */
  function drawFull(params) {
    ensureFrameCacheShape();
    const cacheW = frameCache.width;
    const cacheH = frameCache.height;
    const off = document.createElement('canvas');
    off.width = cacheW;
    off.height = cacheH;
    const octx = off.getContext('2d');
    getFrameRenderer().renderInto(octx, params, layoutFor(params));

    // Cache at the current time slot (only when empty — Render-button frames
    // win over scrub-time captures, though both paths now produce identical
    // pixels).
    const idx = Math.min(frameCache.frames.length - 1,
      Math.max(0, Math.round(currentTime * frameCache.fps)));
    if (!frameCache.frames[idx]) {
      frameCache.frames[idx] = off;
      timeline.updateFrameCacheIndicator(frameCache);
    }

    canvas.style.transform = '';
    canvas.width = cacheW;
    canvas.height = cacheH;
    ctx.drawImage(off, 0, 0);
  }

  /** Fast preview using source images. Draws into the same uniform cache
   *  canvas dimensions as drawFull / cached frames so the page canvas size
   *  doesn't change between playback / scrub / Render paths. */
  function redrawFast(params) {
    const p = params || sampleAnimation(animation, currentTime);
    ensureFrameCacheShape();
    const cacheW = frameCache.width;
    const cacheH = frameCache.height;
    const layout = layoutFor(p);
    prepareCanvas(cacheW, cacheH);
    const dx = Math.floor((cacheW - layout.cw) / 2);
    const dy = Math.floor((cacheH - layout.ch) / 2);
    const rad = (p.stretchAngle * Math.PI) / 180;
    const s = 1 + p.stretchAmount;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const a = cos * cos * s + sin * sin;
    const b = cos * sin * (s - 1);
    const d = sin * sin * s + cos * cos;
    // Image stretch pivots on glyph center, not on baseline — font metrics
    // are reference guides only and editing them must not shift the underlay.
    ctx.save();
    applyCameraTransform(ctx, cacheW, cacheH, p);
    for (const pos of layout.positions) {
      const gx = dx + layout.pad + pos.x;
      const gy = dy + layout.pad + pos.y;
      const cx = gx + p.fontSize / 2;
      const cy = gy + p.fontSize / 2;
      if (pos.missing) { drawMissingAt(gx, gy, p.fontSize); continue; }
      const srcImg = sourceImageCache.get(pos.charId);
      if (!srcImg) continue;
      const cd = project.characters[pos.charId] || {};
      const imgScale = cd.imageScale ?? 1;
      const imgOffPx = p.fontSize / RENDER_SIZE;
      const imgDx = (cd.imageOffsetX ?? 0) * imgOffPx;
      const imgDy = (cd.imageOffsetY ?? 0) * imgOffPx;
      const drawSize = p.fontSize * imgScale;
      const ix = gx + (p.fontSize - drawSize) / 2 + imgDx;
      const iy = gy + (p.fontSize - drawSize) / 2 + imgDy;
      ctx.save();
      ctx.globalCompositeOperation = 'multiply';
      ctx.transform(a, b, b, d, cx - (a * cx + b * cy), cy - (b * cx + d * cy));
      ctx.drawImage(srcImg, ix, iy, drawSize, drawSize);
      ctx.restore();
    }
    ctx.restore();
  }

  function getCachedFrameAt(time) {
    if (!frameCache?.frames?.length) return null;
    const idx = Math.min(frameCache.frames.length - 1,
      Math.max(0, Math.round(time * frameCache.fps)));
    return frameCache.frames[idx] || null;
  }

  function drawCachedFrame(frame) {
    canvas.width = frame.width;
    canvas.height = frame.height;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, frame.width, frame.height);
    ctx.drawImage(frame, 0, 0);
  }

  function redrawPreview() {
    // Always prefer cache when a frame is present at the current time.
    // Edits drop the whole cache (markDirty), so a hit here is guaranteed
    // to match the current animation state.
    const cached = getCachedFrameAt(currentTime);
    if (cached) {
      drawCachedFrame(cached);
      return;
    }
    const params = sampleAnimation(animation, currentTime);
    // Playback and scrubbing both render each frame through the full per-cell
    // pipeline (drawFull) — identical to the exported output, no base-image
    // stretch approximation. Frames are cached as they're produced, so a second
    // pass plays back from cache. (redrawFast survives only for live slider
    // dragging, where transient responsiveness matters more than fidelity.)
    drawFull(params);
  }

  function updateSlidersFromTime() {
    const p = sampleAnimation(animation, currentTime);
    for (const key of ANIMATED_PARAM_KEYS) {
      const ref = sliderInputs[key];
      if (!ref) continue;
      ref.api.setValue(p[key]);
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
    setPlayState(true);
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
    setPlayState(false);
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    // On pause, fall through to redrawPreview — it picks up the cache when
    // available, or live-renders the frame otherwise.
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

    if (e.code === 'Escape' && settingsBackdrop.style.display !== 'none') {
      closeSettings();
      return;
    }
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
    viewResizeObserver.disconnect();
    window.removeEventListener('hashchange', detach);
  });

  // === Render ===
  function isFrameCacheComplete() {
    if (!frameCache?.frames?.length) return false;
    const expected = Math.max(1, Math.round(animation.duration * animation.fps));
    if (frameCache.fps !== animation.fps) return false;
    if (frameCache.frames.length !== expected) return false;
    return frameCache.frames.every(f => !!f);
  }

  async function doRender() {
    renderBtn.disabled = true;
    progressBackdrop.style.display = 'flex';
    progressBar.style.width = '0%';
    progressText.textContent = '0%';
    // Seed cache so renderFrames can write into it directly. Mismatched
    // fps/duration is handled inside renderFrames (it resets the shape).
    if (!frameCache) frameCache = { fps: animation.fps, totalFrames: 0, width: 0, height: 0, frames: [] };
    timeline.updateFrameCacheIndicator(frameCache);
    try {
      await renderFrames(animation, {
        project, global, charIds,
        cache: frameCache,
        onCacheUpdate: () => { timeline.updateFrameCacheIndicator(frameCache); },
        onProgress: (done, total) => {
          const pct = Math.round((done / total) * 100);
          progressBar.style.width = pct + '%';
          progressText.textContent = `${done} / ${total}`;
        },
      });
      redrawPreview();
    } catch (e) {
      console.error('Render failed:', e);
      alert('Render failed: ' + e.message);
    } finally {
      progressBackdrop.style.display = 'none';
      renderBtn.disabled = false;
    }
  }

  // === Export ===
  async function ensureRendered() {
    if (!isFrameCacheComplete()) {
      await doRender();
    }
    if (!isFrameCacheComplete()) return null;
    return {
      frames: frameCache.frames,
      fps: frameCache.fps,
      width: frameCache.width,
      height: frameCache.height,
    };
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
    const prevText = gifLabel.textContent;
    gifLabel.textContent = 'Encoding...';
    try {
      const r = await ensureRendered();
      if (!r) return;
      await exportGif(r);
    } catch (e) {
      console.error(e);
      alert('GIF export failed: ' + e.message);
    } finally {
      gifBtn.disabled = false;
      gifLabel.textContent = prevText;
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
        // Make sure the imported state is persisted before we reload, otherwise
        // the debounced write would be cancelled by the navigation.
        await flushAnimationNow();
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
    applyDisplayZoom();
  });

  /**
   * Re-bind UI to the in-memory animation after an undo/redo. The animation
   * object itself is mutated in place (see restoreAnimationSnapshot in
   * animation-project.js), so timeline-ui's captured reference is still
   * current — we just refresh the visible controls and invalidate caches.
   */
  function refresh() {
    if (!animation) return;
    textarea.value = animation.text ?? '';
    hBtn.classList.toggle('active', animation.writingMode === 'horizontal');
    vBtn.classList.toggle('active', animation.writingMode === 'vertical');
    if (animation.duration != null && currentTime > animation.duration) {
      currentTime = animation.duration;
    }
    updateSlidersFromTime();
    updateTimeDisplay();
    markDirty();
    timeline.render();
    redrawPreview();
    applyDisplayZoom();
  }

  return { refresh };
}
