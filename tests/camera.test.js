import { describe, it, expect } from 'vitest';
import { createCamera, migrateLegacyCamera, CAMERA_DEFAULTS } from '../src/animation/camera.js';

const W = 1920;
const H = 1080;
const CX = W / 2;
const CY = H / 2;

function cam(over = {}) {
  return createCamera({ ...CAMERA_DEFAULTS, ...over }, W, H);
}

describe('createCamera — default pose is the identity', () => {
  it('projects every plane point onto itself', () => {
    const c = cam();
    for (const [x, y] of [[0, 0], [CX, CY], [W, H], [123.4, 987.6]]) {
      const p = c.projectPoint(x, y);
      expect(p.x).toBeCloseTo(x, 9);
      expect(p.y).toBeCloseTo(y, 9);
      expect(p.depth).toBeCloseTo(1000, 9);
    }
  });

  it('tangent affine is the identity matrix', () => {
    const t = cam().tangentAt(300, 200);
    expect(t.a).toBeCloseTo(1, 12);
    expect(t.b).toBeCloseTo(0, 12);
    expect(t.c).toBeCloseTo(0, 12);
    expect(t.d).toBeCloseTo(1, 12);
    expect(t.e).toBeCloseTo(0, 9);
    expect(t.f).toBeCloseTo(0, 9);
    expect(t.scale).toBeCloseTo(1, 12);
  });
});

describe('createCamera — dolly / focal', () => {
  it('halving cameraZ doubles the image about the frame center', () => {
    const c = cam({ cameraZ: 500 });
    const p = c.projectPoint(CX + 100, CY - 50);
    expect(p.x).toBeCloseTo(CX + 200, 9);
    expect(p.y).toBeCloseTo(CY - 100, 9);
    expect(c.tangentAt(CX, CY).scale).toBeCloseTo(2, 12);
  });

  it('doubling focal length also doubles the image (zoom without dolly)', () => {
    const p = cam({ cameraFocal: 2000 }).projectPoint(CX + 100, CY);
    expect(p.x).toBeCloseTo(CX + 200, 9);
  });
});

describe('createCamera — pan (camera + target move together)', () => {
  it('moving the camera right shifts the image left, straight-on', () => {
    const c = cam({ cameraX: 100, cameraTargetX: 100 });
    const p = c.projectPoint(CX, CY);
    expect(p.x).toBeCloseTo(CX - 100, 9);
    expect(p.y).toBeCloseTo(CY, 9);
    // No perspective: tangent stays the identity.
    const t = c.tangentAt(CX + 500, CY + 300);
    expect(t.a).toBeCloseTo(1, 12);
    expect(t.b).toBeCloseTo(0, 12);
    expect(t.c).toBeCloseTo(0, 12);
    expect(t.d).toBeCloseTo(1, 12);
  });
});

