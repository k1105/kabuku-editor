import { loadProject, saveProject, getGlobal, DEFAULT_LAYER, DEFAULT_TRANSFORM, serializeLayerData } from '../core/project.js';
import { getAllGrids, getGrid } from '../grids/grid-plugin.js';
import { createLayer, regenerateCells } from '../core/layer.js';
import { renderCanvas } from '../render/canvas-renderer.js';
import { autoMesh } from '../core/mesh.js';

export function renderIndexPage(app) {
  const project = loadProject();
  const charIds = Object.keys(project.characters);

  // Header
  const header = document.createElement('div');
  header.className = 'header';
  header.innerHTML = `<h1>KABUKU Editor</h1>`;

  // Toolbar
  const toolbar = document.createElement('div');
  toolbar.className = 'index-toolbar';

  // Progress bar (hidden by default)
  const progressWrap = document.createElement('div');
  progressWrap.className = 'import-progress';
  progressWrap.style.display = 'none';
  const progressBar = document.createElement('div');
  progressBar.className = 'import-progress-bar';
  const progressText = document.createElement('span');
  progressText.className = 'import-progress-text';
  progressWrap.appendChild(progressBar);
  progressWrap.appendChild(progressText);

  // Grid container (created early so importImages can append to it)
  let grid = null;

  const importBtn = document.createElement('button');
  importBtn.textContent = 'Import Images';
  importBtn.addEventListener('click', () => importImages(project, { progressWrap, progressBar, progressText, getGrid: () => grid }));

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

  toolbar.appendChild(importBtn);
  toolbar.appendChild(exportBtn);
  toolbar.appendChild(importJsonBtn);

  // Content
  const content = document.createElement('div');
  content.className = 'index-page';
  content.appendChild(toolbar);
  content.appendChild(progressWrap);

  grid = document.createElement('div');
  grid.className = 'char-grid';

  if (charIds.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.innerHTML = `<p>No characters yet.</p><p>Click "Import Images" to load PNG files.</p>`;
    content.appendChild(empty);
  }

  for (const charId of charIds) {
    grid.appendChild(createCharCard(charId, project.characters[charId]));
  }
  content.appendChild(grid);

  app.appendChild(header);
  app.appendChild(content);
}

const GLYPH_SIZE = 512;

function createCharCard(charId, charData) {
  const card = document.createElement('div');
  card.className = 'char-card';
  card.addEventListener('click', () => {
    location.hash = `#/edit/${encodeURIComponent(charId)}`;
  });

  const canvas = document.createElement('canvas');
  canvas.width = 120;
  canvas.height = 120;
  renderThumbnail(canvas, charData);

  const label = document.createElement('div');
  label.className = 'label';
  label.textContent = charId;

  card.appendChild(canvas);
  card.appendChild(label);
  return card;
}

function renderThumbnail(canvas, charData) {
  if (!charData || !charData.layers) {
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    return;
  }

  // Render at full glyph size on offscreen canvas, then scale down
  const offscreen = document.createElement('canvas');
  offscreen.width = GLYPH_SIZE;
  offscreen.height = GLYPH_SIZE;
  const offCtx = offscreen.getContext('2d');

  // Rebuild layers from saved data
  const layers = [];
  for (const ld of charData.layers) {
    const gridPlugin = getGrid(ld.gridName);
    if (!gridPlugin) continue;
    const layer = createLayer(gridPlugin, ld.gridParams);
    layer.id = ld.id;
    layer.name = ld.name;
    layer.opacity = ld.opacity ?? 1;
    layer.visible = ld.visible ?? true;
    regenerateCells(layer, GLYPH_SIZE, GLYPH_SIZE);
    if (ld.cells) {
      for (let i = 0; i < Math.min(layer.cells.length, ld.cells.length); i++) {
        layer.cells[i].filled = ld.cells[i].filled;
        layer.cells[i].manualOverride = ld.cells[i].manualOverride;
      }
    }
    layers.push(layer);
  }

  const global = getGlobal();
  const transform = { ...charData.transform, stretchAngle: global.stretchAngle, stretchAmount: global.stretchAmount };

  // Load background image if available
  if (charData.imagePath) {
    const img = new Image();
    img.onload = () => {
      renderCanvas(offCtx, layers, {
        backgroundImage: img,
        backgroundOpacity: 0.3,
        transform,
        glyphSize: GLYPH_SIZE,
      });
      // Scale down to thumbnail
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

    // Remove empty state if present
    const empty = document.querySelector('.empty-state');
    if (empty) empty.remove();

    // Show progress
    ui.progressWrap.style.display = '';
    const total = files.length;
    let done = 0;
    ui.progressText.textContent = `0 / ${total}`;
    ui.progressBar.style.width = '0%';

    // Reusable offscreen canvas
    const offscreen = document.createElement('canvas');
    offscreen.width = GLYPH_SIZE;
    offscreen.height = GLYPH_SIZE;
    const offCtx = offscreen.getContext('2d');

    const grid = ui.getGrid();

    for (const file of files) {
      const charId = file.name.replace(/\.[^.]+$/, '');

      if (!project.characters[charId]) {
        const imageData = await fileToDataURL(file);

        // Build layer and run auto-mesh
        const gridPlugin = getGrid(DEFAULT_LAYER.gridName);
        const layer = createLayer(gridPlugin, DEFAULT_LAYER.gridParams);
        regenerateCells(layer, GLYPH_SIZE, GLYPH_SIZE);

        const img = await loadImage(imageData);
        offCtx.clearRect(0, 0, GLYPH_SIZE, GLYPH_SIZE);
        offCtx.drawImage(img, 0, 0, GLYPH_SIZE, GLYPH_SIZE);
        autoMesh(offCtx, layer.cells, 0.5);

        const charData = {
          imagePath: imageData,
          layers: serializeLayerData([layer]),
          transform: { ...DEFAULT_TRANSFORM },
        };
        project.characters[charId] = charData;

        // Append card immediately
        grid.appendChild(createCharCard(charId, charData));
      }

      done++;
      const pct = Math.round((done / total) * 100);
      ui.progressBar.style.width = pct + '%';
      ui.progressText.textContent = `${done} / ${total}`;

      // Yield to browser for repaint
      await new Promise(r => requestAnimationFrame(r));
    }

    saveProject(project);
    ui.progressWrap.style.display = 'none';
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
