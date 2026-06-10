import { circleCell, circleCellInBounds } from './circle-utils.js';

export const EllipseGrid = {
  name: 'EllipseGrid',

  getParamDefs() {
    return [
      { key: 'aspectRatio', label: 'Aspect Ratio', min: 0.3, max: 3.0, default: 1.5, step: 0.1 },
      { key: 'layers', label: 'Layers', min: 2, max: 50, default: 16, step: 1 },
      { key: 'spacing', label: 'Spacing', min: 5, max: 80, default: 30, step: 1 },
      { key: 'dotRadius', label: 'Dot Radius', min: 2, max: 40, default: 12, step: 1 },
    ];
  },

  generateCells(width, height, params) {
    const { aspectRatio = 1.5, layers = 8, spacing = 15, dotRadius = 6 } = params;
    const cx = width / 2;
    const cy = height / 2;
    const cells = [circleCell(cx, cy, dotRadius)];

    for (let layer = 1; layer <= layers; layer++) {
      const a = layer * spacing * aspectRatio; // semi-major
      const b = layer * spacing;               // semi-minor
      const circumference = Math.PI * (3 * (a + b) - Math.sqrt((3 * a + b) * (a + 3 * b)));
      const count = Math.max(6, Math.floor(circumference / (dotRadius * 3)));

      for (let i = 0; i < count; i++) {
        const angle = (i / count) * Math.PI * 2;
        const x = cx + a * Math.cos(angle);
        const y = cy + b * Math.sin(angle);
        const cell = circleCellInBounds(x, y, dotRadius, width, height);
        if (cell) cells.push(cell);
      }
    }
    return cells;
  },
};
