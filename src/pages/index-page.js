import { loadProject, saveProject, getGlobal, saveGlobal, serializeLayerOverrides, resolveTransform, resolveGridParams } from '../core/project.js';
import { getAllGrids, getGrid } from '../grids/grid-plugin.js';
import { createLayer, regenerateCells } from '../core/layer.js';
import { renderCanvas } from '../render/canvas-renderer.js';
import { autoMesh } from '../core/mesh.js';
import { createLayerPanel } from '../ui/layer-panel.js';
import { buildRuntimeLayers } from '../core/layer-builder.js';
import { createPreviewControls, getPreviewMode } from '../ui/preview-controls.js';

export function renderIndexPage(app) {
  const project = loadProject();
  const charIds = Object.keys(project.characters);
  let global = getGlobal();
  project.global = global;
  let selectedCharId = charIds.length > 0 ? charIds[0] : null;
  let previewImageCache = {};

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

  // --- Sidebar: Global controls ---
  const sidebar = document.createElement('div');
  sidebar.className = 'sidebar';

  let previewMode = getPreviewMode();

  // Transform (global)
  const transformDefs = [
    { key: 'baseGap', label: 'Gap', min: 0, max: 20, default: 0, step: 0.5 },
    { key: 'gapDirectionWeight', label: 'Gap Dir Weight', min: 0, max: 1, default: 0, step: 0.05 },
    { key: 'metaballRadius', label: 'Blur', min: 0, max: 30, default: 10, step: 1 },
  ];
  const transformGroup = document.createElement('div');
  transformGroup.className = 'param-group';
  function renderTransformSliders() {
    transformGroup.innerHTML = '';
    const h = document.createElement('h3');
    h.textContent = 'Transform';
    transformGroup.appendChild(h);
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
        redrawPreview();
      });
      input.addEventListener('change', () => refreshAllThumbnails());
      row.appendChild(label);
      row.appendChild(input);
      row.appendChild(valSpan);
      transformGroup.appendChild(row);
    }
  }
  renderTransformSliders();

  // === Global Layers ===
  // Build runtime layer objects from global.defaultLayers
  const GLYPH_SIZE_SIDEBAR = 512;
  let globalLayers = [];
  let activeGlobalLayerIdx = 0;

  function rebuildGlobalLayers() {
    globalLayers = [];
    for (const ld of global.defaultLayers) {
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
  rebuildGlobalLayers();

  function saveGlobalLayers() {
    global.defaultLayers = globalLayers.map(layer => ({
      gridName: layer.gridPlugin.name,
      gridParams: { ...layer.gridParams },
      name: layer.name,
    }));
    saveGlobal(global);
  }

  // Grid type selector for active layer
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
  gridSelect.addEventListener('change', () => {
    if (globalLayers.length === 0) return;
    const grid = getGrid(gridSelect.value);
    const layer = globalLayers[activeGlobalLayerIdx];
    layer.gridPlugin = grid;
    const defaults = {};
    for (const def of grid.getParamDefs()) defaults[def.key] = def.default;
    // Use existing gridDefaults for this type if available
    const gd = global.gridDefaults?.[grid.name] || {};
    layer.gridParams = { ...defaults, ...gd };
    layer.name = grid.name;
    renderGridParamSliders();
    globalLayerPanel.update(globalLayers, activeGlobalLayerIdx);
    saveGlobalLayers();
    redrawPreview();
  });
  gridSection.appendChild(gridSelect);

  // Grid param sliders for active layer
  const gridParamGroup = document.createElement('div');
  gridParamGroup.className = 'param-group';

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
        redrawPreview();
      });
      input.addEventListener('change', () => refreshAllThumbnails());
      row.appendChild(label);
      row.appendChild(input);
      row.appendChild(valSpan);
      gridParamGroup.appendChild(row);
    }
  }
  renderGridParamSliders();

  // Layer panel
  const globalLayerPanel = createLayerPanel(globalLayers, activeGlobalLayerIdx, {
    onSelect(idx) {
      activeGlobalLayerIdx = idx;
      const layer = globalLayers[idx];
      gridSelect.value = layer.gridPlugin.name;
      renderGridParamSliders();
      globalLayerPanel.update(globalLayers, activeGlobalLayerIdx);
    },
    onVisibilityChange() { saveGlobalLayers(); redrawPreview(); },
    onOpacityChange() { saveGlobalLayers(); redrawPreview(); },
    onDelete(idx) {
      globalLayers.splice(idx, 1);
      if (activeGlobalLayerIdx >= globalLayers.length) activeGlobalLayerIdx = globalLayers.length - 1;
      globalLayerPanel.update(globalLayers, activeGlobalLayerIdx);
      if (globalLayers.length > 0) {
        gridSelect.value = globalLayers[activeGlobalLayerIdx].gridPlugin.name;
      }
      renderGridParamSliders();
      saveGlobalLayers();
      redrawPreview();
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
      redrawPreview();
    },
  });
  // Sync gridSelect with initial layer
  if (globalLayers.length > 0) {
    gridSelect.value = globalLayers[activeGlobalLayerIdx].gridPlugin.name;
  }

  // Sidebar order: Layers → Grid Type → Grid Params → Transform
  sidebar.appendChild(globalLayerPanel.el);
  sidebar.appendChild(gridSection);
  sidebar.appendChild(gridParamGroup);
  sidebar.appendChild(transformGroup);

  // --- Main area ---
  const mainArea = document.createElement('div');
  mainArea.className = 'index-main';

  // Preview section
  const previewSection = document.createElement('div');
  previewSection.className = 'index-preview';

  const previewCanvas = document.createElement('canvas');
  previewCanvas.className = 'index-preview-canvas';
  previewSection.appendChild(previewCanvas);

  // Preview / Angle / Stretch controls — top-right of preview area
  const previewControls = createPreviewControls({
    global,
    onPreviewChange: (v) => { previewMode = v; redrawPreview(); },
    onStretchInput: () => redrawPreview(),
    onStretchRelease: () => refreshAllThumbnails(),
  });
  previewSection.appendChild(previewControls.el);

  // Bottom bar: char label + LOCAL EDIT button
  const previewBar = document.createElement('div');
  previewBar.className = 'index-preview-bar';

  const previewLabel = document.createElement('span');
  previewLabel.className = 'index-preview-label';
  previewLabel.textContent = selectedCharId || '';

  const localEditBtn = document.createElement('button');
  localEditBtn.className = 'tool-btn local-edit-btn';
  localEditBtn.textContent = 'Local Edit';
  localEditBtn.addEventListener('click', () => {
    if (selectedCharId) {
      location.hash = `#/edit/${encodeURIComponent(selectedCharId)}`;
    }
  });

  const autoMeshOneBtn = document.createElement('button');
  autoMeshOneBtn.className = 'tool-btn';
  autoMeshOneBtn.textContent = 'Auto Mesh';
  autoMeshOneBtn.addEventListener('click', () => autoMeshSelected());

  previewBar.appendChild(previewLabel);
  previewBar.appendChild(autoMeshOneBtn);
  previewBar.appendChild(localEditBtn);
  previewSection.appendChild(previewBar);

  if (charIds.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.innerHTML = `<p>No characters yet.</p><p>Click the "+" tile below to add a glyph.</p>`;
    previewSection.appendChild(empty);
    previewCanvas.style.display = 'none';
    previewBar.style.display = 'none';
  }

  mainArea.appendChild(previewSection);

  // Character strip at bottom
  const charStripWrap = document.createElement('div');
  charStripWrap.className = 'index-char-strip-wrap';

  const charStripHeader = document.createElement('div');
  charStripHeader.className = 'index-char-strip-header';
  const refreshBtn = document.createElement('button');
  refreshBtn.className = 'tool-btn';
  refreshBtn.textContent = 'Refresh All';
  refreshBtn.addEventListener('click', () => refreshAllThumbnails());
  charStripHeader.appendChild(refreshBtn);

  const autoMeshAllBtn = document.createElement('button');
  autoMeshAllBtn.className = 'tool-btn';
  autoMeshAllBtn.textContent = 'Auto Mesh All';
  autoMeshAllBtn.addEventListener('click', () => autoMeshAll());

  const autoMeshSection = document.createElement('div');
  autoMeshSection.className = 'param-group';
  const autoMeshTitle = document.createElement('h3');
  autoMeshTitle.textContent = 'Actions';
  autoMeshSection.appendChild(autoMeshTitle);
  autoMeshSection.appendChild(autoMeshAllBtn);
  sidebar.appendChild(autoMeshSection);

  charStripWrap.appendChild(charStripHeader);

  const charStrip = document.createElement('div');
  charStrip.className = 'index-char-strip';

  const cardElements = {};
  for (const charId of charIds) {
    const card = createCharCard(charId, project.characters[charId], (id) => {
      selectChar(id);
    });
    if (charId === selectedCharId) card.classList.add('selected');
    cardElements[charId] = card;
    charStrip.appendChild(card);
  }

  // "+" add-glyph tile — always last
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

  // Import images handler — invoked by the "+" tile
  function triggerImport() {
    importImages(project, {
      progressWrap, progressBar, progressText,
      getStrip: () => charStrip,
      insertBefore: () => addGlyphTile,
      createCard: (charId, charData) => {
        const card = createCharCard(charId, charData, (id) => { selectChar(id); });
        cardElements[charId] = card;
        return card;
      },
      onDone: () => {
        if (!selectedCharId && Object.keys(project.characters).length > 0) {
          const firstId = Object.keys(project.characters)[0];
          selectChar(firstId);
          previewCanvas.style.display = '';
          previewBar.style.display = '';
          const empty = previewSection.querySelector('.empty-state');
          if (empty) empty.remove();
        }
        redrawPreview();
      },
    });
  }

  // === Refresh all thumbnails ===
  function refreshAllThumbnails() {
    for (const charId of charIds) {
      const card = cardElements[charId];
      if (!card) continue;
      const canvas = card.querySelector('canvas');
      if (canvas) {
        renderThumbnail(canvas, project.characters[charId]);
      }
    }
  }

  // === Auto Mesh Selected ===
  function autoMeshSelected() {
    if (!selectedCharId) return;
    const cd = project.characters[selectedCharId];
    if (!cd?.imagePath) return;

    const img = new Image();
    img.onload = () => {
      const offscreen = document.createElement('canvas');
      offscreen.width = GLYPH_SIZE;
      offscreen.height = GLYPH_SIZE;
      const offCtx = offscreen.getContext('2d');
      offCtx.drawImage(img, 0, 0, GLYPH_SIZE, GLYPH_SIZE);

      const layers = buildRuntimeLayers(global, cd, GLYPH_SIZE);
      for (const layer of layers) {
        autoMesh(offCtx, layer.cells, 0.5);
      }
      cd.layerOverrides = serializeLayerOverrides(layers, global);
      saveProject(project);

      // Update thumbnail
      const card = cardElements[selectedCharId];
      if (card) {
        const canvas = card.querySelector('canvas');
        if (canvas) renderThumbnail(canvas, cd);
      }
      redrawPreview();
    };
    img.src = cd.imagePath;
  }

  // === Auto Mesh All ===
  async function autoMeshAll() {
    autoMeshAllBtn.disabled = true;
    autoMeshAllBtn.textContent = 'Meshing...';
    progressWrap.style.display = '';

    const targets = charIds.filter(cid => project.characters[cid]?.imagePath);
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
      for (const layer of layers) {
        autoMesh(offCtx, layer.cells, 0.5);
      }

      cd.layerOverrides = serializeLayerOverrides(layers, global);

      done++;
      const pct = Math.round((done / total) * 100);
      progressBar.style.width = pct + '%';
      progressText.textContent = `${done} / ${total}`;

      // Yield to browser for repaint
      await new Promise(r => requestAnimationFrame(r));
    }

    saveProject(project);
    refreshAllThumbnails();
    redrawPreview();

    progressWrap.style.display = 'none';
    autoMeshAllBtn.disabled = false;
    autoMeshAllBtn.textContent = 'Auto Mesh All';
  }

  // === Selection ===
  function selectChar(charId) {
    // Remove old selection
    if (selectedCharId && cardElements[selectedCharId]) {
      cardElements[selectedCharId].classList.remove('selected');
    }
    selectedCharId = charId;
    if (cardElements[charId]) {
      cardElements[charId].classList.add('selected');
    }
    previewLabel.textContent = charId;
    previewImageCache = {}; // reset cached image for new char
    redrawPreview();
  }

  // === Preview rendering ===
  function redrawPreview() {
    if (!selectedCharId) return;
    const charData = project.characters[selectedCharId];
    if (!charData) return;

    const size = Math.min(
      previewSection.clientWidth - 32,
      previewSection.clientHeight - 80,
      512
    );
    if (size <= 0) return;
    previewCanvas.width = size;
    previewCanvas.height = size;

    const layers = buildRuntimeLayers(global, charData, GLYPH_SIZE);
    const transformOverrides = charData.transformOverrides || {};
    const transform = resolveTransform(global, transformOverrides);

    const offscreen = document.createElement('canvas');
    offscreen.width = GLYPH_SIZE;
    offscreen.height = GLYPH_SIZE;
    const offCtx = offscreen.getContext('2d');

    const drawFinal = (bgImg) => {
      renderCanvas(offCtx, layers, {
        backgroundImage: bgImg || null,
        backgroundOpacity: bgImg ? 0.3 : 0,
        transform,
        glyphSize: GLYPH_SIZE,
        preview: previewMode,
      });
      const ctx = previewCanvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, previewCanvas.width, previewCanvas.height);
      ctx.drawImage(offscreen, 0, 0, previewCanvas.width, previewCanvas.height);
    };

    if (charData.imagePath) {
      if (previewImageCache[selectedCharId]) {
        drawFinal(previewImageCache[selectedCharId]);
      } else {
        const img = new Image();
        img.onload = () => {
          previewImageCache[selectedCharId] = img;
          drawFinal(img);
        };
        img.src = charData.imagePath;
      }
    } else {
      drawFinal(null);
    }
  }

  const resizeObserver = new ResizeObserver(() => redrawPreview());
  resizeObserver.observe(previewSection);
  requestAnimationFrame(() => redrawPreview());
}

const GLYPH_SIZE = 512;

function createCharCard(charId, charData, onSelect) {
  const card = document.createElement('div');
  card.className = 'char-card';
  card.addEventListener('click', () => {
    onSelect(charId);
  });

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
    if (empty) empty.remove();

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

        // Build layers from global.defaultLayers
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

        // Auto-mesh on all layers
        const img = await loadImage(imageData);
        offCtx.clearRect(0, 0, GLYPH_SIZE, GLYPH_SIZE);
        offCtx.drawImage(img, 0, 0, GLYPH_SIZE, GLYPH_SIZE);
        for (const layer of importLayers) {
          autoMesh(offCtx, layer.cells, 0.5);
        }

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
      const pct = Math.round((done / total) * 100);
      ui.progressBar.style.width = pct + '%';
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
