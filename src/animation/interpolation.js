export const EASINGS = {
  linear: (t) => t,
  'ease-in': (t) => t * t * t,
  'ease-out': (t) => 1 - Math.pow(1 - t, 3),
  'ease-in-out': (t) => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2,
};

export const EASING_NAMES = Object.keys(EASINGS);

/**
 * Normalized cubic-bezier control points [x1, y1, x2, y2] approximating each
 * named easing (same convention as CSS `cubic-bezier`). Used to seed bezier
 * handles when a keyframe carries only a legacy `easing` field — sampling and
 * the editor agree because both go through segmentControls() below.
 */
export const EASING_TO_BEZIER = {
  linear: [1 / 3, 1 / 3, 2 / 3, 2 / 3],
  'ease-in': [0.42, 0, 1, 1],
  'ease-out': [0, 0, 0.58, 1],
  'ease-in-out': [0.42, 0, 0.58, 1],
};

export function applyEasing(t, name) {
  const fn = EASINGS[name] || EASINGS.linear;
  return fn(Math.max(0, Math.min(1, t)));
}

/** One component of a cubic bezier at parameter u in [0,1]. */
function cubic(p0, p1, p2, p3, u) {
  const m = 1 - u;
  return m * m * m * p0 + 3 * m * m * u * p1 + 3 * m * u * u * p2 + u * u * u * p3;
}

/**
 * Control points (in time/value space) for the cubic-bezier segment a→b.
 * Uses explicit handles when present (`hOut` on a, `hIn` on b); otherwise
 * derives them from `b.easing` so legacy keyframes — and freshly-created
 * tracks not yet migrated by ensureBezierHandles() — sample identically.
 */
export function segmentControls(a, b) {
  const spanT = b.time - a.time;
  const spanV = b.value - a.value;
  let p1 = a.hOut ? { x: a.time + a.hOut.dt, y: a.value + a.hOut.dv } : null;
  let p2 = b.hIn ? { x: b.time + b.hIn.dt, y: b.value + b.hIn.dv } : null;
  if (!p1 || !p2) {
    const c = EASING_TO_BEZIER[b.easing] || EASING_TO_BEZIER.linear;
    if (!p1) p1 = { x: a.time + c[0] * spanT, y: a.value + c[1] * spanV };
    if (!p2) p2 = { x: a.time + c[2] * spanT, y: a.value + c[3] * spanV };
  }
  return { p1, p2 };
}

/** Point on the cubic-bezier segment a→b at parameter u — for drawing. */
export function sampleBezierSegment(a, b, u) {
  const { p1, p2 } = segmentControls(a, b);
  return {
    time: cubic(a.time, p1.x, p2.x, b.time, u),
    value: cubic(a.value, p1.y, p2.y, b.value, u),
  };
}

/**
 * Solve X(u) = time for u in [0,1] by bisection. X is (near-)monotonic since
 * handle time-offsets are clamped to the segment span when edited, so a simple
 * bracket search converges to a stable visual result.
 */
function solveU(x0, x1, x2, x3, time) {
  let lo = 0, hi = 1;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) * 0.5;
    if (cubic(x0, x1, x2, x3, mid) < time) lo = mid; else hi = mid;
  }
  return (lo + hi) * 0.5;
}

/**
 * Sample a parameter track at given time.
 * Track = [{time, value, easing?, hIn?, hOut?, handleMode?}, ...] sorted by
 * time (ascending). Each segment a→b is a cubic bezier in time/value space
 * (see segmentControls); the value is found by solving for the bezier
 * parameter at `time`, then evaluating the value component.
 *
 * Before first keyframe: first value. After last: last value. Empty: fallback.
 */
export function sampleTrack(track, time, fallback) {
  if (!track || track.length === 0) return fallback;
  if (time <= track[0].time) return track[0].value;
  if (time >= track[track.length - 1].time) return track[track.length - 1].value;

  for (let i = 0; i < track.length - 1; i++) {
    const a = track[i];
    const b = track[i + 1];
    if (time >= a.time && time <= b.time) {
      const span = b.time - a.time;
      if (span <= 0) return b.value;
      const { p1, p2 } = segmentControls(a, b);
      const u = solveU(a.time, p1.x, p2.x, b.time, time);
      return cubic(a.value, p1.y, p2.y, b.value, u);
    }
  }
  return track[track.length - 1].value;
}
