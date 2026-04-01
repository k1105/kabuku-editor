import { createCell } from '../core/cell.js';

export const FibonacciGrid = {
  name: 'FibonacciGrid',

  getParamDefs() {
    return [
      { key: 'count', label: 'Count', min: 10, max: 500, default: 150, step: 5 },
      { key: 'scale', label: 'Scale', min: 1, max: 20, default: 8, step: 0.5 },
      { key: 'dotRadius', label: 'Dot Radius', min: 2, max: 15, default: 5, step: 1 },
      { key: 'rotation', label: 'Rotation', min: 0, max: 360, default: 0, step: 1 },
    ];
  },

  generateCells(width, height, params) {
    const { count = 150, scale = 8, dotRadius = 5, rotation = 0 } = params;
    const cx = width / 2;
    const cy = height / 2;
    const goldenAngle = Math.PI * (3 - Math.sqrt(5)); // ~137.5 degrees
    const rotRad = (rotation * Math.PI) / 180;
    const cells = [];

    for (let i = 0; i < count; i++) {
      const r = scale * Math.sqrt(i);
      const theta = i * goldenAngle + rotRad;
      const x = cx + r * Math.cos(theta);
      const y = cy + r * Math.sin(theta);

      if (x - dotRadius < 0 || x + dotRadius > width || y - dotRadius < 0 || y + dotRadius > height) continue;

      const path = new Path2D();
      path.arc(x, y, dotRadius, 0, Math.PI * 2);
      cells.push(createCell({ path, center: { x, y } }));
    }
    return cells;
  },
};
