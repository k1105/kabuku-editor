import { createCell } from '../core/cell.js';
import { circleCell } from './circle-utils.js';

export const PixelGrid = {
  name: 'PixelGrid',

  getParamDefs() {
    return [
      { key: 'gridSize', label: 'Grid Size', min: 4, max: 128, default: 32, step: 1 },
      { key: 'roundness', label: 'Roundness (□0–○1)', min: 0, max: 1, default: 0, step: 0.01 },
      // Bridge consecutive filled cells orthogonal to the stretch direction (0=off, 1=on).
      { key: 'connect', label: 'Grid Connect', min: 0, max: 1, default: 0, step: 1 },
    ];
  },

  generateCells(width, height, params) {
    const size = params.gridSize || 16;
    const roundness = Math.min(1, Math.max(0, params.roundness ?? 0));
    const cornerR = (roundness * size) / 2;
    const cols = Math.floor(width / size);
    const rows = Math.floor(height / size);
    const offsetX = (width - cols * size) / 2;
    const offsetY = (height - rows * size) / 2;
    const cells = [];

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const x = offsetX + c * size;
        const y = offsetY + r * size;
        if (cornerR >= size / 2) {
          cells.push(circleCell(x + size / 2, y + size / 2, size / 2));
          continue;
        }
        const path = new Path2D();
        if (cornerR > 0) {
          path.roundRect(x, y, size, size, cornerR);
        } else {
          path.rect(x, y, size, size);
        }
        cells.push(createCell({
          path,
          center: { x: x + size / 2, y: y + size / 2 },
          geometry: {
            type: 'rect', x, y, width: size, height: size,
            ...(cornerR > 0 ? { r: cornerR } : {}),
          },
        }));
      }
    }
    return cells;
  },
};