describe('createCamera — lookAt with perspective', () => {
  it('keeps the target at the frame center', () => {
    const c = cam({ cameraX: 800, cameraY: -300, cameraTargetX: 120, cameraTargetY: 40 });
    const p = c.projectPoint(CX + 120, CY + 40);
    expect(p.x).toBeCloseTo(CX, 6);
    expect(p.y).toBeCloseTo(CY, 6);
  });

  it('camera on the right → right side nearer/larger, left side farther/smaller', () => {
    const c = cam({ cameraX: 800 });
    const r = c.tangentAt(CX + 400, CY);
    const l = c.tangentAt(CX - 400, CY);
    expect(r.depth).toBeLessThan(l.depth);
    expect(r.scale).toBeGreaterThan(l.scale);
    // Keystone: verticals converge — a vertical segment on the far (left)
    // side is shorter on screen than one on the near (right) side.
    const farTop = c.projectPoint(CX - 400, CY - 100);
    const farBot = c.projectPoint(CX - 400, CY + 100);
    const nearTop = c.projectPoint(CX + 400, CY - 100);
    const nearBot = c.projectPoint(CX + 400, CY + 100);
    expect(farBot.y - farTop.y).toBeLessThan(nearBot.y - nearTop.y);
  });

  it('tangent affine matches finite differences of projectPoint', () => {
    const c = cam({ cameraX: 600, cameraY: 250, cameraZ: 700, cameraTargetX: -80, cameraTargetY: 30, cameraRoll: 17, cameraFocal: 900 });
    const X = CX + 220, Y = CY - 140;
    const t = c.tangentAt(X, Y);
    const h = 1e-3;
    const p0 = c.projectPoint(X, Y);
    const px = c.projectPoint(X + h, Y);
    const py = c.projectPoint(X, Y + h);
    expect(t.x).toBeCloseTo(p0.x, 9);
    expect(t.y).toBeCloseTo(p0.y, 9);
    expect(t.a).toBeCloseTo((px.x - p0.x) / h, 4);
    expect(t.b).toBeCloseTo((px.y - p0.y) / h, 4);
    expect(t.c).toBeCloseTo((py.x - p0.x) / h, 4);
    expect(t.d).toBeCloseTo((py.y - p0.y) / h, 4);
    // Affine reproduces the exact projection at its anchor.
    expect(t.a * X + t.c * Y + t.e).toBeCloseTo(p0.x, 9);
    expect(t.b * X + t.d * Y + t.f).toBeCloseTo(p0.y, 9);
  });

  it('points behind the camera are culled', () => {
    // Camera very low, looking left along the plane: points to its right
    // (past the camera) are behind it.
    const c = cam({ cameraX: 3000, cameraZ: 50, cameraTargetX: 2900 });
    expect(c.projectPoint(CX + 8000, CY)).toBeNull();
    expect(c.tangentAt(CX + 8000, CY)).toBeNull();
    expect(c.projectPoint(CX + 2900, CY)).not.toBeNull();
    expect(c.projectPoint(CX - 5000, CY)).not.toBeNull();
  });
});

describe('createCamera — roll', () => {
  it('positive roll turns the image counter-clockwise on screen', () => {
    const c = cam({ cameraRoll: 90 });
    // A point to the right of center ends up above it (y-down screen).
    const p = c.projectPoint(CX + 100, CY);
    expect(p.x).toBeCloseTo(CX, 6);
    expect(p.y).toBeCloseTo(CY - 100, 6);
  });
});

