import { loadProject, saveProject, saveCharacter, getGlobal, saveGlobal, serializeLayerOverrides, resolveTransform, deleteCharacter, renameCharacter, generateUniqueCharId, createEmptyCharacter, currentFontProjectId, currentFontProjectName, flushNow as flushProjectNow } from '../core/project.js';
import { loadImageCached } from '../core/image-cache.js';
import { uploadCharacterImage } from '../core/storage.js';
import { getAllGrids, getGrid } from '../grids/grid-plugin.js';
import { createLayer, regenerateCells } from '../core/layer.js';
import { renderCanvas } from '../render/canvas-renderer.js';
import { autoMesh, autoMeshAsync } from '../core/mesh.js';
import { createLayerPanel } from '../ui/layer-panel.js';
import { createParamsPanel, createTransformPanel } from '../ui/params-panel.js';
import { createToolbar } from '../ui/toolbar.js';
import { buildRuntimeLayers } from '../core/layer-builder.js';
import { exportLayerToSVG, exportAllLayersToSVG } from '../render/svg-exporter.js';
import { buildFontBytes } from '../render/font-exporter.js';
import { buildVariableTTF, buildVariableFontFamilyZip, DEFAULT_FAMILY_ANGLES } from '../render/font/vf-builder.js';
import { svgExportDialog, staticFontDialog, variableFontDialog, glyphAddDialog, saveFile } from '../ui/export-dialog.js';
import { PRESETS as FONT_IMPORT_PRESETS, buildCharSet } from '../render/font/char-ranges.js';
import { loadGoogleFont, renderCharToContext, renderFontSourceToCanvas } from '../render/font/font-import.js';
import { iconButton, iconEl } from '../ui/icons.js';
import { createLangToggle, t } from '../ui/i18n.js';
import { createPageHeader } from '../ui/page-header.js';
import { commit as historyCommit } from '../core/history.js';
import { computeCacheScale } from '../compose/glyph-cache.js';
import { drawSourceImage, metricsLabelMargin } from '../render/canvas-renderer.js';
import { createSliderInput } from '../ui/slider-input.js';
import { createComposeView } from '../compose/compose-view.js';

const GLYPH_SIZE = 1024;
const PANEL_KEY = 'kabuku.editPanel';
const SEL_CHAR_KEY = 'kabuku.selectedChar';

