import { describe, it, expect } from 'vitest';
import { geometryBounds, layersInkBounds, layoutInkBounds, centerPositionsOnInk } from '../src/animation/ink-bounds.js';
import { computeLayout } from '../src/animation/render.js';

const rectCell = (x, y, w, h, filled = true) => ({
  filled, center: { x: x + w / 2, y: y + h / 2 }, geometry: { type: 'rect', x, y, width: w, height: h },
});

describe('geometryBounds', () => {
  it('handles rect / circle / polygon', () => {
    expect(geometryBounds({ type: 'rect', x: 1, y: 2, width: 3, height: 4 })).toEqual({ minX: 1, minY: 2, maxX: 4, maxY: 6 });
    expect(geometryBounds({ type: 'circle', cx: 5, cy: 5, r: 2 })).toEqual({ minX: 3, minY: 3, maxX: 7, maxY: 7 });
    expect(geometryBounds({ type: 'polygon', points: [{ x: 0, y: 1 }, { x: 4, y: -1 }, { x: 2, y: 3 }] }))
      .toEqual({ minX: 0, minY: -1, maxX: 4, maxY: 3 });
  });
  it('falls back to the cell center without geometry', () => {
    expect(geometryBounds(null, { x: 2, y: 3 })).toEqual({ minX: 2, minY: 3, maxX: 2, maxY: 3 });
    expect(geometryBounds(null, null)).toBeNull();
  });
});

describe('layersInkBounds', () => {
  it('unions filled cells of visible layers only, in em fractions', () => {
    const layers = [
      { visible: true, cells: [rectCell(0, 800, 100, 100), rectCell(900, 900, 100, 100), rectCell(0, 0, 100, 100, false)] },
      { visible: false, cells: [rectCell(0, 0, 100, 100)] },
    ];
    expect(layersInkBounds(layers, 1000)).toEqual({ minX: 0, minY: 0.8, maxX: 1, maxY: 1 });
  });
  it('returns null when nothing is filled', () => {
    expect(layersInkBounds([{ visible: true, cells: [rectCell(0, 0, 10, 10, false)] }], 1000)).toBeNull();
  });
});

describe('layoutInkBounds / centerPositionsOnInk', () => {
  // 'a' occupies the lower half of its em box; 'b' the upper half.
  const ink = { a: { minX: 0.25, minY: 0.5, maxX: 0.75, maxY: 1 }, b: { minX: 0.25, minY: 0, maxX: 0.75, maxY: 0.5 } };
  const inkFor = (id) => ink[id] || null;

  it('unions glyph ink boxes in layout px, skipping glyphs without ink', () => {
    const positions = [
      { charId: 'a', x: 0, y: 0, missing: false },
      { charId: ' ', x: 100, y: 0, missing: false },
    ];
    expect(layoutInkBounds(positions, 100, inkFor)).toEqual({ minX: 25, minY: 50, maxX: 75, maxY: 100 });
  });
  it('counts a missing glyph as its full em box', () => {
    const positions = [{ charId: '?', x: 10, y: 20, missing: true }];
    expect(layoutInkBounds(positions, 100, inkFor)).toEqual({ minX: 10, minY: 20, maxX: 110, maxY: 120 });
  });
  it('shifts positions so the ink union is centered on the block', () => {
    const positions = [{ charId: 'a', x: 0, y: 0, missing: false }];
    const out = centerPositionsOnInk(positions, 100, 100, 100, inkFor);
    // ink center (50, 75) → block center (50, 50): shift y by -25
    expect(out).toEqual([{ charId: 'a', x: 0, y: -25, missing: false }]);
    expect(positions[0].y).toBe(0); // input untouched
  });
  it('is a no-op when no glyph has ink', () => {
    const positions = [{ charId: ' ', x: 0, y: 0, missing: false }];
    expect(centerPositionsOnInk(positions, 100, 100, 100, inkFor)).toBe(positions);
  });
});

describe('computeLayout alignMode', () => {
  const charIds = new Set(['a', 'b']);
  const global = { fontMetrics: { baseline: 0.8 } };
  const params = { fontSize: 100, kerning: 0, lineHeight: 1.5, stretchAngle: 0, stretchAmount: 0, baseGap: 0, gapDirectionWeight: 0, metaballRadius: 0 };
  const ink = { a: { minX: 0.25, minY: 0.5, maxX: 0.75, maxY: 1 }, b: { minX: 0.25, minY: 0, maxX: 0.75, maxY: 0.5 } };
  const inkFor = (id) => ink[id] || null;

  it('baseline mode leaves positions on the shared baseline (y = 0)', () => {
    const layout = computeLayout({ ...params, text: 'a' }, { text: 'a', writingMode: 'horizontal', alignMode: 'baseline' }, charIds, global, inkFor);
    expect(layout.positions[0].y).toBe(0);
  });
  it('center mode shifts glyphs so their ink is centered, keeping cw/ch', () => {
    const anim = { text: 'a', writingMode: 'horizontal', alignMode: 'center' };
    const base = computeLayout({ ...params, text: 'a' }, { ...anim, alignMode: 'baseline' }, charIds, global, inkFor);
    const a = computeLayout({ ...params, text: 'a' }, anim, charIds, global, inkFor);
    const b = computeLayout({ ...params, text: 'b' }, anim, charIds, global, inkFor);
    expect(a.cw).toBe(base.cw);
    expect(a.ch).toBe(base.ch);
    // 'a' ink center is at y=75 → shift -25; 'b' ink center at y=25 → shift +25.
    expect(a.positions[0].y).toBe(-25);
    expect(b.positions[0].y).toBe(25);
    // Both ink centers land at the same block-relative point.
    const centerOf = (l, id) => l.positions[0].y + (ink[id].minY + ink[id].maxY) / 2 * params.fontSize;
    expect(centerOf(a, 'a')).toBe(centerOf(b, 'b'));
  });
  it('center mode without an ink resolver falls back to baseline layout', () => {
    const layout = computeLayout({ ...params, text: 'a' }, { text: 'a', writingMode: 'horizontal', alignMode: 'center' }, charIds, global);
    expect(layout.positions[0].y).toBe(0);
  });
});

describe('computeLayout ignores baselineY (applied post-projection in the camera)', () => {
  it('leaves layout untouched', () => {
    const charIds = new Set(['a']);
    const global = { fontMetrics: { baseline: 0.8 } };
    const params = { fontSize: 100, kerning: 0, lineHeight: 1.5, stretchAngle: 0, stretchAmount: 0, baseGap: 0, gapDirectionWeight: 0, metaballRadius: 0, text: 'a' };
    const anim = { text: 'a', writingMode: 'horizontal', alignMode: 'baseline' };
    const base = computeLayout(params, anim, charIds, global);
    const shifted = computeLayout({ ...params, baselineY: 40 }, anim, charIds, global);
    expect(shifted.positions).toEqual(base.positions);
  });
});
