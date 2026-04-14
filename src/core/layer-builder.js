import { getGrid } from '../grids/grid-plugin.js';
import { createLayer, regenerateCells } from './layer.js';
import { resolveCharacterLayers } from './project.js';

/**
 * Restore saved cell states onto new cells by matching nearest center positions.
 */
function applySavedCells(newCells, savedCells) {
  for (const saved of savedCells) {
    if (!saved.center) continue;
    let minDist = Infinity;
    let nearest = null;
    for (const nc of newCells) {
      const dx = nc.center.x - saved.center.x;
      const dy = nc.center.y - saved.center.y;
      const dist = dx * dx + dy * dy;
      if (dist < minDist) {
        minDist = dist;
        nearest = nc;
      }
    }
    if (nearest && minDist < 400) {
      nearest.filled = saved.filled;
      nearest.manualOverride = saved.manualOverride;
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