export function renderIndexPage(app) {
  const project = loadProject();
  let global = getGlobal();
  project.global = global;
  // Restore last-selected char so undo/redo (which re-renders the page) keeps
  // the user's context.
  const savedSel = sessionStorage.getItem(SEL_CHAR_KEY);
  let selectedCharId = (savedSel && project.characters[savedSel])
    ? savedSel
    : (Object.keys(project.characters)[0] ?? null);

  // Active sidebar panel, chosen from the left icon rail.
  const PANELS = ['layers', 'pen', 'automesh', 'metrics', 'props', 'compose'];
  let panel = PANELS.includes(sessionStorage.getItem(PANEL_KEY))
    ? sessionStorage.getItem(PANEL_KEY)
    : 'layers';
  // Panels that edit the selected glyph's per-character state (live paint
  // edits, image placement, meshing) need the in-memory local layers; the
  // others render straight from the global config.
  const isLocalContext = () => panel === 'pen' || panel === 'props' || panel === 'automesh';

  // Paint state
  let currentTool = 'paint';
  let isPainting = false;
  let backgroundImage = null;
  let bgOpacity = 0.3;

  // Guides-view zoom, persisted across page renders.
  const SCALE_L_KEY = 'kabuku.previewScaleL';
  const loadScale = (key) => {
    const v = parseFloat(sessionStorage.getItem(key));
    return Number.isFinite(v) && v > 0 ? v : 1;
  };
  let scaleL = loadScale(SCALE_L_KEY);

  // Font-wide (global) layer state
  let globalLayers = [];
  let activeGlobalLayerIdx = 0;
  rebuildGlobalLayers();

  // Per-character state (rebuilt on char/panel change)
  let localLayers = [];
  let activeLocalLayerIdx = 0;
  let localTransformOverrides = {};
  let localTransform = resolveTransform(global, {});

  // === Header ===
  const projectName = currentFontProjectName() || 'KABUKU Editor';
  const { el: header, headerNav: headerActions, progressEl } = createPageHeader({
    activePage: 'glyphs',
    fontProjectId: currentFontProjectId(),
    title: projectName,
  });
  const progressWrap = progressEl.wrap;
  const progressBar = progressEl.bar;
  const progressText = progressEl.text;

  // === Settings modal (shared style with the animation editor) ===
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

  function openSettings() { settingsBackdrop.style.display = 'flex'; }
  function closeSettings() { settingsBackdrop.style.display = 'none'; }
  settingsBackdrop.addEventListener('click', (e) => {
    if (e.target === settingsBackdrop) closeSettings();
  });
  function onSettingsKeyDown(e) {
    if (e.key === 'Escape' && settingsBackdrop.style.display !== 'none') closeSettings();
  }
  document.addEventListener('keydown', onSettingsKeyDown);
  // Detach on hashchange so the listener doesn't leak across page navigations.
  window.addEventListener('hashchange', function detachSettings() {
    document.removeEventListener('keydown', onSettingsKeyDown);
    window.removeEventListener('hashchange', detachSettings);
  });

  function makeSettingsGroup(title) {
    const g = document.createElement('div');
    g.className = 'param-group';
    const h = document.createElement('h3');
    h.textContent = title;
    g.appendChild(h);
    settingsBody.appendChild(g);
    return g;
  }
  function settingsToolBtn(icon, label, onClick) {
    const btn = document.createElement('button');
    btn.className = 'tool-btn';
    btn.appendChild(iconEl(icon));
    const span = document.createElement('span');
    span.textContent = label;
    btn.appendChild(span);
    btn.addEventListener('click', onClick);
    return btn;
  }

  // --- Project (JSON import / export) ---
  const projectGroup = makeSettingsGroup('Project');
  const projectRow = document.createElement('div');
  projectRow.className = 'anim-button-row';
  const importJsonBtn = settingsToolBtn('upload', 'Import (.json)', () => doImportProject());
  importJsonBtn.title = 'Import a JSON project file';
  const exportProjectBtn = settingsToolBtn('download', 'Export (.json)', () => doExportProject());
  exportProjectBtn.title = 'Export full project (includes base images as data URLs)';
  projectRow.appendChild(importJsonBtn);
  projectRow.appendChild(exportProjectBtn);
  projectGroup.appendChild(projectRow);

  // --- Font Export ---
  const fontExportGroup = makeSettingsGroup('Font Export');
  const fontExportRow = document.createElement('div');
  fontExportRow.className = 'anim-button-row';
  fontExportRow.appendChild(settingsToolBtn('download', 'Static (.otf)', () => doStaticFontExport()));
  fontExportRow.appendChild(settingsToolBtn('download', 'Variable Font', () => doVariableFontExport()));
  fontExportGroup.appendChild(fontExportRow);

  // --- Language ---
  const langGroup = makeSettingsGroup('Language');
  langGroup.appendChild(createLangToggle());

  // Settings gear button in the header (first in the nav, like the animation
  // editor).
  const settingsBtn = iconButton('settings', 'Settings', { title: 'Settings' });
  settingsBtn.addEventListener('click', () => openSettings());
  headerActions.insertBefore(settingsBtn, headerActions.firstChild);

  // === Settings actions ===
  async function doExportProject() {
    // Strip session-level globals (preview stretch state) so re-importing
    // doesn't lock in a transient view.
    const out = JSON.parse(JSON.stringify(project));
    if (out.global) {
      delete out.global.stretchAngle;
      delete out.global.stretchAmount;
    }
    const json = JSON.stringify(out, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    await saveBlobWithPicker(blob, 'kabuku_project.json', {
      description: 'KABUKU project',
      accept: { 'application/json': ['.json'] },
    });
  }

  function doImportProject() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.addEventListener('change', async () => {
      const file = input.files[0];
      if (!file) return;
      try {
        const data = JSON.parse(await file.text());
        if (data.global) {
          if (data.global.stretchAngle === undefined) data.global.stretchAngle = 0;
          if (data.global.stretchAmount === undefined) data.global.stretchAmount = 0;
        }
        saveProject(data);
        // Wait for Firestore write so the reload picks up the imported state.
        await flushProjectNow();
        location.reload();
      } catch (e) {
        alert(`Import failed: ${e.message}`);
      }
    });
    input.click();
  }

  function fontFamilyName() {
    return (global.fontInfo?.familyName || 'Kabuku').replace(/\s+/g, '');
  }

  async function doStaticFontExport() {
    const familyName = fontFamilyName();
    const result = await staticFontDialog({
      defaultFilename: `${familyName}-Regular.otf`,
      defaultStretch: global.stretchAmount || 0,
      defaultAngle: global.stretchAngle || 0,
    });
    if (!result) return;
    try {
      const proj = loadProject();
      const { bytes, skipped } = buildFontBytes(proj, {
        transform: {
          stretchAmount: result.stretchAmount,
          stretchAngle: result.stretchAngle,
          baseGap: 0,
          gapDirectionWeight: 0,
        },
      });
      const ok = await saveFile(bytes, result.filename, 'font/otf');
      if (ok && skipped.length > 0) {
        alert(`次のグリフはスキップされました（charId が Unicode 1文字でない）:\n${skipped.join(', ')}`);
      }
    } catch (e) {
      console.error(e);
      alert(`Static font export failed: ${e.message}`);
    }
  }

  async function doVariableFontExport() {
    const familyName = fontFamilyName();
    const result = await variableFontDialog({
      angles: DEFAULT_FAMILY_ANGLES,
      defaultFilenameSingle: `${familyName}-Angle$ANGLE.ttf`,
      defaultFilenameAll: `${familyName}-VF-Family.zip`,
    });
    if (!result) return;
    try {
      const proj = loadProject();
      if (result.mode === 'all') {
        const { zip, skipped, fileCount } = buildVariableFontFamilyZip(proj);
        const ok = await saveFile(zip, result.filename, 'application/zip');
        if (ok) {
          let msg = `${fileCount} ファイルを書き出しました。`;
          if (skipped.length > 0) msg += `\n\nスキップ:\n${skipped.join(', ')}`;
          alert(msg);
        }
      } else {
        const { binary, skipped } = buildVariableTTF(proj, {
          angle: result.angle,
          styleName: `Angle ${result.angle}`,
        });
        const ok = await saveFile(binary, result.filename, 'font/ttf');
        if (ok && skipped.length > 0) {
          alert(`スキップ:\n${skipped.join(', ')}`);
        }
      }
    } catch (e) {
      console.error(e);
      alert(`Variable font export failed: ${e.message}`);
    }
  }

  // === Main layout ===
  const page = document.createElement('div');
  page.className = 'edit-page';

  // === Sidebar ===
  const sidebar = document.createElement('div');
  sidebar.className = 'sidebar';

  // === Left icon rail ===
  // A vertical strip of icon buttons sitting left of the sidebar. Each button
  // swaps the sidebar to a dedicated panel. Icons come from Iconify (Lucide
  // set) via the <iconify-icon> web component registered in main.js.
  const iconRail = document.createElement('div');
  iconRail.className = 'icon-rail';
  const RAIL_ITEMS = [
    { id: 'layers',   icon: 'lucide:layers',             title: 'Layers' },
    { id: 'pen',      icon: 'lucide:pen-tool',           title: 'Pen' },
    { id: 'automesh', icon: 'lucide:grid-3x3',           title: 'Auto Mesh' },
    { id: 'metrics',  icon: 'lucide:ruler',              title: 'Font Metrics' },
    { id: 'props',    icon: 'lucide:sliders-horizontal', title: 'Properties' },
    { id: 'compose',  icon: 'lucide:type',               title: 'Compose' },
  ];
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
  function syncRailButtons() {
    for (const [id, btn] of Object.entries(railButtons)) {
      btn.classList.toggle('active', panel === id);
    }
  }
  syncRailButtons();

  const sidebarBody = document.createElement('div');
  sidebarBody.className = 'sidebar-body';
  sidebar.appendChild(sidebarBody);

  // === Main area ===
  const mainArea = document.createElement('div');
  mainArea.className = 'index-main';

  const previewSection = document.createElement('div');
  previewSection.className = 'index-preview';

  // Center viewport: the Guides pane — the selected glyph drawn with no stretch
  // and all guides, as the paintable editing reference. (The standalone
  // single-glyph Preview was removed; the composed result lives in Compose.)
  const previewSplit = document.createElement('div');
  previewSplit.className = 'index-preview-split';

  // Build a Scale slider row. Zoom only changes the final blit scale, not the
  // (expensive) offscreen render — so `apply` re-blits the existing buffer
  // rather than re-rendering.
  function createScaleRow(get, set, apply) {
    const row = document.createElement('div');
    row.className = 'param-row';
    const label = document.createElement('label');
    label.textContent = 'Scale';
    const { slider, valueInput } = createSliderInput({
      min: 0.25,
      max: 3,
      step: 0.05,
      value: get(),
      onInput: (v) => { set(v); apply(); },
    });
    row.appendChild(label);
    row.appendChild(slider);
    row.appendChild(valueInput);
    return row;
  }

  const leftPane = document.createElement('div');
  leftPane.className = 'index-preview-pane';
  const previewCanvasL = document.createElement('canvas');
  previewCanvasL.className = 'index-preview-canvas';
  const previewCtxL = previewCanvasL.getContext('2d');
  const leftTag = document.createElement('span');
  leftTag.className = 'index-preview-tag';
  leftTag.textContent = 'Guides';
  // Left pane controls (docked at bottom): zoom only — stretch never affects
  // this pane.
  const leftBar = document.createElement('div');
  leftBar.className = 'index-pane-controls';
  leftBar.appendChild(createScaleRow(
    () => scaleL,
    (v) => { scaleL = v; sessionStorage.setItem(SCALE_L_KEY, String(v)); },
    () => blit(previewCanvasL, previewCtxL, offCanvasL, scaleL),
  ));
  leftPane.appendChild(previewCanvasL);
  leftPane.appendChild(leftTag);
  leftPane.appendChild(leftBar);

  previewSplit.appendChild(leftPane);

  previewSection.appendChild(previewSplit);

  const emptyState = document.createElement('div');
  emptyState.className = 'empty-state';
  emptyState.innerHTML = `<p>No characters yet.</p><p>Click the "+" tile below to add a glyph.</p>`;
  if (selectedCharId) {
    emptyState.style.display = 'none';
  } else {
    previewSplit.style.display = 'none';
  }
  previewSection.appendChild(emptyState);

  // === Compose (組版) view ===
  // The compose editor is mounted as a third center view (alongside Guides and
  // Preview) plus a sidebar control column. It shares this page's live project /
  // global so edits flow both ways; a glyph painted in-place here refreshes its
  // strip thumbnail via onCharEdited.
  const composeView = createComposeView({
    project,
    global,
    onCharEdited: (charId) => {
      const card = cardElements[charId];
      const canvas = card?.querySelector('canvas');
      if (canvas) renderThumbnail(canvas, project.characters[charId]);
    },
    onCharsAdded: (charIds) => {
      const empty = document.querySelector('.empty-state');
      if (empty) empty.style.display = 'none';
      for (const charId of charIds) {
        if (cardElements[charId]) continue;
        const card = createCharCard(charId, project.characters[charId], (id) => selectChar(id), (id) => deleteGlyph(id));
        cardElements[charId] = card;
        charStrip.appendChild(card);
      }
    },
  });
  composeView.centerEl.style.display = 'none';
  previewSection.appendChild(composeView.centerEl);

  mainArea.appendChild(previewSection);

  // === Char strip ===
  const charStripWrap = document.createElement('div');
  charStripWrap.className = 'index-char-strip-wrap';

  const charStrip = document.createElement('div');
  charStrip.className = 'index-char-strip';

  const cardElements = {};
  for (const charId of Object.keys(project.characters)) {
    const card = createCharCard(charId, project.characters[charId], (id) => selectChar(id), (id) => deleteGlyph(id));
    if (charId === selectedCharId) card.classList.add('selected');
    cardElements[charId] = card;
    charStrip.appendChild(card);
  }

  const addGlyphTile = document.createElement('button');
  addGlyphTile.className = 'char-card add-glyph-tile';
  addGlyphTile.title = 'Add glyph';
  addGlyphTile.textContent = '+';
  addGlyphTile.addEventListener('click', () => openAddGlyphDialog());

  // The "+" tile is pinned to the right edge (a sibling of the scroll strip),
  // so the glyph list scrolls horizontally in front of it.
  charStripWrap.appendChild(charStrip);
  charStripWrap.appendChild(addGlyphTile);
  mainArea.appendChild(charStripWrap);

  page.appendChild(iconRail);
  page.appendChild(sidebar);
  page.appendChild(mainArea);

  app.appendChild(header);
  app.appendChild(page);
  app.appendChild(settingsBackdrop);

  // Canvas fills the preview area; internal pixels match display size × DPR so
  // CSS scaling doesn't distort the aspect ratio (was clamped to GLYPH_SIZE
  // which broke aspect when the preview area was smaller than the glyph).
  // Match the guides canvas pixel buffer to its display size × DPR. Returns
  // whether it actually changed size (so callers can decide to redraw).
  function sizeCanvases() {
    const dpr = window.devicePixelRatio || 1;
    const rect = previewCanvasL.getBoundingClientRect();
    const w = Math.max(1, Math.floor(rect.width * dpr));
    const h = Math.max(1, Math.floor(rect.height * dpr));
    if (previewCanvasL.width === w && previewCanvasL.height === h) return false;
    previewCanvasL.width = w;
    previewCanvasL.height = h;
    return true;
  }
  function resizeCanvas() {
    if (sizeCanvases()) redraw();
  }
  const resizeObserver = new ResizeObserver(() => resizeCanvas());
  resizeObserver.observe(previewCanvasL);
  requestAnimationFrame(() => resizeCanvas());

  // Painting happens on the left (un-stretched, guide) pane only — its cell
  // geometry matches the hit-test paths.
  previewCanvasL.addEventListener('mousedown', (e) => {
    if (panel !== 'pen') return;
    isPainting = true;
    handlePaint(e);
  });
  previewCanvasL.addEventListener('mousemove', (e) => {
    if (!isPainting) return;
    handlePaint(e);
  });
  previewCanvasL.addEventListener('mouseup', () => {
    if (!isPainting) return;
    isPainting = false;
    saveLocalChar();
    refreshSelectedThumbnail();
    historyCommit('paint');
  });
  previewCanvasL.addEventListener('mouseleave', () => {
    if (!isPainting) return;
    isPainting = false;
    saveLocalChar();
    refreshSelectedThumbnail();
    historyCommit('paint');
  });

  function handlePaint(e) {
    if (!selectedCharId || localLayers.length === 0) return;
    const rect = previewCanvasL.getBoundingClientRect();
    const sx = previewCanvasL.width / rect.width;
    const sy = previewCanvasL.height / rect.height;
    const px = (e.clientX - rect.left) * sx;
    const py = (e.clientY - rect.top) * sy;
    // Glyph is drawn scaled & centered: width = GLYPH_SIZE * s
    const s = scaleL;
    const dw = GLYPH_SIZE * s;
    const dh = GLYPH_SIZE * s;
    const dx = (previewCanvasL.width - dw) / 2;
    const dy = (previewCanvasL.height - dh) / 2;
    const gx = (px - dx) / s;
    const gy = (py - dy) / s;
    const layer = localLayers[activeLocalLayerIdx];
    if (!layer) return;
    for (const cell of layer.cells) {
      if (offCtxL.isPointInPath(cell.path, gx, gy)) {
        const newFilled = currentTool === 'paint';
        if (cell.filled !== newFilled) {
          cell.filled = newFilled;
          cell.manualOverride = true;
          redraw();
        }
        break;
      }
    }
  }

  // === Init ===
  rebuildLocalState();
  loadBackgroundImage();
  syncCenterView();
  renderSidebarBody();
  if (panel === 'compose') composeView.redraw();

  // ============ Functions ============
  function setPanel(newPanel) {
    if (panel === newPanel) return;
    panel = newPanel;
    sessionStorage.setItem(PANEL_KEY, panel);
    syncRailButtons();
    if (isLocalContext()) rebuildLocalState();
    syncCenterView();
    renderSidebarBody();
    // The view we just un-hid was sized to ~0 while display:none; re-measure its
    // pixel buffer before drawing so the first frame isn't a stretched 1px blit.
    sizeCanvases();
    redraw();
    // The compose view manages its own canvas sizing; refresh it on entry so it
    // picks up any glyph edits made in the other panels.
    if (panel === 'compose') { composeView.invalidate(); composeView.redraw(); }
  }

  // The center viewport shows ONE view at a time: the Compose canvas, or the
  // Guides pane (the paintable editing reference) for every other panel. They
  // occupy the same space. This is the single authority for center visibility
  // (incl. the no-glyph empty state).
  // Display-only: callers redraw (init does so via the rAF resize below), and
  // redraw() touches offscreen buffers declared later in this function, so this
  // must not draw while the page is still being built.
  function syncCenterView() {
    const showCompose = panel === 'compose';
    composeView.centerEl.style.display = showCompose ? '' : 'none';
    // The glyph strip is for picking the edited glyph — irrelevant in Compose,
    // which addresses glyphs by the typed text, so hide it there.
    charStripWrap.style.display = showCompose ? 'none' : '';
    if (showCompose) {
      // Compose works without a selected glyph and fills the whole area.
      previewSplit.style.display = 'none';
      emptyState.style.display = 'none';
      return;
    }
    if (!selectedCharId) {
      previewSplit.style.display = 'none';
      emptyState.style.display = '';
      return;
    }
    emptyState.style.display = 'none';
    previewSplit.style.display = '';
  }

  function rebuildGlobalLayers() {
    globalLayers = [];
    for (const ld of global.defaultLayers || []) {
      const gridPlugin = getGrid(ld.gridName);
      if (!gridPlugin) continue;
      const layer = createLayer(gridPlugin, { ...ld.gridParams });
      layer.name = ld.name || gridPlugin.name;
      if (ld.opacity !== undefined) layer.opacity = ld.opacity;
      if (ld.visible !== undefined) layer.visible = ld.visible;
      globalLayers.push(layer);
    }
    if (activeGlobalLayerIdx >= globalLayers.length) {
      activeGlobalLayerIdx = Math.max(0, globalLayers.length - 1);
    }
  }

  function saveGlobalLayers({ propagateGridParams = false } = {}) {
    global.defaultLayers = globalLayers.map(layer => ({
      gridName: layer.gridPlugin.name,
      gridParams: { ...layer.gridParams },
      name: layer.name,
      opacity: layer.opacity,
      visible: layer.visible,
    }));
    // Policy: a global edit wins over per-char overrides. Visibility/opacity
    // overrides are always reconciled (matching values dropped). When
    // propagateGridParams is set — i.e. a grid param/type was just edited
    // globally — also strip per-char gridParamOverrides so the new global
    // values flow through to every glyph (cells are kept; they encode the
    // meshed glyph shape).
    for (const cd of Object.values(project.characters)) {
      const overrides = cd.layerOverrides || [];
      overrides.forEach((lo, i) => {
        if (!lo) return;
        const gl = global.defaultLayers[i];
        if (!gl) return;
        if (lo.opacity === gl.opacity) delete lo.opacity;
        if (lo.visible === gl.visible) delete lo.visible;
        if (!propagateGridParams) return;
        if (lo.gridName && lo.gridName !== gl.gridName) return;
        if (lo.gridParamOverrides) delete lo.gridParamOverrides;
      });
    }
    project.global = global;
    saveProject(project);
  }

  function rebuildLocalState() {
    if (!selectedCharId) {
      localLayers = [];
      localTransformOverrides = {};
      localTransform = resolveTransform(global, {});
      backgroundImage = null;
      return;
    }
    const cd = project.characters[selectedCharId];
    localLayers = buildRuntimeLayers(global, cd, GLYPH_SIZE);
    activeLocalLayerIdx = Math.min(activeLocalLayerIdx, Math.max(0, localLayers.length - 1));
    localTransformOverrides = { ...(cd.transformOverrides || {}) };
    localTransform = resolveTransform(global, localTransformOverrides);
  }

  function loadBackgroundImage() {
    backgroundImage = null;
    if (!selectedCharId) { redraw(); return; }
    const cd = project.characters[selectedCharId];
    if (cd?.imagePath) {
      const targetId = selectedCharId;
      // Cached so undo/redo doesn't re-decode the same base64 blob.
      loadImageCached(cd.imagePath).then(img => {
        if (selectedCharId !== targetId || !img) return;
        backgroundImage = img;
        redraw();
      });
      return;
    }
    if (cd?.fontSource) {
      const targetId = selectedCharId;
      renderFontSourceToCanvas(cd.fontSource, GLYPH_SIZE, global.fontMetrics).then(cv => {
        if (selectedCharId !== targetId) return; // selection changed mid-load
        backgroundImage = cv;
        redraw();
      }).catch(() => { redraw(); });
      return;
    }
    redraw();
  }

  function saveLocalChar() {
    if (!selectedCharId) return;
    const cd = project.characters[selectedCharId];
    const overrides = Object.keys(localTransformOverrides).length > 0 ? localTransformOverrides : undefined;
    const next = {
      imagePath: cd?.imagePath || '',
      layerOverrides: serializeLayerOverrides(localLayers, global),
      transformOverrides: overrides,
    };
    if (cd?.imageOffsetX !== undefined) next.imageOffsetX = cd.imageOffsetX;
    if (cd?.imageOffsetY !== undefined) next.imageOffsetY = cd.imageOffsetY;
    if (cd?.imageScale !== undefined) next.imageScale = cd.imageScale;
    if (cd?.fontSource) next.fontSource = cd.fontSource;
    saveCharacter(selectedCharId, next);
    project.characters[selectedCharId] = { ...cd, ...next };
  }

  // === Sidebar bodies ===
  function renderSidebarBody() {
    sidebarBody.innerHTML = '';
    switch (panel) {
      case 'layers':   renderLayersPanel(); break;
      case 'pen':      renderPenPanel(); break;
      case 'automesh': renderAutoMeshPanel(); break;
      case 'metrics':  renderMetricsPanel(); break;
      case 'props':    renderPropsPanel(); break;
      case 'compose':  sidebarBody.appendChild(composeView.sidebarEl); break;
    }
  }

  function appendNoSelMsg() {
    const msg = document.createElement('div');
    msg.className = 'param-group';
    msg.style.color = 'var(--text-dim)';
    msg.style.fontSize = '12px';
    msg.textContent = 'Select a glyph below to edit.';
    sidebarBody.appendChild(msg);
  }

  function renderLayersPanel() {
    // Layers
    const globalLayerPanel = createLayerPanel(globalLayers, activeGlobalLayerIdx, {
      onSelect(idx) {
        activeGlobalLayerIdx = idx;
        const layer = globalLayers[idx];
        gridSelect.value = layer.gridPlugin.name;
        renderGridParamSliders();
        globalLayerPanel.update(globalLayers, activeGlobalLayerIdx);
        redraw();
      },
      onVisibilityChange() { saveGlobalLayers(); redraw(); refreshAllThumbnails(); historyCommit('layer-visibility'); },
      // Opacity slider commits via the delegated 'change' listener on release;
      // committing here would fire on every input event during the drag.
      onOpacityChange() { saveGlobalLayers(); redraw(); refreshAllThumbnails(); },
      onDelete(idx) {
        globalLayers.splice(idx, 1);
        if (activeGlobalLayerIdx >= globalLayers.length) activeGlobalLayerIdx = globalLayers.length - 1;
        globalLayerPanel.update(globalLayers, activeGlobalLayerIdx);
        if (globalLayers.length > 0) gridSelect.value = globalLayers[activeGlobalLayerIdx].gridPlugin.name;
        renderGridParamSliders();
        saveGlobalLayers();
        redraw();
        historyCommit('layer-delete');
      },
      onAdd() {
        const grid = getGrid(gridSelect.value);
        const defaults = {};
        for (const def of grid.getParamDefs()) defaults[def.key] = def.default;
        const gd = global.gridDefaults?.[grid.name] || {};
        const layer = createLayer(grid, { ...defaults, ...gd });
        globalLayers.push(layer);
        activeGlobalLayerIdx = globalLayers.length - 1;
        globalLayerPanel.update(globalLayers, activeGlobalLayerIdx);
        renderGridParamSliders();
        saveGlobalLayers();
        redraw();
        historyCommit('layer-add');
      },
    });
    sidebarBody.appendChild(globalLayerPanel.el);

    // Grid Type
    const gridSection = document.createElement('div');
    gridSection.className = 'param-group';
    const gridSectionTitle = document.createElement('h3');
    gridSectionTitle.textContent = 'Grid Type';
    gridSection.appendChild(gridSectionTitle);
    const gridSelect = document.createElement('select');
    for (const g of getAllGrids()) {
      const opt = document.createElement('option');
      opt.value = g.name;
      opt.textContent = g.name;
      gridSelect.appendChild(opt);
    }
    if (globalLayers.length > 0) gridSelect.value = globalLayers[activeGlobalLayerIdx].gridPlugin.name;
    gridSelect.addEventListener('change', () => {
      if (globalLayers.length === 0) return;
      const grid = getGrid(gridSelect.value);
      const layer = globalLayers[activeGlobalLayerIdx];
      layer.gridPlugin = grid;
      const defaults = {};
      for (const def of grid.getParamDefs()) defaults[def.key] = def.default;
      const gd = global.gridDefaults?.[grid.name] || {};
      layer.gridParams = { ...defaults, ...gd };
      layer.name = grid.name;
      renderGridParamSliders();
      globalLayerPanel.update(globalLayers, activeGlobalLayerIdx);
      saveGlobalLayers({ propagateGridParams: true });
      redraw();
      refreshAllThumbnails();
    });
    gridSection.appendChild(gridSelect);
    sidebarBody.appendChild(gridSection);

    // Grid Params
    const gridParamGroup = document.createElement('div');
    gridParamGroup.className = 'param-group';
    sidebarBody.appendChild(gridParamGroup);

    function renderGridParamSliders() {
      gridParamGroup.innerHTML = '';
      if (globalLayers.length === 0) return;
      const layer = globalLayers[activeGlobalLayerIdx];
      if (!layer) return;
      const h = document.createElement('h3');
      h.textContent = 'Grid Parameters';
      gridParamGroup.appendChild(h);
      for (const def of layer.gridPlugin.getParamDefs()) {
        const row = document.createElement('div');
        row.className = 'param-row';
        const label = document.createElement('label');
        label.textContent = def.label;
        const { slider, valueInput } = createSliderInput({
          min: def.min, max: def.max, step: def.step,
          value: layer.gridParams[def.key] ?? def.default,
          onInput: (v) => {
            layer.gridParams[def.key] = v;
            saveGlobalLayers({ propagateGridParams: true });
            redraw();
          },
          onChange: () => refreshAllThumbnails(),
        });
        row.appendChild(label);
        row.appendChild(slider);
        row.appendChild(valueInput);
        gridParamGroup.appendChild(row);
      }
    }
    renderGridParamSliders();

    // Transform (global)
    const transformDefs = [
      { key: 'baseGap', label: 'Gap', min: 0, max: 20, default: 0, step: 0.5 },
      { key: 'gapDirectionWeight', label: 'Gap Dir Weight', min: 0, max: 1, default: 0, step: 0.05, hardMin: 0, hardMax: 1 },
      { key: 'metaballRadius', label: 'Blur', min: 0, max: 30, default: 10, step: 1 },
    ];
    const transformGroup = document.createElement('div');
    transformGroup.className = 'param-group';
    const transformTitle = document.createElement('h3');
    transformTitle.textContent = 'Transform';
    transformGroup.appendChild(transformTitle);
    for (const def of transformDefs) {
      const row = document.createElement('div');
      row.className = 'param-row';
      const label = document.createElement('label');
      label.textContent = def.label;
      const { slider, valueInput } = createSliderInput({
        min: def.min, max: def.max, step: def.step,
        value: global[def.key] ?? def.default,
        hardMin: def.hardMin, hardMax: def.hardMax,
        onInput: (v) => {
          global[def.key] = v;
          saveGlobal(global);
          redraw();
        },
        onChange: () => refreshAllThumbnails(),
      });
      row.appendChild(label);
      row.appendChild(slider);
      row.appendChild(valueInput);
      transformGroup.appendChild(row);
    }
    sidebarBody.appendChild(transformGroup);
    // Font export moved to the Settings modal (gear icon in the header).
  }

  // Font Metrics (global) — ascender / x-height / baseline / descender guides.
  function renderMetricsPanel() {
    const metricsDefs = [
      { key: 'ascender',  label: 'Ascender',  default: 0.05 },
      { key: 'xHeight',   label: 'x-Height',  default: 0.30 },
      { key: 'baseline',  label: 'Baseline',  default: 0.80 },
      { key: 'descender', label: 'Descender', default: 0.95 },
    ];
    const metricsGroup = document.createElement('div');
    metricsGroup.className = 'param-group';
    const metricsTitle = document.createElement('h3');
    metricsTitle.textContent = 'Font Metrics';
    metricsGroup.appendChild(metricsTitle);
    if (!global.fontMetrics) global.fontMetrics = {};
    for (const def of metricsDefs) {
      const row = document.createElement('div');
      row.className = 'param-row';
      const label = document.createElement('label');
      label.textContent = def.label;
      const { slider, valueInput } = createSliderInput({
        min: 0, max: 1, step: 0.005,
        value: global.fontMetrics[def.key] ?? def.default,
        hardMin: 0, hardMax: 1,
        formatter: (v) => v.toFixed(3),
        onInput: (v) => {
          global.fontMetrics[def.key] = v;
          saveGlobal(global);
          redraw();
        },
      });
      row.appendChild(label);
      row.appendChild(slider);
      row.appendChild(valueInput);
      metricsGroup.appendChild(row);
    }
    sidebarBody.appendChild(metricsGroup);
  }

  // Auto Mesh — one shared threshold drives both the single-glyph mesh and the
  // batch "all glyphs" pass.
  function renderAutoMeshPanel() {
    const group = document.createElement('div');
    group.className = 'param-group';
    const title = document.createElement('h3');
    title.textContent = 'Auto Mesh';
    group.appendChild(title);

    const threshRow = document.createElement('div');
    threshRow.className = 'param-row';
    const threshLabel = document.createElement('label');
    threshLabel.textContent = 'Threshold';
    const threshApi = createSliderInput({
      min: 0, max: 1, step: 0.05,
      value: 0.5,
      hardMin: 0, hardMax: 1,
    });
    threshRow.appendChild(threshLabel);
    threshRow.appendChild(threshApi.slider);
    threshRow.appendChild(threshApi.valueInput);
    group.appendChild(threshRow);

    const btnRow = document.createElement('div');
    btnRow.className = 'anim-button-row';
    btnRow.style.marginTop = '8px';

    const meshBtn = document.createElement('button');
    meshBtn.className = 'tool-btn';
    meshBtn.textContent = 'Auto Mesh';
    meshBtn.disabled = !selectedCharId;
    meshBtn.addEventListener('click', () => doAutoMesh(threshApi.getValue()));
    btnRow.appendChild(meshBtn);

    const meshAllBtn = document.createElement('button');
    meshAllBtn.className = 'tool-btn';
    meshAllBtn.textContent = 'Auto Mesh All';
    meshAllBtn.addEventListener('click', () => autoMeshAll(meshAllBtn, threshApi.getValue()));
    btnRow.appendChild(meshAllBtn);

    group.appendChild(btnRow);
    sidebarBody.appendChild(group);
  }

  // Pen — the per-character editor (was the "Local" sidebar): paint tools,
  // read-only layer list, per-glyph grid/transform overrides, SVG export and
  // delete. Glyph name + source image moved to the Properties panel.
  function renderPenPanel() {
    if (!selectedCharId) { appendNoSelMsg(); return; }

    // Tools
    const toolbar = createToolbar((tool) => { currentTool = tool; });
    sidebarBody.appendChild(toolbar.el);

    // Per-layer baseline = the layer's own gridParams in global.defaultLayers
    // (NOT global.gridDefaults, which is the per-grid-type fallback). This is
    // what overrides are diffed against, so the override badge is accurate.
    const layerBaseline = (idx) => global.defaultLayers?.[idx]?.gridParams || {};

    // Layer panel (read-only)
    const layerPanel = createLayerPanel(localLayers, activeLocalLayerIdx, {
      readOnly: true,
      onSelect(idx) {
        activeLocalLayerIdx = idx;
        const layer = localLayers[idx];
        paramsPanel.update(layer.gridPlugin.getParamDefs(), layer.gridParams, layerBaseline(idx));
        layerPanel.update(localLayers, activeLocalLayerIdx);
        redraw();
      },
      onVisibilityChange() { redraw(); saveLocalChar(); refreshSelectedThumbnail(); historyCommit('local-layer-visibility'); },
      // Opacity slider commits via delegated 'change' on release.
      onOpacityChange() { redraw(); saveLocalChar(); refreshSelectedThumbnail(); },
    });
    sidebarBody.appendChild(layerPanel.el);

    // Grid params (local override)
    const activeLayer = localLayers[activeLocalLayerIdx];
    const paramsPanel = createParamsPanel(
      activeLayer ? activeLayer.gridPlugin.getParamDefs() : [],
      activeLayer ? activeLayer.gridParams : {},
      layerBaseline(activeLocalLayerIdx),
      {
        localOnly: true,
        onLocalChange(key, val) {
          const layer = localLayers[activeLocalLayerIdx];
          if (!layer) return;
          layer.gridParams[key] = val;
          const baseline = layerBaseline(activeLocalLayerIdx);
          if (val === baseline[key]) {
            delete layer.gridParamOverrides?.[key];
          } else {
            if (!layer.gridParamOverrides) layer.gridParamOverrides = {};
            layer.gridParamOverrides[key] = val;
          }
          regenerateCells(layer, GLYPH_SIZE, GLYPH_SIZE);
          redraw();
          saveLocalChar();
        },
        onGlobalChange() {},
        onReset(key) {
          const layer = localLayers[activeLocalLayerIdx];
          if (!layer) return;
          const baseline = layerBaseline(activeLocalLayerIdx);
          layer.gridParams[key] = baseline[key];
          delete layer.gridParamOverrides?.[key];
          regenerateCells(layer, GLYPH_SIZE, GLYPH_SIZE);
          redraw();
          saveLocalChar();
        },
      }
    );
    sidebarBody.appendChild(paramsPanel.el);

    // Transform (local override)
    const transformPanel = createTransformPanel(localTransform, global, {
      localOnly: true,
      onLocalChange(key, val) {
        localTransform[key] = val;
        if (val === global[key]) {
          delete localTransformOverrides[key];
        } else {
          localTransformOverrides[key] = val;
        }
        redraw();
        saveLocalChar();
      },
      onGlobalChange() {},
      onReset(key) {
        localTransform[key] = global[key];
        delete localTransformOverrides[key];
        transformPanel.render();
        redraw();
        saveLocalChar();
      },
    });
    sidebarBody.appendChild(transformPanel.el);

    // SVG Export — single button opens a dialog with layer-scope + filename.
    const svgSection = document.createElement('div');
    svgSection.className = 'param-group';
    const svgTitle = document.createElement('h3');
    svgTitle.textContent = 'Export';
    svgSection.appendChild(svgTitle);

    const svgBtn = document.createElement('button');
    svgBtn.className = 'tool-btn';
    svgBtn.textContent = 'SVG Export';
    svgBtn.addEventListener('click', async () => {
      const result = await svgExportDialog({
        defaultFilename: `${selectedCharId}.svg`,
        hasActiveLayer: !!localLayers[activeLocalLayerIdx],
      });
      if (!result) return;
      try {
        let svg;
        if (result.scope === 'active') {
          const layer = localLayers[activeLocalLayerIdx];
          if (!layer) return;
          svg = exportLayerToSVG(layer, GLYPH_SIZE, GLYPH_SIZE, {
            transform: localTransform,
            fontMetrics: global.fontMetrics,
          });
        } else {
          svg = exportAllLayersToSVG(localLayers, GLYPH_SIZE, GLYPH_SIZE, {
            transform: localTransform,
            fontMetrics: global.fontMetrics,
          });
        }
        await saveFile(svg, result.filename, 'image/svg+xml');
      } catch (e) {
        console.error(e);
        alert(`SVG export failed: ${e.message}`);
      }
    });
    svgSection.appendChild(svgBtn);
    sidebarBody.appendChild(svgSection);

    // Danger zone: full-width delete button at the bottom
    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'danger-btn';
    deleteBtn.textContent = 'Delete Glyph';
    deleteBtn.addEventListener('click', () => deleteSelectedGlyph());
    sidebarBody.appendChild(deleteBtn);
  }

  // Properties — per-glyph name plus the source image and its placement
  // (load, background opacity, offset & scale).
  function renderPropsPanel() {
    if (!selectedCharId) { appendNoSelMsg(); return; }

    // Glyph (name)
    const glyphSection = document.createElement('div');
    glyphSection.className = 'param-group';
    const glyphTitle = document.createElement('h3');
    glyphTitle.textContent = 'Glyph';
    glyphSection.appendChild(glyphTitle);

    // Capture charId at render time so blur after a glyph switch doesn't
    // try to rename the newly-selected glyph.
    const editingCharId = selectedCharId;
    const nameRow = document.createElement('div');
    nameRow.className = 'param-row';
    const nameLabel = document.createElement('label');
    nameLabel.textContent = 'Name';
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'glyph-name-input';
    nameInput.value = editingCharId;
    function commitName() {
      if (selectedCharId !== editingCharId) return;
      const v = nameInput.value.trim();
      if (!v) { nameInput.value = editingCharId; return; }
      if (v === editingCharId) return;
      const result = renameSelectedGlyph(v);
      if (!result.ok) {
        if (result.reason === 'conflict') alert(`A glyph named "${v}" already exists.`);
        else if (result.reason === 'empty') alert('Name cannot be empty.');
        nameInput.value = editingCharId;
      }
    }
    nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); nameInput.blur(); }
      else if (e.key === 'Escape') { nameInput.value = editingCharId; nameInput.blur(); }
    });
    nameInput.addEventListener('blur', commitName);
    nameRow.appendChild(nameLabel);
    nameRow.appendChild(nameInput);
    glyphSection.appendChild(nameRow);
    sidebarBody.appendChild(glyphSection);

    // Source image
    const imgSection = document.createElement('div');
    imgSection.className = 'param-group';
    const imgTitle = document.createElement('h3');
    imgTitle.textContent = 'Source Image';
    imgSection.appendChild(imgTitle);

    const imgBtn = document.createElement('button');
    imgBtn.className = 'tool-btn';
    imgBtn.textContent = 'Load Image';
    imgBtn.addEventListener('click', loadLocalImage);
    imgSection.appendChild(imgBtn);

    const bgOpRow = document.createElement('div');
    bgOpRow.className = 'param-row';
    bgOpRow.style.marginTop = '8px';
    const bgOpLabel = document.createElement('label');
    bgOpLabel.textContent = 'BG Opacity';
    const bgOpApi = createSliderInput({
      min: 0, max: 1, step: 0.05,
      value: bgOpacity,
      hardMin: 0, hardMax: 1,
      onInput: (v) => {
        bgOpacity = v;
        redraw();
      },
    });
    bgOpRow.appendChild(bgOpLabel);
    bgOpRow.appendChild(bgOpApi.slider);
    bgOpRow.appendChild(bgOpApi.valueInput);
    imgSection.appendChild(bgOpRow);

    // Image transform (per-character offset & scale to align glyph to metrics)
    const imgTransformDefs = [
      { key: 'imageOffsetX', label: 'Image X', min: -GLYPH_SIZE, max: GLYPH_SIZE, default: 0, step: 1 },
      { key: 'imageOffsetY', label: 'Image Y', min: -GLYPH_SIZE, max: GLYPH_SIZE, default: 0, step: 1 },
      { key: 'imageScale',   label: 'Image Scale', min: 0.1, max: 3, default: 1, step: 0.01 },
    ];
    for (const def of imgTransformDefs) {
      const row = document.createElement('div');
      row.className = 'param-row';

      const badge = document.createElement('button');
      badge.type = 'button';
      badge.className = 'override-badge';

      const label = document.createElement('label');
      label.textContent = def.label;

      const api = createSliderInput({
        min: def.min, max: def.max, step: def.step,
        value: def.default,
        formatter: (v) => def.step < 0.1
          ? v.toFixed(2)
          : (Number.isInteger(v) ? String(v) : v.toFixed(2)),
        onInput: (v) => {
          const c = project.characters[selectedCharId];
          if (!c) return;
          if (v === def.default) delete c[def.key];
          else c[def.key] = v;
          syncOverrideUI();
          redraw();
        },
        onChange: () => {
          saveLocalChar();
          refreshSelectedThumbnail();
        },
      });

      function syncFromState() {
        const cd = project.characters[selectedCharId] || {};
        const v = cd[def.key] ?? def.default;
        api.setValue(v);
        syncOverrideUI();
      }

      function syncOverrideUI() {
        const cd = project.characters[selectedCharId] || {};
        const v = cd[def.key] ?? def.default;
        const overridden = v !== def.default;
        label.classList.toggle('overridden', overridden);
        badge.classList.toggle('is-off', !overridden);
        badge.title = overridden ? 'Click to reset override' : '';
        badge.tabIndex = overridden ? 0 : -1;
      }

      function resetThis() {
        const c = project.characters[selectedCharId];
        if (!c) return;
        delete c[def.key];
        syncFromState();
        saveLocalChar();
        redraw();
        refreshSelectedThumbnail();
      }

      badge.addEventListener('click', () => {
        if (!label.classList.contains('overridden')) return;
        resetThis();
      });

      row.appendChild(badge);
      row.appendChild(label);
      row.appendChild(api.slider);
      row.appendChild(api.valueInput);
      imgSection.appendChild(row);
      syncFromState();
    }

    sidebarBody.appendChild(imgSection);
  }

  function loadLocalImage() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/png,image/jpeg';
    input.addEventListener('change', async () => {
      const file = input.files[0];
      if (!file) return;
      const targetId = selectedCharId;
      // Show a local preview immediately while the upload runs.
      const dataUrl = await fileToDataURL(file);
      const previewImg = await loadImage(dataUrl);
      if (selectedCharId === targetId) {
        backgroundImage = previewImg;
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
      const cd = project.characters[targetId];
      saveCharacter(targetId, {
        ...(cd || {}),
        imagePath: url,
        layerOverrides: serializeLayerOverrides(localLayers, global),
        transformOverrides: Object.keys(localTransformOverrides).length > 0 ? localTransformOverrides : undefined,
      });
      project.characters[targetId] = { ...(cd || {}), imagePath: url };
      if (selectedCharId === targetId) {
        refreshSelectedThumbnail();
      }
      historyCommit('load-image');
    });
    input.click();
  }

  function doAutoMesh(threshold) {
    if (!backgroundImage) {
      alert('Load an image first.');
      return;
    }
    const offscreen = document.createElement('canvas');
    offscreen.width = GLYPH_SIZE;
    offscreen.height = GLYPH_SIZE;
    const offCtx = offscreen.getContext('2d');
    // Fill white so areas outside the (possibly offset/scaled) image are
    // treated as background, not dark (transparent → 0,0,0 → counted as black).
    offCtx.fillStyle = '#fff';
    offCtx.fillRect(0, 0, GLYPH_SIZE, GLYPH_SIZE);
    const cd = project.characters[selectedCharId];
    drawSourceImage(offCtx, backgroundImage, 0, 0, GLYPH_SIZE, {
      imageOffsetX: cd?.imageOffsetX ?? 0,
      imageOffsetY: cd?.imageOffsetY ?? 0,
      imageScale: cd?.imageScale ?? 1,
    });
    if (localLayers.length === 0) return;
    for (const layer of localLayers) {
      autoMesh(offCtx, layer.cells, threshold);
    }
    redraw();
    saveLocalChar();
    refreshSelectedThumbnail();
    historyCommit('auto-mesh');
  }

  // === Empty glyph creation ===
  function addEmptyGlyph() {
    const newId = generateUniqueCharId('new');
    createEmptyCharacter(newId);
    project.characters[newId] = { imagePath: '' };
    const card = createCharCard(newId, project.characters[newId], (id) => selectChar(id), (id) => deleteGlyph(id));
    cardElements[newId] = card;
    charStrip.appendChild(card);
    selectChar(newId);   // selectChar → syncCenterView restores the center view
    historyCommit('add-glyph');
  }

  // === Char rename ===
  function renameSelectedGlyph(newId) {
    if (!selectedCharId) return { ok: false, reason: 'missing' };
    const trimmed = (newId || '').trim();
    if (trimmed === selectedCharId) return { ok: true };
    const result = renameCharacter(selectedCharId, trimmed);
    if (!result.ok) return result;
    // Rebuild in-memory project ordering to match storage
    const rebuilt = {};
    for (const [k, v] of Object.entries(project.characters)) {
      rebuilt[k === selectedCharId ? trimmed : k] = v;
    }
    project.characters = rebuilt;
    const card = cardElements[selectedCharId];
    delete cardElements[selectedCharId];
    cardElements[trimmed] = card;
    if (card) {
      const label = card.querySelector('.label');
      if (label) label.textContent = trimmed;
    }
    selectedCharId = trimmed;
    sessionStorage.setItem(SEL_CHAR_KEY, trimmed);
    historyCommit('rename-glyph');
    return { ok: true };
  }

  // === Char delete ===
  function deleteSelectedGlyph() {
    if (!selectedCharId) return;
    deleteGlyph(selectedCharId);
  }

  function deleteGlyph(charId) {
    if (!charId || !project.characters[charId]) return;
    if (!confirm(`Delete glyph "${charId}"?`)) return;
    const wasSelected = charId === selectedCharId;
    deleteCharacter(charId);
    delete project.characters[charId];
    const card = cardElements[charId];
    if (card) card.remove();
    delete cardElements[charId];
    if (wasSelected) {
      const remaining = Object.keys(project.characters);
      selectedCharId = remaining[0] ?? null;
      if (selectedCharId && cardElements[selectedCharId]) {
        cardElements[selectedCharId].classList.add('selected');
      }
      syncCenterView();
      rebuildLocalState();
      loadBackgroundImage();
      renderSidebarBody();
      redraw();
    }
    historyCommit('delete-glyph');
  }

  // === Char import ===

  /** Shared importer UI hooks for both image-file and font-family imports. */
  function makeImportHooks(historyTag) {
    return {
      progressWrap, progressBar, progressText,
      getStrip: () => charStrip,
      // The "+" tile lives outside the strip now, so imported cards just append
      // to the end of the scroll strip.
      insertBefore: () => null,
      createCard: (charId, charData) => {
        const card = createCharCard(charId, charData, (id) => selectChar(id), (id) => deleteGlyph(id));
        cardElements[charId] = card;
        return card;
      },
      onDone: () => {
        if (!selectedCharId && Object.keys(project.characters).length > 0) {
          const firstId = Object.keys(project.characters)[0];
          selectChar(firstId);
        }
        redraw();
        historyCommit(historyTag);
      },
    };
  }

  /** Unified "+" affordance: tabbed dialog for image / font / empty. */
  async function openAddGlyphDialog() {
    const result = await glyphAddDialog({
      presets: FONT_IMPORT_PRESETS,
      familySuggestions: [
        'Noto Sans JP', 'Noto Serif JP', 'M PLUS 1p', 'Kosugi Maru',
        'Roboto', 'Inter', 'Noto Sans', 'Open Sans', 'Lato',
      ],
      defaultFamily: 'Noto Sans JP',
      defaultPresetIds: ['hiragana'],
    });
    if (!result) return;
    if (result.mode === 'image') {
      importImages(project, makeImportHooks('import-images'));
    } else if (result.mode === 'font') {
      const chars = buildCharSet(result.presetIds, result.customText);
      if (chars.length === 0) return;
      await importFromFont(project, result.family, chars, makeImportHooks('import-from-font'));
    } else if (result.mode === 'empty') {
      addEmptyGlyph();
    }
  }

  // === Selection ===
  function selectChar(charId) {
    if (selectedCharId && cardElements[selectedCharId]) {
      cardElements[selectedCharId].classList.remove('selected');
    }
    selectedCharId = charId;
    if (charId) sessionStorage.setItem(SEL_CHAR_KEY, charId);
    else sessionStorage.removeItem(SEL_CHAR_KEY);
    if (cardElements[charId]) cardElements[charId].classList.add('selected');
    syncCenterView();
    rebuildLocalState();
    loadBackgroundImage();
    // Per-character panels show the selected glyph's state, so re-render them
    // on selection change.
    if (isLocalContext()) renderSidebarBody();
    redraw();
  }

  function refreshSelectedThumbnail() {
    if (!selectedCharId) return;
    const card = cardElements[selectedCharId];
    if (!card) return;
    const canvas = card.querySelector('canvas');
    if (canvas) renderThumbnail(canvas, project.characters[selectedCharId]);
  }

  function refreshAllThumbnails() {
    for (const charId of Object.keys(project.characters)) {
      const card = cardElements[charId];
      if (!card) continue;
      const canvas = card.querySelector('canvas');
      if (canvas) renderThumbnail(canvas, project.characters[charId]);
    }
  }

  // === Auto Mesh All ===
  async function autoMeshAll(btn, threshold = 0.5) {
    btn.disabled = true;
    btn.textContent = 'Meshing...';
    progressWrap.style.display = '';
    const targets = Object.keys(project.characters).filter(cid => {
      const cd = project.characters[cid];
      return cd?.imagePath || cd?.fontSource;
    });
    const total = targets.length;
    let done = 0;
    progressBar.style.width = '0%';
    progressText.textContent = `0 / ${total}`;
    const offscreen = document.createElement('canvas');
    offscreen.width = GLYPH_SIZE;
    offscreen.height = GLYPH_SIZE;
    const offCtx = offscreen.getContext('2d');
    for (const cid of targets) {
      const cd = project.characters[cid];
      let source = null;
      if (cd?.imagePath) {
        source = await loadImageCached(cd.imagePath);
      } else if (cd?.fontSource) {
        try {
          source = await renderFontSourceToCanvas(cd.fontSource, GLYPH_SIZE, global.fontMetrics);
        } catch { source = null; }
      }
      if (!source) { done++; continue; }
      offCtx.fillStyle = '#fff';
      offCtx.fillRect(0, 0, GLYPH_SIZE, GLYPH_SIZE);
      drawSourceImage(offCtx, source, 0, 0, GLYPH_SIZE, {
        imageOffsetX: cd?.imageOffsetX ?? 0,
        imageOffsetY: cd?.imageOffsetY ?? 0,
        imageScale: cd?.imageScale ?? 1,
      });
      const layers = buildRuntimeLayers(global, cd, GLYPH_SIZE);
      for (const layer of layers) await autoMeshAsync(offCtx, layer.cells, threshold);
      cd.layerOverrides = serializeLayerOverrides(layers, global);
      done++;
      progressBar.style.width = Math.round((done / total) * 100) + '%';
      progressText.textContent = `${done} / ${total}`;
      await new Promise(r => requestAnimationFrame(r));
    }
    saveProject(project);
    if (isLocalContext()) rebuildLocalState();
    refreshAllThumbnails();
    redraw();
    progressWrap.style.display = 'none';
    btn.disabled = false;
    btn.textContent = 'Auto Mesh All';
    historyCommit('auto-mesh-all');
  }

  // === Render ===
  // Guides-view offscreen buffer. offCtxL doubles as the hit-test context in
  // handlePaint.
  const offCanvasL = document.createElement('canvas');
  offCanvasL.width = GLYPH_SIZE;
  offCanvasL.height = GLYPH_SIZE;
  const offCtxL = offCanvasL.getContext('2d');

  // Resolve the layers + base transform for the selected glyph.
  function currentRender() {
    if (isLocalContext()) {
      return { layers: localLayers, transform: localTransform };
    }
    const cd = project.characters[selectedCharId];
    return {
      layers: buildRuntimeLayers(global, cd, GLYPH_SIZE),
      transform: resolveTransform(global, cd.transformOverrides || {}),
    };
  }

  function clearDisplay(canvas, ctx) {
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  // Cheap step: paint an already-rendered offscreen buffer into a display canvas
  // at the given zoom. Zoom does NOT affect the offscreen, so changing scale
  // only needs this, not a re-render. The offscreen is square and the glyph is
  // centered in it, so centering the offscreen in the display yields a
  // zoom-independent glyph center (relied on by handlePaint).
  function blit(canvas, ctx, offCanvas, scale) {
    clearDisplay(canvas, ctx);
    const size = offCanvas.width;
    const dw = size * scale;
    const dh = size * scale;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(offCanvas, (canvas.width - dw) / 2, (canvas.height - dh) / 2, dw, dh);
  }

  // Heavy step: render the glyph into an offscreen buffer (this runs the
  // per-cell transform + the metaball blur/contrast filter), then blit it.
  //
  // The offscreen grows with the current transform so stretched / blurred
  // content that overshoots the glyph boundary isn't clipped. The editor uses
  // true per-cell stretch (metrics guides must stay un-skewed, so we can't use
  // the image-affine approximation compose/animation employ). Slider-bounded
  // stretchAmount keeps memory in check (~100 MB worst case at GLYPH_SIZE=1024,
  // stretch=2). Extra margin is added for metrics labels drawn just outside the
  // glyph; preview panes skip guides so they need no margin.
  function renderTarget(canvas, ctx, offCanvas, offCtx, { layers, transform, preview, showBackground, scale, activeLayerIndex, overlayActiveFill }) {
    const stretchFactor = 1 + 2 * (transform.stretchAmount || 0);
    const cacheScale = stretchFactor + (computeCacheScale(transform) - 1);
    const baseSize = Math.ceil(GLYPH_SIZE * cacheScale);
    const labelMargin = (!preview && global.fontMetrics) ? metricsLabelMargin(GLYPH_SIZE) * 2 : 0;
    const canvasSize = baseSize + labelMargin;
    if (offCanvas.width !== canvasSize || offCanvas.height !== canvasSize) {
      offCanvas.width = canvasSize;
      offCanvas.height = canvasSize;
    }
    offCtx.fillStyle = '#fff';
    offCtx.fillRect(0, 0, canvasSize, canvasSize);
    const cd = project.characters[selectedCharId];
    renderCanvas(offCtx, layers, {
      backgroundImage: showBackground ? backgroundImage : null,
      backgroundOpacity: bgOpacity,
      transform,
      glyphSize: GLYPH_SIZE,
      preview,
      fontMetrics: global.fontMetrics,
      activeLayerIndex,
      overlayActiveFill,
      imageTransform: {
        imageOffsetX: cd?.imageOffsetX ?? 0,
        imageOffsetY: cd?.imageOffsetY ?? 0,
        imageScale: cd?.imageScale ?? 1,
      },
    });
    blit(canvas, ctx, offCanvas, scale);
  }

  // Guides view: drop stretch only (gap/blur kept), show every guide + the
  // source image — the paintable reference.
  function renderLeft(rc = currentRender()) {
    const leftTransform = { ...rc.transform, stretchAmount: 0, stretchAngle: 0 };
    renderTarget(previewCanvasL, previewCtxL, offCanvasL, offCtxL, {
      layers: rc.layers, transform: leftTransform, preview: false, showBackground: true, scale: scaleL,
      // Active-layer highlight: red grid outline (+ red fill overlay in the
      // per-character / local editor) so it's clear which layer is being painted.
      activeLayerIndex: isLocalContext() ? activeLocalLayerIdx : activeGlobalLayerIdx,
      // Only the Pen panel paints, so reserve the red fill overlay for it.
      overlayActiveFill: panel === 'pen',
    });
  }

  function redraw() {
    if (!selectedCharId) {
      clearDisplay(previewCanvasL, previewCtxL);
      return;
    }
    renderLeft();
  }

  /**
   * Re-bind in-memory project state and refresh in-place DOM. Called by
   * main.js after undo/redo so the existing page DOM (header, sidebar shell,
   * preview canvas) is kept and only the dependent state is reset.
   *
   * `changes` (from restoreFromSnapshot) lets us skip the most expensive
   * work — re-rasterizing every thumbnail — when the diff is small:
   *   - globalChanged: any global setting or layer changed → all thumbs
   *     depend on it (buildRuntimeLayers reads global), so refresh all.
   *   - otherwise: only re-render thumbs for the chars that changed.
   */
  function refresh(changes) {
    const next = loadProject();
    // project is a const reference held by panels & callbacks — assign
    // properties onto it rather than rebinding.
    Object.assign(project, next);
    // global is likewise captured by long-lived closures (sidebar panels and
    // the compose view's stretch control), so update it in place rather than
    // rebinding — otherwise those closures would read/write a stale object
    // after undo/redo (which swaps _fp.global for a fresh snapshot object).
    const nextGlobal = getGlobal();
    if (nextGlobal !== global) {
      for (const k of Object.keys(global)) delete global[k];
      Object.assign(global, nextGlobal);
    }
    project.global = global;

    // Validate selection: undo may have deleted the active glyph.
    const charIds = Object.keys(project.characters);
    if (selectedCharId && !project.characters[selectedCharId]) {
      selectedCharId = charIds[0] ?? null;
      if (selectedCharId) sessionStorage.setItem(SEL_CHAR_KEY, selectedCharId);
      else sessionStorage.removeItem(SEL_CHAR_KEY);
    }

    // Diff char strip — drop removed, add new, reorder existing in place.
    const newIdSet = new Set(charIds);
    for (const cid of Object.keys(cardElements)) {
      if (!newIdSet.has(cid)) {
        cardElements[cid].remove();
        delete cardElements[cid];
      }
    }
    const addedIds = new Set();
    for (const cid of charIds) {
      if (!cardElements[cid]) {
        cardElements[cid] = createCharCard(cid, project.characters[cid], (id) => selectChar(id), (id) => deleteGlyph(id));
        addedIds.add(cid);
      }
      charStrip.appendChild(cardElements[cid]); // appending moves to end → ordered
    }

    for (const cid of Object.keys(cardElements)) {
      cardElements[cid].classList.toggle('selected', cid === selectedCharId);
    }

    syncCenterView();

    // Thumbnails are the heavy part — each does a 1024² buildRuntimeLayers
    // + metaball renderCanvas + downscale. Skip the ones we know haven't
    // changed.
    const refreshAll = !changes || changes.globalChanged || !changes.changedCharIds;
    if (refreshAll) {
      refreshAllThumbnails();
    } else {
      const toRefresh = new Set([...changes.changedCharIds, ...addedIds]);
      for (const cid of toRefresh) {
        const card = cardElements[cid];
        if (!card) continue;
        const canvas = card.querySelector('canvas');
        if (canvas) renderThumbnail(canvas, project.characters[cid]);
      }
    }
    rebuildGlobalLayers();
    rebuildLocalState();
    // Sidebar only depends on globals + selected char's local state. Skip
    // its full rebuild when neither changed.
    const sidebarStale = refreshAll
      || (selectedCharId && changes.changedCharIds.has(selectedCharId));
    if (sidebarStale) renderSidebarBody();
    loadBackgroundImage();
    redraw();
    // Keep the compose composition in sync with undone/redone glyph state.
    composeView.invalidate();
    if (panel === 'compose') composeView.redraw();
  }

  return { refresh };
}

