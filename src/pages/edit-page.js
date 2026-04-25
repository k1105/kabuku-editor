import { autoMesh } from '../core/mesh.js';
import { renderCanvas } from '../render/canvas-renderer.js';
import { exportLayerToSVG, exportAllLayersToSVG, downloadSVG } from '../render/svg-exporter.js';
import { getCharacter, saveCharacter, getAllCharIds, serializeLayerOverrides, getGlobal, resolveTransform } from '../core/project.js';
import { buildRuntimeLayers } from '../core/layer-builder.js';
import { createToolbar } from '../ui/toolbar.js';
import { createParamsPanel, createTransformPanel } from '../ui/params-panel.js';
import { createLayerPanel } from '../ui/layer-panel.js';
import { regenerateCells } from '../core/layer.js';
import { createPreviewControls, getPreviewMode } from '../ui/preview-controls.js';

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
  const global = getGlobal();
  let transformOverrides = {};
  let transform = resolveTransform(global, {});
  let isPainting = false;

  // Restore state from saved data
  if (charData) {
    transformOverrides = charData.transformOverrides || {};
    transform = resolveTransform(global, transformOverrides);
  }

  // Build layers from global structure + character overrides
  layers = buildRuntimeLayers(global, charData, GLYPH_SIZE);

  // === Layout ===
  const header = document.createElement('div');
  header.className = 'header';

  const backBtn = document.createElement('button');
  backBtn.textContent = 'Back';
  backBtn.addEventListener('click', () => { location.hash = '#/'; });

  const title = document.createElement('h1');
  title.textContent = charId;

  const centerNav = document.createElement('div');
  centerNav.className = 'header-center-nav';

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

  centerNav.appendChild(prevBtn);
  centerNav.appendChild(title);
  centerNav.appendChild(nextBtn);
  header.appendChild(backBtn);
  header.appendChild(centerNav);

  const editPage = document.createElement('div');
  editPage.className = 'edit-page';

  const sidebar = document.createElement('div');
  sidebar.className = 'sidebar';

  // (Grid type change is global-only — not available on local edit page)

  // Tools (paint/erase only — preview moved to canvas)
  let previewMode = getPreviewMode();
  const toolbar = createToolbar((tool) => { currentTool = tool; });

  // Image import
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

  // Grid params (local overrides only)
  const activeLayer = layers[activeLayerIdx];
  const activeGridDefaults = global.gridDefaults?.[activeLayer.gridPlugin.name] || {};
  const paramsPanel = createParamsPanel(
    activeLayer.gridPlugin.getParamDefs(),
    activeLayer.gridParams,
    activeGridDefaults,
    {
      localOnly: true,
      onLocalChange(key, val) {
        const layer = layers[activeLayerIdx];
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
        save();
      },
      onGlobalChange() {},
      onReset(key) {
        const layer = layers[activeLayerIdx];
        const gd = global.gridDefaults?.[layer.gridPlugin.name] || {};
        layer.gridParams[key] = gd[key];
        delete layer.gridParamOverrides[key];
        regenerateCells(layer, GLYPH_SIZE, GLYPH_SIZE);
        redraw();
        save();
      },
    }
  );
  // Transform params (local overrides only)
  const transformPanel = createTransformPanel(transform, global, {
    localOnly: true,
    onLocalChange(key, val) {
      transform[key] = val;
      if (val === global[key]) {
        delete transformOverrides[key];
      } else {
        transformOverrides[key] = val;
      }
      redraw();
      save();
    },
    onGlobalChange() {},
    onReset(key) {
      transform[key] = global[key];
      delete transformOverrides[key];
      transformPanel.render();
      redraw();
      save();
    },
  });
  // Layer panel (read-only: no add/delete/type change — those are global-only)
  const layerPanel = createLayerPanel(layers, activeLayerIdx, {
    readOnly: true,
    onSelect(idx) {
      activeLayerIdx = idx;
      const layer = layers[idx];
      const gd = global.gridDefaults?.[layer.gridPlugin.name] || {};
      paramsPanel.update(layer.gridPlugin.getParamDefs(), layer.gridParams, gd);
      layerPanel.update(layers, activeLayerIdx);
      redraw();
    },
    onVisibilityChange() { redraw(); save(); },
    onOpacityChange() { redraw(); save(); },
  });
  // Sidebar order: Layers → Grid Params → Transform → Tools → Image → Export
  sidebar.appendChild(layerPanel.el);
  sidebar.appendChild(paramsPanel.el);
  sidebar.appendChild(transformPanel.el);
  sidebar.appendChild(toolbar.el);
  sidebar.appendChild(imgSection);

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

  // Preview / Angle / Stretch controls — top-right of canvas area
  const previewControls = createPreviewControls({
    global,
    onPreviewChange: (v) => { previewMode = v; redraw(); },
    onStretchInput: (key) => {
      if (!(key in transformOverrides)) transform[key] = global[key];
      redraw();
    },
  });
  canvasArea.appendChild(previewControls.el);

  editPage.appendChild(sidebar);
  editPage.appendChild(canvasArea);

  app.appendChild(header);
  app.appendChild(editPage);

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
  requestAnimationFrame(() => resizeCanvas());

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

    const ox = (canvas.width - GLYPH_SIZE) / 2;
    const oy = (canvas.height - GLYPH_SIZE) / 2;
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

  function redraw() {
    renderCanvas(ctx, layers, {
      backgroundImage,
      backgroundOpacity: parseFloat(bgOpInput.value),
      transform,
      glyphSize: GLYPH_SIZE,
      preview: previewMode,
    });
  }

  function save() {
    const overrides = Object.keys(transformOverrides).length > 0 ? transformOverrides : undefined;
    saveCharacter(charId, {
      imagePath: charData?.imagePath || '',
      layerOverrides: serializeLayerOverrides(layers, global),
      transformOverrides: overrides,
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
          layerOverrides: serializeLayerOverrides(layers, global),
          transformOverrides: Object.keys(transformOverrides).length > 0 ? transformOverrides : undefined,
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

  redraw();
}