describe('migrateLegacyCamera', () => {
  it('leaves new-model animations untouched', () => {
    const anim = { baseValues: { cameraX: 5, cameraZ: 800 }, tracks: {} };
    expect(migrateLegacyCamera(anim)).toBe(false);
    expect(anim.baseValues).toEqual({ cameraX: 5, cameraZ: 800 });
  });

  it('converts pan/zoom/rotation base values and tracks', () => {
    const anim = {
      baseValues: { cameraX: 40, cameraY: -10, cameraDistance: 2, cameraRotation: 30 },
      tracks: {
        cameraX: [
          { time: 0, value: 0, easing: 'linear', hOut: { dt: 0.3, dv: 20 } },
          { time: 1, value: 100, easing: 'ease-in', hIn: { dt: -0.3, dv: -20 } },
        ],
        cameraDistance: [
          { time: 0, value: 1, easing: 'linear', hOut: { dt: 0.2, dv: 0.5 } },
          { time: 1, value: 4, easing: 'linear' },
        ],
        cameraRotation: [{ time: 0.5, value: 45, easing: 'linear' }],
      },
    };
    expect(migrateLegacyCamera(anim)).toBe(true);
    const bv = anim.baseValues;
    expect(bv.cameraX).toBe(-40);
    expect(bv.cameraTargetX).toBe(-40);
    expect(bv.cameraY).toBe(10);
    expect(bv.cameraTargetY).toBe(10);
    expect(bv.cameraZ).toBeCloseTo(500);
    expect(bv.cameraRoll).toBe(-30);
    expect(bv.cameraFocal).toBe(CAMERA_DEFAULTS.cameraFocal);
    expect('cameraDistance' in bv).toBe(false);
    expect('cameraRotation' in bv).toBe(false);

    const tr = anim.tracks;
    expect(tr.cameraX.map(k => k.value)).toEqual([-0, -100]);
    expect(tr.cameraX[0].hOut).toEqual({ dt: 0.3, dv: -20 });
    expect(tr.cameraX[1].hIn).toEqual({ dt: -0.3, dv: 20 });
    expect(tr.cameraX[1].easing).toBe('ease-in');
    // Target gets an independent copy of the same motion.
    expect(tr.cameraTargetX.map(k => k.value)).toEqual([-0, -100]);
    expect(tr.cameraTargetX).not.toBe(tr.cameraX);
    expect(tr.cameraTargetX[0]).not.toBe(tr.cameraX[0]);
    // Y had no track → none created.
    expect(tr.cameraY).toBeUndefined();
    expect(tr.cameraTargetY).toBeUndefined();
    // Zoom → z, point-wise, handles dropped.
    expect(tr.cameraZ.map(k => k.value)).toEqual([1000, 250]);
    expect(tr.cameraZ[0].hOut).toBeUndefined();
    expect(tr.cameraDistance).toBeUndefined();
    expect(tr.cameraRoll).toEqual([{ time: 0.5, value: -45, easing: 'linear' }]);
    expect(tr.cameraRotation).toBeUndefined();

    // Idempotent: second call is a no-op.
    expect(migrateLegacyCamera(anim)).toBe(false);
  });

  it('migrated pan renders identically to the legacy pan', () => {
    // Legacy: pan (+60, +20) shifted the whole image by (+60, +20).
    const anim = { baseValues: { cameraX: 60, cameraY: 20, cameraDistance: 1, cameraRotation: 0 }, tracks: {} };
    migrateLegacyCamera(anim);
    const p = createCamera(anim.baseValues, W, H).projectPoint(CX, CY);
    expect(p.x).toBeCloseTo(CX + 60, 9);
    expect(p.y).toBeCloseTo(CY + 20, 9);
  });

  it('migrated zoom + rotation render identically to the legacy transform', () => {
    // Legacy: rotate 90° clockwise about center, then scale 2.
    const anim = { baseValues: { cameraX: 0, cameraY: 0, cameraDistance: 2, cameraRotation: 90 }, tracks: {} };
    migrateLegacyCamera(anim);
    const p = createCamera(anim.baseValues, W, H).projectPoint(CX + 100, CY);
    // (100,0) rotated 90° cw (y-down) → (0,100), ×2 → (0,200)
    expect(p.x).toBeCloseTo(CX, 6);
    expect(p.y).toBeCloseTo(CY + 200, 6);
  });
});

describe('createCamera — describe()', () => {
  it('default pose: frustum feet are the frame corners, basis is world-aligned', () => {
    const d = cam().describe();
    expect(d.position).toEqual([0, 0, 1000]);
    expect(d.target).toEqual([0, 0, 0]);
    expect(d.forward.map(v => +v.toFixed(9))).toEqual([0, 0, -1]);
    expect(d.right.map(v => +v.toFixed(9))).toEqual([1, 0, 0]);
    expect(d.up.map(v => +v.toFixed(9) + 0)).toEqual([0, -1, 0]);
    const feet = d.frustum.map(f => [Math.round(f.x), Math.round(f.y), Math.round(f.z), f.hit]);
    expect(feet).toEqual([[-CX, -CY, 0, true], [CX, -CY, 0, true], [CX, CY, 0, true], [-CX, CY, 0, true]]);
  });

  it('a corner ray that misses the plane is extended and flagged', () => {
    // Very low camera looking almost along the plane: top corners look above
    // the horizon.
    const d = cam({ cameraZ: 20, cameraX: 3000, cameraTargetX: 0 }).describe();
    expect(d.frustum.some(f => !f.hit)).toBe(true);
    for (const f of d.frustum) expect(Number.isFinite(f.x) && Number.isFinite(f.z)).toBe(true);
  });
});
