import { getGrid } from '../grids/grid-plugin.js';
import { createLayer, regenerateCells } from './layer.js';
import { resolveCharacterLayers } from './project.js';
import { nearestCell, CELL_MATCH_DIST_SQ } from './cell.js';

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
    }
  }
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
    layer.gridParamOverrides = { ...rl.gridParamOverrides };
    regenerateCells(layer, glyphSize, glyphSize);
    if (rl.cells && rl.cells.length > 0) {
      applySavedCells(layer.cells, rl.cells);
    }
    layers.push(layer);
  }
  return layers;
}
