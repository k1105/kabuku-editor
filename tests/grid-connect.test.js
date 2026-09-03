import { describe, it, expect } from 'vitest';
import {
  connectionStep,
  connectorPairs,
  connectorQuads,
  connectHiddenCells,
  connectRunScales,
  effectiveCellScale,
  layerScaleTransform,
  isConnectEnabled,
} from '../src/render/grid-connect.js';

const SIZE = 16;

/** PixelGrid 相当の矩形セル（格子座標 col/row 指定）。 */
function cell(col, row, filled = true, orientation = null) {
  const x = col * SIZE;
  const y = row * SIZE;
  return {
    center: { x: x + SIZE / 2, y: y + SIZE / 2 },
    filled,
    geometry: { type: 'rect', x, y, width: SIZE, height: SIZE },
    orientation,
    coherence: 0,
  };
}

function pixelLayer(cells, connect = 1, scaleParallel = 1, scaleOrthogonal = 1) {
  return {
    gridPlugin: { name: 'PixelGrid' },
    gridParams: { gridSize: SIZE, connect },
    cells,
    scaleParallel,
    scaleOrthogonal,
  };
}

describe('connectionStep', () => {
  it('45°単位に量子化する', () => {
    expect(connectionStep(0)).toEqual({ di: 1, dj: 0 });
    expect(connectionStep(20)).toEqual({ di: 1, dj: 0 });
    expect(connectionStep(45)).toEqual({ di: 1, dj: 1 });
    expect(connectionStep(90)).toEqual({ di: 0, dj: 1 });
    expect(connectionStep(110)).toEqual({ di: 0, dj: 1 });
    expect(connectionStep(135)).toEqual({ di: -1, dj: 1 });
    expect(connectionStep(170)).toEqual({ di: 1, dj: 0 }); // 180 ≡ 0
  });
});

describe('connectorPairs', () => {
  it('水平方向: 連続セルはペア、途切れは繋がない', () => {
    // ■■■_■ の並び → ペアは (0,1) と (1,2) の 2 つ
    const cells = [cell(0, 0), cell(1, 0), cell(2, 0), cell(4, 0), cell(3, 0, false)];
    const pairs = connectorPairs(cells, 0);
    expect(pairs.length).toBe(2);
    expect(pairs[0][0].center.x).toBe(cells[0].center.x);
    expect(pairs[0][1].center.x).toBe(cells[1].center.x);
  });

  it('垂直方向 (90°)', () => {
    const cells = [cell(0, 0), cell(0, 1), cell(0, 2)];
    expect(connectorPairs(cells, 90).length).toBe(2);
    // 水平の角度では縦の並びは繋がらない
    expect(connectorPairs(cells, 0).length).toBe(0);
  });

  it('斜め 45°/135°', () => {
    const diag = [cell(0, 0), cell(1, 1), cell(2, 2)];
    expect(connectorPairs(diag, 45).length).toBe(2);
    expect(connectorPairs(diag, 135).length).toBe(0);

    const anti = [cell(2, 0), cell(1, 1), cell(0, 2)];
    expect(connectorPairs(anti, 135).length).toBe(2);
  });

  it('塗りセルが 1 つ以下なら空', () => {
    expect(connectorPairs([cell(0, 0)], 0)).toEqual([]);
    expect(connectorPairs([], 0)).toEqual([]);
  });
});

describe('isConnectEnabled', () => {
  it('PixelGrid + connect=1 のみ有効', () => {
    expect(isConnectEnabled(pixelLayer([], 1))).toBe(true);
    expect(isConnectEnabled(pixelLayer([], 0))).toBe(false);
    expect(isConnectEnabled({ gridPlugin: { name: 'CircleGrid' }, gridParams: { connect: 1 } })).toBe(false);
  });
});