function createCharCard(charId, charData, onSelect, onDelete) {
  const card = document.createElement('div');
  card.className = 'char-card';
  card.addEventListener('click', () => onSelect(charId));
  const canvas = document.createElement('canvas');
  canvas.width = 80;
  canvas.height = 80;
  renderThumbnail(canvas, charData);
  card.appendChild(canvas);
  if (onDelete) {
    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'char-card-delete';
    delBtn.title = `Delete glyph "${charId}"`;
    delBtn.textContent = '×';
    delBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      onDelete(charId);
    });
    card.appendChild(delBtn);
  }
  return card;
}

function renderThumbnail(canvas, charData) {
  if (!charData) {
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    return;
  }
  const offscreen = document.createElement('canvas');
  offscreen.width = GLYPH_SIZE;
  offscreen.height = GLYPH_SIZE;
  const offCtx = offscreen.getContext('2d');
  const global = getGlobal();
  const layers = buildRuntimeLayers(global, charData, GLYPH_SIZE);
  const transformOverrides = charData.transformOverrides || {};
  // Thumbnails always render at neutral stretch so they don't update on every
  // slider tick (re-meshing every glyph is too expensive). The preview canvas
  // still reflects the live stretch state.
  const transform = {
    ...resolveTransform(global, transformOverrides),
    stretchAngle: 0,
    stretchAmount: 0,
  };
  const imageTransform = {
    imageOffsetX: charData.imageOffsetX ?? 0,
    imageOffsetY: charData.imageOffsetY ?? 0,
    imageScale: charData.imageScale ?? 1,
  };
  const drawWithBackground = (bg) => {
    renderCanvas(offCtx, layers, {
      backgroundImage: bg,
      backgroundOpacity: 0.3,
      transform,
      glyphSize: GLYPH_SIZE,
      preview: true,
      imageTransform,
      fontMetrics: global.fontMetrics,
    });
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(offscreen, 0, 0, canvas.width, canvas.height);
  };
  if (charData.imagePath) {
    loadImageCached(charData.imagePath).then(img => {
      if (img) drawWithBackground(img);
      else drawWithBackground(null);
    });
  } else if (charData.fontSource) {
    renderFontSourceToCanvas(charData.fontSource, GLYPH_SIZE, global.fontMetrics)
      .then(drawWithBackground)
      .catch(() => drawWithBackground(null));
  } else {
    renderCanvas(offCtx, layers, {
      transform,
      glyphSize: GLYPH_SIZE,
      preview: true,
      fontMetrics: global.fontMetrics,
    });
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(offscreen, 0, 0, canvas.width, canvas.height);
  }
}

