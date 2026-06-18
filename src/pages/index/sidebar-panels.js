/**
 * Sidebar panel renderers for the font editor (Layers / Pen / Auto Mesh /
 * Font Metrics) plus the per-glyph source-image section, image loading and
 * single-glyph auto-mesh.
 *
 * `ctx` exposes the page's closure state through getters/setters (the page
 * remains the single source of truth); `deps` are page-level operations the
 * panels trigger. Each render*Panel() appends into `sidebarBody` — the page
 * clears it and dispatches per the active rail panel.
 */
import { saveCharacter, saveGlobal, serializeLayerOverrides } from '../../core/project.js';
import { uploadCharacterImage } from '../../core/storage.js';
import { getAllGrids, getGrid } from '../../grids/grid-plugin.js';
import { createLayer, regenerateCells } from '../../core/layer.js';
import { autoMesh } from '../../core/mesh.js';
import { drawSourceImage } from '../../render/canvas-renderer.js';
import { exportLayerToSVG, exportAllLayersToSVG } from '../../render/svg-exporter.js';
import { svgExportDialog } from '../../ui/export-dialog.js';
import { createLayerPanel } from '../../ui/layer-panel.js';
import { createParamsPanel, createTransformPanel } from '../../ui/params-panel.js';
import { createToolbar } from '../../ui/toolbar.js';
import { createParamRow } from '../../ui/param-row.js';
import { commit as historyCommit } from '../../core/history.js';
import { fileToDataURL, loadImage, saveFile } from '../../utils/file-io.js';
import { GLYPH_SIZE } from './constants.js';

