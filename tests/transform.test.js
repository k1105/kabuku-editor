import { describe, it, expect } from 'vitest';
import { stretchMatrix } from '../src/core/transform-math.js';
import { applyStretch } from '../src/transform/stretch.js';
import { applyGap } from '../src/transform/gap.js';
import { cellScaleFactor, scaleGeometryAboutCenter } from '../src/render/transform-utils.js';

describe('scaleGeometryAboutCenter', () => {
  const center = { x: 100, y: 100 };

  it('s===1 returns the original object', () => {
    const g = { type: 'rect', x: 90, y: 90, width: 20, height: 20 };
    expect(scaleGeometryAboutCenter(g, center, 1)).toBe(g);
  });

  it('scales a centered rect about its center', () => {
    const g = { type: 'rect', x: 90, y: 90, width: 20, height: 20 }; // center 100,100
    const r = scaleGeometryAboutCenter(g, center, 2);
    expect(r.width).toBeCloseTo(40);
    expect(r.height).toBeCloseTo(40);
    expect(r.x).toBeCloseTo(80);  // stays centered on 100
    expect(r.y).toBeCloseTo(80);
  });

  it('scales a circle radius and keeps its center', () => {
    const g = { type: 'circle', cx: 100, cy: 100, r: 10 };
    const r = scaleGeometryAboutCenter(g, center, 1.5);
    expect(r.r).toBeCloseTo(15);
    expect(r.cx).toBeCloseTo(100);
    expect(r.cy).toBeCloseTo(100);
  });

  it('negative scale normalizes rect dims (stays centered) ', () => {
    const g = { type: 'rect', x: 90, y: 90, width: 20, height: 20 };
    const r = scaleGeometryAboutCenter(g, center, -1);
    expect(r.width).toBeCloseTo(20);
    expect(r.height).toBeCloseTo(20);
    expect(r.x).toBeCloseTo(90);
    expect(r.y).toBeCloseTo(90);
  });

  it('mirrors polygon points about center for negative scale', () => {
    const g = { type: 'polygon', points: [{ x: 110, y: 100 }, { x: 100, y: 110 }] };
    const r = scaleGeometryAboutCenter(g, center, -1);
    expect(r.points[0]).toEqual({ x: 90, y: 100 });
    expect(r.points[1]).toEqual({ x: 100, y: 90 });
  });
});

describe('cellScaleFactor', () => {
  const cell = (orientation) => ({ orientation });

  it('range 1/1 is identity regardless of orientation', () => {
    const t = { stretchAngle: 30, scaleParallel: 1, scaleOrthogonal: 1 };
    expect(cellScaleFactor(cell(0), t)).toBe(1);
    expect(cellScaleFactor(cell(90), t)).toBe(1);
  });

  it('orthogonal → scaleOrthogonal, parallel → scaleParallel', () => {
    const t = { stretchAngle: 0, scaleParallel: 0.5, scaleOrthogonal: 1.5 };
    expect(cellScaleFactor(cell(0), t)).toBeCloseTo(0.5);  // parallel to 0°
    expect(cellScaleFactor(cell(90), t)).toBeCloseTo(1.5); // orthogonal
    expect(cellScaleFactor(cell(45), t)).toBeCloseTo(1.0); // midpoint
  });

  it('uses the angle vs the stretch direction (undirected)', () => {
    const t = { stretchAngle: 90, scaleParallel: 0.5, scaleOrthogonal: 1.5 };
    expect(cellScaleFactor(cell(90), t)).toBeCloseTo(0.5);  // now 90° is parallel
    expect(cellScaleFactor(cell(0), t)).toBeCloseTo(1.5);   // 0° is orthogonal
    expect(cellScaleFactor(cell(180), t)).toBeCloseTo(1.5); // 180 == 0
  });

  it('null orientation (isolated cell) is not scaled', () => {
    const t = { stretchAngle: 0, scaleParallel: 0.5, scaleOrthogonal: 1.5 };
    expect(cellScaleFactor(cell(null), t)).toBe(1);
  });

  it('negative endpoints interpolate through zero', () => {
    const t = { stretchAngle: 0, scaleParallel: 1, scaleOrthogonal: -1 };
    expect(cellScaleFactor(cell(0), t)).toBeCloseTo(1);
    expect(cellScaleFactor(cell(45), t)).toBeCloseTo(0);   // shrinks to nothing
    expect(cellScaleFactor(cell(90), t)).toBeCloseTo(-1);  // mirrored
  });
});