function importImages(project, ui) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/png,image/jpeg,image/gif';
  input.multiple = true;
  input.addEventListener('change', async () => {
    const files = Array.from(input.files);
    if (files.length === 0) return;
    const empty = document.querySelector('.empty-state');
    if (empty) empty.style.display = 'none';
    ui.progressWrap.style.display = '';
    const total = files.length;
    let done = 0;
    ui.progressText.textContent = `0 / ${total}`;
    ui.progressBar.style.width = '0%';
    const offscreen = document.createElement('canvas');
    offscreen.width = GLYPH_SIZE;
    offscreen.height = GLYPH_SIZE;
    const offCtx = offscreen.getContext('2d');
    const strip = ui.getStrip();
    for (const file of files) {
      const charId = file.name.replace(/\.[^.]+$/, '');
      if (!project.characters[charId]) {
        const g = getGlobal();
        const importLayers = [];
        for (const gl of g.defaultLayers) {
          const gridPlugin = getGrid(gl.gridName);
          if (!gridPlugin) continue;
          // Build from the configured global layer's own params, not the
          // per-grid-type fallback in gridDefaults — otherwise every key
          // gets serialized as a spurious per-char override.
          const layer = createLayer(gridPlugin, { ...(gl.gridParams || {}) });
          layer.name = gl.name || gl.gridName;
          regenerateCells(layer, GLYPH_SIZE, GLYPH_SIZE);
          importLayers.push(layer);
        }
        // Local mesh from the file bytes, plus parallel Storage upload — the
        // upload result (HTTPS URL) is what we persist as imagePath.
        const localPreview = await fileToDataURL(file);
        const img = await loadImage(localPreview);
        offCtx.clearRect(0, 0, GLYPH_SIZE, GLYPH_SIZE);
        offCtx.drawImage(img, 0, 0, GLYPH_SIZE, GLYPH_SIZE);
        for (const layer of importLayers) await autoMeshAsync(offCtx, layer.cells, 0.5);
        let imageUrl;
        try {
          imageUrl = await uploadCharacterImage({ charId, file });
        } catch (e) {
          console.warn(`Upload failed for ${charId}:`, e);
          // Skip the failing glyph entirely to avoid persisting a giant data
          // URL that won't sync to Firestore.
          done++;
          ui.progressBar.style.width = Math.round((done / total) * 100) + '%';
          ui.progressText.textContent = `${done} / ${total}`;
          await new Promise(r => requestAnimationFrame(r));
          continue;
        }
        const charData = {
          imagePath: imageUrl,
          layerOverrides: serializeLayerOverrides(importLayers, g),
        };
        project.characters[charId] = charData;
        const card = ui.createCard(charId, charData);
        const before = ui.insertBefore?.();
        if (before && before.parentNode === strip) {
          strip.insertBefore(card, before);
        } else {
          strip.appendChild(card);
        }
      }
      done++;
      ui.progressBar.style.width = Math.round((done / total) * 100) + '%';
      ui.progressText.textContent = `${done} / ${total}`;
      await new Promise(r => requestAnimationFrame(r));
    }
    saveProject(project);
    ui.progressWrap.style.display = 'none';
    if (ui.onDone) ui.onDone();
  });
  input.click();
}