export function createSidebarPanels({ sidebarBody, ctx, deps }) {
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
    const globalLayerPanel = createLayerPanel(ctx.globalLayers, ctx.activeGlobalLayerIdx, {
      onSelect(idx) {
        ctx.activeGlobalLayerIdx = idx;
        const layer = ctx.globalLayers[idx];
        gridSelect.value = layer.gridPlugin.name;
        renderGridParamSliders();
        globalLayerPanel.update(ctx.globalLayers, ctx.activeGlobalLayerIdx);
        deps.redraw();
      },
      onVisibilityChange() { deps.saveGlobalLayers(); deps.redraw(); deps.refreshAllThumbnails(); historyCommit('layer-visibility'); },
      // Opacity slider commits via the delegated 'change' listener on release;
      // committing here would fire on every input event during the drag.
      onOpacityChange() { deps.saveGlobalLayers(); deps.redraw(); deps.refreshAllThumbnails(); },
      onDelete(idx) {
        ctx.globalLayers.splice(idx, 1);
        if (ctx.activeGlobalLayerIdx >= ctx.globalLayers.length) ctx.activeGlobalLayerIdx = ctx.globalLayers.length - 1;
        globalLayerPanel.update(ctx.globalLayers, ctx.activeGlobalLayerIdx);
        if (ctx.globalLayers.length > 0) gridSelect.value = ctx.globalLayers[ctx.activeGlobalLayerIdx].gridPlugin.name;
        renderGridParamSliders();
        deps.saveGlobalLayers();
        deps.redraw();
        historyCommit('layer-delete');
      },
      onAdd() {
        const grid = getGrid(gridSelect.value);
        const defaults = {};
        for (const def of grid.getParamDefs()) defaults[def.key] = def.default;
        const gd = ctx.global.gridDefaults?.[grid.name] || {};
        const layer = createLayer(grid, { ...defaults, ...gd });
        ctx.globalLayers.push(layer);
        ctx.activeGlobalLayerIdx = ctx.globalLayers.length - 1;
        globalLayerPanel.update(ctx.globalLayers, ctx.activeGlobalLayerIdx);
        renderGridParamSliders();
        deps.saveGlobalLayers();
        deps.redraw();
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
    if (ctx.globalLayers.length > 0) gridSelect.value = ctx.globalLayers[ctx.activeGlobalLayerIdx].gridPlugin.name;
    gridSelect.addEventListener('change', () => {
      if (ctx.globalLayers.length === 0) return;
      const grid = getGrid(gridSelect.value);
      const layer = ctx.globalLayers[ctx.activeGlobalLayerIdx];
      layer.gridPlugin = grid;
      const defaults = {};
      for (const def of grid.getParamDefs()) defaults[def.key] = def.default;
      const gd = ctx.global.gridDefaults?.[grid.name] || {};
      layer.gridParams = { ...defaults, ...gd };
      layer.name = grid.name;
      renderGridParamSliders();
      globalLayerPanel.update(ctx.globalLayers, ctx.activeGlobalLayerIdx);
      deps.saveGlobalLayers({ propagateGridParams: true });
      deps.redraw();
      deps.refreshAllThumbnails();
    });
    gridSection.appendChild(gridSelect);
    sidebarBody.appendChild(gridSection);

    // Grid Params
    const gridParamGroup = document.createElement('div');
    gridParamGroup.className = 'param-group';
    sidebarBody.appendChild(gridParamGroup);

    function renderGridParamSliders() {
      gridParamGroup.innerHTML = '';
      if (ctx.globalLayers.length === 0) return;
      const layer = ctx.globalLayers[ctx.activeGlobalLayerIdx];
      if (!layer) return;
      const h = document.createElement('h3');
      h.textContent = 'Grid Parameters';
      gridParamGroup.appendChild(h);
      for (const def of layer.gridPlugin.getParamDefs()) {
        const { row } = createParamRow(def.label, {
          min: def.min, max: def.max, step: def.step,
          value: layer.gridParams[def.key] ?? def.default,
          onInput: (v) => {
            layer.gridParams[def.key] = v;
            deps.saveGlobalLayers({ propagateGridParams: true });
            deps.redraw();
          },
          onChange: () => deps.refreshAllThumbnails(),
        });
        gridParamGroup.appendChild(row);
      }
    }
    renderGridParamSliders();

    // Transform (ctx.global)
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
      const { row } = createParamRow(def.label, {
        min: def.min, max: def.max, step: def.step,
        value: ctx.global[def.key] ?? def.default,
        hardMin: def.hardMin, hardMax: def.hardMax,
        onInput: (v) => {
          ctx.global[def.key] = v;
          saveGlobal(ctx.global);
          deps.redraw();
        },
        onChange: () => deps.refreshAllThumbnails(),
      });
      transformGroup.appendChild(row);
    }
    sidebarBody.appendChild(transformGroup);

    // Per-cell orientation scale (global, applies to all glyphs + export). The
    // factor lerps by なす角(cell orientation vs stretch direction)/90: parallel
    // cells → ∥, orthogonal → ⊥. 1.0/1.0 = no change; negatives invert/mirror.
    const scaleGroup = document.createElement('div');
    scaleGroup.className = 'param-group';
    const scaleTitle = document.createElement('h3');
    scaleTitle.textContent = '角度スケール (全文字共通)';
    scaleGroup.appendChild(scaleTitle);
    const SCALE_DEFS = [
      { key: 'scaleParallel', label: 'Scale ∥ (平行)' },
      { key: 'scaleOrthogonal', label: 'Scale ⊥ (直交)' },
    ];
    for (const def of SCALE_DEFS) {
      const { row } = createParamRow(def.label, {
        min: -2, max: 3, step: 0.05,
        value: ctx.global[def.key] ?? 1,
        onInput: (v) => {
          ctx.global[def.key] = v;
          saveGlobal(ctx.global);
          deps.redraw();
        },
        onChange: () => { deps.refreshAllThumbnails(); historyCommit('cell-scale'); },
      });
      scaleGroup.appendChild(row);
    }
    sidebarBody.appendChild(scaleGroup);
    // Font export moved to the Settings modal (gear icon in the header).
  }

  // Font Metrics (ctx.global) — ascender / x-height / baseline / descender guides.
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
    if (!ctx.global.fontMetrics) ctx.global.fontMetrics = {};
    for (const def of metricsDefs) {
      const { row } = createParamRow(def.label, {
        min: 0, max: 1, step: 0.005,
        value: ctx.global.fontMetrics[def.key] ?? def.default,
        hardMin: 0, hardMax: 1,
        formatter: (v) => v.toFixed(3),
        onInput: (v) => {
          ctx.global.fontMetrics[def.key] = v;
          saveGlobal(ctx.global);
          deps.redraw();
        },
      });
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

    const { row: threshRow, api: threshApi } = createParamRow('Threshold', {
      min: 0, max: 1, step: 0.05,
      value: 0.5,
      hardMin: 0, hardMax: 1,
    });
    group.appendChild(threshRow);

    const btnRow = document.createElement('div');
    btnRow.className = 'anim-button-row';
    btnRow.style.marginTop = '8px';

    const meshBtn = document.createElement('button');
    meshBtn.className = 'tool-btn';
    meshBtn.textContent = 'Auto Mesh';
    meshBtn.disabled = !ctx.selectedCharId;
    meshBtn.addEventListener('click', () => doAutoMesh(threshApi.getValue()));
    btnRow.appendChild(meshBtn);

    const meshAllBtn = document.createElement('button');
    meshAllBtn.className = 'tool-btn';
    meshAllBtn.textContent = 'Auto Mesh All';
    meshAllBtn.addEventListener('click', () => deps.autoMeshAll(meshAllBtn, threshApi.getValue()));
    btnRow.appendChild(meshAllBtn);

    group.appendChild(btnRow);
    sidebarBody.appendChild(group);
  }

  // Pen — the per-character editor (was the "Local" sidebar): paint tools,
  // read-only layer list (incl. the base-image "下地" layer), per-glyph
  // grid/transform overrides, SVG export and delete. Selecting the base layer
  // swaps the detail area to the source-image placement params; the glyph name
  // is edited via the overlay at the top of the viewport.
  function renderPenPanel() {
    if (!ctx.selectedCharId) { appendNoSelMsg(); return; }

    // Tools
    const toolbar = createToolbar((tool) => { ctx.currentTool = tool; deps.redraw(); });
    sidebarBody.appendChild(toolbar.el);

    // Orientation overlay toggle
    const orientLabel = document.createElement('label');
    orientLabel.style.display = 'flex';
    orientLabel.style.alignItems = 'center';
    orientLabel.style.gap = '6px';
    orientLabel.style.marginTop = '6px';
    const orientCb = document.createElement('input');
    orientCb.type = 'checkbox';
    orientCb.checked = ctx.showOrientation;
    orientCb.addEventListener('change', () => {
      ctx.showOrientation = orientCb.checked;
      deps.redraw();
    });
    orientLabel.appendChild(orientCb);
    orientLabel.appendChild(document.createTextNode('角度オーバーレイ'));
    toolbar.el.appendChild(orientLabel);

    // Per-layer baseline = the layer's own gridParams in ctx.global.defaultLayers
    // (NOT ctx.global.gridDefaults, which is the per-grid-type fallback). This is
    // what overrides are diffed against, so the override badge is accurate.
    const layerBaseline = (idx) => ctx.global.defaultLayers?.[idx]?.gridParams || {};

    // Reset the base-layer selection whenever the panel is (re)built (char or
    // panel change). When true the detail area shows the source-image placement
    // params instead of grid params + transform, and the canvas emphasizes the
    // image (see renderLeft).
    ctx.baseLayerActive = false;
    deps.kvg.exitEdit();

    function applyDetailVisibility() {
      gridDetailEl.style.display = ctx.baseLayerActive ? 'none' : '';
      baseDetailEl.style.display = ctx.baseLayerActive ? '' : 'none';
    }

    // Layer panel (read-only) with the base-image layer pinned to the end.
    const layerPanel = createLayerPanel(ctx.localLayers, ctx.activeLocalLayerIdx, {
      readOnly: true,
      baseLayer: { name: '下地', active: false },
      onSelect(idx) {
        ctx.baseLayerActive = false;
        deps.kvg.exitEdit();
        ctx.activeLocalLayerIdx = idx;
        const layer = ctx.localLayers[idx];
        paramsPanel.update(layer.gridPlugin.getParamDefs(), layer.gridParams, layerBaseline(idx));
        layerPanel.update(ctx.localLayers, ctx.activeLocalLayerIdx, false);
        applyDetailVisibility();
        deps.redraw();
      },
      onSelectBase() {
        ctx.baseLayerActive = true;
        // Pass -1 so no normal layer stays highlighted while base is active;
        // ctx.activeLocalLayerIdx is left untouched so grid editing / SVG export
        // resume on the same layer when the user selects it again.
        layerPanel.update(ctx.localLayers, -1, true);
        applyDetailVisibility();
        deps.kvg.enterEdit(); // builds the path overlay for kanjivg bases (async)
        deps.redraw();
      },
      onVisibilityChange() { deps.redraw(); deps.saveLocalChar(); deps.refreshSelectedThumbnail(); historyCommit('local-layer-visibility'); },
      // Opacity slider commits via delegated 'change' on release.
      onOpacityChange() { deps.redraw(); deps.saveLocalChar(); deps.refreshSelectedThumbnail(); },
    });
    sidebarBody.appendChild(layerPanel.el);

    // Grid detail (normal layer) and base detail (下地) live in sibling
    // containers; applyDetailVisibility() swaps which one is shown.
    const gridDetailEl = document.createElement('div');
    const baseDetailEl = document.createElement('div');

    // Grid params (local override)
    const activeLayer = ctx.localLayers[ctx.activeLocalLayerIdx];
    const paramsPanel = createParamsPanel(
      activeLayer ? activeLayer.gridPlugin.getParamDefs() : [],
      activeLayer ? activeLayer.gridParams : {},
      layerBaseline(ctx.activeLocalLayerIdx),
      {
        localOnly: true,
        onLocalChange(key, val) {
          const layer = ctx.localLayers[ctx.activeLocalLayerIdx];
          if (!layer) return;
          layer.gridParams[key] = val;
          const baseline = layerBaseline(ctx.activeLocalLayerIdx);
          if (val === baseline[key]) {
            delete layer.gridParamOverrides?.[key];
          } else {
            if (!layer.gridParamOverrides) layer.gridParamOverrides = {};
            layer.gridParamOverrides[key] = val;
          }
          regenerateCells(layer, GLYPH_SIZE, GLYPH_SIZE);
          deps.redraw();
          deps.saveLocalChar();
        },
        onGlobalChange() {},
        onReset(key) {
          const layer = ctx.localLayers[ctx.activeLocalLayerIdx];
          if (!layer) return;
          const baseline = layerBaseline(ctx.activeLocalLayerIdx);
          layer.gridParams[key] = baseline[key];
          delete layer.gridParamOverrides?.[key];
          regenerateCells(layer, GLYPH_SIZE, GLYPH_SIZE);
          deps.redraw();
          deps.saveLocalChar();
        },
      }
    );
    gridDetailEl.appendChild(paramsPanel.el);

    // Transform (local override)
    const transformPanel = createTransformPanel(ctx.localTransform, ctx.global, {
      localOnly: true,
      onLocalChange(key, val) {
        ctx.localTransform[key] = val;
        if (val === ctx.global[key]) {
          delete ctx.localTransformOverrides[key];
        } else {
          ctx.localTransformOverrides[key] = val;
        }
        deps.redraw();
        deps.saveLocalChar();
      },
      onGlobalChange() {},
      onReset(key) {
        ctx.localTransform[key] = ctx.global[key];
        delete ctx.localTransformOverrides[key];
        transformPanel.render();
        deps.redraw();
        deps.saveLocalChar();
      },
    });
    gridDetailEl.appendChild(transformPanel.el);

    // Base layer (下地) detail: source image + placement params.
    renderSourceImageSection(baseDetailEl);

    sidebarBody.appendChild(gridDetailEl);
    sidebarBody.appendChild(baseDetailEl);
    applyDetailVisibility();

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
        defaultFilename: `${ctx.selectedCharId}.svg`,
        hasActiveLayer: !!ctx.localLayers[ctx.activeLocalLayerIdx],
      });
      if (!result) return;
      try {
        let svg;
        if (result.scope === 'active') {
          const layer = ctx.localLayers[ctx.activeLocalLayerIdx];
          if (!layer) return;
          svg = exportLayerToSVG(layer, GLYPH_SIZE, GLYPH_SIZE, {
            transform: ctx.localTransform,
            fontMetrics: ctx.global.fontMetrics,
          });
        } else {
          svg = exportAllLayersToSVG(ctx.localLayers, GLYPH_SIZE, GLYPH_SIZE, {
            transform: ctx.localTransform,
            fontMetrics: ctx.global.fontMetrics,
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
    deleteBtn.addEventListener('click', () => deps.deleteSelectedGlyph());
    sidebarBody.appendChild(deleteBtn);
  }

  // Source image + placement params for the active glyph's base layer (下地):
  // load image, background opacity, image offset/scale, and (for kanjivg-sourced
  // glyphs) stroke width. Rendered into `container` — the Pen panel's base-layer
  // detail area.
  function renderSourceImageSection(container) {
    if (!ctx.selectedCharId) return;

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

    const { row: bgOpRow } = createParamRow('BG Opacity', {
      min: 0, max: 1, step: 0.05,
      value: ctx.bgOpacity,
      hardMin: 0, hardMax: 1,
      onInput: (v) => {
        ctx.bgOpacity = v;
        deps.redraw();
      },
    });
    bgOpRow.style.marginTop = '8px';
    imgSection.appendChild(bgOpRow);

    // Image transform (per-character offset & scale to align glyph to metrics)
    const imgTransformDefs = [
      { key: 'imageOffsetX', label: 'Image X', min: -GLYPH_SIZE, max: GLYPH_SIZE, default: 0, step: 1 },
      { key: 'imageOffsetY', label: 'Image Y', min: -GLYPH_SIZE, max: GLYPH_SIZE, default: 0, step: 1 },
      { key: 'imageScale',   label: 'Image Scale', min: 0.1, max: 3, default: 1, step: 0.01 },
    ];
    for (const def of imgTransformDefs) {
      const badge = document.createElement('button');
      badge.type = 'button';
      badge.className = 'override-badge';

      const { row, api, label } = createParamRow(def.label, {
        min: def.min, max: def.max, step: def.step,
        value: def.default,
        formatter: (v) => def.step < 0.1
          ? v.toFixed(2)
          : (Number.isInteger(v) ? String(v) : v.toFixed(2)),
        onInput: (v) => {
          const c = ctx.project.characters[ctx.selectedCharId];
          if (!c) return;
          if (v === def.default) delete c[def.key];
          else c[def.key] = v;
          syncOverrideUI();
          deps.redraw();
        },
        onChange: () => {
          deps.saveLocalChar();
          deps.refreshSelectedThumbnail();
        },
      }, { badge });

      function syncFromState() {
        const cd = ctx.project.characters[ctx.selectedCharId] || {};
        const v = cd[def.key] ?? def.default;
        api.setValue(v);
        syncOverrideUI();
      }

      function syncOverrideUI() {
        const cd = ctx.project.characters[ctx.selectedCharId] || {};
        const v = cd[def.key] ?? def.default;
        const overridden = v !== def.default;
        label.classList.toggle('overridden', overridden);
        badge.classList.toggle('is-off', !overridden);
        badge.title = overridden ? 'Click to reset override' : '';
        badge.tabIndex = overridden ? 0 : -1;
      }

      function resetThis() {
        const c = ctx.project.characters[ctx.selectedCharId];
        if (!c) return;
        delete c[def.key];
        syncFromState();
        deps.saveLocalChar();
        deps.redraw();
        deps.refreshSelectedThumbnail();
      }

      badge.addEventListener('click', () => {
        if (!label.classList.contains('overridden')) return;
        resetThis();
      });

      imgSection.appendChild(row);
      syncFromState();
    }

    // KanjiVG stroke width (per-character override of ctx.global.kanjivgStrokeWidth).
    // Only meaningful for kanjivg-sourced glyphs; re-run Auto Mesh after changing
    // it to update cell fills, same as Image Scale.
    if (ctx.project.characters[ctx.selectedCharId]?.kanjivgSource) {
      const def = { label: 'Stroke', min: 1, max: 20, step: 0.5, default: ctx.global.kanjivgStrokeWidth };
      const badge = document.createElement('button');
      badge.type = 'button';
      badge.className = 'override-badge';

      const { row, api, label } = createParamRow(def.label, {
        min: def.min, max: def.max, step: def.step,
        value: def.default,
        formatter: (v) => v.toFixed(1),
        onInput: (v) => {
          const c = ctx.project.characters[ctx.selectedCharId];
          if (!c?.kanjivgSource) return;
          if (v === def.default) {
            const { strokeWidth: _strokeWidth, ...rest } = c.kanjivgSource;
            c.kanjivgSource = rest;
          } else {
            c.kanjivgSource = { ...c.kanjivgSource, strokeWidth: v };
          }
          syncOverrideUI();
          deps.loadBackgroundImage();
        },
        onChange: () => {
          deps.saveLocalChar();
          deps.refreshSelectedThumbnail();
        },
      }, { badge });

      function syncFromState() {
        const cd = ctx.project.characters[ctx.selectedCharId] || {};
        api.setValue(cd.kanjivgSource?.strokeWidth ?? def.default);
        syncOverrideUI();
      }

      function syncOverrideUI() {
        const cd = ctx.project.characters[ctx.selectedCharId] || {};
        const overridden = cd.kanjivgSource?.strokeWidth !== undefined;
        label.classList.toggle('overridden', overridden);
        badge.classList.toggle('is-off', !overridden);
        badge.title = overridden ? 'Click to reset override' : '';
        badge.tabIndex = overridden ? 0 : -1;
      }

      badge.addEventListener('click', () => {
        const c = ctx.project.characters[ctx.selectedCharId];
        if (!c?.kanjivgSource || c.kanjivgSource.strokeWidth === undefined) return;
        const { strokeWidth: _strokeWidth, ...rest } = c.kanjivgSource;
        c.kanjivgSource = rest;
        syncFromState();
        deps.saveLocalChar();
        deps.loadBackgroundImage();
        deps.refreshSelectedThumbnail();
      });

      imgSection.appendChild(row);
      syncFromState();

      // Bezier path editing (active while the 下地 layer is selected).
      const hint = document.createElement('div');
      hint.className = 'kvg-edit-hint';
      hint.textContent = 'アンカー/ハンドルをドラッグでパス編集（ダブルクリックで連続⇔独立を切替）';
      imgSection.appendChild(hint);

      const resetBtn = document.createElement('button');
      resetBtn.type = 'button';
      resetBtn.className = 'tool-btn';
      resetBtn.textContent = 'パス編集をリセット';
      resetBtn.style.marginTop = '6px';
      resetBtn.disabled = !ctx.project.characters[ctx.selectedCharId]?.kanjivgSource?.editedPaths?.length;
      resetBtn.addEventListener('click', () => {
        const c = ctx.project.characters[ctx.selectedCharId];
        if (!c?.kanjivgSource?.editedPaths) return;
        const { editedPaths: _editedPaths, ...rest } = c.kanjivgSource;
        c.kanjivgSource = rest;
        deps.saveLocalChar();
        deps.loadBackgroundImage();
        deps.refreshSelectedThumbnail();
        historyCommit('kvg-edit-reset');
        if (ctx.baseLayerActive) deps.kvg.enterEdit(); // rebuild the overlay from fetched paths
        resetBtn.disabled = true;
      });
      imgSection.appendChild(resetBtn);
    }

    container.appendChild(imgSection);
  }

  function loadLocalImage() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/png,image/jpeg';
    input.addEventListener('change', async () => {
      const file = input.files[0];
      if (!file) return;
      const targetId = ctx.selectedCharId;
      // Show a local preview immediately while the upload runs.
      const dataUrl = await fileToDataURL(file);
      const previewImg = await loadImage(dataUrl);
      if (ctx.selectedCharId === targetId) {
        ctx.backgroundImage = previewImg;
        deps.redraw();
      }
      let url;
      try {
        url = await uploadCharacterImage({ charId: targetId, file });
      } catch (e) {
        console.error(e);
        alert(`画像のアップロードに失敗しました: ${e.message}`);
        return;
      }
      const cd = ctx.project.characters[targetId];
      saveCharacter(targetId, {
        ...(cd || {}),
        imagePath: url,
        layerOverrides: serializeLayerOverrides(ctx.localLayers, ctx.global),
        transformOverrides: Object.keys(ctx.localTransformOverrides).length > 0 ? ctx.localTransformOverrides : undefined,
      });
      ctx.project.characters[targetId] = { ...(cd || {}), imagePath: url };
      if (ctx.selectedCharId === targetId) {
        deps.refreshSelectedThumbnail();
      }
      historyCommit('load-image');
    });
    input.click();
  }

  function doAutoMesh(threshold) {
    if (!ctx.backgroundImage) {
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
    const cd = ctx.project.characters[ctx.selectedCharId];
    drawSourceImage(offCtx, ctx.backgroundImage, 0, 0, GLYPH_SIZE, {
      imageOffsetX: cd?.imageOffsetX ?? 0,
      imageOffsetY: cd?.imageOffsetY ?? 0,
      imageScale: cd?.imageScale ?? 1,
    });
    if (ctx.localLayers.length === 0) return;
    for (const layer of ctx.localLayers) {
      autoMesh(offCtx, layer.cells, threshold);
    }
    deps.redraw();
    deps.saveLocalChar();
    deps.refreshSelectedThumbnail();
    historyCommit('auto-mesh');
  }


  return { renderLayersPanel, renderMetricsPanel, renderAutoMeshPanel, renderPenPanel };
}
