import { createDefaultAnimation } from '../core/project.js';
import {
  getSnapshotProject, getSnapshotGlobal, getAnimation, saveAnimation,
  currentAnimationProjectName,
  flushNow as flushAnimationNow,
  subscribeAnimationProject, hasUnsavedChanges as animHasUnsavedChanges,
} from '../core/animation-project.js';
import { RENDER_SIZE } from '../compose/glyph-cache.js';
import { sampleAnimation, upsertKeyframe, clampTime, nextKeyframeTime, prevKeyframeTime, sampleText, upsertTextKeyframe, activeTextKeyframe } from '../animation/animation.js';
import { attachCharKerningKeys, remapCharKerning, kernHintText, createKernHint, attachKernCaretTracking } from '../compose/char-kerning.js';
import { createTimelineUI } from '../animation/timeline-ui.js';
import { renderFrames, DEFAULT_CANVAS_WIDTH, DEFAULT_CANVAS_HEIGHT } from '../animation/render.js';
import { exportPngSequence, exportGif } from '../animation/export.js';
import { createPageHeader } from '../ui/page-header.js';
import { iconEl, iconSvg, iconButton } from '../ui/icons.js';
import { createSettingsModal, settingsToolBtn } from '../ui/settings-modal.js';
import { commit as historyCommit } from '../core/animation-history.js';
import { createSourceImageLoader } from '../compose/source-image.js';
import { createAudioPlayer } from '../animation/audio-track.js';
import { createParamRow } from '../ui/param-row.js';
import { createLangToggle } from '../ui/i18n.js';
import { getGrid } from '../grids/grid-plugin.js';
import { createIconRail } from '../ui/icon-rail.js';
import { downloadBlob, pickAndApplyJson } from '../utils/file-io.js';
import { createPreviewRenderer } from './animation/preview.js';
import { createPlayback } from './animation/playback.js';
import { createAudioPanel } from './animation/audio-panel.js';
import { addNumberField } from './animation/form-utils.js';
import { addColorField } from '../ui/color-field.js';
import { createTypefaceLinkControl } from './animation/typeface-link.js';

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
  { key: 'cameraRotation', label: 'Rotation', min: -180, max: 180, step: 1 },
];

/**
 * Build animatable grid-param sliders grouped by default layer. Returns one
 * group per layer: `{ title, defs }`, where each def's `label` is the plain
 * param name (the layer name lives in the group heading, so rows stay short).
 * `timelineLabel` disambiguates with the layer name only when there are
 * multiple layers (the timeline is a flat list with no grouping).
 *
 * Track keys are namespaced `grid.<layerIndex>.<paramKey>` and the slider's
 * baseline value comes from the snapshot's global.defaultLayers, so an
 * unkeyframed grid param rests at the typeset's configured value.
 */
