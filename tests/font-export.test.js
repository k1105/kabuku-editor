import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { buildVariableTTF } from '../src/render/font/vf-builder.js';
import { buildFont } from '../src/render/font-exporter.js';

/**
 * フォント書き出しのスナップショットテスト。
 * Phase 2 の座標変換共通化・グリフ収集共通化（collectGlyphSpecs）で
 * バイト列が変わらないことを保証する命綱。
 *
 * head テーブルの created と nameID 3 が Date.now() を含むため固定する。
 */

// PixelGrid gridSize=256 → 1024px で 4x4 セル、中心は 128/384/640/896
function fixtureProject() {
  return {
    global: {
      stretchAngle: 0,
      stretchAmount: 0,
      baseGap: 20,
      gapDirectionWeight: 1,
      metaballStrength: 1,
      metaballRadius: 8,
      gridDefaults: {},
      defaultLayers: [
        { gridName: 'PixelGrid', gridParams: { gridSize: 256 }, name: 'PixelGrid' },
      ],
      fontMetrics: { ascender: 0.05, xHeight: 0.3, baseline: 0.8, descender: 0.95 },
      fontInfo: { familyName: 'KabukuTest' },
    },
    characters: {
      // 縦棒っぽい形: 中央列を埋める
      I: {
        layerOverrides: [
          {
            gridName: 'PixelGrid',
            cells: [
              { center: { x: 384, y: 128 }, filled: true },
              { center: { x: 384, y: 384 }, filled: true },
              { center: { x: 384, y: 640 }, filled: true },
            ],
          },
        ],
      },
      // 単一コードポイントでない charId はスキップされる
      new_1: { layerOverrides: [] },
    },
  };
}

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(1_750_000_000_000);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

describe('buildVariableTTF', () => {
  it('バイト列が決定的で、スナップショットと一致する', () => {
    const { binary, skipped } = buildVariableTTF(fixtureProject(), { angle: 45 });
    expect(skipped).toEqual(['new_1']);
    // sfnt version = 0x00010000 (TTF)
    expect([...binary.slice(0, 4)]).toEqual([0x00, 0x01, 0x00, 0x00]);
    expect({ length: binary.length, sha256: sha256(binary) }).toMatchSnapshot();
  });

  it('同じ入力からは同じバイト列', () => {
    const a = buildVariableTTF(fixtureProject(), { angle: 45 }).binary;
    const b = buildVariableTTF(fixtureProject(), { angle: 45 }).binary;
    expect(sha256(a)).toBe(sha256(b));
  });

  it('角度が違えばバイト列も変わる', () => {
    const a = buildVariableTTF(fixtureProject(), { angle: 0 }).binary;
    const b = buildVariableTTF(fixtureProject(), { angle: 90 }).binary;
    expect(sha256(a)).not.toBe(sha256(b));
  });
});

describe('buildFont (static OTF)', () => {
  it('グリフのパスデータがスナップショットと一致する', () => {
    const { font, skipped } = buildFont(fixtureProject(), {
      transform: { stretchAngle: 45, stretchAmount: 1, baseGap: 10, gapDirectionWeight: 0.5 },
    });
    expect(skipped).toEqual(['new_1']);
    const glyphData = [];
    for (let i = 0; i < font.glyphs.length; i++) {
      const g = font.glyphs.get(i);
      glyphData.push({
        name: g.name,
        unicode: g.unicode ?? null,
        advanceWidth: g.advanceWidth,
        path: g.path ? g.path.toPathData(2) : null,
      });
    }
    expect(glyphData).toMatchSnapshot();
  });
});
