import { getGrid, getAllGrids } from '../grids/grid-plugin.js';
import { createLayer, regenerateCells } from '../core/layer.js';
import { autoMesh } from '../core/mesh.js';
import { renderCanvas } from '../render/canvas-renderer.js';
import { exportLayerToSVG, exportAllLayersToSVG, downloadSVG } from '../render/svg-exporter.js';
import { getCharacter, saveCharacter, getAllCharIds, serializeLayerData, getGlobal, saveGlobal, DEFAULT_LAYER, DEFAULT_TRANSFORM } from '../core/project.js';
import { createToolbar } from '../ui/toolbar.js';
import { createParamsPanel, createStretchPanel, createTransformPanel } from '../ui/params-panel.js';
import { createLayerPanel } from '../ui/layer-panel.js';

const GLYPH_SIZE = 512;

export function renderEditPage(app, charId) {
  const charData = getCharacter(charId);
  const allCharIds = getAllCharIds();
  const charIndex = allCharIds.indexOf(charId);

  // State
  let layers = [];
  let activeLayerIdx = 0;
  let currentTool = 'paint';
  let backgroundImage = null;
  let global = getGlobal();
  let transform = { ...DEFAULT_TRANSFORM };
  let isPainting = false;

  // Restore state from saved data
  if (charData) {
    if (charData.transform) Object.assign(transform, charData.transform);
    if (charData.layers && charData.layers.length > 0) {
      for (const ld of charData.layers) {
        const gridPlugin = getGrid(ld.gridName);
        if (!gridPlugin) continue;
        const layer = createLayer(gridPlugin, ld.gridParams);
        layer.id = ld.id;
        layer.name = ld.name;
        layer.opacity = ld.opacity ?? 1;
        layer.visible = ld.visible ?? true;
        regenerateCells(layer, GLYPH_SIZE, GLYPH_SIZE);
        // Restore filled state
        if (ld.cells) {
          for (let i = 0; i < Math.min(layer.cells.length, ld.cells.length); i++) {
            layer.cells[i].filled = ld.cells[i].filled;
            layer.cells[i].manualOverride = ld.cells[i].manualOverride;
          }
        }
        layers.push(layer);
      }
    }
  }

  // Default layer if none
  if (layers.length === 0) {
    const defaultGrid = getGrid(DEFAULT_LAYER.gridName);
    const layer = createLayer(defaultGrid, DEFAULT_LAYER.gridParams);
    regenerateCells(layer, GLYPH_SIZE, GLYPH_SIZE);
    layers.push(layer);
  }

  // === Layout ===
  // Header
  const header = document.createElement('div');
  header.className = 'header';

  const backBtn = document.createElement('button');
  backBtn.textContent = 'Back';
  backBtn.addEventListener('click', () => { location.hash = '#/'; });

  const title = document.createElement('h1');
  title.textContent = charId;

  const nav = document.createElement('div');
  nav.className = 'header-nav';

  const prevBtn = document.createElement('button');
  prevBtn.textContent = 'Prev';
  prevBtn.disabled = charIndex <= 0;
  prevBtn.addEventListener('click', () => {
    if (charIndex > 0) location.hash = `#/edit/${encodeURIComponent(allCharIds[charIndex - 1])}`;
  });

  const nextBtn = document.createElement('button');
  nextBtn.textContent = 'Next';
  nextBtn.disabled = charIndex >= allCharIds.length - 1;
  nextBtn.addEventListener('click', () => {
    if (charIndex < allCharIds.length - 1) location.hash = `#/edit/${encodeURIComponent(allCharIds[charIndex + 1])}`;
  });

  nav.appendChild(prevBtn);
  nav.appendChild(nextBtn);
  header.appendChild(backBtn);
  header.appendChild(title);
  header.appendChild(nav);

  // Edit page container
  const editPage = document.createElement('div');
  editPage.className = 'edit-page';

  // Sidebar
  const sidebar = document.createElement('div');
  sidebar.className = 'sidebar';

  // Grid type selector
  const gridSection = document.createElement('div');
  gridSection.className = 'param-group';
  const gridTitle = document.createElement('h3');
  gridTitle.textContent = 'Grid Type';
  gridSection.appendChild(gridTitle);

  const gridSelect = document.createElement('select');
  for (const g of getAllGrids()) {
    const opt = document.createElement('option');
    opt.value = g.name;
    opt.textContent = g.name;
    if (layers[activeLayerIdx]?.gridPlugin.name === g.name) opt.selected = true;
    gridSelect.appendChild(opt);
  }
  gridSelect.addEventListener('change', () => {
    const grid = getGrid(gridSelect.value);
    const layer = layers[activeLayerIdx];
    layer.gridPlugin = grid;
    // Reset params to defaults
    const defaults = {};
    for (const def of grid.getParamDefs()) defaults[def.key] = def.default;
    layer.gridParams = defaults;
    regenerateCells(layer, GLYPH_SIZE, GLYPH_SIZE);
    layer.name = `${grid.name} ${activeLayerIdx + 1}`;
    paramsPanel.update(grid.getParamDefs(), layer.gridParams);
    layerPanel.update(layers, activeLayerIdx);
    redraw();
    save();
  });
  gridSection.appendChild(gridSelect);
  sidebar.appendChild(gridSection);

  // Tools
  let previewMode = false;
  const toolbar = createToolbar(
    (tool) => { currentTool = tool; },
    (isPreview) => { previewMode = isPreview; redraw(); }
  );
  sidebar.appendChild(toolbar.el);

  // Image import for this character
  const imgSection = document.createElement('div');
  imgSection.className = 'param-group';
  const imgTitle = document.createElement('h3');
  imgTitle.textContent = 'Source Image';
  imgSection.appendChild(imgTitle);

  const imgBtn = document.createElement('button');
  imgBtn.className = 'tool-btn';
  imgBtn.textContent = 'Load Image';
  imgBtn.addEventListener('click', loadImage);
  imgSection.appendChild(imgBtn);

  const meshBtn = document.createElement('button');
  meshBtn.className = 'tool-btn';
  meshBtn.textContent = 'Auto Mesh';
  meshBtn.style.marginLeft = '4px';
  meshBtn.addEventListener('click', doAutoMesh);
  imgSection.appendChild(meshBtn);

  // Threshold slider
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
  threshInput.addEventListener('input', () => {
    threshVal.textContent = threshInput.value;
  });
  threshRow.appendChild(threshLabel);
  threshRow.appendChild(threshInput);
  threshRow.appendChild(threshVal);
  imgSection.appendChild(threshRow);

  // Background opacity
  const bgOpRow = document.createElement('div');
  bgOpRow.className = 'param-row';
  const bgOpLabel = document.createElement('label');
  bgOpLabel.textContent = 'BG Opacity';
  const bgOpInput = document.createElement('input');
  bgOpInput.type = 'range';
  bgOpInput.min = 0;
  bgOpInput.max = 1;
  bgOpInput.step = 0.05;
  bgOpInput.value = 0.3;
  const bgOpVal = document.createElement('span');
  bgOpVal.className = 'value';
  bgOpVal.textContent = '0.3';
  bgOpInput.addEventListener('input', () => {
    bgOpVal.textContent = bgOpInput.value;
    redraw();
  });
  bgOpRow.appendChild(bgOpLabel);
  bgOpRow.appendChild(bgOpInput);
  bgOpRow.appendChild(bgOpVal);
  imgSection.appendChild(bgOpRow);

  sidebar.appendChild(imgSection);

  // Grid params
  const activeLayer = layers[activeLayerIdx];
  const paramsPanel = createParamsPanel(
    activeLayer.gridPlugin.getParamDefs(),
    activeLayer.gridParams,
    (key, val) => {
      activeLayer.gridParams[key] = val;
      regenerateCells(layers[activeLayerIdx], GLYPH_SIZE, GLYPH_SIZE);
      redraw();
      save();
    }
  );
  sidebar.appendChild(paramsPanel.el);

  // Stretch params (global)
  const stretchPanel = createStretchPanel(global, (key, val) => {
    global[key] = val;
    saveGlobal(global);
    redraw();
  });
  sidebar.appendChild(stretchPanel.el);

  // Transform params (per-character)
  const transformPanel = createTransformPanel(transform, (key, val) => {
    transform[key] = val;
    redraw();
    save();
  });
  sidebar.appendChild(transformPanel.el);

  // Layer panel
  const layerPanel = createLayerPanel(layers, activeLayerIdx, {
    onSelect(idx) {
      activeLayerIdx = idx;
      const layer = layers[idx];
      gridSelect.value = layer.gridPlugin.name;
      paramsPanel.update(layer.gridPlugin.getParamDefs(), layer.gridParams);
      layerPanel.update(layers, activeLayerIdx);
      redraw();
    },
    onVisibilityChange() { redraw(); save(); },
    onOpacityChange() { redraw(); save(); },
    onDelete(idx) {
      layers.splice(idx, 1);
      if (activeLayerIdx >= layers.length) activeLayerIdx = layers.length - 1;
      layerPanel.update(layers, activeLayerIdx);
      const layer = layers[activeLayerIdx];
      gridSelect.value = layer.gridPlugin.name;
      paramsPanel.update(layer.gridPlugin.getParamDefs(), layer.gridParams);
      redraw();
      save();
    },
    onAdd() {
      const grid = getGrid(gridSelect.value);
      const layer = createLayer(grid);
      regenerateCells(layer, GLYPH_SIZE, GLYPH_SIZE);
      layers.push(layer);
      activeLayerIdx = layers.length - 1;
      layerPanel.update(layers, activeLayerIdx);
      paramsPanel.update(layer.gridPlugin.getParamDefs(), layer.gridParams);
      redraw();
      save();
    },
  });
  sidebar.appendChild(layerPanel.el);

  // SVG Export section
  const svgSection = document.createElement('div');
  svgSection.className = 'param-group';
  const svgTitle = document.createElement('h3');
  svgTitle.textContent = 'Export';
  svgSection.appendChild(svgTitle);

  const svgLayerBtn = document.createElement('button');
  svgLayerBtn.className = 'tool-btn';
  svgLayerBtn.textContent = 'SVG (Layer)';
  svgLayerBtn.addEventListener('click', () => {
    const layer = layers[activeLayerIdx];
    const svg = exportLayerToSVG(layer, GLYPH_SIZE, GLYPH_SIZE);
    downloadSVG(svg, `${charId}_${layer.name}.svg`);
  });

  const svgAllBtn = document.createElement('button');
  svgAllBtn.className = 'tool-btn';
  svgAllBtn.textContent = 'SVG (All)';
  svgAllBtn.style.marginLeft = '4px';
  svgAllBtn.addEventListener('click', () => {
    const svg = exportAllLayersToSVG(layers, GLYPH_SIZE, GLYPH_SIZE);
    downloadSVG(svg, `${charId}_all.svg`);
  });

  svgSection.appendChild(svgLayerBtn);
  svgSection.appendChild(svgAllBtn);
  sidebar.appendChild(svgSection);

  // Canvas area
  const canvasArea = document.createElement('div');
  canvasArea.className = 'canvas-area';

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  canvasArea.appendChild(canvas);

  editPage.appendChild(sidebar);
  editPage.appendChild(canvasArea);

  app.appendChild(header);
  app.appendChild(editPage);

  // Resize canvas to fill canvas-area (1:1 logical pixels, no DPR scaling)
  function resizeCanvas() {
    const rect = canvasArea.getBoundingClientRect();
    const w = Math.floor(rect.width);
    const h = Math.floor(rect.height);
    if (canvas.width === w && canvas.height === h) return;
    canvas.width = w;
    canvas.height = h;
    redraw();
  }

  const resizeObserver = new ResizeObserver(() => resizeCanvas());
  resizeObserver.observe(canvasArea);
  // Initial sizing after layout
  requestAnimationFrame(() => resizeCanvas());

  // Load background image if saved
  if (charData?.imagePath) {
    const img = new Image();
    img.onload = () => {
      backgroundImage = img;
      redraw();
    };
    img.src = charData.imagePath;
  }

  // === Interaction ===
  canvas.addEventListener('mousedown', (e) => {
    isPainting = true;
    handlePaint(e);
  });

  canvas.addEventListener('mousemove', (e) => {
    if (!isPainting) return;
    handlePaint(e);
  });

  canvas.addEventListener('mouseup', () => {
    isPainting = false;
    save();
  });

  canvas.addEventListener('mouseleave', () => {
    if (isPainting) {
      isPainting = false;
      save();
    }
  });

  function handlePaint(e) {
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const x = (e.clientX - rect.left) * scaleX;
    const y = (e.clientY - rect.top) * scaleY;

    // Glyph area offset within canvas
    const ox = (canvas.width - GLYPH_SIZE) / 2;
    const oy = (canvas.height - GLYPH_SIZE) / 2;

    // Convert to glyph-local coords for hit testing against cell paths
    const gx = x - ox;
    const gy = y - oy;

    const layer = layers[activeLayerIdx];
    for (const cell of layer.cells) {
      if (ctx.isPointInPath(cell.path, gx, gy)) {
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

  function getCombinedTransform() {
    return { ...transform, stretchAngle: global.stretchAngle, stretchAmount: global.stretchAmount };
  }

  function redraw() {
    renderCanvas(ctx, layers, {
      backgroundImage,
      backgroundOpacity: parseFloat(bgOpInput.value),
      transform: getCombinedTransform(),
      glyphSize: GLYPH_SIZE,
      preview: previewMode,
    });
  }

  function save() {
    saveCharacter(charId, {
      imagePath: charData?.imagePath || '',
      layers: serializeLayerData(layers),
      transform,
    });
  }

  function loadImage() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/png,image/jpeg';
    input.addEventListener('change', async () => {
      const file = input.files[0];
      if (!file) return;
      const dataUrl = await new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.readAsDataURL(file);
      });

      const img = new Image();
      img.onload = () => {
        backgroundImage = img;
        saveCharacter(charId, {
          imagePath: dataUrl,
          layers: serializeLayerData(layers),
          transform,
        });
        redraw();
      };
      img.src = dataUrl;
    });
    input.click();
  }

  function doAutoMesh() {
    if (!backgroundImage) {
      alert('Load an image first.');
      return;
    }
    // Draw image to offscreen canvas for pixel analysis
    const offscreen = document.createElement('canvas');
    offscreen.width = GLYPH_SIZE;
    offscreen.height = GLYPH_SIZE;
    const offCtx = offscreen.getContext('2d');
    offCtx.drawImage(backgroundImage, 0, 0, GLYPH_SIZE, GLYPH_SIZE);

    const layer = layers[activeLayerIdx];
    const threshold = parseFloat(threshInput.value);
    autoMesh(offCtx, layer.cells, threshold);
    redraw();
    save();
  }

  // Initial draw
  redraw();
}
