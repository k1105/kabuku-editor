import { describe, it, expect } from 'vitest';
import { getAllGrids } from '../src/grids/grid-plugin.js';

/**
 * グリッドプラグインの特性テスト（characterization test）。
 * 「現在の出力」を固定し、リファクタリングで挙動が変わったら検知する。
 * 各グリッドはデフォルトパラメータで 1024x1024 に生成し、
 * セル数・geometry 種別・先頭セルの座標をスナップショットする。
 */
const SIZE = 1024;

function defaultParams(grid) {
  const params = {};
  for (const def of grid.getParamDefs()) params[def.key] = def.default;
  return params;
}

describe('grid plugins', () => {
  const grids = getAllGrids();

  it('登録済みグリッド一覧', () => {
    expect(grids.map((g) => g.name).sort()).toMatchSnapshot();
  });

  for (const grid of getAllGrids()) {
    describe(grid.name, () => {
      it('インターフェイスを満たす', () => {
        expect(typeof grid.name).toBe('string');
        expect(typeof grid.generateCells).toBe('function');
        expect(typeof grid.getParamDefs).toBe('function');
        for (const def of grid.getParamDefs()) {
          expect(def).toHaveProperty('key');
          expect(def).toHaveProperty('default');
          expect(def.min).toBeLessThanOrEqual(def.default);
          expect(def.max).toBeGreaterThanOrEqual(def.default);
        }
      });

      it('デフォルトパラメータでの出力は決定的', () => {
        const a = grid.generateCells(SIZE, SIZE, defaultParams(grid));
        const b = grid.generateCells(SIZE, SIZE, defaultParams(grid));
        expect(a.length).toBe(b.length);
        for (let i = 0; i < a.length; i++) {
          expect(a[i].center).toEqual(b[i].center);
        }
      });

      it('セルは正しい形をしている', () => {
        const cells = grid.generateCells(SIZE, SIZE, defaultParams(grid));
        expect(cells.length).toBeGreaterThan(0);
        for (const cell of cells) {
          expect(cell.center.x).toBeTypeOf('number');
          expect(cell.center.y).toBeTypeOf('number');
          expect(Number.isFinite(cell.center.x)).toBe(true);
          expect(Number.isFinite(cell.center.y)).toBe(true);
          expect(cell.filled).toBe(false);
        }
      });

      it('出力の特性スナップショット', () => {
        const cells = grid.generateCells(SIZE, SIZE, defaultParams(grid));
        const summary = {
          count: cells.length,
          geometryTypes: [...new Set(cells.map((c) => c.geometry?.type ?? null))].sort(),
          firstCenters: cells.slice(0, 5).map((c) => ({
            x: Math.round(c.center.x * 100) / 100,
            y: Math.round(c.center.y * 100) / 100,
          })),
        };
        expect(summary).toMatchSnapshot();
      });
    });
  }
});
