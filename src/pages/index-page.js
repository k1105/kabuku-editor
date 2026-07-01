import { loadProject, saveProject, saveCharacter, getGlobal, saveGlobal, serializeLayerOverrides, resolveTransform, deleteCharacter, renameCharacter, generateUniqueCharId, createEmptyCharacter, currentFontProjectId, currentFontProjectName, flushNow as flushProjectNow, subscribeProject, hasUnsavedChanges as fontHasUnsavedChanges } from '../core/project.js';
import { loadImageCached } from '../core/image-cache.js';
import { getGrid } from '../grids/grid-plugin.js';
import { createLayer } from '../core/layer.js';
import { autoMeshAsync } from '../core/mesh.js';
import { propagateOrientation, setCellOrientationManual, estimatePitch } from '../core/orientation.js';
import { buildRuntimeLayers } from '../core/layer-builder.js';
import { glyphAddDialog } from '../ui/export-dialog.js';
import { PRESETS as FONT_IMPORT_PRESETS, buildCharSet } from '../render/font/char-ranges.js';
import { renderFontSourceToCanvas } from '../render/font/font-import.js';
import { importLocalFontFile } from '../render/font/local-font.js';
import { renderKanjiVGSourceToCanvas } from '../render/font/kanjivg-import.js';
import { createPageHeader } from '../ui/page-header.js';
import { commit as historyCommit } from '../core/history.js';
import { drawSourceImage } from '../render/canvas-renderer.js';
import { createParamRow } from '../ui/param-row.js';
import { createStretchControl } from '../ui/preview-controls.js';
import { createIconRail } from '../ui/icon-rail.js';
import { createComposeView } from '../compose/compose-view.js';
import { GLYPH_SIZE } from './index/constants.js';
import { createCharCard, renderThumbnail } from './index/char-cards.js';
import { importImages, importFromFont, importFromKanjiVG } from './index/char-import.js';
import { setupIndexSettings } from './index/settings-actions.js';
import { createKvgEditor } from './index/kvg-editor.js';
import { createSidebarPanels } from './index/sidebar-panels.js';
import { createGuidesRenderer } from './index/guides-renderer.js';

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
  const PANELS = ['layers', 'pen', 'automesh', 'metrics', 'compose'];
  let panel = PANELS.includes(sessionStorage.getItem(PANEL_KEY))
    ? sessionStorage.getItem(PANEL_KEY)
    : 'layers';
  // Panels that edit the selected glyph's per-character state (live paint
  // edits, image placement, meshing) need the in-memory local layers; the
  // others render straight from the global config.
  const isLocalContext = () => panel === 'pen' || panel === 'automesh';

  // Paint state
  let currentTool = 'paint';
  let showOrientation = false; // overlay per-cell stroke tangent ticks
  let isPainting = false;
  let backgroundImage = null;
  let bgOpacity = 0.3;

  // Preview mode (outside Compose): hides grid + background and locks every
  // parameter, leaving only glyph selection and the stretch controls (which
  // exist only while preview is active). Never on in the Compose panel.
  let previewMode = false;

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
  // True while the base-image layer (下地) is the active selection in the Pen
  // panel. Suppresses the grid red highlight and emphasizes the source image
  // on the canvas instead.
  let baseLayerActive = false;
  let localTransformOverrides = {};
  let localTransform = resolveTransform(global, {});

  // === Header ===
  const projectName = currentFontProjectName() || 'KABUKU Editor';
  const { el: header, headerNav: headerActions, progressEl } = createPageHeader({
    activePage: 'glyphs',
    fontProjectId: currentFontProjectId(),
    title: projectName,
    save: {
      flush: () => flushProjectNow(),
      subscribe: subscribeProject,
      isDirty: fontHasUnsavedChanges,
    },
  });
  const progressWrap = progressEl.wrap;
  const progressBar = progressEl.bar;
  const progressText = progressEl.text;

  const settings = setupIndexSettings({ project, global, headerActions });
  const settingsBackdrop = settings.el;

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
  const rail = createIconRail([
    { id: 'layers',   icon: 'lucide:layers',   title: 'Layers' },
    { id: 'pen',      icon: 'lucide:pen-tool', title: 'Pen' },
    { id: 'automesh', icon: 'lucide:grid-3x3', title: 'Auto Mesh' },
    { id: 'metrics',  icon: 'lucide:ruler',    title: 'Font Metrics' },
    { id: 'compose',  icon: 'lucide:type',     title: 'Compose' },
  ], (id) => setPanel(id));
  const iconRail = rail.el;
  function syncRailButtons() {
    rail.setActive(panel);
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
    const { row } = createParamRow('Scale', {
      min: 0.25,
      max: 3,
      step: 0.05,
      value: get(),
      onInput: (v) => { set(v); apply(); },
    });
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

  // Glyph name editor, docked at the top-center of the viewport (same overlay
  // idea as the Scale slider at the bottom). Replaces the former Properties
  // panel, which held only this one field.
  const nameOverlay = document.createElement('div');
  nameOverlay.className = 'index-pane-name';
  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.className = 'glyph-name-input';
  nameInput.setAttribute('aria-label', 'Glyph name');
  nameOverlay.appendChild(nameInput);
  function syncGlyphNameInput() {
    // Hidden whenever the Guides pane is (no selection, or Compose panel).
    const show = !!selectedCharId && panel !== 'compose';
    nameOverlay.style.display = show ? '' : 'none';
    if (show && document.activeElement !== nameInput) nameInput.value = selectedCharId;
  }
  function commitGlyphName() {
    const editingCharId = selectedCharId;
    if (!editingCharId) return;
    const v = nameInput.value.trim();
    if (!v || v === editingCharId) { nameInput.value = editingCharId; return; }
    const result = renameSelectedGlyph(v);
    if (!result.ok) {
      if (result.reason === 'conflict') alert(`A glyph named "${v}" already exists.`);
      else if (result.reason === 'empty') alert('Name cannot be empty.');
      nameInput.value = editingCharId;
    }
  }
  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); nameInput.blur(); }
    else if (e.key === 'Escape') { nameInput.value = selectedCharId || ''; nameInput.blur(); }
  });
  nameInput.addEventListener('blur', commitGlyphName);

  // Left pane controls (docked at bottom): zoom only — stretch never affects
  // this pane.
  const leftBar = document.createElement('div');
  leftBar.className = 'index-pane-controls';
  leftBar.appendChild(createScaleRow(
    () => scaleL,
    (v) => { scaleL = v; sessionStorage.setItem(SCALE_L_KEY, String(v)); },
    () => { renderer.blitCurrent(); kvg.drawOverlay(); },
  ));

  // Stretch sliders (伸縮 / 伸縮の角度) — present only while preview is active.
  const stretchControl = createStretchControl({
    global,
    onInput: () => renderLeft(),
  });
  const stretchWrap = document.createElement('div');
  stretchWrap.className = 'pane-stretch';
  stretchWrap.style.display = 'none';
  for (const row of stretchControl.rows) stretchWrap.appendChild(row);
  leftBar.appendChild(stretchWrap);

  // Preview toggle, pinned to the right end of the bar (margin-left:auto in CSS).
  // Hidden in the Compose panel (syncCenterView hides the whole pane there).
  const previewToggleBtn = document.createElement('button');
  previewToggleBtn.type = 'button';
  previewToggleBtn.className = 'pane-preview-btn';
  previewToggleBtn.textContent = 'Preview';
  previewToggleBtn.addEventListener('click', () => setPreviewMode(!previewMode));
  leftBar.appendChild(previewToggleBtn);

  leftPane.appendChild(previewCanvasL);
  leftPane.appendChild(leftTag);
  leftPane.appendChild(nameOverlay);
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
  // Disconnect on page teardown — an observing ResizeObserver keeps this
  // page's entire closure alive after navigation.
  window.addEventListener('hashchange', function detachResizeObserver() {
    resizeObserver.disconnect();
    window.removeEventListener('hashchange', detachResizeObserver);
  });
  requestAnimationFrame(() => resizeCanvas());

  // KanjiVG base-path editor (active while a kanjivg base layer is selected).
  const kvg = createKvgEditor({
    canvas: previewCanvasL,
    ctx: previewCtxL,
    getEnv: () => ({ project, selectedCharId, baseLayerActive, panel, previewMode, scaleL, global }),
    setBackgroundImage: (cv) => { backgroundImage = cv; },
    redraw: () => redraw(),
  });

  // Sidebar panels operate on this page's closure state through accessor
  // properties; the page stays the single source of truth.
  // Accessor view over this page's closure state, shared by the extracted
  // sidebar-panels and guides-renderer modules. The page stays the single
  // source of truth; modules read/write through these properties.
  const pageState = {
    get panel() { return panel; },
    get previewMode() { return previewMode; },
    get scaleL() { return scaleL; },
    get project() { return project; },
    get global() { return global; },
    get selectedCharId() { return selectedCharId; },
    get globalLayers() { return globalLayers; },
    get activeGlobalLayerIdx() { return activeGlobalLayerIdx; },
    set activeGlobalLayerIdx(v) { activeGlobalLayerIdx = v; },
    get localLayers() { return localLayers; },
    get activeLocalLayerIdx() { return activeLocalLayerIdx; },
    set activeLocalLayerIdx(v) { activeLocalLayerIdx = v; },
    get baseLayerActive() { return baseLayerActive; },
    set baseLayerActive(v) { baseLayerActive = v; },
    get currentTool() { return currentTool; },
    set currentTool(v) { currentTool = v; },
    get showOrientation() { return showOrientation; },
    set showOrientation(v) { showOrientation = v; },
    get bgOpacity() { return bgOpacity; },
    set bgOpacity(v) { bgOpacity = v; },
    get backgroundImage() { return backgroundImage; },
    set backgroundImage(v) { backgroundImage = v; },
    get localTransform() { return localTransform; },
    get localTransformOverrides() { return localTransformOverrides; },
  };

  const panels = createSidebarPanels({
    sidebarBody,
    ctx: pageState,
    deps: {
      kvg,
      redraw: () => redraw(),
      saveGlobalLayers: (opts) => saveGlobalLayers(opts),
      refreshAllThumbnails: () => refreshAllThumbnails(),
      saveLocalChar: () => saveLocalChar(),
      refreshSelectedThumbnail: () => refreshSelectedThumbnail(),
      loadBackgroundImage: () => loadBackgroundImage(),
      deleteSelectedGlyph: () => deleteSelectedGlyph(),
      autoMeshAll: (btn, threshold) => autoMeshAll(btn, threshold),
    },
  });

  // Painting happens on the left (un-stretched, guide) pane only — its cell
  // geometry matches the hit-test paths.
  previewCanvasL.addEventListener('mousedown', (e) => {
    if (previewMode || panel !== 'pen') return;
    // While the 下地 layer is active we're editing the base, not painting cells.
    // For kanjivg bases, drag the path anchors/handles.
    if (baseLayerActive) {
      if (kvg.isEditing()) {
        const hit = kvg.hitTest(e);
        if (hit) kvg.startDrag(hit);
      }
      return;
    }
    if (currentTool === 'orient') { applyOrientAt(e); return; }
    // Only the fill tools mutate cell.filled — guard against any other tool
    // accidentally erasing (newFilled would otherwise be false).
    if (currentTool !== 'paint' && currentTool !== 'erase') return;
    isPainting = true;
    handlePaint(e);
  });
  previewCanvasL.addEventListener('mousemove', (e) => {
    if (kvg.hasDrag()) { kvg.dragMove(e); return; }
    if (!isPainting) return;
    handlePaint(e);
  });
  previewCanvasL.addEventListener('mouseup', () => {
    if (kvg.hasDrag()) {
      kvg.endDrag();
      saveLocalChar();
      refreshSelectedThumbnail();
      historyCommit('kvg-edit');
      return;
    }
    if (!isPainting) return;
    isPainting = false;
    saveLocalChar();
    refreshSelectedThumbnail();
    historyCommit('paint');
  });
  previewCanvasL.addEventListener('mouseleave', () => {
    if (kvg.hasDrag()) {
      kvg.endDrag();
      saveLocalChar();
      refreshSelectedThumbnail();
      historyCommit('kvg-edit');
      return;
    }
    if (!isPainting) return;
    isPainting = false;
    saveLocalChar();
    refreshSelectedThumbnail();
    historyCommit('paint');
  });
  // Double-click an anchor to toggle smooth/broken handle continuity.
  previewCanvasL.addEventListener('dblclick', (e) => {
    if (previewMode || panel !== 'pen' || !kvg.isEditing()) return;
    if (!kvg.toggleAnchorModeAt(e)) return;
    saveLocalChar();
    historyCommit('kvg-edit');
  });

  // Cell under the cursor in the active local layer (+ that layer), or null.
  function cellAt(e) {
    if (!selectedCharId || localLayers.length === 0) return null;
    const rect = previewCanvasL.getBoundingClientRect();
    const sx = previewCanvasL.width / rect.width;
    const sy = previewCanvasL.height / rect.height;
    const px = (e.clientX - rect.left) * sx;
    const py = (e.clientY - rect.top) * sy;
    // Glyph is drawn scaled & centered: width = GLYPH_SIZE * s
    const s = scaleL;
    const dw = GLYPH_SIZE * s;
    const dx = (previewCanvasL.width - dw) / 2;
    const dy = (previewCanvasL.height - dw) / 2;
    const gx = (px - dx) / s;
    const gy = (py - dy) / s;
    const layer = localLayers[activeLocalLayerIdx];
    if (!layer) return null;
    for (const cell of layer.cells) {
      if (renderer.offCtx.isPointInPath(cell.path, gx, gy)) return { cell, layer };
    }
    return null;
  }

  function handlePaint(e) {
    const hit = cellAt(e);
    if (!hit) return;
    const newFilled = currentTool === 'paint';
    if (hit.cell.filled !== newFilled) {
      hit.cell.filled = newFilled;
      hit.cell.manualOverride = true;
      // 案A: a freshly painted cell inherits its angle from oriented neighbors.
      if (newFilled) propagateOrientation(hit.layer.cells, hit.cell);
      redraw();
    }
  }

  // Angle tool: click a filled cell, type its stroke angle (degrees). Empty
  // input clears the manual override so the next auto pass recomputes it.
  function applyOrientAt(e) {
    const hit = cellAt(e);
    if (!hit || !hit.cell.filled) return;
    const cell = hit.cell;
    const current = cell.orientation != null ? Math.round(cell.orientation) : '';
    const input = prompt('このセルの角度（度・0=水平, 90=垂直）。空欄で自動に戻す:', String(current));
    if (input === null) return;
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
    redraw();
    saveLocalChar();
    historyCommit('orient');
  }

  // === Render ===
  const renderer = createGuidesRenderer({
    displayCanvas: previewCanvasL,
    displayCtx: previewCtxL,
    state: pageState,
    deps: {
      isLocalContext: () => isLocalContext(),
      drawOverlay: () => kvg.drawOverlay(),
    },
  });
  // Hoisted wrappers — redraw() is called from callbacks declared above the
  // renderer's instantiation point.
  function redraw() { renderer.redraw(); }
  function renderLeft() { renderer.renderLeft(); }

  // === Init ===
  rebuildLocalState();
  loadBackgroundImage();
  syncCenterView();
  renderSidebarBody();
  if (panel === 'compose') composeView.redraw();

  // ============ Functions ============

  // Enter/leave preview mode. On exit the stretch values are cleared (the
  // controls disappear, so there'd be no way to undo a leftover stretch) and
  // the guides view returns. Locking the sidebar params is done via a class.
  function setPreviewMode(on) {
    if (previewMode === on) return;
    previewMode = on;
    if (!on) {
      global.stretchAmount = 0;
      global.stretchAngle = 0;
      saveGlobal(global);
      stretchControl.syncFromGlobal();
    }
    stretchWrap.style.display = on ? '' : 'none';
    previewToggleBtn.classList.toggle('active', on);
    sidebar.classList.toggle('preview-locked', on);
    previewCanvasL.classList.toggle('preview-active', on);
    redraw();
  }

  function setPanel(newPanel) {
    if (panel === newPanel) return;
    // The stretch controls and parameter lock only make sense outside Compose.
    if (newPanel === 'compose') setPreviewMode(false);
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
    syncGlyphNameInput();
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
      if (ld.scaleParallel !== undefined) layer.scaleParallel = ld.scaleParallel;
      if (ld.scaleOrthogonal !== undefined) layer.scaleOrthogonal = ld.scaleOrthogonal;
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
      scaleParallel: layer.scaleParallel ?? 1,
      scaleOrthogonal: layer.scaleOrthogonal ?? 1,
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
    if (cd?.kanjivgSource) {
      const targetId = selectedCharId;
      renderKanjiVGSourceToCanvas(cd.kanjivgSource, GLYPH_SIZE, global.kanjivgStrokeWidth).then(cv => {
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
    if (cd?.kanjivgSource) next.kanjivgSource = cd.kanjivgSource;
    saveCharacter(selectedCharId, next);
    project.characters[selectedCharId] = { ...cd, ...next };
  }

  // === Sidebar bodies ===
  function renderSidebarBody() {
    sidebarBody.innerHTML = '';
    switch (panel) {
      case 'layers':   panels.renderLayersPanel(); break;
      case 'pen':      panels.renderPenPanel(); break;
      case 'automesh': panels.renderAutoMeshPanel(); break;
      case 'metrics':  panels.renderMetricsPanel(); break;
      case 'compose':  sidebarBody.appendChild(composeView.sidebarEl); break;
    }
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
    syncGlyphNameInput();
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
      defaultStrokeWidth: global.kanjivgStrokeWidth,
    });
    if (!result) return;
    if (result.mode === 'image') {
      importImages(project, makeImportHooks('import-images'));
    } else if (result.mode === 'font') {
      const chars = buildCharSet(result.presetIds, result.customText);
      if (chars.length === 0) return;
      await importFromFont(project, result.family, chars, makeImportHooks('import-from-font'));
    } else if (result.mode === 'fontfile') {
      let family;
      try {
        ({ family } = await importLocalFontFile(result.file));
      } catch (e) {
        alert(e.message || 'Font import failed');
        return;
      }
      const chars = buildCharSet(result.presetIds, result.customText);
      if (chars.length === 0) return;
      await importFromFont(project, family, chars, makeImportHooks('import-from-font-file'));
    } else if (result.mode === 'kanjivg') {
      const chars = buildCharSet(result.presetIds, result.customText);
      if (chars.length === 0) return;
      if (typeof result.strokeWidth === 'number') {
        global.kanjivgStrokeWidth = result.strokeWidth;
        saveGlobal(global);
      }
      await importFromKanjiVG(project, chars, global.kanjivgStrokeWidth, makeImportHooks('import-from-kanjivg'));
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
      return cd?.imagePath || cd?.fontSource || cd?.kanjivgSource;
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
      } else if (cd?.kanjivgSource) {
        try {
          source = await renderKanjiVGSourceToCanvas(cd.kanjivgSource, GLYPH_SIZE, global.kanjivgStrokeWidth);
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
    // global may have been swapped by undo/redo; keep the preview stretch
    // sliders in step with it.
    stretchControl.syncFromGlobal();
    redraw();
    // Keep the compose composition in sync with undone/redone glyph state.
    composeView.invalidate();
    if (panel === 'compose') composeView.redraw();
  }

  return { refresh };
}