describe('connectorQuads', () => {
  it('伸縮方向と直交する並びを繋ぐ（垂直伸縮 → 水平ペア）', () => {
    const layer = pixelLayer([cell(0, 0), cell(1, 0)]);
    const quads = connectorQuads(layer, { stretchAngle: 90 }, 512, 512, 256);
    expect(quads.length).toBe(1);
    // 中心 (8,8)-(24,8)、半幅 8 → y は 0..16
    expect(quads[0].points).toEqual([
      { x: 8, y: 16 },
      { x: 24, y: 16 },
      { x: 24, y: 0 },
      { x: 8, y: 0 },
    ]);
  });

  it('伸縮方向と平行な並びは繋がない', () => {
    const layer = pixelLayer([cell(0, 0), cell(1, 0)]);
    expect(connectorQuads(layer, { stretchAngle: 0 }, 512, 512, 256)).toEqual([]);
  });

  it('connect=0 なら空', () => {
    const layer = pixelLayer([cell(0, 0), cell(1, 0)], 0);
    expect(connectorQuads(layer, { stretchAngle: 90 }, 512, 512, 256)).toEqual([]);
  });

  it('変位後のセル中心同士を結ぶ', () => {
    // 水平伸縮 → 垂直の並びを接続。両セルは同じ x なので水平伸縮で
    // 同量だけ x 変位し、ブリッジもそのまま追従する。
    const layer = pixelLayer([cell(0, 0), cell(0, 1)]);
    const t = { stretchAngle: 0, stretchAmount: 1 };
    const quads = connectorQuads(layer, t, 512, 512, 256);
    expect(quads.length).toBe(1);
    // x' = 256 + (8 - 256) * 2 = -240、半幅 8 → x は -248..-232
    const xs = quads[0].points.map((p) => p.x).sort((a, b) => a - b);
    expect(xs[0]).toBeCloseTo(-248);
    expect(xs[3]).toBeCloseTo(-232);
  });

  it('stretchAngle を落とした編集ビューでは scaleRefAngle が方向を決める', () => {
    const horizontal = pixelLayer([cell(0, 0), cell(1, 0)]);
    const t = { stretchAngle: 0, stretchAmount: 0, scaleRefAngle: 90 };
    expect(connectorQuads(horizontal, t, 512, 512, 256).length).toBe(1);
  });
});

describe('connectHiddenCells', () => {
  it('連結された並びの端点以外（両側に相手がいるセル）を隠す', () => {
    const cells = [cell(0, 0), cell(1, 0), cell(2, 0), cell(3, 0)];
    const hidden = connectHiddenCells(pixelLayer(cells), { stretchAngle: 90, connectHideInterior: true });
    expect(hidden.has(cells[0])).toBe(false);
    expect(hidden.has(cells[1])).toBe(true);
    expect(hidden.has(cells[2])).toBe(true);
    expect(hidden.has(cells[3])).toBe(false);
  });

  it('孤立セル・2セルの並びは何も隠さない', () => {
    const cells = [cell(0, 0), cell(1, 0), cell(5, 0)];
    expect(connectHiddenCells(pixelLayer(cells), { stretchAngle: 90, connectHideInterior: true }).size).toBe(0);
  });

  it('接続方向と違う並びは隠さない', () => {
    const cells = [cell(0, 0), cell(1, 0), cell(2, 0)];
    expect(connectHiddenCells(pixelLayer(cells), { stretchAngle: 0, connectHideInterior: true }).size).toBe(0);
  });

  it('connect=0 なら空', () => {
    const cells = [cell(0, 0), cell(1, 0), cell(2, 0)];
    expect(connectHiddenCells(pixelLayer(cells, 0), { stretchAngle: 90, connectHideInterior: true }).size).toBe(0);
  });

  it('connectHideInterior が無い（version 8 以前の）transform では何も隠さない', () => {
    const cells = [cell(0, 0), cell(1, 0), cell(2, 0)];
    expect(connectHiddenCells(pixelLayer(cells), { stretchAngle: 90 }).size).toBe(0);
    expect(connectHiddenCells(pixelLayer(cells), { stretchAngle: 90, connectHideInterior: false }).size).toBe(0);
  });

  it('編集ビューでは scaleRefAngle が方向を決める', () => {
    const cells = [cell(0, 0), cell(1, 0), cell(2, 0)];
    const t = { stretchAngle: 0, stretchAmount: 0, scaleRefAngle: 90, connectHideInterior: true };
    expect(connectHiddenCells(pixelLayer(cells), t).size).toBe(1);
  });
});

