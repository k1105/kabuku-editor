import { describe, it, expect } from 'vitest';
import { encodeCellsV2, decodeCellsV2, gridParamsEqual, GRID_SPACE } from '../src/core/cell-codec.js';

/**
 * Deterministic fake grid plugin: a `count × count` lattice spread over the
 * glyph space. Mirrors the real plugins' contract (same params + size → same
 * cells in the same order).
 */
const FakeGrid = {
  name: 'FakeGrid',
  generateCells(width, height, params) {
    const count = params.count ?? 4;
    const cells = [];
    for (let r = 0; r < count; r++) {
      for (let c = 0; c < count; c++) {
        cells.push({
          center: { x: ((c + 0.5) * width) / count, y: ((r + 0.5) * height) / count },
          filled: false,
          manualOverride: false,
          orientation: null,
          coherence: 0,
          orientationSource: null,
        });
      }
    }
    return cells;
  },
};

function runtimeCells(params) {
  return FakeGrid.generateCells(GRID_SPACE, GRID_SPACE, params);
}

describe('encodeCellsV2', () => {
  it('returns null when no cell is filled or overridden', () => {
    expect(encodeCellsV2(runtimeCells({ count: 3 }), { count: 3 })).toBeNull();
  });

  it('captures fills, overrides and quantized orientation by index', () => {
    const cells = runtimeCells({ count: 3 });
    cells[1].filled = true;
    cells[4].filled = true;
    cells[4].orientation = 42.34;
    cells[4].coherence = 0.876;
    cells[4].orientationSource = 'propagated';
    cells[7].manualOverride = true; // manually erased cell (not filled)

    const v2 = encodeCellsV2(cells, { count: 3 });
    expect(v2.n).toBe(9);
    expect(v2.params).toEqual({ count: 3 });
    expect(v2.filled).toEqual([1, 4]);
    expect(v2.manual).toEqual([7]);
    expect(v2.orientIdx).toEqual([4]);
    expect(v2.orient).toEqual([423]);
    expect(v2.coher).toEqual([88]);
    expect(v2.src).toBe('p');
  });
});

describe('decodeCellsV2', () => {
  it('round-trips to the legacy saved-cell shape', () => {
    const cells = runtimeCells({ count: 3 });
    cells[1].filled = true;
    cells[4].filled = true;
    cells[4].orientation = 42.3;
    cells[4].coherence = 0.88;
    cells[4].orientationSource = 'propagated';
    cells[7].manualOverride = true;

    const saved = decodeCellsV2(encodeCellsV2(cells, { count: 3 }), FakeGrid);
    expect(saved).toHaveLength(3);

    const at = (i) => saved.find((s) => s.center.x === cells[i].center.x && s.center.y === cells[i].center.y);
    expect(at(1)).toMatchObject({ filled: true, manualOverride: false, orientation: null });
    expect(at(4)).toMatchObject({
      filled: true,
      orientation: 42.3,
      coherence: 0.88,
      orientationSource: 'propagated',
    });
    expect(at(7)).toMatchObject({ filled: false, manualOverride: true });
  });

  it('bails out when the grid no longer reproduces the saved cell count', () => {
    const cells = runtimeCells({ count: 3 });
    cells[0].filled = true;
    const v2 = encodeCellsV2(cells, { count: 3 });
    v2.n = 999;
    expect(decodeCellsV2(v2, FakeGrid)).toBeNull();
  });

  it('ignores out-of-range indices instead of throwing', () => {
    const cells = runtimeCells({ count: 2 });
    cells[0].filled = true;
    const v2 = encodeCellsV2(cells, { count: 2 });
    v2.filled = [0, 500];
    delete v2.n; // older payloads without the guard field still decode
    const saved = decodeCellsV2(v2, FakeGrid);
    expect(saved).toHaveLength(1);
    expect(saved[0].filled).toBe(true);
  });
});

describe('gridParamsEqual', () => {
  it('shallow-compares flat param maps', () => {
    expect(gridParamsEqual({ a: 1, b: 'x' }, { b: 'x', a: 1 })).toBe(true);
    expect(gridParamsEqual({ a: 1 }, { a: 2 })).toBe(false);
    expect(gridParamsEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(gridParamsEqual(null, {})).toBe(true);
  });
});
