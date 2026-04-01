import { createCell } from '../core/cell.js';

export const PixelGrid = {
  name: 'PixelGrid',

  getParamDefs() {
    return [
      { key: 'gridSize', label: 'Grid Size', min: 4, max: 64, default: 16, step: 1 },
    ];
  },

  generateCells(width, height, params) {
    const size = params.gridSize || 16;
    const cols = Math.floor(width / size);
    const rows = Math.floor(height / size);
    const offsetX = (width - cols * size) / 2;
    const offsetY = (height - rows * size) / 2;
    const cells = [];

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const x = offsetX + c * size;
        const y = offsetY + r * size;
        const path = new Path2D();
        path.rect(x, y, size, size);
        cells.push(createCell({
          path,
          center: { x: x + size / 2, y: y + size / 2 },
        }));
      }
    }
    return cells;
  },
};
