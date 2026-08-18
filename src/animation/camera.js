/**
 * 3D perspective camera for the animation renderer.
 *
 * The typeset lives on the plane z = 0 in a pixel-unit world whose origin is
 * the frame center (x right, y down — canvas convention — and z toward the
 * viewer). The camera sits at (cameraX, cameraY, cameraZ), always looks at the
 * plane point (cameraTargetX, cameraTargetY) — a lookAt camera — and can roll
 * about its view axis. Projection is a pinhole with focal length `cameraFocal`
 * (px): a point at depth d along the view axis is scaled by focal / d, so the
 * defaults (z = focal = 1000, camera straight above the target) reproduce the
 * un-transformed frame exactly, and moving the camera off-axis while the target
 * stays put produces true perspective (keystone) distortion.
 *
 * Canvas 2D can only apply affine transforms, while a perspective view of the
 * plane is a homography. The renderer therefore asks for the homography's
 * tangent affine at each cell center (`tangentAt`) — exact at that point and
 * first-order elsewhere, which for grid-sized cells is visually
 * indistinguishable from the true projection — and projects polygon vertices
 * exactly (`projectPoint`). Both take frame-canvas pixel coordinates (origin
 * top-left) so callers never deal with the centered world frame.
 */

export const CAMERA_PARAM_KEYS = [
  'cameraX',
  'cameraY',
  'cameraZ',
  'cameraTargetX',
  'cameraTargetY',
  'cameraRoll',
  'cameraFocal',
];

export const CAMERA_DEFAULTS = {
  cameraX: 0,
  cameraY: 0,
  cameraZ: 1000,
  cameraTargetX: 0,
  cameraTargetY: 0,
  cameraRoll: 0,
  cameraFocal: 1000,
};

// Points closer to the camera plane than this (px along the view axis) are
// treated as behind the camera and skipped, which also keeps the tangent
// affine from exploding as a cell approaches the eye.
const MIN_DEPTH = 1;
// The camera never touches the plane: z is clamped so the lookAt direction is
// always defined (target is on z = 0, camera strictly in front of it).
const MIN_CAMERA_Z = 1;
const MIN_FOCAL = 1;

function normalize(v) {
  const n = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / n, v[1] / n, v[2] / n];
}

