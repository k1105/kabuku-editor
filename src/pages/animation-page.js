import { createDefaultAnimation, listFontProjects } from '../core/project.js';
import {
  getSnapshotProject, getSnapshotGlobal, getAnimation, saveAnimation,
  currentAnimationProjectName, currentAnimationProjectId, refreshSnapshotFromOrigin,
  getOriginFontProjectId, getOriginFontProjectName,
  setLinkedFontProject,
  flushNow as flushAnimationNow,
  subscribeAnimationProject, hasUnsavedChanges as animHasUnsavedChanges,
} from '../core/animation-project.js';
import { RENDER_SIZE } from '../compose/glyph-cache.js';
import { sampleAnimation, upsertKeyframe, clampTime, nextKeyframeTime, prevKeyframeTime, sampleText, upsertTextKeyframe, activeTextKeyframe } from '../animation/animation.js';
import { createTimelineUI } from '../animation/timeline-ui.js';
import { renderFrames, computeFrameCacheShape, createFrameRenderer, computeLayout, DEFAULT_CANVAS_WIDTH, DEFAULT_CANVAS_HEIGHT } from '../animation/render.js';
import { exportPngSequence, exportGif } from '../animation/export.js';
import { createPageHeader } from '../ui/page-header.js';
import { iconEl, iconSvg, iconButton } from '../ui/icons.js';
import { createSettingsModal, settingsToolBtn } from '../ui/settings-modal.js';
import { commit as historyCommit } from '../core/animation-history.js';
import { stretchMatrix } from '../core/transform-math.js';
import { createSourceImageLoader } from '../compose/source-image.js';
import { uploadAnimationAudio } from '../core/storage.js';
import { createAudioPlayer, decodeAudioPeaks, songTimeAt, isAudible } from '../animation/audio-track.js';
import { createParamRow } from '../ui/param-row.js';
import { createLangToggle, t } from '../ui/i18n.js';
import { getGrid } from '../grids/grid-plugin.js';

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
  // Guide audio (lyric-video editing) — null until a file is imported.
  if (animation.audio === undefined) animation.audio = null;

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

  // --- Left icon rail ---
  // A vertical strip of icon buttons left of the sidebar (mirrors the Glyphs
  // editor). Each button swaps the sidebar to a dedicated panel: Text, Camera,
  // Layer, Export. Icons come from Iconify (Lucide set) via <iconify-icon>.
  const iconRail = document.createElement('div');
  iconRail.className = 'icon-rail';
  const RAIL_ITEMS = [
    { id: 'text',   icon: 'lucide:type',   title: 'Text' },
    { id: 'camera', icon: 'lucide:video',  title: 'Camera' },
    { id: 'audio',  icon: 'lucide:music',  title: 'Audio' },
  ];
  let activePanel = 'text';
  const railButtons = {};
  for (const item of RAIL_ITEMS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'rail-btn';
    btn.title = t(item.title);
    btn.setAttribute('aria-label', item.title);
    const ic = document.createElement('iconify-icon');
    ic.setAttribute('icon', item.icon);
    btn.appendChild(ic);
    btn.addEventListener('click', () => setPanel(item.id));
    railButtons[item.id] = btn;
    iconRail.appendChild(btn);
  }

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
    for (const [k, btn] of Object.entries(railButtons)) btn.classList.toggle('active', k === id);
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
    if (active) active.value = textarea.value;
    else animation.text = textarea.value;
    persist();
    markDirty();
    // Keep the timeline's keyframe label in sync while editing a keyframe's text
    // (the base-text edit has no timeline row to refresh).
    if (active) timeline.render();
    redrawPreview();
  });

  textKfBtn.addEventListener('click', () => {
    upsertTextKeyframe(animation.textTrack, currentTime, textarea.value);
    persist();
    markDirty();
    timeline.render();
    refreshTextKfBtn();
    redrawPreview();
    commitHistory('text-keyframe');
  });

  textBody.appendChild(textarea);

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

  function addAnimatedSliders(parent, defs) {
    for (const def of defs) {
      const initial = sampleAnimation(animation, currentTime)[def.key];

      const { row, api } = createParamRow(def.label, {
        min: def.min, max: def.max, step: def.step,
        value: initial,
        hardMin: def.hardMin, hardMax: def.hardMax,
        onInput: (v) => {
          redrawFast(overrideWith(def.key, v));
        },
        onChange: (v) => {
          // Tracks are created lazily — a param gets a timeline row only once
          // it holds a keyframe (see track cleanup above).
          if (!animation.tracks[def.key]) animation.tracks[def.key] = [];
          upsertKeyframe(animation.tracks[def.key], currentTime, v);
          persist();
          markDirty();
          timeline.render();
          redrawPreview();
        },
      });
      parent.appendChild(row);

      sliderInputs[def.key] = { api, def };
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

  // AUDIO group — guide audio for lyric-video editing. The clip plays during
  // preview/playback in sync with the playhead but is never part of the
  // rendered/exported output. See audio-track.js for the data model.
  const audioGroup = document.createElement('div');
  audioGroup.className = 'param-group anim-audio-group';
  const audioTitle = document.createElement('h3');
  audioTitle.textContent = 'AUDIO (guide)';
  audioGroup.appendChild(audioTitle);

  const audioHint = document.createElement('p');
  audioHint.className = 'anim-audio-hint';
  audioHint.textContent = '編集用のガイド音源です。書き出し動画には含まれません。';
  audioGroup.appendChild(audioHint);

  // Hidden file input + import button.
  const audioFileInput = document.createElement('input');
  audioFileInput.type = 'file';
  audioFileInput.accept = 'audio/*';
  audioFileInput.style.display = 'none';
  const importAudioBtn = document.createElement('button');
  importAudioBtn.className = 'tool-btn anim-audio-import';
  importAudioBtn.appendChild(iconEl('upload'));
  const importAudioLbl = document.createElement('span');
  importAudioLbl.textContent = '音源を読み込む';
  importAudioBtn.appendChild(importAudioLbl);
  importAudioBtn.addEventListener('click', () => audioFileInput.click());
  audioFileInput.addEventListener('change', () => {
    const file = audioFileInput.files?.[0];
    audioFileInput.value = ''; // allow re-selecting the same file later
    if (file) doImportAudio(file);
  });
  audioGroup.appendChild(importAudioBtn);
  audioGroup.appendChild(audioFileInput);

  // Loaded-clip controls (filename, listen player, volume, remove). Shown only
  // when a clip is loaded; refreshAudioPanel() toggles visibility + values.
  const audioControls = document.createElement('div');
  audioControls.className = 'anim-audio-controls';

  const audioNameRow = document.createElement('div');
  audioNameRow.className = 'anim-audio-name';
  audioControls.appendChild(audioNameRow);

  // Head-start field: how many seconds INTO the song to begin at the animation's
  // start (= the song position at timeline t=0 = -offset). Skipping an intro
  // reads as a positive number, which is what users expect. Internally we still
  // store `offset` (the timeline time where the song's start sits), so the field
  // edits `-offset`. Editable here OR by dragging the waveform clip; the drag
  // updates this live via refreshAudioPanel().
  const offsetInput = addNumberField(audioControls, '頭出し (s)', 0, -600, 600, 0.01, (v) => {
    if (!animation.audio) return;
    animation.audio.offset = -v;
    persist(); timeline.render();
    if (playing) syncAudioToTime(true);
    commitHistory('audio-offset');
  });

  // Standalone "listen" UI: a custom transport to audition the whole song
  // independently of the editing timeline. It only plays sound — it never
  // touches the playhead, offset, or animation state ("他の状態を汚さない").
  // Use it to find the spot you want, then set 開始位置 / drag the waveform clip
  // to line the song up with the animation.
  const listenHint = document.createElement('p');
  listenHint.className = 'anim-audio-hint';
  listenHint.textContent = '試聴用プレイヤー（タイムラインとは独立）。';
  audioControls.appendChild(listenHint);

  const listenPlayer = document.createElement('div');
  listenPlayer.className = 'anim-listen-player';
  // Full-width seek bar on its own row so it's as long as possible.
  const listenSeek = document.createElement('input');
  listenSeek.type = 'range';
  listenSeek.className = 'anim-listen-seek';
  listenSeek.min = 0;
  listenSeek.max = 1;
  listenSeek.step = 0.001;
  listenSeek.value = 0;
  listenPlayer.appendChild(listenSeek);
  // Transport row: play/pause button + time readout.
  const listenRow = document.createElement('div');
  listenRow.className = 'anim-listen-row';
  const listenPlayBtn = document.createElement('button');
  listenPlayBtn.type = 'button';
  listenPlayBtn.className = 'anim-listen-play';
  listenPlayBtn.appendChild(iconEl('play'));
  const listenTime = document.createElement('span');
  listenTime.className = 'anim-listen-time';
  listenTime.textContent = '0:00 / 0:00';
  listenRow.appendChild(listenPlayBtn);
  listenRow.appendChild(listenTime);
  listenPlayer.appendChild(listenRow);
  audioControls.appendChild(listenPlayer);

  // --- listen transport wiring (all isolated to listenAudio) ---
  const fmtTime = (s) => {
    if (!Number.isFinite(s) || s < 0) s = 0;
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec < 10 ? '0' : ''}${sec}`;
  };
  const listenDuration = () => {
    const d = listenAudio.duration;
    return Number.isFinite(d) && d > 0 ? d : (animation.audio?.duration || 0);
  };
  let listenScrubbing = false;
  function refreshListenIcon() {
    listenPlayBtn.innerHTML = '';
    listenPlayBtn.appendChild(iconEl(listenAudio.paused ? 'play' : 'pause'));
  }
  function refreshListenProgress() {
    const dur = listenDuration();
    if (!listenScrubbing) {
      listenSeek.value = dur > 0 ? listenAudio.currentTime / dur : 0;
    }
    listenTime.textContent = `${fmtTime(listenAudio.currentTime)} / ${fmtTime(dur)}`;
  }
  listenPlayBtn.addEventListener('click', () => {
    if (!animation.audio) return;
    if (listenAudio.paused) {
      // Don't sound the audition over timeline playback.
      if (playing) pausePlayback();
      listenAudio.play().catch(() => { /* not ready / gesture — ignore */ });
    } else {
      listenAudio.pause();
    }
  });
  listenSeek.addEventListener('input', () => {
    listenScrubbing = true;
    const dur = listenDuration();
    if (dur > 0) {
      try { listenAudio.currentTime = parseFloat(listenSeek.value) * dur; } catch { /* not seekable */ }
    }
    listenTime.textContent = `${fmtTime(listenAudio.currentTime)} / ${fmtTime(dur)}`;
  });
  listenSeek.addEventListener('change', () => { listenScrubbing = false; });
  listenAudio.addEventListener('play', refreshListenIcon);
  listenAudio.addEventListener('pause', refreshListenIcon);
  listenAudio.addEventListener('ended', () => { refreshListenIcon(); refreshListenProgress(); });
  listenAudio.addEventListener('timeupdate', refreshListenProgress);
  listenAudio.addEventListener('loadedmetadata', refreshListenProgress);

  const { row: gainRow, api: gainApi } = createParamRow('音量', {
    min: 0, max: 1, step: 0.01, value: 1,
    onInput: (v) => { if (animation.audio) audioPlayer.setGain(v); },
    onChange: (v) => {
      if (!animation.audio) return;
      animation.audio.gain = v;
      audioPlayer.setGain(v);
      persist();
      commitHistory('audio-gain');
    },
  });
  audioControls.appendChild(gainRow);

  const removeAudioBtn = document.createElement('button');
  removeAudioBtn.className = 'tool-btn anim-audio-remove';
  removeAudioBtn.appendChild(iconEl('trash'));
  const removeAudioLbl = document.createElement('span');
  removeAudioLbl.textContent = '音源を削除';
  removeAudioBtn.appendChild(removeAudioLbl);
  removeAudioBtn.addEventListener('click', () => {
    if (!animation.audio) return;
    if (!confirm('ガイド音源を削除します。よろしいですか?')) return;
    animation.audio = null;
    audioPlayer.dispose();
    persist();
    timeline.render();
    refreshAudioPanel();
    commitHistory('audio-remove');
  });
  audioControls.appendChild(removeAudioBtn);

  audioGroup.appendChild(audioControls);
  panelAudio.appendChild(audioGroup);

  // Reflect the current animation.audio state into the panel controls.
  function refreshAudioPanel() {
    const a = animation.audio;
    if (a) {
      audioControls.style.display = '';
      importAudioLbl.textContent = '音源を差し替える';
      audioNameRow.textContent = a.name || 'audio';
      // Field shows head-start (= -offset); see the field's definition above.
      offsetInput.value = -(a.offset ?? 0);
      gainApi.setValue(a.gain ?? 1);
      // Point the listen player at the clip. Only reassign on a real URL change
      // so refreshes (offset drag, undo) don't reset its playback position.
      if (listenAudio.dataset.url !== a.url) {
        listenAudio.src = a.url;
        listenAudio.dataset.url = a.url;
      }
      refreshListenIcon();
      refreshListenProgress();
    } else {
      audioControls.style.display = 'none';
      importAudioLbl.textContent = '音源を読み込む';
      listenAudio.pause();
      listenAudio.removeAttribute('src');
      delete listenAudio.dataset.url;
    }
  }

  /**
   * Import a guide-audio file: decode peaks from its bytes (for the waveform),
   * upload the file to Storage, then attach it to the animation. Peaks are
   * computed up front and persisted so reloads never re-decode.
   */
  async function doImportAudio(file) {
    importAudioBtn.disabled = true;
    const prevLbl = importAudioLbl.textContent;
    importAudioLbl.textContent = '読み込み中…';
    try {
      const bytes = await file.arrayBuffer();
      // decodeAudioData detaches its buffer — decode from a copy so the
      // original bytes remain intact for the upload.
      const { peaks, duration } = await decodeAudioPeaks(bytes.slice(0));
      const url = await uploadAnimationAudio({ file });
      animation.audio = {
        url, name: file.name || 'audio',
        duration, offset: 0, gain: animation.audio?.gain ?? 1, peaks,
      };
      audioPlayer.load(url);
      audioPlayer.setGain(animation.audio.gain);
      persist();
      markDirty();
      timeline.render();
      refreshAudioPanel();
      commitHistory('audio-import');
    } catch (e) {
      console.error('Audio import failed:', e);
      alert('音源の読み込みに失敗しました: ' + e.message);
    } finally {
      importAudioBtn.disabled = false;
      importAudioLbl.textContent = animation.audio ? '音源を差し替える' : prevLbl;
    }
  }

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
    onChange: () => { persist(); markDirty(); syncTextArea(); commitHistory('keyframe-edit'); },
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
  let frameRendererSig = null;
  // The renderer caches per-glyph source images and static cells, both of which
  // depend on the input text and on which grid params are animated. Rebuild it
  // when that structure changes (not on mere value edits — dynamic cells are
  // keyed by sampled params, so new values reuse the same renderer).
  function rendererSignature() {
    const gridKeys = Object.keys(animation.tracks || {})
      .filter(k => k.startsWith('grid.') && animation.tracks[k]?.length)
      .sort()
      .join(',');
    // Include text keyframe values: a keyframe can introduce a glyph absent from
    // the base text, and the renderer pre-loads per-glyph sources (auto-mesh) up
    // front, so its source set must be invalidated when the text track changes.
    const textKf = (animation.textTrack || []).map(kf => kf.value).join('');
    return `${animation.text || ''}|${gridKeys}|${textKf}`;
  }
  function getFrameRenderer() {
    const sig = rendererSignature();
    if (!frameRenderer
        || frameRenderer.width !== canvasW()
        || frameRenderer.height !== canvasH()
        || sig !== frameRendererSig) {
      frameRenderer = createFrameRenderer(animation, { project, global, charIds });
      frameRendererSig = sig;
      // Warm the per-glyph source images used by per-frame auto-mesh. Until
      // they're ready renderInto draws static cells; once loaded, drop the
      // (static) cached frames and redraw so the meshed result shows.
      if (frameRenderer.isReady && !frameRenderer.isReady()) {
        frameRenderer.ready().then(() => { markDirty(); redrawPreview(); });
      }
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

  /** Apply camera transform (pan + rotation + zoom) around the canvas center. */
  function applyCameraTransform(targetCtx, cw, ch, p) {
    const cx = cw / 2;
    const cy = ch / 2;
    targetCtx.translate(cx + (p.cameraX || 0), cy + (p.cameraY || 0));
    targetCtx.rotate(((p.cameraRotation || 0) * Math.PI) / 180);
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
    const { a, b, d } = stretchMatrix(p.stretchAngle, p.stretchAmount);
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
    syncTextArea();
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
    timeDisplay.textContent = `${currentTime.toFixed(2)}s / ${animation.duration.toFixed(2)}s`;
  }

  // === Playback ===
  /**
   * Keep the guide-audio element aligned to the master wall-clock during
   * playback. Starts/pauses the clip as the playhead enters/leaves the song's
   * placed range, and re-seeks ONLY on explicit events (`force`: start, scrub,
   * offset change).
   *
   * It deliberately does NOT hard-correct drift every frame: the audio element
   * has output latency (tens to a couple hundred ms), so its clock trails the
   * wall-clock by more than any small tolerance, and per-frame seeking made the
   * sound stutter ("ぶつぶつ"). Once started the element free-runs at real time —
   * over a short guide clip the residual drift is inaudible.
   */
  function syncAudioToTime(force) {
    const a = animation.audio;
    if (!a || !playing) { return; }
    if (isAudible(a, currentTime)) {
      const desired = songTimeAt(a, currentTime);
      if (!audioPlayer.isPlaying()) {
        audioPlayer.setGain(a.gain ?? 1);
        audioPlayer.play(desired);
      } else if (force) {
        audioPlayer.seek(desired);
      }
    } else if (audioPlayer.isPlaying()) {
      audioPlayer.pause();
    }
  }

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
    // Auditioning and timeline playback shouldn't sound at once.
    listenAudio.pause();
    syncAudioToTime(true);
    const tick = () => {
      if (!playing) return;
      const a = animation.audio;
      const offset = a?.offset || 0;
      // While the guide audio is actually sounding, slave the playhead to the
      // audio element's own clock so the playhead sits exactly over the part of
      // the waveform being heard (the wall-clock drifts ahead of the audio by
      // its output latency, which looked like the waveform was out of sync).
      // Re-anchor the wall-clock baseline each frame so handing back to it (out
      // of the song's range / after a clip ends) is seamless.
      if (a && audioPlayer.isPlaying()) {
        currentTime = offset + audioPlayer.currentTime;
        playStartWallTime = performance.now();
        playStartAnimTime = currentTime;
      } else {
        const elapsed = (performance.now() - playStartWallTime) / 1000;
        currentTime = playStartAnimTime + elapsed;
      }
      if (currentTime >= animation.duration) {
        currentTime = animation.duration;
        updateSlidersFromTime();
        timeline.renderPlayhead();
        updateTimeDisplay();
        redrawPreview();
        pausePlayback();
        return;
      }
      syncAudioToTime(false);
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
    audioPlayer.pause();
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
    if (playing) syncAudioToTime(true);
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
    timeline.destroy?.();
    viewResizeObserver.disconnect();
    audioPlayer.dispose();
    listenAudio.pause();
    listenAudio.removeAttribute('src');
    listenAudio.load?.();
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
        const merged = { ...base, ...data, tracks: { ...base.tracks, ...(data.tracks || {}) }, baseValues: { ...base.baseValues, ...(data.baseValues || {}) }, textTrack: Array.isArray(data.textTrack) ? data.textTrack : [], audio: data.audio ?? null };
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