describe('stretchMatrix', () => {
  it('amount 0 は単位行列', () => {
    const m = stretchMatrix(37, 0);
    expect(m.a).toBeCloseTo(1, 12);
    expect(m.b).toBeCloseTo(0, 12);
    expect(m.d).toBeCloseTo(1, 12);
  });

  it('angle 0 は X 方向のみ拡大', () => {
    const m = stretchMatrix(0, 1);
    expect(m.a).toBeCloseTo(2, 12);
    expect(m.b).toBeCloseTo(0, 12);
    expect(m.d).toBeCloseTo(1, 12);
  });

  it('angle 90 は Y 方向のみ拡大', () => {
    const m = stretchMatrix(90, 1);
    expect(m.a).toBeCloseTo(1, 12);
    expect(m.b).toBeCloseTo(0, 12);
    expect(m.d).toBeCloseTo(2, 12);
  });

  it('null/undefined 引数は識別値として扱う', () => {
    const m = stretchMatrix(undefined, undefined);
    expect(m.a).toBeCloseTo(1, 12);
    expect(m.b).toBeCloseTo(0, 12);
    expect(m.d).toBeCloseTo(1, 12);
  });

  it('45度: 既知の対称行列', () => {
    const m = stretchMatrix(45, 1);
    expect(m.a).toBeCloseTo(1.5, 12);
    expect(m.b).toBeCloseTo(0.5, 12);
    expect(m.d).toBeCloseTo(1.5, 12);
  });
});

describe('applyStretch', () => {
  it('amount 0 は同一オブジェクトを返す', () => {
    const c = { x: 10, y: 20 };
    expect(applyStretch(c, 45, 0, 100, 100)).toBe(c);
  });

  it('angle 0: 中心からの X 距離が (1+amount) 倍になる', () => {
    const out = applyStretch({ x: 70, y: 30 }, 0, 1, 100, 100, 50);
    expect(out.x).toBeCloseTo(50 + (70 - 50) * 2, 10);
    expect(out.y).toBeCloseTo(30, 10);
  });

  it('angle 90: ベースラインを基準に Y 距離が伸びる', () => {
    const out = applyStretch({ x: 50, y: 30 }, 90, 1, 100, 100, 80);
    expect(out.x).toBeCloseTo(50, 10);
    expect(out.y).toBeCloseTo(80 + (30 - 80) * 2, 10);
  });

  it('baselineY 省略時は canvasHeight/2 がピボット', () => {
    const out = applyStretch({ x: 50, y: 30 }, 90, 1, 100, 100);
    expect(out.y).toBeCloseTo(50 + (30 - 50) * 2, 10);
  });

  it('ピボット上の点は不動', () => {
    const out = applyStretch({ x: 50, y: 80 }, 30, 2, 100, 100, 80);
    expect(out.x).toBeCloseTo(50, 10);
    expect(out.y).toBeCloseTo(80, 10);
  });

  it('stretchMatrix と applyStretch は同じ変換（実装間整合性）', () => {
    const angle = 33;
    const amount = 0.7;
    const w = 200;
    const h = 200;
    const baselineY = 160;
    const p = { x: 137, y: 42 };
    const viaApply = applyStretch(p, angle, amount, w, h, baselineY);
    const m = stretchMatrix(angle, amount);
    const dx = p.x - w / 2;
    const dy = p.y - baselineY;
    const viaMatrix = {
      x: w / 2 + m.a * dx + m.b * dy,
      y: baselineY + m.b * dx + m.d * dy,
    };
    expect(viaApply.x).toBeCloseTo(viaMatrix.x, 8);
    expect(viaApply.y).toBeCloseTo(viaMatrix.y, 8);
  });
});

describe('applyGap', () => {
  it('baseGap 0 は同一オブジェクトを返す', () => {
    const c = { x: 10, y: 20 };
    expect(applyGap(c, 0, 0, 1, 100, 100)).toBe(c);
  });

  it('中心と一致する点は不動', () => {
    const c = { x: 50, y: 50 };
    expect(applyGap(c, 0, 10, 1, 100, 100)).toBe(c);
  });

  it('weight 0: 方向に依らず一様に baseGap だけ外へ押し出す', () => {
    const out = applyGap({ x: 80, y: 50 }, 0, 10, 0, 100, 100);
    expect(out.x).toBeCloseTo(90, 10);
    expect(out.y).toBeCloseTo(50, 10);
  });

  it('weight 1: ストレッチ方向に最大、直交方向はゼロ', () => {
    // ストレッチ角 0、セルも角 0 方向 → cos^2 = 1 → gap = baseGap
    const along = applyGap({ x: 80, y: 50 }, 0, 10, 1, 100, 100);
    expect(along.x).toBeCloseTo(90, 10);
    // 直交方向（真上）→ cos^2 = 0 → gap = 0
    const perp = applyGap({ x: 50, y: 20 }, 0, 10, 1, 100, 100);
    expect(perp.x).toBeCloseTo(50, 10);
    expect(perp.y).toBeCloseTo(20, 10);
  });
});