function cross(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

/**
 * Build a camera from sampled animation params for a width×height frame.
 * Missing params fall back to CAMERA_DEFAULTS.
 *
 * Returns { projectPoint(x, y), tangentAt(x, y), describe() } where x, y are
 * frame-canvas pixels of a point on the typeset plane. The first two return
 * null when the point is behind (or at) the camera.
 *  - projectPoint → { x, y, depth }: screen position (frame px) + view depth.
 *  - tangentAt → { a, b, c, d, e, f, x, y, depth, scale }: the affine
 *    (canvas setTransform order) that maps plane px → screen px, exact at
 *    (x, y) and linearized around it; `scale` is its isotropic magnification
 *    (sqrt |det|), handy for depth-scaling screen-space effects such as blur.
 */
export function createCamera(params, width, height) {
  const p = params || {};
  const cx = width / 2;
  const cy = height / 2;
  const focal = Math.max(MIN_FOCAL, p.cameraFocal ?? CAMERA_DEFAULTS.cameraFocal);
  const camX = p.cameraX ?? CAMERA_DEFAULTS.cameraX;
  const camY = p.cameraY ?? CAMERA_DEFAULTS.cameraY;
  const camZ = Math.max(MIN_CAMERA_Z, p.cameraZ ?? CAMERA_DEFAULTS.cameraZ);
  const tgtX = p.cameraTargetX ?? CAMERA_DEFAULTS.cameraTargetX;
  const tgtY = p.cameraTargetY ?? CAMERA_DEFAULTS.cameraTargetY;
  const roll = ((p.cameraRoll ?? CAMERA_DEFAULTS.cameraRoll) * Math.PI) / 180;

  // Camera basis (world units). Forward always has a negative z component
  // (camera above the plane, target on it), so the right vector is well
  // defined for every reachable pose.
  const fwd = normalize([tgtX - camX, tgtY - camY, -camZ]);
  const worldUp = [0, -1, 0]; // y-down world: "up" on the plane is -y
  const right0 = normalize(cross(worldUp, fwd));
  const up0 = cross(fwd, right0);
  // Roll: positive rolls the camera clockwise (as seen looking along the view
  // axis), so the image turns counter-clockwise on screen.
  const cr = Math.cos(roll);
  const sr = Math.sin(roll);
  const right = [
    right0[0] * cr - up0[0] * sr,
    right0[1] * cr - up0[1] * sr,
    right0[2] * cr - up0[2] * sr,
  ];
  const up = [
    right0[0] * sr + up0[0] * cr,
    right0[1] * sr + up0[1] * cr,
    right0[2] * sr + up0[2] * cr,
  ];
  // Screen y grows downward, so project onto -up.
  const down = [-up[0], -up[1], -up[2]];

  // A plane point at frame px (X, Y) is world (X - cx, Y - cy, 0); relative to
  // the camera: (X - cx - camX, Y - cy - camY, -camZ). Each view coordinate is
  // then affine in (X, Y): coef_x * X + coef_y * Y + k.
  const ox = -cx - camX;
  const oy = -cy - camY;
  const kR = right[0] * ox + right[1] * oy - right[2] * camZ;
  const kD = down[0] * ox + down[1] * oy - down[2] * camZ;
  const kF = fwd[0] * ox + fwd[1] * oy - fwd[2] * camZ;

  function projectPoint(X, Y) {
    const depth = fwd[0] * X + fwd[1] * Y + kF;
    if (!(depth > MIN_DEPTH)) return null;
    const nx = right[0] * X + right[1] * Y + kR;
    const ny = down[0] * X + down[1] * Y + kD;
    return {
      x: cx + (focal * nx) / depth,
      y: cy + (focal * ny) / depth,
      depth,
    };
  }

  function tangentAt(X, Y) {
    const depth = fwd[0] * X + fwd[1] * Y + kF;
    if (!(depth > MIN_DEPTH)) return null;
    const nx = right[0] * X + right[1] * Y + kR;
    const ny = down[0] * X + down[1] * Y + kD;
    const sx = cx + (focal * nx) / depth;
    const sy = cy + (focal * ny) / depth;
    const inv2 = focal / (depth * depth);
    // Partial derivatives of the projection (quotient rule).
    const a = (right[0] * depth - nx * fwd[0]) * inv2; // ∂sx/∂X
    const b = (down[0] * depth - ny * fwd[0]) * inv2;  // ∂sy/∂X
    const c = (right[1] * depth - nx * fwd[1]) * inv2; // ∂sx/∂Y
    const d = (down[1] * depth - ny * fwd[1]) * inv2;  // ∂sy/∂Y
    return {
      a, b, c, d,
      e: sx - a * X - c * Y,
      f: sy - b * X - d * Y,
      x: sx,
      y: sy,
      depth,
      scale: Math.sqrt(Math.abs(a * d - b * c)),
    };
  }

  /**
   * World-space description of the pose, for visualisation (the scene view in
   * the Camera panel). Coordinates are world units (frame-center origin, px).
   *  - position / target: [x, y, z]
   *  - right / up / forward: unit basis after roll
   *  - focal: focal length (px)
   *  - frustum: the plane points seen at the four frame corners
   *    (top-left, top-right, bottom-right, bottom-left). A corner ray that never
   *    reaches the plane (looks above the horizon) is extended to `farDist`
   *    world units instead, and flagged `hit: false`.
   */
  function describe(farDist = 4 * Math.hypot(tgtX - camX, tgtY - camY, camZ)) {
    const corners = [[0, 0], [width, 0], [width, height], [0, height]];
    const frustum = corners.map(([sx, sy]) => {
      const u = (sx - cx) / focal;
      const v = (sy - cy) / focal;
      const dir = [
        fwd[0] + right[0] * u + down[0] * v,
        fwd[1] + right[1] * u + down[1] * v,
        fwd[2] + right[2] * u + down[2] * v,
      ];
      const len = Math.hypot(dir[0], dir[1], dir[2]) || 1;
      let t = dir[2] < 0 ? -camZ / dir[2] : Infinity;
      const hit = Number.isFinite(t) && t * len <= farDist;
      if (!hit) t = farDist / len;
      return { x: camX + dir[0] * t, y: camY + dir[1] * t, z: camZ + dir[2] * t, hit };
    });
    return {
      position: [camX, camY, camZ],
      target: [tgtX, tgtY, 0],
      right: right.slice(),
      up: up.slice(),
      forward: fwd.slice(),
      focal,
      frustum,
    };
  }

  return { projectPoint, tangentAt, describe };
}

/**
 * One-time migration of the legacy 2D camera (cameraX/cameraY = pan px,
 * cameraDistance = zoom factor, cameraRotation = image rotation deg) to the 3D
 * lookAt camera. Detected by the presence of the retired keys; returns false
 * (and touches nothing) for animations already on the new model.
 *
 * Mapping (visually equivalent under the defaults):
 *  - pan (px) → camera AND target move by −pan (the camera slides while still
 *    looking straight down at the plane, i.e. a pure pan);
 *  - zoom s → cameraZ = focal / s (keyframes are converted point-wise, so a
 *    keyframed zoom keeps its keys but the in-between curve is re-derived from
 *    the easing — 1/s is not affine);
 *  - rotation r → cameraRoll = −r (camera roll turns the image the other way).
 * Handles on sign-flipped tracks are negated in value (exact); the z track
 * drops its handles so ensureBezierHandles rebuilds them from the easing.
 */
export function migrateLegacyCamera(animation) {
  if (!animation) return false;
  const bv = animation.baseValues || (animation.baseValues = {});
  const tr = animation.tracks || (animation.tracks = {});
  const legacy = 'cameraDistance' in bv || 'cameraRotation' in bv
    || tr.cameraDistance != null || tr.cameraRotation != null;
  if (!legacy) return false;

  const negKf = (kf) => {
    const out = { time: kf.time, value: -kf.value, easing: kf.easing || 'linear' };
    if (kf.handleMode != null) out.handleMode = kf.handleMode;
    if (kf.hIn) out.hIn = { dt: kf.hIn.dt, dv: -kf.hIn.dv };
    if (kf.hOut) out.hOut = { dt: kf.hOut.dt, dv: -kf.hOut.dv };
    return out;
  };
  const negTrack = (track) => track.map(negKf);

  // Pan → position + target.
  for (const axis of ['X', 'Y']) {
    const posKey = `camera${axis}`;
    const tgtKey = `cameraTarget${axis}`;
    const base = bv[posKey] ?? 0;
    bv[posKey] = -base;
    bv[tgtKey] = -base;
    const track = tr[posKey];
    if (Array.isArray(track) && track.length > 0) {
      tr[posKey] = negTrack(track);
      tr[tgtKey] = negTrack(track);
    } else {
      delete tr[posKey];
      delete tr[tgtKey];
    }
  }

  // Zoom → z distance.
  const focal = CAMERA_DEFAULTS.cameraFocal;
  const zoomToZ = (s) => focal / Math.max(0.01, s ?? 1);
  bv.cameraZ = zoomToZ(bv.cameraDistance);
  delete bv.cameraDistance;
  if (Array.isArray(tr.cameraDistance) && tr.cameraDistance.length > 0) {
    tr.cameraZ = tr.cameraDistance.map(kf => ({
      time: kf.time,
      value: zoomToZ(kf.value),
      easing: kf.easing || 'linear',
    }));
  } else {
    delete tr.cameraZ;
  }
  delete tr.cameraDistance;

  // Rotation → roll.
  bv.cameraRoll = -(bv.cameraRotation ?? 0);
  delete bv.cameraRotation;
  if (Array.isArray(tr.cameraRotation) && tr.cameraRotation.length > 0) {
    tr.cameraRoll = negTrack(tr.cameraRotation);
  } else {
    delete tr.cameraRoll;
  }
  delete tr.cameraRotation;

  if (bv.cameraFocal == null) bv.cameraFocal = focal;
  return true;
}
