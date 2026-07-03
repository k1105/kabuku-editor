import { createCell } from '../core/cell.js';
import { circleCell } from './circle-utils.js';

export const PixelGrid = {
  name: 'PixelGrid',

  getParamDefs() {
    return [
      { key: 'gridSize', label: 'Grid Size', min: 4, max: 128, default: 32, step: 1 },
      { key: 'shape', label: 'Shape (□=0 / ○=1)', min: 0, max: 1, default: 0, step: 1 },
    ];
  },

  generateCells(width, height, params) {
    const size = params.gridSize || 16;
    const circle = (params.shape ?? 0) >= 1;
    const cols = Math.floor(width / size);
    const rows = Math.floor(height / size);
    const offsetX = (width - cols * size) / 2;
    const offsetY = (height - rows * size) / 2;
    const cells = [];

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const x = offsetX + c * size;
        const y = offsetY + r * size;
        if (circle) {
          cells.push(circleCell(x + size / 2, y + size / 2, size / 2));
          continue;
        }
        const path = new Path2D();
        path.rect(x, y, size, size);
        cells.push(createCell({
          path,
          center: { x: x + size / 2, y: y + size / 2 },
          geometry: { type: 'rect', x, y, width: size, height: size },
        }));
      }
    }
    return cells;
  },
};
