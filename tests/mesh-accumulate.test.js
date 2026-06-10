import { describe, it, expect } from 'vitest';
import { accumulateCellPixels } from '../src/core/mesh-accumulate.js';

/** RGBA ピクセル列を組み立てるヘルパ */
function pixels(...px) {
  const out = new Uint8ClampedArray(px.length * 4);
  px.forEach(([r, g, b, a], i) => out.set([r, g, b, a], i * 4));
  return out;
}

describe('accumulateCellPixels', () => {
  it('セルIDごとに total / dark を数える', () => {
    // mask: cell1, cell1, cell2, 背景
    const mask = pixels([1, 0, 0, 255], [1, 0, 0, 255], [2, 0, 0, 255], [0, 0, 0, 255]);
    // source: 黒, 白, 黒, 黒
    const source = pixels([0, 0, 0, 255], [255, 255, 255, 255], [0, 0, 0, 255], [0, 0, 0, 255]);
    const { dark, total } = accumulateCellPixels(source, mask, 2, 200, 128);
    expect([...total]).toEqual([2, 1]);
    expect([...dark]).toEqual([1, 1]);
  });

  it('マスクのアンチエイリアス境界 (alpha < threshold) はスキップ', () => {
    const mask = pixels([1, 0, 0, 199], [1, 0, 0, 200]);
    const source = pixels([0, 0, 0, 255], [0, 0, 0, 255]);
    const { dark, total } = accumulateCellPixels(source, mask, 1, 200, 128);
    expect([...total]).toEqual([1]);
    expect([...dark]).toEqual([1]);
  });

  it('ID は R + G<<8 でデコードされる（256セル超）', () => {
    const mask = pixels([44, 1, 0, 255]); // id = 44 + 256 = 300
    const source = pixels([0, 0, 0, 255]);
    const { total } = accumulateCellPixels(source, mask, 300, 200, 128);
    expect(total[299]).toBe(1);
  });

  it('範囲外IDと背景(0)は無視', () => {
    const mask = pixels([0, 0, 0, 255], [5, 0, 0, 255]);
    const source = pixels([0, 0, 0, 255], [0, 0, 0, 255]);
    const { total } = accumulateCellPixels(source, mask, 2, 200, 128);
    expect([...total]).toEqual([0, 0]);
  });

  it('明度はRGB平均で判定される', () => {
    // (128+128+128)/3 = 128 → not dark (threshold 128, strict <)
    const mask = pixels([1, 0, 0, 255], [1, 0, 0, 255]);
    const source = pixels([128, 128, 128, 255], [127, 128, 126, 255]);
    const { dark, total } = accumulateCellPixels(source, mask, 1, 200, 128);
    expect([...total]).toEqual([2]);
    expect([...dark]).toEqual([1]);
  });
});