/**
 * Generate glyphs for `chars` using a Google Fonts family, render each into
 * an offscreen canvas, and run the same autoMesh pipeline as the image-file
 * import. To keep localStorage usage sane (Joyo can be 2k+ glyphs) we omit
 * `imagePath` — the meshed result is stored directly in `layerOverrides`.
 */
async function importFromFont(project, family, chars, ui) {
  const empty = document.querySelector('.empty-state');
  if (empty) empty.style.display = 'none';
  ui.progressWrap.style.display = '';
  ui.progressBar.style.width = '0%';
  ui.progressText.textContent = `Loading font...`;

  try {
    await loadGoogleFont(family, chars.join(''));
  } catch (e) {
    ui.progressWrap.style.display = 'none';
    alert(e.message || 'Font load failed');
    return;
  }

  const total = chars.length;
  ui.progressText.textContent = `0 / ${total}`;
  const offscreen = document.createElement('canvas');
  offscreen.width = GLYPH_SIZE;
  offscreen.height = GLYPH_SIZE;
  const offCtx = offscreen.getContext('2d');
  const strip = ui.getStrip();
  let done = 0;
  for (const ch of chars) {
    const charId = ch;
    if (!project.characters[charId]) {
      const g = getGlobal();
      const importLayers = [];
      for (const gl of g.defaultLayers) {
        const gridPlugin = getGrid(gl.gridName);
        if (!gridPlugin) continue;
        const layer = createLayer(gridPlugin, { ...(gl.gridParams || {}) });
        layer.name = gl.name || gl.gridName;
        regenerateCells(layer, GLYPH_SIZE, GLYPH_SIZE);
        importLayers.push(layer);
      }
      renderCharToContext(offCtx, ch, family, GLYPH_SIZE, g.fontMetrics);
      for (const layer of importLayers) await autoMeshAsync(offCtx, layer.cells, 0.5);
      const charData = {
        layerOverrides: serializeLayerOverrides(importLayers, g),
        fontSource: { family, char: ch },
      };
      project.characters[charId] = charData;
      const card = ui.createCard(charId, charData);
      const before = ui.insertBefore?.();
      if (before && before.parentNode === strip) {
        strip.insertBefore(card, before);
      } else {
        strip.appendChild(card);
      }
    }
    done++;
    ui.progressBar.style.width = Math.round((done / total) * 100) + '%';
    ui.progressText.textContent = `${done} / ${total}`;
    await new Promise(r => requestAnimationFrame(r));
  }
  saveProject(project);
  ui.progressWrap.style.display = 'none';
  if (ui.onDone) ui.onDone();
}

function fileToDataURL(file) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.readAsDataURL(file);
  });
}

function loadImage(src) {
  return new Promise((resolve) => {
    const img = new Image();
    // Set crossOrigin before src so HTTPS Storage URLs can be drawn into a
    // canvas without tainting it (data: URLs ignore the attribute).
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.src = src;
  });
}

/**
 * Save a Blob through the OS save dialog (Chrome/Edge) so the user picks the
 * filename and folder. Falls back to anchor-download on Safari/Firefox.
 * Silently no-ops if the user cancels the picker.
 */
async function saveBlobWithPicker(blob, suggestedName, { description = '', accept } = {}) {
  if (typeof window.showSaveFilePicker === 'function') {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName,
        types: accept ? [{ description, accept }] : undefined,
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return;
    } catch (e) {
      if (e?.name === 'AbortError') return;
      console.warn('Save picker failed, falling back to download:', e);
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = suggestedName;
  a.click();
  URL.revokeObjectURL(url);
}
