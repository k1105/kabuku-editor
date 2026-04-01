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
      let minDist = Infinity;
      let nearest = null;
      for (const nc of newCells) {
        const dx = nc.center.x - oc.center.x;
        const dy = nc.center.y - oc.center.y;
        const dist = dx * dx + dy * dy;
        if (dist < minDist) {
          minDist = dist;
          nearest = nc;
        }
      }
      if (nearest && minDist < 400) { // within ~20px
        nearest.filled = oc.filled;
        nearest.manualOverride = true;
      }
    }
  }

  layer.cells = newCells;
}
