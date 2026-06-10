import { nearestCell, CELL_MATCH_DIST_SQ } from './cell.js';

let layerIdCounter = 0;

export function createLayer(gridPlugin, params = {}) {
  const defaults = {};
  for (const def of gridPlugin.getParamDefs()) {
    defaults[def.key] = def.default;
  }
  const gridParams = { ...defaults, ...params };

  return {
    id: `layer_${layerIdCounter++}`,
    name: `${gridPlugin.name} ${layerIdCounter}`,
    gridPlugin,
    gridParams,
    cells: [],
    opacity: 1.0,
    visible: true,
  };
}

export function regenerateCells(layer, width, height) {
  const oldCells = layer.cells;
  const newCells = layer.gridPlugin.generateCells(width, height, layer.gridParams);

  // Preserve manualOverride cells by matching nearest center
  if (oldCells.length > 0) {
    const overrides = oldCells.filter(c => c.manualOverride);
    for (const oc of overrides) {
      const { cell, distSq } = nearestCell(newCells, oc.center);
      if (cell && distSq < CELL_MATCH_DIST_SQ) {
        cell.filled = oc.filled;
        cell.manualOverride = true;
      }
    }
  }

  layer.cells = newCells;
}