function buildGridLayerGroups(global) {
  const groups = [];
  const layers = global.defaultLayers || [];
  const multi = layers.length > 1;
  layers.forEach((gl, i) => {
    const grid = getGrid(gl.gridName);
    if (!grid) return;
    const title = gl.name || gl.gridName;
    const defs = grid.getParamDefs().map((pd) => ({
      key: `grid.${i}.${pd.key}`,
      label: pd.label,
      timelineLabel: multi ? `${title}: ${pd.label}` : pd.label,
      min: pd.min, max: pd.max, step: pd.step,
      base: gl.gridParams?.[pd.key] ?? pd.default,
    }));
    if (defs.length > 0) groups.push({ title, defs });
  });
  return groups;
}

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
  // Back-fill the step-keyframed text track for animations created before it
  // existed.
  if (!Array.isArray(animation.textTrack)) animation.textTrack = [];
  // Back-fill per-character kerning (em units) on older animations.
  if (!Array.isArray(animation.charKerning)) animation.charKerning = [];
  // Guide audio (lyric-video editing) — null until a file is imported.
  if (animation.audio === undefined) animation.audio = null;
  // Back-fill the BPM beat guide (music-synced editing) on older animations.
  if (animation.bpm === undefined) animation.bpm = null;
  if (animation.beatOffset == null) animation.beatOffset = 0;
  if (animation.beatsPerBar == null) animation.beatsPerBar = 4;
  if (animation.beatSnap == null) animation.beatSnap = true;
  if (animation.beatSnapDiv == null) animation.beatSnapDiv = 1;
  // Back-fill frame colors on animations created before they were configurable.
  if (!animation.bgColor) animation.bgColor = '#ffffff';
  if (!animation.textColor) animation.textColor = '#000000';

  // Grid param sliders, grouped by default layer (one sub-section per layer).
  // The flattened def list is used for baseValues seeding + timeline labels.
  const gridLayerGroups = buildGridLayerGroups(global);
  const gridSliderDefs = gridLayerGroups.flatMap(g => g.defs);
  if (!animation.baseValues) animation.baseValues = {};
  for (const def of gridSliderDefs) {
    if (animation.baseValues[def.key] == null) animation.baseValues[def.key] = def.base;
  }

  // Only params that hold keyframe info get a timeline row. Collapse any track
  // that is just a constant (a single keyframe at t≈0 — the legacy auto-seed)
  // back into baseValues and drop it, so existing projects don't show a row for
  // every param. Tracks with real animation (≥2 keyframes, or a single keyframe
  // at t>0) are kept untouched.
  let tracksChanged = false;
  for (const key of Object.keys(animation.tracks || {})) {
    const tr = animation.tracks[key];
    if (!tr || tr.length === 0) { delete animation.tracks[key]; tracksChanged = true; continue; }
    if (tr.length === 1 && Math.abs(tr[0].time) < 1e-4) {
      animation.baseValues[key] = tr[0].value;
      delete animation.tracks[key];
      tracksChanged = true;
    }
  }
  if (tracksChanged) saveAnimation(animation);

  // State
  let currentTime = 0;
  let playing = false;
  // Frame cache: { fps, totalFrames, width, height, frames: Array<Canvas|null> }.
  // Populated incrementally by renderFrames(); cleared by markDirty() on any
  // animation edit. redrawPreview() checks per-frame; missing entries fall
  // back to live drawing.
  let frameCache = null;
  // Editor display zoom: a number (1 = 100%) or 'fit' (scale the whole canvas
  // into the view with padding). Affects only on-screen display size, not the
  // canvas resolution or rendered output.
  let displayZoom = 'fit';

  // Accessor view over this page's closure state, shared by the extracted
  // modules (preview / playback / audio panel). The page stays the single
  // source of truth; `animation` is reassigned on JSON import, so modules must
  // always read it through this getter.
  const pageState = {
    get animation() { return animation; },
    get currentTime() { return currentTime; },
    set currentTime(v) { currentTime = v; },
    get playing() { return playing; },
    set playing(v) { playing = v; },
    get frameCache() { return frameCache; },
    set frameCache(v) { frameCache = v; },
    get displayZoom() { return displayZoom; },
  };

  // Guide-audio player (HTMLAudioElement wrapper). The animation wall-clock is
  // the master timeline; this is kept in sync by the playback loop. Disposed on
  // page detach.
  const audioPlayer = createAudioPlayer();
  // Standalone "listen" engine for auditioning the song independently of the
  // timeline — driven by the custom transport built in the AUDIO panel below.
  // It shares no state with audioPlayer or the playhead. A detached <audio>
  // element plays fine without being in the DOM.
  const listenAudio = new Audio();
  listenAudio.preload = 'metadata';

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

  // Preload source images so the underlay tracks both image- and font-imported
  // chars (see createSourceImageLoader).
  const getSourceImage = createSourceImageLoader({
    cache: sourceImageCache, project, global,
    renderSize: RENDER_SIZE,
    onLoad: () => redrawPreview(),
  });
  for (const cid of Object.keys(project.characters)) getSourceImage(cid);

  // === Header ===
  const animName = currentAnimationProjectName() || 'Animation';
  const { el: header, headerNav } = createPageHeader({
    activePage: 'animation',
    fontProjectId: null,
    title: animName,
    historyMode: 'animation',
    save: {
      flush: () => flushAnimationNow(),
      subscribe: subscribeAnimationProject,
      isDirty: animHasUnsavedChanges,
    },
  });

  // === Settings popup (opened via the gear icon in the nav) ===
  // Holds the less-frequently-touched setup: typeface loading, canvas size,
  // and movie duration/fps. Controls apply live (each persists on change), so
  // there's no confirm/cancel — just open and close.
  const settings = createSettingsModal({ title: 'Settings' });
  const settingsBackdrop = settings.el;
  const openSettings = settings.open;
  const makeSettingsGroup = settings.addGroup;

  // Created up-front so child controls land in a fixed visual order regardless
  // of when they're built below.
  const sfTypeface = makeSettingsGroup('Typeface');
  const sfCanvas = makeSettingsGroup('Canvas');
  const sfColors = makeSettingsGroup('Colors');
  const sfMovie = makeSettingsGroup('Duration & FPS');
  const sfProject = makeSettingsGroup('Project Data');
  const sfLanguage = makeSettingsGroup('Language');
  sfLanguage.appendChild(createLangToggle());

  // JSON export / import of the whole animation — moved here from the sidebar so
  // the Export panel stays focused on rendered output (PNG / GIF).
  const jsonRow = document.createElement('div');
  jsonRow.className = 'anim-button-row';
  jsonRow.appendChild(settingsToolBtn('download', 'Export JSON', () => doJsonExport()));
  jsonRow.appendChild(settingsToolBtn('upload', 'Import JSON', () => doJsonImport()));
  sfProject.appendChild(jsonRow);

  const settingsBtn = iconButton('settings', 'Settings', { title: 'Settings' });
  settingsBtn.addEventListener('click', () => openSettings());
  headerNav.insertBefore(settingsBtn, headerNav.firstChild);

  sfTypeface.appendChild(createTypefaceLinkControl());

  // === Page ===
  const page = document.createElement('div');
  page.className = 'edit-page anim-page';

  // --- Left icon rail ---
  // A vertical strip of icon buttons left of the sidebar (mirrors the Glyphs
  // editor). Each button swaps the sidebar to a dedicated panel: Text, Camera,
  // Layer, Export. Icons come from Iconify (Lucide set) via <iconify-icon>.
  const rail = createIconRail([
    { id: 'text',   icon: 'lucide:type',  title: 'Text' },
    { id: 'camera', icon: 'lucide:video', title: 'Camera' },
    { id: 'audio',  icon: 'lucide:music', title: 'Audio' },
  ], (id) => setPanel(id));
  const iconRail = rail.el;
  let activePanel = 'text';

  // --- Sidebar ---
  const sidebar = document.createElement('div');
  sidebar.className = 'sidebar';
  const sidebarBody = document.createElement('div');
  sidebarBody.className = 'sidebar-body';
  sidebar.appendChild(sidebarBody);

  // One container per rail panel; setPanel() shows the active one and hides the
  // rest. Groups are built once (so slider/timeline wiring stays intact) and
  // parented into these containers — toggling visibility, not rebuilding.
  const panelText = document.createElement('div');
  const panelCamera = document.createElement('div');
  const panelAudio = document.createElement('div');
  const PANEL_ELS = { text: panelText, camera: panelCamera, audio: panelAudio };
  for (const el of Object.values(PANEL_ELS)) sidebarBody.appendChild(el);

  function setPanel(id) {
    activePanel = id;
    for (const [k, el] of Object.entries(PANEL_ELS)) el.style.display = k === id ? '' : 'none';
    rail.setActive(id);
  }

  // Collapsible param group. The heading doubles as a toggle button: clicking it
  // hides/shows the body (a chevron rotates to indicate state). Content goes into
  // the returned `body`, not the group, so slider/timeline wiring is unaffected.
  function createCollapsibleGroup(titleText) {
    const group = document.createElement('div');
    group.className = 'param-group collapsible';
    const header = document.createElement('button');
    header.type = 'button';
    header.className = 'group-header';
    const chevron = document.createElement('iconify-icon');
    chevron.className = 'group-chevron';
    chevron.setAttribute('icon', 'lucide:chevron-down');
    const label = document.createElement('span');
    label.textContent = titleText;
    header.appendChild(chevron);
    header.appendChild(label);
    const body = document.createElement('div');
    body.className = 'group-body';
    header.addEventListener('click', () => group.classList.toggle('collapsed'));
    group.appendChild(header);
    group.appendChild(body);
    return { group, body };
  }

  // Text group. Text is a step-keyframed parameter: the textarea edits whatever
  // source governs the current time (the base `animation.text` before the first
  // keyframe, otherwise the active text keyframe's value), and the diamond
  // button stamps the current content as a keyframe at the playhead.
  const { group: textGroup, body: textBody } = createCollapsibleGroup('Text');

  // Header row: a keyframe (diamond) button sits beside the "Text" affordance.
  const textKfRow = document.createElement('div');
  textKfRow.className = 'anim-text-kf-row';
  const textKfBtn = document.createElement('button');
  textKfBtn.type = 'button';
  textKfBtn.className = 'anim-text-kf-btn';
  textKfBtn.title = 'Add / update a text keyframe at the current time';
  const textKfIcon = document.createElement('iconify-icon');
  textKfIcon.setAttribute('icon', 'lucide:diamond');
  textKfBtn.appendChild(textKfIcon);
  const textKfLbl = document.createElement('span');
  textKfLbl.textContent = 'Keyframe';
  textKfBtn.appendChild(textKfLbl);
  textKfRow.appendChild(textKfBtn);
  textBody.appendChild(textKfRow);

  const textarea = document.createElement('textarea');
  textarea.className = 'compose-textarea';
  textarea.value = sampleText(animation, currentTime);

  // Reflect the diamond's "is there a keyframe exactly here" state.
  function refreshTextKfBtn() {
    const onKf = (animation.textTrack || []).some(
      kf => Math.abs(kf.time - currentTime) < 1e-4);
    textKfBtn.classList.toggle('active', onKf);
  }
  // Mirror the time-sampled text into the textarea (called on seek / playback).
  // Skip while the user is typing in it so we don't fight the caret.
  function syncTextArea() {
    if (document.activeElement === textarea) return;
    textarea.value = sampleText(animation, currentTime);
    refreshTextKfBtn();
  }

  textarea.addEventListener('input', () => {
    // Edit the source that governs the current time: the active keyframe when
    // the playhead sits in its hold region, else the base text.
    const active = activeTextKeyframe(animation, currentTime);
    const oldText = active ? active.value : (animation.text || '');
    // Keep per-character kerning glued to its characters across the edit.
    const remapped = remapCharKerning(oldText, textarea.value,
      active ? active.charKerning : animation.charKerning);
    if (active) { active.value = textarea.value; active.charKerning = remapped; }
    else { animation.text = textarea.value; animation.charKerning = remapped; }
    persist();
    markDirty();
    // Keep the timeline's keyframe label in sync while editing a keyframe's text
    // (the base-text edit has no timeline row to refresh).
    if (active) timeline.render();
    redrawPreview();
  });

  textKfBtn.addEventListener('click', () => {
    // A freshly stamped keyframe inherits the governing source's per-character
    // kerning so the look doesn't jump at the keyframe boundary.
    const prevKern = getGoverningKerning();
    const kf = upsertTextKeyframe(animation.textTrack, currentTime, textarea.value);
    if (!Array.isArray(kf.charKerning)) kf.charKerning = [...prevKern];
    persist();
    markDirty();
    timeline.render();
    refreshTextKfBtn();
    redrawPreview();
    commitHistory('text-keyframe');
  });

  textBody.appendChild(textarea);

  // Per-character kerning (em units, additive to the 字間 slider): Option+←→
  // at the caret nudges the gap between the surrounding characters; a selection
  // nudges every gap inside it. Stored on the governing text source (base text
  // or active text keyframe) so it follows text keyframes, and in em so it
  // scales with Font Size.
  function getGoverningKerning() {
    const active = activeTextKeyframe(animation, currentTime);
    const kern = active ? active.charKerning : animation.charKerning;
    return Array.isArray(kern) ? kern : [];
  }
  function setGoverningKerning(next) {
    const active = activeTextKeyframe(animation, currentTime);
    if (active) active.charKerning = next;
    else animation.charKerning = next;
  }
  // Rapid keypresses collapse into one history entry.
  let kernHistoryTimer = null;
  let kernHint = null; // created after mainArea exists
  attachCharKerningKeys(textarea, {
    getKerning: () => getGoverningKerning(),
    setKerning: (next) => setGoverningKerning(next),
    onAdjust: (indices, next) => {
      persist();
      markDirty();
      redrawPreview();
      kernHint?.show(kernHintText(textarea.value, indices, next));
      clearTimeout(kernHistoryTimer);
      kernHistoryTimer = setTimeout(() => commitHistory('char-kerning'), 600);
    },
  });
  // Canvas caret marking the gap ⌥+←→ adjusts, following the textarea caret
  // while it's focused. The preview reads the live selection at draw time
  // (deps.getKernCaretSelection); tracking only nudges it to redraw when the
  // caret actually moved.
  const detachKernCaret = attachKernCaretTracking(textarea, () => preview?.refreshKernCaret());

  const kernHelp = document.createElement('p');
  kernHelp.className = 'kern-help';
  kernHelp.textContent = '⌥+←→: カーソル位置の字間を調整（Shiftで大きく）';
  textBody.appendChild(kernHelp);

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
  textBody.appendChild(modeRow);
  panelText.appendChild(textGroup);

  // Animated param sliders
  const { group: paramsGroup, body: paramsBody } = createCollapsibleGroup('Animated Parameters');

  const sliderInputs = {}; // key -> { api, def }
  const kfToggles = {}; // key -> stopwatch <button>

  // AE-style stopwatch state: a param is "keyframed" iff its track holds
  // keyframes. While off, slider edits only move the constant baseValue.
  function isKeyframed(key) {
    return (animation.tracks[key] || []).length > 0;
  }

  /** Sync every stopwatch button with its track's keyframed state. */
  function refreshKfToggles() {
    for (const [key, btn] of Object.entries(kfToggles)) {
      const on = isKeyframed(key);
      btn.classList.toggle('active', on);
      btn.title = on
        ? 'キーフレームを無効にする（全キーフレームを削除）'
        : 'キーフレームを有効にする（現在時刻にキーフレームを追加）';
    }
  }

  function addAnimatedSliders(parent, defs) {
    for (const def of defs) {
      const initial = sampleAnimation(animation, currentTime)[def.key];

      // Stopwatch toggle (AE-style) — sits left of the label via the badge slot.
      const kfBtn = document.createElement('button');
      kfBtn.type = 'button';
      kfBtn.className = 'anim-kf-toggle';
      const kfIcon = document.createElement('iconify-icon');
      kfIcon.setAttribute('icon', 'lucide:timer');
      kfBtn.appendChild(kfIcon);

      const { row, api } = createParamRow(def.label, {
        min: def.min, max: def.max, step: def.step,
        value: initial,
        hardMin: def.hardMin, hardMax: def.hardMax,
        onInput: (v) => {
          redrawFast(overrideWith(def.key, v));
        },
        onChange: (v) => {
          if (isKeyframed(def.key)) {
            upsertKeyframe(animation.tracks[def.key], currentTime, v);
          } else {
            // Stopwatch off: the edit re-bases the constant value, no keyframe.
            animation.baseValues[def.key] = v;
          }
          persist();
          markDirty();
          timeline.render();
          redrawPreview();
        },
      }, { badge: kfBtn });
      parent.appendChild(row);

      kfBtn.addEventListener('click', () => {
        if (isKeyframed(def.key)) {
          const track = animation.tracks[def.key];
          if (track.length > 1 && !window.confirm(
            `${def.label} のキーフレーム（${track.length}個）をすべて削除しますか？`)) {
            return;
          }
          // Freeze the value visible right now as the new constant.
          animation.baseValues[def.key] = api.getValue();
          delete animation.tracks[def.key];
        } else {
          if (!animation.tracks[def.key]) animation.tracks[def.key] = [];
          upsertKeyframe(animation.tracks[def.key], currentTime, api.getValue());
        }
        persist();
        markDirty();
        timeline.render();
        refreshKfToggles();
        redrawPreview();
        commitHistory('keyframe-toggle');
      });

      sliderInputs[def.key] = { api, def };
      kfToggles[def.key] = kfBtn;
    }
  }

  addAnimatedSliders(paramsBody, ANIMATED_SLIDER_DEFS);
  panelText.appendChild(paramsGroup);

  // CAMERA group
  const cameraGroup = document.createElement('div');
  cameraGroup.className = 'param-group';
  const cameraTitle = document.createElement('h3');
  cameraTitle.textContent = 'CAMERA';
  cameraGroup.appendChild(cameraTitle);
  addAnimatedSliders(cameraGroup, CAMERA_SLIDER_DEFS);
  panelCamera.appendChild(cameraGroup);

  const audioPanel = createAudioPanel({
    state: pageState,
    audioPlayer,
    listenAudio,
    deps: {
      persist: () => persist(),
      markDirty: () => markDirty(),
      commitHistory: (label) => commitHistory(label),
      renderTimeline: () => timeline.render(),
      pausePlayback: () => pausePlayback(),
      syncAudioToTime: (force) => syncAudioToTime(force),
    },
  });
  panelAudio.appendChild(audioPanel.el);
  function refreshAudioPanel() { audioPanel.refresh(); }

  // GLYPH / GRID group — animatable grid params (size/scale/etc.) per layer.
  // Animating any of these switches that glyph to per-frame cell regeneration
  // + auto-mesh in the render pipeline (see render.js).
  if (gridLayerGroups.length > 0) {
    const { group: gridGroup, body: gridBody } = createCollapsibleGroup('Glyph / Grid');
    // One sub-section per layer: the layer name is the heading, params sit
    // under it with plain labels so rows stay readable.
    for (const lg of gridLayerGroups) {
      const sub = document.createElement('h4');
      sub.className = 'param-subhead';
      sub.textContent = lg.title;
      gridBody.appendChild(sub);
      addAnimatedSliders(gridBody, lg.defs);
    }
    panelText.appendChild(gridGroup);
  } else {
    // No animatable grid params (typeset has no grid layers) — leave a hint so
    // the Glyph / Grid section isn't blank.
    const { group: emptyGroup, body: emptyBody } = createCollapsibleGroup('Glyph / Grid');
    const p = document.createElement('p');
    p.style.color = 'var(--text-dim)';
    p.style.fontSize = '12px';
    p.textContent = 'No grid layers available.';
    emptyBody.appendChild(p);
    panelText.appendChild(emptyGroup);
  }

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

  // Frame colors (background / glyph fill). Applied inside render.js's
  // renderInto, so preview and PNG/GIF export pick them up together.
  // Live-preview on every picker input; commit history when the picker closes.
  const bgColorInput = addColorField(sfColors, 'Background', animation.bgColor,
    (v) => { animation.bgColor = v; persist(); markDirty(); redrawPreview(); },
    () => { commitHistory('bg-color'); });
  const textColorInput = addColorField(sfColors, 'Text', animation.textColor,
    (v) => { animation.textColor = v; persist(); markDirty(); redrawPreview(); },
    () => { commitHistory('text-color'); });

  const durationInput = addNumberField(sfMovie, 'Duration (s)', animation.duration, 0.5, 120, 0.5, (v) => {
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

  // Download button — opens the export popup (PNG / GIF). Sits to the right of
  // Play in the transport zone (Render sits to the left).
  const downloadBtn = document.createElement('button');
  downloadBtn.className = 'tool-btn';
  downloadBtn.title = 'Export';
  downloadBtn.appendChild(iconEl('download'));
  downloadBtn.addEventListener('click', () => openExport());

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

  // === Export popup (opened via the download button in the transport zone) ===
  // Reuses the settings-modal styling. Holds the rendered-output options
  // (PNG sequence / GIF); applies on click, no confirm/cancel.
  const exportBackdrop = document.createElement('div');
  exportBackdrop.className = 'settings-modal-backdrop';
  exportBackdrop.style.display = 'none';
  const exportModal = document.createElement('div');
  exportModal.className = 'settings-modal';
  exportBackdrop.appendChild(exportModal);
  const exportHead = document.createElement('div');
  exportHead.className = 'settings-modal-head';
  const exportModalTitle = document.createElement('h2');
  exportModalTitle.textContent = 'Export';
  const exportCloseBtn = iconButton('close', 'Close', { title: 'Close' });
  exportCloseBtn.addEventListener('click', () => closeExport());
  exportHead.appendChild(exportModalTitle);
  exportHead.appendChild(exportCloseBtn);
  exportModal.appendChild(exportHead);
  const exportBody = document.createElement('div');
  exportBody.className = 'settings-modal-body';
  exportModal.appendChild(exportBody);

  const exportGroup = document.createElement('div');
  exportGroup.className = 'param-group';
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
  exportBody.appendChild(exportGroup);

  function openExport() { exportBackdrop.style.display = 'flex'; }
  function closeExport() { exportBackdrop.style.display = 'none'; }
  exportBackdrop.addEventListener('click', (e) => {
    if (e.target === exportBackdrop) closeExport();
  });

  // Show the default (Text) panel.
  setPanel('text');

  // --- Main area ---
  const mainArea = document.createElement('div');
  mainArea.className = 'compose-canvas-area anim-canvas-area';
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  mainArea.appendChild(canvas);
  kernHint = createKernHint(mainArea);

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

  // Centered transport: Render (left) / Play (center) / Download (right).
  const transportZone = document.createElement('div');
  transportZone.className = 'anim-view-transport';
  transportZone.appendChild(renderBtn);
  transportZone.appendChild(playBtn);
  transportZone.appendChild(downloadBtn);

  viewToolbar.appendChild(zoomZone);
  viewToolbar.appendChild(transportZone);

  // --- Bottom timeline ---
  const timelineWrap = document.createElement('div');
  timelineWrap.className = 'anim-timeline-wrap';

  const timeDisplay = document.createElement('div');
  timeDisplay.className = 'anim-time-display';
  timelineWrap.appendChild(timeDisplay);

  // Friendly track labels for the timeline rows (e.g. 'grid.0.scale' -> 'Scale').
  // The timeline is flat, so grid rows use `timelineLabel` (layer-qualified when
  // there are multiple layers) to stay unambiguous.
  const trackLabelMap = {};
  for (const d of [...ANIMATED_SLIDER_DEFS, ...CAMERA_SLIDER_DEFS]) {
    trackLabelMap[d.key] = d.label;
  }
  for (const d of gridSliderDefs) {
    trackLabelMap[d.key] = d.timelineLabel || d.label;
  }

  const timeline = createTimelineUI(animation, {
    onSeek: (t) => {
      currentTime = clampTime(t, animation.duration);
      updateSlidersFromTime();
      timeline.renderPlayhead();
      updateTimeDisplay();
      redrawPreview();
      if (playing) syncAudioToTime(true);
    },
    // refreshKfToggles: deleting a track's last keyframe in the timeline flips
    // that param's stopwatch back off.
    onChange: () => { persist(); markDirty(); syncTextArea(); refreshKfToggles(); commitHistory('keyframe-edit'); },
    // Beat-guide settings (BPM / offset / snap) changed in the timeline
    // header. Display + snapping only — rendered frames are unaffected, so
    // persist without markDirty (keeping the frame cache alive).
    onGuideChange: () => { persist(); updateTimeDisplay(); },
    getCurrentTime: () => currentTime,
    labelFor: (key) => trackLabelMap[key] || key,
    // Dragging the waveform clip re-times the audio offset; persist + reflect
    // it in the Audio panel field, and re-sync the player if playing.
    onAudioOffsetChange: () => {
      persist();
      refreshAudioPanel();
      if (playing) syncAudioToTime(true);
      commitHistory('audio-offset');
    },
    // The timeline resized the composition (end-handle drag, fit-to-content, or
    // auto-grow when a keyframe is dragged past the end). Persist, clamp the
    // playhead, and keep the settings popup's Duration field in sync.
    onDurationChange: (d) => {
      if (currentTime > d) { currentTime = d; updateSlidersFromTime(); updateTimeDisplay(); }
      durationInput.value = Number.isInteger(d) ? d : d.toFixed(2);
      persist(); markDirty();
    },
  });
  timelineWrap.appendChild(timeline.el);

  // Assemble
  const leftCol = document.createElement('div');
  leftCol.className = 'anim-main-col';
  leftCol.appendChild(mainArea);
  leftCol.appendChild(viewToolbar);
  leftCol.appendChild(timelineWrap);

  page.appendChild(iconRail);
  page.appendChild(sidebar);
  page.appendChild(leftCol);

  app.appendChild(header);
  app.appendChild(page);
  app.appendChild(settingsBackdrop);
  app.appendChild(exportBackdrop);
  app.appendChild(progressBackdrop);

  // === Rendering ===
  const preview = createPreviewRenderer({
    canvas, ctx, mainArea,
    state: pageState,
    env: { project, global, charIds, sourceImageCache },
    deps: {
      updateFrameCacheIndicator: (fc) => timeline?.updateFrameCacheIndicator?.(fc),
      markDirty: () => markDirty(),
      // Live textarea caret/selection for the kerning-caret overlay (null when
      // the textarea isn't focused → no caret drawn).
      getKernCaretSelection: () => (document.activeElement === textarea
        ? { selStart: textarea.selectionStart, selEnd: textarea.selectionEnd }
        : null),
    },
  });
  // Hoisted wrappers — callbacks declared above this point call these.
  function applyDisplayZoom() { preview.applyDisplayZoom(); }
  function redrawPreview() { preview.redrawPreview(); }
  function redrawFast(params) { preview.redrawFast(params); }
  function overrideWith(key, val) { return preview.overrideWith(key, val); }

  function updateSlidersFromTime() {
    syncTextArea();
    refreshKfToggles();
    const p = sampleAnimation(animation, currentTime);
    for (const key of Object.keys(sliderInputs)) {
      const ref = sliderInputs[key];
      if (!ref) continue;
      // p only carries keys that have a track; unkeyframed params (e.g. an
      // untouched grid slider) fall back to their baseline value.
      const v = p[key] ?? animation.baseValues?.[key];
      if (v != null) ref.api.setValue(v);
    }
  }

  function updateTimeDisplay() {
    let text = `${currentTime.toFixed(2)}s / ${animation.duration.toFixed(2)}s`;
    // Musical position readout when the BPM guide is on. Bar/beat are 1-based;
    // before the beat offset the bar number can drop to 0 or below, which is a
    // truthful "pre-roll" readout, so it's left as-is.
    if (animation.bpm > 0) {
      const spb = 60 / animation.bpm;
      const perBar = Math.max(1, Math.round(animation.beatsPerBar || 4));
      const beats = (currentTime - (animation.beatOffset || 0)) / spb;
      const bar = Math.floor(beats / perBar) + 1;
      const beat = ((beats % perBar) + perBar) % perBar + 1;
      text += ` | ${bar}小節 ${beat.toFixed(1)}拍`;
    }
    timeDisplay.textContent = text;
  }

  // === Playback ===
  const playback = createPlayback({
    state: pageState,
    audioPlayer,
    listenAudio,
    deps: {
      setPlayState: (on) => setPlayState(on),
      updateSlidersFromTime: () => updateSlidersFromTime(),
      renderPlayhead: () => timeline.renderPlayhead(),
      updateTimeDisplay: () => updateTimeDisplay(),
      redrawPreview: () => redrawPreview(),
    },
  });
  // Hoisted wrappers — callbacks declared above this point call these.
  function togglePlay() { playback.togglePlay(); }
  function pausePlayback() { playback.pausePlayback(); }
  function seekTo(t) { playback.seekTo(t); }
  function syncAudioToTime(force) { playback.syncAudioToTime(force); }

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
      settings.close();
      return;
    }
    if (e.code === 'Escape' && exportBackdrop.style.display !== 'none') {
      closeExport();
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
    clearTimeout(kernHistoryTimer);
    detachKernCaret();
    kernHint?.destroy();
    settings.destroy();
    timeline.destroy?.();
    preview.destroy();
    audioPlayer.dispose();
    listenAudio.pause();
    listenAudio.removeAttribute('src');
    listenAudio.load?.();
    window.removeEventListener('hashchange', detach);
  });

  // === Render ===
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
    if (!preview.isFrameCacheComplete()) {
      await doRender();
    }
    if (!preview.isFrameCacheComplete()) return null;
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
    downloadBlob(blob, 'kabuku_animation.json');
  }

  function doJsonImport() {
    pickAndApplyJson(async (data) => {
      // Merge with defaults to ensure all tracks exist
      const base = createDefaultAnimation();
      const merged = { ...base, ...data, tracks: { ...base.tracks, ...(data.tracks || {}) }, baseValues: { ...base.baseValues, ...(data.baseValues || {}) }, textTrack: Array.isArray(data.textTrack) ? data.textTrack : [], charKerning: Array.isArray(data.charKerning) ? data.charKerning : [], audio: data.audio ?? null };
      animation = merged;
      saveAnimation(animation);
      // Make sure the imported state is persisted before we reload, otherwise
      // the debounced write would be cancelled by the navigation.
      await flushAnimationNow();
      location.reload();
    });
  }

  // Init
  updateSlidersFromTime();
  updateTimeDisplay();
  // Prime the guide-audio player + panel from persisted state.
  if (animation.audio?.url) {
    audioPlayer.load(animation.audio.url);
    audioPlayer.setGain(animation.audio.gain ?? 1);
  }
  refreshAudioPanel();
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
    if (!Array.isArray(animation.textTrack)) animation.textTrack = [];
    if (!Array.isArray(animation.charKerning)) animation.charKerning = [];
    if (animation.audio === undefined) animation.audio = null;
    // Re-prime the guide-audio player after an undo/redo (the clip may have
    // been added/removed/changed by the snapshot).
    if (animation.audio?.url) {
      audioPlayer.load(animation.audio.url);
      audioPlayer.setGain(animation.audio.gain ?? 1);
    } else {
      audioPlayer.pause();
    }
    refreshAudioPanel();
    textarea.value = sampleText(animation, currentTime);
    refreshTextKfBtn();
    hBtn.classList.toggle('active', animation.writingMode === 'horizontal');
    vBtn.classList.toggle('active', animation.writingMode === 'vertical');
    bgColorInput.value = animation.bgColor || '#ffffff';
    textColorInput.value = animation.textColor || '#000000';
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
