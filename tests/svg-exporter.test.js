import { describe, it, expect } from 'vitest';
import { exportLayerToSVG, exportAllLayersToSVG } from '../src/render/svg-exporter.js';

/**
 * SVG エクスポートのスナップショットテスト。
 * Phase 2 でセル座標変換（stretch+gap）を共通化する際、
 * 出力が 1 文字も変わらないことを保証する命綱。
 */
function fixtureLayer(id = 'layer_1') {
  return {
    id,
    name: 'Test',
    visible: true,
    opacity: 0.9,
    cells: [
      {
        center: { x: 100, y: 100 },
        filled: true,
        geometry: { type: 'rect', x: 80, y: 80, width: 40, height: 40 },
      },
      {
        center: { x: 300, y: 200 },
        filled: true,
        geometry: { type: 'circle', cx: 300, cy: 200, r: 25 },
      },
      {
        center: { x: 512, y: 700 },
        filled: true,
        geometry: {
          type: 'polygon',
          points: [
            { x: 500, y: 690 },
            { x: 530, y: 695 },
            { x: 520, y: 715 },
            { x: 498, y: 710 },
          ],
        },
      },
      // 非 filled セルは出力されない
      {
        center: { x: 900, y: 900 },
        filled: false,
        geometry: { type: 'circle', cx: 900, cy: 900, r: 25 },
      },
    ],
  };
}

const METRICS = { ascender: 0.05, xHeight: 0.3, baseline: 0.8, descender: 0.95 };

describe('svg-exporter', () => {
  it('変換なしの単一レイヤー出力', () => {
    const svg = exportLayerToSVG(fixtureLayer(), 1024, 1024, {
      transform: {},
      fontMetrics: METRICS,
    });
    expect(svg).toMatchSnapshot();
  });

  // metaball (metaballRadius > 0) は OffscreenCanvas でラスタライズするため
  // Node では検証できない。stretch + gap までを固定する。
  it('stretch + gap 込みの全レイヤー出力', () => {
    const layers = [fixtureLayer('layer_1'), { ...fixtureLayer('layer_2'), opacity: 0.5 }];
    const svg = exportAllLayersToSVG(layers, 1024, 1024, {
      transform: {
        stretchAngle: 45,
        stretchAmount: 1.5,
        baseGap: 30,
        gapDirectionWeight: 0.5,
      },
      fontMetrics: METRICS,
    });
    expect(svg).toMatchSnapshot();
  });

  it('非表示レイヤーは出力されない', () => {
    const hidden = { ...fixtureLayer('layer_hidden'), visible: false };
    const svg = exportAllLayersToSVG([hidden], 1024, 1024, { transform: {} });
    expect(svg).not.toContain('layer_hidden');
  });

  it('変換なしとあり（amount 0 / baseGap 0）は同一出力', () => {
    const a = exportLayerToSVG(fixtureLayer(), 1024, 1024, { transform: {}, fontMetrics: METRICS });
    const b = exportLayerToSVG(fixtureLayer(), 1024, 1024, {
      transform: { stretchAngle: 45, stretchAmount: 0, baseGap: 0, gapDirectionWeight: 1 },
      fontMetrics: METRICS,
    });
    expect(b).toBe(a);
  });
});
