import { loadProject, saveProject, saveCharacter, getGlobal, saveGlobal, serializeLayerOverrides, resolveTransform, resolveGridParams } from '../core/project.js';
import { getAllGrids, getGrid } from '../grids/grid-plugin.js';
import { createLayer, regenerateCells } from '../core/layer.js';
import { renderCanvas } from '../render/canvas-renderer.js';
import { autoMesh } from '../core/mesh.js';
import { createLayerPanel } from '../ui/layer-panel.js';
import { createParamsPanel, createTransformPanel } from '../ui/params-panel.js';
import { createToolbar } from '../ui/toolbar.js';
import { buildRuntimeLayers } from '../core/layer-builder.js';
import { exportLayerToSVG, exportAllLayersToSVG, downloadSVG } from '../render/svg-exporter.js';
import { createPreviewControls, getPreviewMode, getPreviewScale } from '../ui/preview-controls.js';

const GLYPH_SIZE = 512;
const MODE_KEY = 'kabuku.editMode';

export function renderIndexPage(app) {
  const project = loadProject();
  let global = getGlobal();
  project.global = global;
  let selectedCharId = Object.keys(project.characters)[0] ?? null;

  // Mode: 'global' | 'local'
  let mode = sessionStorage.getItem(MODE_KEY) === 'local' ? 'local' : 'global';

  // Preview / paint state
  let previewMode = getPreviewMode();
  let currentTool = 'paint';
  let isPainting = false;
  let backgroundImage = null;
  let bgOpacity = 0.3;

  // Global-mode state
  let globalLayers = [];
  let activeGlobalLayerIdx = 0;
  rebuildGlobalLayers();

  // Local-mode state (rebuilt on char/mode change)
  let localLayers = [];
  let activeLocalLayerIdx = 0;
  let localTransformOverrides = {};
  let localTransform = resolveTransform(global, {});

  // === Header ===
  const header = document.createElement('div');
  header.className = 'header';

  const title = document.createElement('h1');
  title.textContent = 'KABUKU Editor';
  header.appendChild(title);

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
  header.appendChild(progressWrap);

  const headerActions = document.createElement('div');
  headerActions.className = 'header-nav';

  const exportBtn = document.createElement('button');
  exportBtn.textContent = 'Export JSON';
  exportBtn.addEventListener('click', () => {
    const json = JSON.stringify(project, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'kabuku_project.json';
    a.click();
    URL.revokeObjectURL(url);
  });

  const importJsonBtn = document.createElement('button');
  importJsonBtn.textContent = 'Import JSON';
  importJsonBtn.addEventListener('click', () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.addEventListener('change', async () => {
      const file = input.files[0];
      if (!file) return;
      const text = await file.text();
      const data = JSON.parse(text);
      saveProject(data);
      location.reload();
    });
    input.click();
  });

  const composeBtn = document.createElement('button');
  composeBtn.textContent = 'Compose';
  composeBtn.addEventListener('click', () => { location.hash = '#/compose'; });

  const animationBtn = document.createElement('button');
  animationBtn.textContent = 'Animation';
  animationBtn.addEventListener('click', () => { location.hash = '#/animation'; });

  headerActions.appendChild(exportBtn);
  headerActions.appendChild(importJsonBtn);
  headerActions.appendChild(composeBtn);
  headerActions.appendChild(animationBtn);
  header.appendChild(headerActions);

  // === Main layout ===
  const page = document.createElement('div');
  page.className = 'edit-page';

  // === Sidebar ===
  const sidebar = document.createElement('div');
  sidebar.className = 'sidebar';

  // Mode toggle
  const modeBar = document.createElement('div');
  modeBar.className = 'mode-bar';
  const globalBtn = document.createElement('button');
  globalBtn.className = 'mode-tab';
  globalBtn.textContent = 'Global';
  const localBtn = document.createElement('button');
  localBtn.className = 'mode-tab';
  localBtn.textContent = 'Local';
  modeBar.appendChild(globalBtn);
  modeBar.appendChild(localBtn);
  sidebar.appendChild(modeBar);

  function syncModeButtons() {
    globalBtn.classList.toggle('active', mode === 'global');
    localBtn.classList.toggle('active', mode === 'local');
  }
  syncModeButtons();

  globalBtn.addEventListener('click', () => setMode('global'));
  localBtn.addEventListener('click', () => setMode('local'));

  const sidebarBody = document.createElement('div');
  sidebarBody.className = 'sidebar-body';
  sidebar.appendChild(sidebarBody);

  // === Main area ===
  const mainArea = document.createElement('div');
  mainArea.className = 'index-main';

  const previewSection = document.createElement('div');
  previewSection.className = 'index-preview';

  const previewCanvas = document.createElement('canvas');
  previewCanvas.className = 'index-preview-canvas';
  const previewCtx = previewCanvas.getContext('2d');
  previewSection.appendChild(previewCanvas);

  const previewControls = createPreviewControls({
    global,
    onPreviewChange: (v) => { previewMode = v; redraw(); },
    onStretchInput: () => { localTransform = resolveTransform(global, localTransformOverrides); redraw(); },
    onStretchRelease: () => refreshAllThumbnails(),
    onScaleChange: () => redraw(),
  });
  previewSection.appendChild(previewControls.el);

  const emptyState = document.createElement('div');
  emptyState.className = 'empty-state';
  emptyState.innerHTML = `<p>No characters yet.</p><p>Click the "+" tile below to add a glyph.</p>`;
  if (selectedCharId) {
    emptyState.style.display = 'none';
  } else {
    previewCanvas.style.display = 'none';
  }
  previewSection.appendChild(emptyState);

  mainArea.appendChild(previewSection);

  // === Char strip ===
  const charStripWrap = document.createElement('div');
  charStripWrap.className = 'index-char-strip-wrap';

  const charStripHeader = document.createElement('div');
  charStripHeader.className = 'index-char-strip-header';
  const refreshBtn = document.createElement('button');
  refreshBtn.className = 'tool-btn';
  refreshBtn.textContent = 'Refresh All';
  refreshBtn.addEventListener('click', () => refreshAllThumbnails());
  charStripHeader.appendChild(refreshBtn);
  charStripWrap.appendChild(charStripHeader);

  const charStrip = document.createElement('div');
  charStrip.className = 'index-char-strip';

  const cardElements = {};
  for (const charId of Object.keys(project.characters)) {
    const card = createCharCard(charId, project.characters[charId], (id) => selectChar(id));
    if (charId === selectedCharId) card.classList.add('selected');
    cardElements[charId] = card;
    charStrip.appendChild(card);
  }

  const addGlyphTile = document.createElement('button');
  addGlyphTile.className = 'char-card add-glyph-tile';
  addGlyphTile.title = 'Add glyph';
  addGlyphTile.textContent = '+';
  addGlyphTile.addEventListener('click', () => triggerImport());
  charStrip.appendChild(addGlyphTile);

  charStripWrap.appendChild(charStrip);
  mainArea.appendChild(charStripWrap);

  page.appendChild(sidebar);
  page.appendChild(mainArea);

  app.appendChild(header);
  app.appendChild(page);

  // Canvas fills the preview area; glyph is rendered at GLYPH_SIZE centered
  function resizeCanvas() {
    const rect = previewSection.getBoundingClientRect();
    const w = Math.max(GLYPH_SIZE, Math.floor(rect.width));
    const h = Math.max(GLYPH_SIZE, Math.floor(rect.height));
    if (previewCanvas.width === w && previewCanvas.height === h) return;
    previewCanvas.width = w;
    previewCanvas.height = h;
    redraw();
  }
  const resizeObserver = new ResizeObserver(() => resizeCanvas());
  resizeObserver.observe(previewSection);
  requestAnimationFrame(() => resizeCanvas());

  previewCanvas.addEventListener('mousedown', (e) => {
    if (mode !== 'local') return;
    isPainting = true;
    handlePaint(e);
  });
  previewCanvas.addEventListener('mousemove', (e) => {
    if (!isPainting) return;
    handlePaint(e);
  });
  previewCanvas.addEventListener('mouseup', () => {
    if (!isPainting) return;
    isPainting = false;
    saveLocalChar();
    refreshSelectedThumbnail();
  });
  previewCanvas.addEventListener('mouseleave', () => {
    if (!isPainting) return;
    isPainting = false;
    saveLocalChar();
    refreshSelectedThumbnail();
  });

  function handlePaint(e) {
    if (!selectedCharId || localLayers.length === 0) return;
    const rect = previewCanvas.getBoundingClientRect();
    const sx = previewCanvas.width / rect.width;
    const sy = previewCanvas.height / rect.height;
    const px = (e.clientX - rect.left) * sx;
    const py = (e.clientY - rect.top) * sy;
    // Glyph is drawn scaled & centered: width = GLYPH_SIZE * s
    const s = getPreviewScale();
    const dw = GLYPH_SIZE * s;
    const dh = GLYPH_SIZE * s;
    const dx = (previewCanvas.width - dw) / 2;
    const dy = (previewCanvas.height - dh) / 2;
    const gx = (px - dx) / s;
    const gy = (py - dy) / s;
    const layer = localLayers[activeLocalLayerIdx];
    if (!layer) return;
    for (const cell of layer.cells) {
      if (offCtx.isPointInPath(cell.path, gx, gy)) {
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
  renderSidebarBody();

  // ============ Functions ============
  function setMode(newMode) {
    if (mode === newMode) return;
    mode = newMode;
    sessionStorage.setItem(MODE_KEY, mode);
    syncModeButtons();
    if (mode === 'local') rebuildLocalState();
    renderSidebarBody();
    redraw();
  }

  function rebuildGlobalLayers() {
    globalLayers = [];
    for (const ld of global.defaultLayers || []) {
      const gridPlugin = getGrid(ld.gridName);
      if (!gridPlugin) continue;
      const layer = createLayer(gridPlugin, { ...ld.gridParams });
      layer.name = ld.name || gridPlugin.name;
      globalLayers.push(layer);
    }
    if (activeGlobalLayerIdx >= globalLayers.length) {
      activeGlobalLayerIdx = Math.max(0, globalLayers.length - 1);
    }
  }

  function saveGlobalLayers() {
    global.defaultLayers = globalLayers.map(layer => ({
      gridName: layer.gridPlugin.name,
      gridParams: { ...layer.gridParams },
      name: layer.name,
    }));
    saveGlobal(global);
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
    if (!cd?.imagePath) { redraw(); return; }
    const img = new Image();
    img.onload = () => { backgroundImage = img; redraw(); };
    img.src = cd.imagePath;
  }

  function saveLocalChar() {
    if (!selectedCharId) return;
    const cd = project.characters[selectedCharId];
    const overrides = Object.keys(localTransformOverrides).length > 0 ? localTransformOverrides : undefined;
    saveCharacter(selectedCharId, {
      imagePath: cd?.imagePath || '',
      layerOverrides: serializeLayerOverrides(localLayers, global),
      transformOverrides: overrides,
    });
    project.characters[selectedCharId] = {
      ...cd,
      layerOverrides: serializeLayerOverrides(localLayers, global),
      transformOverrides: overrides,
    };
  }

  // === Sidebar bodies ===
  function renderSidebarBody() {
    sidebarBody.innerHTML = '';
    if (mode === 'global') renderGlobalSidebar();
    else renderLocalSidebar();
  }

  function renderGlobalSidebar() {
    // Layers
    const globalLayerPanel = createLayerPanel(globalLayers, activeGlobalLayerIdx, {
      onSelect(idx) {
        activeGlobalLayerIdx = idx;
        const layer = globalLayers[idx];
        gridSelect.value = layer.gridPlugin.name;
        renderGridParamSliders();
        globalLayerPanel.update(globalLayers, activeGlobalLayerIdx);
      },
      onVisibilityChange() { saveGlobalLayers(); redraw(); refreshAllThumbnails(); },
      onOpacityChange() { saveGlobalLayers(); redraw(); refreshAllThumbnails(); },
      onDelete(idx) {
        globalLayers.splice(idx, 1);
        if (activeGlobalLayerIdx >= globalLayers.length) activeGlobalLayerIdx = globalLayers.length - 1;
        globalLayerPanel.update(globalLayers, activeGlobalLayerIdx);
        if (globalLayers.length > 0) gridSelect.value = globalLayers[activeGlobalLayerIdx].gridPlugin.name;
        renderGridParamSliders();
        saveGlobalLayers();
        redraw();
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
      saveGlobalLayers();
      redraw();
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
        const input = document.createElement('input');
        input.type = 'range';
        input.min = def.min;
        input.max = def.max;
        input.step = def.step;
        input.value = layer.gridParams[def.key] ?? def.default;
        const valSpan = document.createElement('span');
        valSpan.className = 'value';
        valSpan.textContent = input.value;
        input.addEventListener('input', () => {
          const v = parseFloat(input.value);
          layer.gridParams[def.key] = v;
          valSpan.textContent = v;
          saveGlobalLayers();
          redraw();
        });
        input.addEventListener('change', () => refreshAllThumbnails());
        row.appendChild(label);
        row.appendChild(input);
        row.appendChild(valSpan);
        gridParamGroup.appendChild(row);
      }
    }
    renderGridParamSliders();

    // Transform (global)
    const transformDefs = [
      { key: 'baseGap', label: 'Gap', min: 0, max: 20, default: 0, step: 0.5 },
      { key: 'gapDirectionWeight', label: 'Gap Dir Weight', min: 0, max: 1, default: 0, step: 0.05 },
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
      const input = document.createElement('input');
      input.type = 'range';
      input.min = def.min;
      input.max = def.max;
      input.step = def.step;
      input.value = global[def.key] ?? def.default;
      const valSpan = document.createElement('span');
      valSpan.className = 'value';
      valSpan.textContent = input.value;
      input.addEventListener('input', () => {
        const v = parseFloat(input.value);
        global[def.key] = v;
        valSpan.textContent = v;
        saveGlobal(global);
        redraw();
      });
      input.addEventListener('change', () => refreshAllThumbnails());
      row.appendChild(label);
      row.appendChild(input);
      row.appendChild(valSpan);
      transformGroup.appendChild(row);
    }
    sidebarBody.appendChild(transformGroup);

    // Auto Mesh All
    const autoMeshSection = document.createElement('div');
    autoMeshSection.className = 'param-group';
    const autoMeshTitle = document.createElement('h3');
    autoMeshTitle.textContent = 'Actions';
    autoMeshSection.appendChild(autoMeshTitle);
    const autoMeshAllBtn = document.createElement('button');
    autoMeshAllBtn.className = 'tool-btn';
    autoMeshAllBtn.textContent = 'Auto Mesh All';
    autoMeshAllBtn.addEventListener('click', () => autoMeshAll(autoMeshAllBtn));
    autoMeshSection.appendChild(autoMeshAllBtn);
    sidebarBody.appendChild(autoMeshSection);
  }

  function renderLocalSidebar() {
    if (!selectedCharId) {
      const msg = document.createElement('div');
      msg.className = 'param-group';
      msg.style.color = 'var(--text-dim)';
      msg.style.fontSize = '12px';
      msg.textContent = 'Select a glyph below to edit.';
      sidebarBody.appendChild(msg);
      return;
    }

    // Layer panel (read-only)
    const layerPanel = createLayerPanel(localLayers, activeLocalLayerIdx, {
      readOnly: true,
      onSelect(idx) {
        activeLocalLayerIdx = idx;
        const layer = localLayers[idx];
        const gd = global.gridDefaults?.[layer.gridPlugin.name] || {};
        paramsPanel.update(layer.gridPlugin.getParamDefs(), layer.gridParams, gd);
        layerPanel.update(localLayers, activeLocalLayerIdx);
        redraw();
      },
      onVisibilityChange() { redraw(); saveLocalChar(); refreshSelectedThumbnail(); },
      onOpacityChange() { redraw(); saveLocalChar(); refreshSelectedThumbnail(); },
    });
    sidebarBody.appendChild(layerPanel.el);

    // Grid params (local override)
    const activeLayer = localLayers[activeLocalLayerIdx];
    const activeGridDefaults = activeLayer ? (global.gridDefaults?.[activeLayer.gridPlugin.name] || {}) : {};
    const paramsPanel = createParamsPanel(
      activeLayer ? activeLayer.gridPlugin.getParamDefs() : [],
      activeLayer ? activeLayer.gridParams : {},
      activeGridDefaults,
      {
        localOnly: true,
        onLocalChange(key, val) {
          const layer = localLayers[activeLocalLayerIdx];
          if (!layer) return;
          layer.gridParams[key] = val;
          const gd = global.gridDefaults?.[layer.gridPlugin.name] || {};
          if (val === gd[key]) {
            delete layer.gridParamOverrides[key];
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
          const gd = global.gridDefaults?.[layer.gridPlugin.name] || {};
          layer.gridParams[key] = gd[key];
          delete layer.gridParamOverrides[key];
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

    // Tools
    const toolbar = createToolbar((tool) => { currentTool = tool; });
    sidebarBody.appendChild(toolbar.el);

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

    const meshBtn = document.createElement('button');
    meshBtn.className = 'tool-btn';
    meshBtn.textContent = 'Auto Mesh';
    meshBtn.style.marginLeft = '4px';
    meshBtn.addEventListener('click', () => doAutoMesh(parseFloat(threshInput.value)));
    imgSection.appendChild(meshBtn);

    const threshRow = document.createElement('div');
    threshRow.className = 'param-row';
    threshRow.style.marginTop = '8px';
    const threshLabel = document.createElement('label');
    threshLabel.textContent = 'Threshold';
    const threshInput = document.createElement('input');
    threshInput.type = 'range';
    threshInput.min = 0;
    threshInput.max = 1;
    threshInput.step = 0.05;
    threshInput.value = 0.5;
    const threshVal = document.createElement('span');
    threshVal.className = 'value';
    threshVal.textContent = '0.5';
    threshInput.addEventListener('input', () => { threshVal.textContent = threshInput.value; });
    threshRow.appendChild(threshLabel);
    threshRow.appendChild(threshInput);
    threshRow.appendChild(threshVal);
    imgSection.appendChild(threshRow);

    const bgOpRow = document.createElement('div');
    bgOpRow.className = 'param-row';
    const bgOpLabel = document.createElement('label');
    bgOpLabel.textContent = 'BG Opacity';
    const bgOpInput = document.createElement('input');
    bgOpInput.type = 'range';
    bgOpInput.min = 0;
    bgOpInput.max = 1;
    bgOpInput.step = 0.05;
    bgOpInput.value = bgOpacity;
    const bgOpVal = document.createElement('span');
    bgOpVal.className = 'value';
    bgOpVal.textContent = bgOpacity;
    bgOpInput.addEventListener('input', () => {
      bgOpacity = parseFloat(bgOpInput.value);
      bgOpVal.textContent = bgOpInput.value;
      redraw();
    });
    bgOpRow.appendChild(bgOpLabel);
    bgOpRow.appendChild(bgOpInput);
    bgOpRow.appendChild(bgOpVal);
    imgSection.appendChild(bgOpRow);

    sidebarBody.appendChild(imgSection);

    // SVG Export
    const svgSection = document.createElement('div');
    svgSection.className = 'param-group';
    const svgTitle = document.createElement('h3');
    svgTitle.textContent = 'Export';
    svgSection.appendChild(svgTitle);
    const svgLayerBtn = document.createElement('button');
    svgLayerBtn.className = 'tool-btn';
    svgLayerBtn.textContent = 'SVG (Layer)';
    svgLayerBtn.addEventListener('click', () => {
      const layer = localLayers[activeLocalLayerIdx];
      if (!layer) return;
      const svg = exportLayerToSVG(layer, GLYPH_SIZE, GLYPH_SIZE);
      downloadSVG(svg, `${selectedCharId}_${layer.name}.svg`);
    });
    const svgAllBtn = document.createElement('button');
    svgAllBtn.className = 'tool-btn';
    svgAllBtn.textContent = 'SVG (All)';
    svgAllBtn.style.marginLeft = '4px';
    svgAllBtn.addEventListener('click', () => {
      const svg = exportAllLayersToSVG(localLayers, GLYPH_SIZE, GLYPH_SIZE);
      downloadSVG(svg, `${selectedCharId}_all.svg`);
    });
    svgSection.appendChild(svgLayerBtn);
    svgSection.appendChild(svgAllBtn);
    sidebarBody.appendChild(svgSection);
  }

  function loadLocalImage() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/png,image/jpeg';
    input.addEventListener('change', async () => {
      const file = input.files[0];
      if (!file) return;
      const dataUrl = await fileToDataURL(file);
      const img = new Image();
      img.onload = () => {
        backgroundImage = img;
        const cd = project.characters[selectedCharId];
        saveCharacter(selectedCharId, {
          imagePath: dataUrl,
          layerOverrides: serializeLayerOverrides(localLayers, global),
          transformOverrides: Object.keys(localTransformOverrides).length > 0 ? localTransformOverrides : undefined,
        });
        project.characters[selectedCharId] = {
          ...cd,
          imagePath: dataUrl,
        };
        redraw();
        refreshSelectedThumbnail();
      };
      img.src = dataUrl;
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
    offCtx.drawImage(backgroundImage, 0, 0, GLYPH_SIZE, GLYPH_SIZE);
    const layer = localLayers[activeLocalLayerIdx];
    if (!layer) return;
    autoMesh(offCtx, layer.cells, threshold);
    redraw();
    saveLocalChar();
    refreshSelectedThumbnail();
  }

  // === Char import ===
  function triggerImport() {
    importImages(project, {
      progressWrap, progressBar, progressText,
      getStrip: () => charStrip,
      insertBefore: () => addGlyphTile,
      createCard: (charId, charData) => {
        const card = createCharCard(charId, charData, (id) => selectChar(id));
        cardElements[charId] = card;
        return card;
      },
      onDone: () => {
        if (!selectedCharId && Object.keys(project.characters).length > 0) {
          const firstId = Object.keys(project.characters)[0];
          selectChar(firstId);
        }
        redraw();
      },
    });
  }

  // === Selection ===
  function selectChar(charId) {
    if (selectedCharId && cardElements[selectedCharId]) {
      cardElements[selectedCharId].classList.remove('selected');
    }
    selectedCharId = charId;
    if (cardElements[charId]) cardElements[charId].classList.add('selected');
    emptyState.style.display = 'none';
    previewCanvas.style.display = '';
    rebuildLocalState();
    loadBackgroundImage();
    if (mode === 'local') renderSidebarBody();
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
  async function autoMeshAll(btn) {
    btn.disabled = true;
    btn.textContent = 'Meshing...';
    progressWrap.style.display = '';
    const targets = Object.keys(project.characters).filter(cid => project.characters[cid]?.imagePath);
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
      const img = await new Promise((resolve) => {
        const im = new Image();
        im.onload = () => resolve(im);
        im.onerror = () => resolve(null);
        im.src = cd.imagePath;
      });
      if (!img) { done++; continue; }
      offCtx.clearRect(0, 0, GLYPH_SIZE, GLYPH_SIZE);
      offCtx.drawImage(img, 0, 0, GLYPH_SIZE, GLYPH_SIZE);
      const layers = buildRuntimeLayers(global, cd, GLYPH_SIZE);
      for (const layer of layers) autoMesh(offCtx, layer.cells, 0.5);
      cd.layerOverrides = serializeLayerOverrides(layers, global);
      done++;
      progressBar.style.width = Math.round((done / total) * 100) + '%';
      progressText.textContent = `${done} / ${total}`;
      await new Promise(r => requestAnimationFrame(r));
    }
    saveProject(project);
    if (mode === 'local') rebuildLocalState();
    refreshAllThumbnails();
    redraw();
    progressWrap.style.display = 'none';
    btn.disabled = false;
    btn.textContent = 'Auto Mesh All';
  }

  // === Render preview ===
  const offCanvas = document.createElement('canvas');
  offCanvas.width = GLYPH_SIZE;
  offCanvas.height = GLYPH_SIZE;
  const offCtx = offCanvas.getContext('2d');

  function redraw() {
    previewCtx.fillStyle = '#fff';
    previewCtx.fillRect(0, 0, previewCanvas.width, previewCanvas.height);
    if (!selectedCharId) return;
    let layers, transform;
    if (mode === 'local') {
      layers = localLayers;
      transform = localTransform;
    } else {
      const cd = project.characters[selectedCharId];
      layers = buildRuntimeLayers(global, cd, GLYPH_SIZE);
      transform = resolveTransform(global, cd.transformOverrides || {});
    }
    offCtx.fillStyle = '#fff';
    offCtx.fillRect(0, 0, GLYPH_SIZE, GLYPH_SIZE);
    renderCanvas(offCtx, layers, {
      backgroundImage: mode === 'local' ? backgroundImage : null,
      backgroundOpacity: bgOpacity,
      transform,
      glyphSize: GLYPH_SIZE,
      preview: previewMode,
    });
    const s = getPreviewScale();
    const dw = GLYPH_SIZE * s;
    const dh = GLYPH_SIZE * s;
    const dx = (previewCanvas.width - dw) / 2;
    const dy = (previewCanvas.height - dh) / 2;
    previewCtx.imageSmoothingEnabled = true;
    previewCtx.drawImage(offCanvas, dx, dy, dw, dh);
  }
}

function createCharCard(charId, charData, onSelect) {
  const card = document.createElement('div');
  card.className = 'char-card';
  card.addEventListener('click', () => onSelect(charId));
  const canvas = document.createElement('canvas');
  canvas.width = 80;
  canvas.height = 80;
  renderThumbnail(canvas, charData);
  const label = document.createElement('div');
  label.className = 'label';
  label.textContent = charId;
  card.appendChild(canvas);
  card.appendChild(label);
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
  const transform = resolveTransform(global, transformOverrides);
  if (charData.imagePath) {
    const img = new Image();
    img.onload = () => {
      renderCanvas(offCtx, layers, {
        backgroundImage: img,
        backgroundOpacity: 0.3,
        transform,
        glyphSize: GLYPH_SIZE,
        preview: true,
      });
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(offscreen, 0, 0, canvas.width, canvas.height);
    };
    img.src = charData.imagePath;
  } else {
    renderCanvas(offCtx, layers, {
      transform,
      glyphSize: GLYPH_SIZE,
      preview: true,
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
        const imageData = await fileToDataURL(file);
        const g = getGlobal();
        const importLayers = [];
        for (const gl of g.defaultLayers) {
          const gridPlugin = getGrid(gl.gridName);
          if (!gridPlugin) continue;
          const resolvedParams = resolveGridParams(g, gl.gridName, {});
          const layer = createLayer(gridPlugin, resolvedParams);
          layer.name = gl.name || gl.gridName;
          regenerateCells(layer, GLYPH_SIZE, GLYPH_SIZE);
          importLayers.push(layer);
        }
        const img = await loadImage(imageData);
        offCtx.clearRect(0, 0, GLYPH_SIZE, GLYPH_SIZE);
        offCtx.drawImage(img, 0, 0, GLYPH_SIZE, GLYPH_SIZE);
        for (const layer of importLayers) autoMesh(offCtx, layer.cells, 0.5);
        const charData = {
          imagePath: imageData,
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
    img.onload = () => resolve(img);
    img.src = src;
  });
}
