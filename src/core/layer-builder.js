import { getGrid } from '../grids/grid-plugin.js';
import { createLayer, regenerateCells } from './layer.js';
import { resolveCharacterLayers } from './project.js';
import { nearestCell, CELL_MATCH_DIST_SQ } from './cell.js';
import { decodeCellsV2, gridParamsEqual, CHAR_TO_SRC } from './cell-codec.js';

/**
 * Restore saved cell states onto new cells by matching nearest center positions.
 */
function applySavedCells(newCells, savedCells) {
  for (const saved of savedCells) {
    if (!saved.center) continue;
    const { cell, distSq } = nearestCell(newCells, saved.center);
    if (cell && distSq < CELL_MATCH_DIST_SQ) {
      cell.filled = saved.filled;
      cell.manualOverride = saved.manualOverride;
      if (saved.orientation != null) {
        cell.orientation = saved.orientation;
        cell.coherence = saved.coherence ?? 0;
        cell.orientationSource = saved.orientationSource ?? null;
      }
    }
  }
}

/**
 * Restore a compact cellsV2 payload onto the layer's freshly generated cells.
 * When the current grid params still match the capture-time params the indices
 * map 1:1 — apply directly. Otherwise regenerate the capture-time reference
 * grid and fall back to the legacy nearest-center matching, so per-char fills
 * survive global grid-param tweaks exactly as the old format did.
 */
function applySavedCellsV2(layer, v2) {
  const cells = layer.cells;
  if (gridParamsEqual(v2.params, layer.gridParams) && cells.length === v2.n) {
    for (const i of v2.filled || []) {
      if (cells[i]) cells[i].filled = true;
    }
    for (const i of v2.manual || []) {
      if (cells[i]) cells[i].manualOverride = true;
    }
    (v2.orientIdx || []).forEach((i, k) => {
      const cell = cells[i];
      if (!cell) return;
      cell.orientation = (v2.orient?.[k] ?? 0) / 10;
      cell.coherence = (v2.coher?.[k] ?? 0) / 100;
      cell.orientationSource = CHAR_TO_SRC[v2.src?.[k]] || 'image';
    });
    return;
  }
  const saved = decodeCellsV2(v2, layer.gridPlugin);
  if (saved && saved.length > 0) applySavedCells(cells, saved);
}

/**
 * Build runtime layer objects from global structure + character overrides.
 */
export function buildRuntimeLayers(global, charData, glyphSize) {
  const resolved = resolveCharacterLayers(global, charData);
  const layers = [];
  for (const rl of resolved) {
    const gridPlugin = getGrid(rl.gridName);
    if (!gridPlugin) continue;
    const layer = createLayer(gridPlugin, rl.resolvedParams);
    layer.name = rl.name;
    layer.opacity = rl.opacity;
    layer.visible = rl.visible;
    layer.scaleParallel = rl.scaleParallel;
    layer.scaleOrthogonal = rl.scaleOrthogonal;
    layer.gridParamOverrides = { ...rl.gridParamOverrides };
    regenerateCells(layer, glyphSize, glyphSize);
    if (rl.cellsV2) {
      applySavedCellsV2(layer, rl.cellsV2);
    } else if (rl.cells && rl.cells.length > 0) {
      applySavedCells(layer.cells, rl.cells);
    }
    layers.push(layer);
  }
  return layers;
}
