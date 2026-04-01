import { createCell } from '../core/cell.js';

export const EllipseGrid = {
  name: 'EllipseGrid',

  getParamDefs() {
    return [
      { key: 'aspectRatio', label: 'Aspect Ratio', min: 0.3, max: 3.0, default: 1.5, step: 0.1 },
      { key: 'layers', label: 'Layers', min: 2, max: 25, default: 8, step: 1 },
      { key: 'spacing', label: 'Spacing', min: 5, max: 40, default: 15, step: 1 },
      { key: 'dotRadius', label: 'Dot Radius', min: 2, max: 20, default: 6, step: 1 },
    ];
  },

  generateCells(width, height, params) {
    const { aspectRatio = 1.5, layers = 8, spacing = 15, dotRadius = 6 } = params;
    const cx = width / 2;
    const cy = height / 2;
    const cells = [];

    // Center cell
    const centerPath = new Path2D();
    centerPath.arc(cx, cy, dotRadius, 0, Math.PI * 2);
    cells.push(createCell({ path: centerPath, center: { x: cx, y: cy } }));

    for (let layer = 1; layer <= layers; layer++) {
      const a = layer * spacing * aspectRatio; // semi-major
      const b = layer * spacing;               // semi-minor
      const circumference = Math.PI * (3 * (a + b) - Math.sqrt((3 * a + b) * (a + 3 * b)));
      const count = Math.max(6, Math.floor(circumference / (dotRadius * 3)));

      for (let i = 0; i < count; i++) {
        const angle = (i / count) * Math.PI * 2;
        const x = cx + a * Math.cos(angle);
        const y = cy + b * Math.sin(angle);

        if (x - dotRadius < 0 || x + dotRadius > width || y - dotRadius < 0 || y + dotRadius > height) continue;

        const path = new Path2D();
        path.arc(x, y, dotRadius, 0, Math.PI * 2);
        cells.push(createCell({ path, center: { x, y } }));
      }
    }
    return cells;
  },
};
