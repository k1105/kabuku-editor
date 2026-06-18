import { describe, it, expect } from 'vitest';
import {
  normalizeAngle180,
  angularDelta180,
  computeCellOrientations,
  propagateOrientation,
  fillOrientationGaps,
  setCellOrientationManual,
} from '../src/core/orientation.js';

/** Build a W×H white RGBA buffer and a setter to paint dark pixels. */
function whiteCanvas(W, H) {
  const data = new Uint8ClampedArray(W * H * 4);
  data.fill(255);
  const dark = (x, y) => {
    const i = (y * W + x) * 4;
    data[i] = data[i + 1] = data[i + 2] = 0;
  };
  return { data, dark };
}

function cell(x, y) {
  return { center: { x, y }, filled: true, orientation: null, coherence: 0, orientationSource: null };
}

describe('angle helpers', () => {
  it('normalizeAngle180 wraps into [0,180)', () => {
    expect(normalizeAngle180(190)).toBeCloseTo(10);
    expect(normalizeAngle180(-10)).toBeCloseTo(170);
    expect(normalizeAngle180(180)).toBeCloseTo(0);
  });

  it('angularDelta180 treats lines as undirected (0..90)', () => {
    expect(angularDelta180(0, 180)).toBeCloseTo(0);
    expect(angularDelta180(0, 90)).toBeCloseTo(90);
    expect(angularDelta180(10, 170)).toBeCloseTo(20);
  });
});

describe('computeCellOrientations — 「十」strokes', () => {
  const W = 60, H = 60;

  it('horizontal stroke → ~0°, vertical stroke → ~90°', () => {
    const { data, dark } = whiteCanvas(W, H);
    // horizontal bar at y≈30 (thickness 5), vertical bar at x≈30
    for (let x = 0; x < W; x++) for (let dyy = -2; dyy <= 2; dyy++) dark(x, 30 + dyy);
    for (let y = 0; y < H; y++) for (let dxx = -2; dxx <= 2; dxx++) dark(30 + dxx, y);

    const hCell = cell(12, 30); // on the horizontal bar, away from crossing
    const vCell = cell(30, 12); // on the vertical bar, away from crossing
    computeCellOrientations(data, W, H, [hCell, vCell], { windowRadius: 5 });

    expect(angularDelta180(hCell.orientation, 0)).toBeLessThan(10);
    expect(angularDelta180(vCell.orientation, 90)).toBeLessThan(10);
    expect(hCell.orientationSource).toBe('image');
  });

  it('leaves a manual override untouched', () => {
    const { data, dark } = whiteCanvas(W, H);
    for (let x = 0; x < W; x++) for (let dyy = -2; dyy <= 2; dyy++) dark(x, 30 + dyy);
    const c = cell(12, 30);
    setCellOrientationManual(c, 42);
    computeCellOrientations(data, W, H, [c], { windowRadius: 5 });
    expect(c.orientation).toBeCloseTo(42);
    expect(c.orientationSource).toBe('manual');
  });

  it('skips unfilled cells', () => {
    const { data, dark } = whiteCanvas(W, H);
    for (let x = 0; x < W; x++) for (let dyy = -2; dyy <= 2; dyy++) dark(x, 30 + dyy);
    const c = cell(12, 30);
    c.filled = false;
    computeCellOrientations(data, W, H, [c], { windowRadius: 5 });
    expect(c.orientation).toBeNull();
  });
});

describe('propagateOrientation (案A)', () => {
  it('a new cell inherits the angle of nearby oriented cells', () => {
    const a = cell(10, 10); a.orientation = 30; a.coherence = 0.9; a.orientationSource = 'image';
    const b = cell(14, 10); b.orientation = 34; b.coherence = 0.8; b.orientationSource = 'image';
    const fresh = cell(12, 10);
    fresh.orientation = null; fresh.orientationSource = null;
    propagateOrientation([a, b, fresh], fresh, { radius: 50 });
    expect(fresh.orientationSource).toBe('propagated');
    expect(angularDelta180(fresh.orientation, 32)).toBeLessThan(8);
  });

  it('no-op when no oriented neighbor is in range', () => {
    const far = cell(500, 500); far.orientation = 30; far.coherence = 1;
    const fresh = cell(12, 10);
    propagateOrientation([far, fresh], fresh, { radius: 50 });
    expect(fresh.orientation).toBeNull();
  });
});

describe('fillOrientationGaps', () => {
  it('diffuses an angle into a thick-stroke interior chain, leaving no filled cell null', () => {
    // A 1-D chain along x: ends are image-oriented (0°), middle cells are null.
    const cells = [];
    for (let i = 0; i < 7; i++) {
      const c = cell(i * 10, 0);
      cells.push(c);
    }
    cells[0].orientation = 0; cells[0].coherence = 0.9; cells[0].orientationSource = 'image';
    cells[6].orientation = 0; cells[6].coherence = 0.9; cells[6].orientationSource = 'image';
    fillOrientationGaps(cells, { radius: 12 }); // radius reaches only adjacent cells → needs rounds
    for (const c of cells) {
      expect(c.orientation).not.toBeNull();
      expect(angularDelta180(c.orientation, 0)).toBeLessThan(5);
    }
    expect(cells[3].orientationSource).toBe('propagated');
  });

  it('preserves manual overrides and never overwrites existing angles', () => {
    const a = cell(0, 0); a.orientation = 10; a.coherence = 0.9; a.orientationSource = 'image';
    const m = cell(10, 0); setCellOrientationManual(m, 80);
    const gap = cell(20, 0);
    fillOrientationGaps([a, m, gap], { radius: 40 });
    expect(m.orientation).toBeCloseTo(80);
    expect(m.orientationSource).toBe('manual');
    expect(gap.orientation).not.toBeNull(); // filled from a + m
  });

  it('leaves fully isolated cells null (no oriented neighbor anywhere)', () => {
    const a = cell(0, 0); // null, filled
    const b = cell(10, 0); // null, filled
    fillOrientationGaps([a, b], { radius: 40 });
    expect(a.orientation).toBeNull();
    expect(b.orientation).toBeNull();
  });
});