describe('connectRunScales / effectiveCellScale', () => {
  // 伸縮 90°(垂直) → 水平の並びを接続。scaleParallel=1, scaleOrthogonal=2 で
  // orientation 90° は平行(1.0)、0° は直交(2.0)、45° は中間(1.5)。
  const t = { stretchAngle: 90, connectHideInterior: true, connectUniformScale: true };

  it('連結された並びの全セルが run 内最大のスケールになる', () => {
    const cells = [cell(0, 0, true, 90), cell(1, 0, true, 45), cell(2, 0, true, 0)];
    const layer = pixelLayer(cells, 1, 1, 2);
    const scales = connectRunScales(layer, t);
    expect(scales.size).toBe(3);
    for (const c of cells) expect(scales.get(c)).toBeCloseTo(2);
    const layerT = layerScaleTransform(layer, t);
    expect(effectiveCellScale(cells[0], layerT, scales)).toBeCloseTo(2);
  });

  it('別の run・孤立セルは影響を受けない', () => {
    // ■■_■_■ : run A = (0,1)、run B なし、孤立 = 3, 5
    const cells = [cell(0, 0, true, 90), cell(1, 0, true, 0), cell(3, 0, true, 90), cell(5, 0, true, 45)];
    const layer = pixelLayer(cells, 1, 1, 2);
    const scales = connectRunScales(layer, t);
    expect(scales.get(cells[0])).toBeCloseTo(2);
    expect(scales.get(cells[1])).toBeCloseTo(2);
    expect(scales.has(cells[2])).toBe(false);
    expect(scales.has(cells[3])).toBe(false);
    const layerT = layerScaleTransform(layer, t);
    expect(effectiveCellScale(cells[2], layerT, scales)).toBeCloseTo(1);
    expect(effectiveCellScale(cells[3], layerT, scales)).toBeCloseTo(1.5);
  });

  it('負のスケールは絶対値で比較し、結果は非負', () => {
    const cells = [cell(0, 0, true, 90), cell(1, 0, true, 0)];
    const layer = pixelLayer(cells, 1, 1, -3);
    const scales = connectRunScales(layer, t);
    expect(scales.get(cells[0])).toBeCloseTo(3);
    expect(scales.get(cells[1])).toBeCloseTo(3);
  });

  it('ブリッジの半幅も run のスケールに揃う', () => {
    const cells = [cell(0, 0, true, 90), cell(1, 0, true, 0)];
    const layer = pixelLayer(cells, 1, 1, 2);
    const quads = connectorQuads(layer, t, 512, 512, 256);
    expect(quads.length).toBe(1);
    // 半幅 = 2 × 8 = 16 → y は -8..24 で両端とも同じ
    const ys = quads[0].points.map((p) => p.y);
    expect(ys).toEqual([24, 24, -8, -8]);
  });

  it('connectUniformScale が無い（version 9 以前の）transform では従来通り', () => {
    const cells = [cell(0, 0, true, 90), cell(1, 0, true, 0)];
    const layer = pixelLayer(cells, 1, 1, 2);
    const legacy = { stretchAngle: 90, connectHideInterior: true };
    expect(connectRunScales(layer, legacy).size).toBe(0);
    const quads = connectorQuads(layer, legacy, 512, 512, 256);
    // 左端は半幅 8、右端は半幅 16
    expect(quads[0].points[0].y).toBe(16);
    expect(quads[0].points[1].y).toBe(24);
  });

  it('connect=0 なら空', () => {
    const cells = [cell(0, 0, true, 90), cell(1, 0, true, 0)];
    expect(connectRunScales(pixelLayer(cells, 0, 1, 2), t).size).toBe(0);
  });
});
