import { describe, it, expect } from 'vitest';
import { createCamera, CAMERA_DEFAULTS } from '../src/animation/camera.js';
import { applyRingRotation } from '../src/pages/animation/camera-scene-view.js';

const W = 1920, H = 1080;
const desc = (over = {}) => createCamera({ ...CAMERA_DEFAULTS, ...over }, W, H).describe();
const deg = (r) => (r * Math.PI) / 180;

describe('applyRingRotation', () => {
  it('roll ring: rotating about the view axis changes only cameraRoll', () => {
    const d = desc({ cameraRoll: 10 });
    // forward = right × up, so +angle about forward turns up toward −right,
    // i.e. roll (which tilts up toward +right) decreases.
    const ch = applyRingRotation(d, 'roll', d.forward, deg(20), 10);
    expect(ch.cameraRoll).toBeCloseTo(-10, 0);
    expect(ch.cameraTargetX).toBeUndefined();
    // Reproduces the rotated up vector: camera rebuilt with roll −10 has the same basis.
    const d2 = desc({ cameraRoll: -10 });
    const up = createCamera({ ...CAMERA_DEFAULTS, cameraRoll: ch.cameraRoll }, W, H).describe().up;
    expect(up.map(v => +v.toFixed(6))).toEqual(d2.up.map(v => +v.toFixed(6)));
  });

  it('yaw ring: re-aims sideways, roll stays ~0 for a straight-down camera', () => {
    const d = desc(); // straight down from (0,0,1000)
    // +angle about up moves forward toward right (u=forward → v=right).
    const ch = applyRingRotation(d, 'yaw', d.up, deg(10), 0);
    expect(ch.cameraTargetX).toBeCloseTo(1000 * Math.tan(deg(10)), 0);
    expect(Math.abs(ch.cameraTargetY)).toBeLessThan(1e-6);
    expect(Math.abs(ch.cameraRoll)).toBeLessThan(1e-6);
    // Round-trip: a camera built from the changes has the rotated forward.
    const d2 = createCamera({ ...CAMERA_DEFAULTS, ...ch }, W, H).describe();
    const fwd = d.forward; // original
    expect(d2.forward[0]).toBeGreaterThan(fwd[0]);
    expect(d2.forward[0]).toBeCloseTo(Math.sin(deg(10)), 3);
  });

  it('pitch ring: re-aims up/down the plane (u=up → v=forward)', () => {
    const d = desc();
    const ch = applyRingRotation(d, 'pitch', d.right, deg(-10), 0);
    // Rotating forward toward up (-y) by 10°: target moves to negative y.
    expect(ch.cameraTargetY).toBeCloseTo(-1000 * Math.tan(deg(10)), 0);
    expect(Math.abs(ch.cameraTargetX)).toBeLessThan(1e-6);
    expect(Math.abs(ch.cameraRoll)).toBeLessThan(1e-6);
  });

  it('rejects rotations that aim at/above the horizon', () => {
    const d = desc();
    expect(applyRingRotation(d, 'pitch', d.right, deg(-95), 0)).toBeNull();
  });

  it('round-trips an oblique pose: rebuilt camera has the rotated basis', () => {
    const d = desc({ cameraX: 700, cameraY: -300, cameraZ: 800, cameraTargetX: 100, cameraTargetY: 50, cameraRoll: 25 });
    for (const [id, n] of [['pitch', d.right], ['yaw', d.up], ['roll', d.forward]]) {
      const ch = applyRingRotation(d, id, n, deg(15), 25);
      const d2 = createCamera({ ...CAMERA_DEFAULTS, cameraX: 700, cameraY: -300, cameraZ: 800, cameraTargetX: 100, cameraTargetY: 50, cameraRoll: 25, ...ch }, W, H).describe();
      // Expected basis: rotate the originals about n.
      const rot = (w) => {
        const c = Math.cos(deg(15)), s = Math.sin(deg(15));
        const cr = [n[1] * w[2] - n[2] * w[1], n[2] * w[0] - n[0] * w[2], n[0] * w[1] - n[1] * w[0]];
        const dn = n[0] * w[0] + n[1] * w[1] + n[2] * w[2];
        return [0, 1, 2].map(i => w[i] * c + cr[i] * s + n[i] * dn * (1 - c));
      };
      const ef = rot(d.forward), eu = rot(d.up);
      for (let i = 0; i < 3; i++) {
        expect(d2.forward[i]).toBeCloseTo(ef[i], 2);
        expect(d2.up[i]).toBeCloseTo(eu[i], 2);
      }
    }
  });
});
