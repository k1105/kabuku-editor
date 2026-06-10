import { circleCell, circleCellInBounds } from './circle-utils.js';

export const CircleGrid = {
  name: 'CircleGrid',

  getParamDefs() {
    return [
      { key: 'layers', label: 'Layers', min: 2, max: 60, default: 16, step: 1 },
      { key: 'spacing', label: 'Spacing', min: 5, max: 80, default: 30, step: 1 },
      { key: 'dotRadius', label: 'Dot Radius', min: 2, max: 40, default: 12, step: 1 },
      { key: 'rotation', label: 'Rotation', min: 0, max: 360, default: 0, step: 1 },
    ];
  },

  generateCells(width, height, params) {
    const { layers = 8, spacing = 15, dotRadius = 6, rotation = 0 } = params;
    const cx = width / 2;
    const cy = height / 2;
    const rotRad = (rotation * Math.PI) / 180;
    const cells = [circleCell(cx, cy, dotRadius)];

    for (let layer = 1; layer <= layers; layer++) {
      const radius = layer * spacing;
      const circumference = 2 * Math.PI * radius;
      const count = Math.max(6, Math.floor(circumference / (dotRadius * 3)));

      for (let i = 0; i < count; i++) {
        const angle = (i / count) * Math.PI * 2 + rotRad;
        const x = cx + Math.cos(angle) * radius;
        const y = cy + Math.sin(angle) * radius;
        const cell = circleCellInBounds(x, y, dotRadius, width, height);
        if (cell) cells.push(cell);
      }
    }
    return cells;
  },
};
