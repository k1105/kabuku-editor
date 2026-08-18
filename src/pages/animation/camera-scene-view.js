/**
 * Camera scene view — a small orbitable 3D wireframe shown at the top of the
 * Camera panel so the camera pose reads at a glance: the typeset plane (frame
 * rectangle at z = 0), the camera position, its view frustum down to the
 * plane, the look-at target, and the world axes.
 *
 * It also carries Blender-style transform gizmos for direct manipulation:
 *  - Move mode: XYZ arrows at the camera (drag along a world axis) plus XY
 *    arrows at the look-at target (it lives on the plane, so no Z).
 *  - Rotate mode: three great-circle rings on a sphere around the camera —
 *    pitch (about the camera's right axis, red), yaw (about its up axis,
 *    green) and roll (about the view axis, blue). Pitch/yaw re-aim the camera
 *    (the look-at target is re-solved where the new view axis meets the
 *    plane); roll spins it in place.
 * Dragging empty space orbits the viewpoint; double-click resets it.
 *
 * Edits are reported through `env.onInput(changes)` (live, per pointer move)
 * and `env.onChange(changes)` (pointer up) as partial param objects — the page
 * owns keyframe/baseValue semantics, exactly like the sliders.
 */
import { createCamera } from '../../animation/camera.js';

const DEFAULT_YAW = -35;   // deg, about the vertical axis
const DEFAULT_PITCH = 28;  // deg, tilt down onto the plane
const ASPECT = 1.0;        // canvas height / width

const HIT_PX = 8;          // handle hit radius (css px)
const ARROW_PX = 48;       // camera axis arrow length (css px)
const TARGET_ARROW_PX = 32;
const RING_PX = 42;        // rotate gizmo sphere radius (css px)
const RING_SEGMENTS = 64;

const AXIS_COLORS = { x: '#e5484d', y: '#46a758', z: '#4a9eff' };
const HOVER_COLOR = '#ffd54a';
const WORLD_UP = [0, -1, 0]; // y-down world: "up" on the plane is -y

// --- tiny vector helpers ---
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => { const n = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / n, a[1] / n, a[2] / n]; };
/** Rotate `w` about unit axis `n` by `ang` (Rodrigues; +ang takes u → v when n = u × v). */
function rotateAbout(w, n, ang) {
  const c = Math.cos(ang), s = Math.sin(ang);
  return add(add(mul(w, c), mul(cross(n, w), s)), mul(n, dot(n, w) * (1 - c)));
}
/** Distance from point p to segment ab (2D). */
function segDist(p, a, b) {
  const vx = b[0] - a[0], vy = b[1] - a[1];
  const l2 = vx * vx + vy * vy;
  let t = l2 > 0 ? ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + vx * t), p[1] - (a[1] + vy * t));
}
/** Camera roll (deg) that reproduces `up` given the view axis `fwd`. */
function rollFromBasis(fwd, up) {
  const right0 = norm(cross(WORLD_UP, fwd));
  const up0 = cross(fwd, right0);
  return (Math.atan2(dot(up, right0), dot(up, up0)) * 180) / Math.PI;
}
/** Wrap `deg` to the turn nearest `ref` so a drag never jumps by 360. */
function unwrapNear(deg, ref) {
  let d = deg;
  while (d - ref > 180) d -= 360;
  while (d - ref < -180) d += 360;
  return d;
}

/**
 * Rotate a camera pose (from `createCamera().describe()`) about the unit axis
 * `n` by `dth` radians and express the result as look-at target + roll
 * changes. `ringId` 'roll' keeps the view axis (only roll changes); 'pitch' /
 * 'yaw' re-aim the camera, re-solving the target where the new view axis meets
 * the plane. Returns null when the new view axis would miss the plane (looking
 * at or above the horizon). Roll is unwrapped to the turn nearest `startRoll`.
 */
export function applyRingRotation(desc, ringId, n, dth, startRoll = 0) {
  const fwd = rotateAbout(desc.forward, n, dth);
  const up = rotateAbout(desc.up, n, dth);
  const r1 = (v) => Math.round(v * 10) / 10;
  if (ringId === 'roll') {
    return { cameraRoll: r1(unwrapNear(rollFromBasis(desc.forward, up), startRoll)) };
  }
  if (fwd[2] > -1e-3) return null;
  const C = desc.position;
  const t = -C[2] / fwd[2];
  return {
    cameraTargetX: r1(C[0] + fwd[0] * t),
    cameraTargetY: r1(C[1] + fwd[1] * t),
    cameraRoll: r1(unwrapNear(rollFromBasis(fwd, up), startRoll)),
  };
}

/**
 * @param {{
 *   getFrameSize: () => {width:number, height:number},
 *   onInput?: (changes: object) => void,
 *   onChange?: (changes: object) => void,
 * }} env
 * @returns {{ el: HTMLElement, render: (params: object) => void, setMode: (m: 'move'|'rotate') => void }}
 */
export function createCameraSceneView(env) {
  const el = document.createElement('div');
  el.className = 'cam-scene';
  const canvas = document.createElement('canvas');
  canvas.className = 'cam-scene-canvas';
  canvas.title = 'Drag handles to edit · drag empty space to orbit · double-click to reset view';
  el.appendChild(canvas);
  const ctx = canvas.getContext('2d');

  // Mode toolbar (Move / Rotate), overlaid top-right.
  const tools = document.createElement('div');
  tools.className = 'cam-scene-tools';
  const modeBtns = {};
  for (const [id, icon, title] of [['move', 'lucide:move-3d', 'Move (camera / look-at)'], ['rotate', 'lucide:rotate-3d', 'Rotate (pitch / yaw / roll)']]) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'cam-scene-tool';
    b.title = title;
    const ic = document.createElement('iconify-icon');
    ic.setAttribute('icon', icon);
    b.appendChild(ic);
    b.addEventListener('click', () => setMode(id));
    tools.appendChild(b);
    modeBtns[id] = b;
  }
  el.appendChild(tools);

  let mode = 'move';
  let yaw = DEFAULT_YAW;
  let pitch = DEFAULT_PITCH;
  let lastParams = null;
  let handles = [];       // rebuilt every render (screen-space hit targets)
  let hoverId = null;
  let orbitDrag = null;   // { x, y, yaw, pitch }
  let gizmoDrag = null;   // { handle, x, y, start: params, fit, desc, theta0, changes }
  let frozenFit = null;   // fit kept constant during a gizmo drag
  let lastFit = null;     // fit used by the last render (hit-testing / drags)

  function setMode(m) {
    mode = m;
    for (const [id, b] of Object.entries(modeBtns)) b.classList.toggle('active', id === m);
    render(lastParams);
  }
  setMode('move');

  // === Viewer projection ===
  // World: x right, y down, z toward the (animation) viewer. The scene view
  // uses -y as "up", orbits about that axis (yaw), tilts (pitch), and projects
  // orthographically. `rows` is the orthonormal view rotation: view = R · p,
  // screen = (view.x, view.y) after fit; view.z grows toward the scene viewer.
  function viewRows() {
    const cy = Math.cos((yaw * Math.PI) / 180), sy = Math.sin((yaw * Math.PI) / 180);
    const cp = Math.cos((pitch * Math.PI) / 180), sp = Math.sin((pitch * Math.PI) / 180);
    return [
      [cy, 0, -sy],
      [sy * sp, cp, cy * sp],
      [sy * cp, -sp, cy * cp],
    ];
  }

  /** Fit plane + camera + target into the canvas; returns the mapping. */
  function computeFit(cssW, cssH, plane, desc) {
    const rows = viewRows();
    const view = (p) => [dot(rows[0], p), dot(rows[1], p), dot(rows[2], p)];
    const pts = [...plane, desc.position, desc.target].map(view);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y] of pts) {
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    // Some room for the gizmo handles around the camera dot (they may still
    // poke past the edge when the camera sits at the fit boundary — fine).
    const pad = 30;
    const spanX = Math.max(1, maxX - minX), spanY = Math.max(1, maxY - minY);
    const scale = Math.min((cssW - pad * 2) / spanX, (cssH - pad * 2) / spanY);
    const ox = cssW / 2 - ((minX + maxX) / 2) * scale;
    const oy = cssH / 2 - ((minY + maxY) / 2) * scale;
    const S = (p) => { const v = view(p); return [ox + v[0] * scale, oy + v[1] * scale]; };
    const depth = (p) => dot(rows[2], p);
    // Screen (css px) → world ray: point on the view plane + t · toward-viewer.
    const unproject = (sx, sy) => {
      const vx = (sx - ox) / scale, vy = (sy - oy) / scale;
      const origin = add(mul(rows[0], vx), mul(rows[1], vy));
      return { origin, dir: rows[2] };
    };
    return { rows, S, depth, scale, unproject };
  }

  // === Gizmo geometry ===
  function buildHandles(fit, desc) {
    const out = [];
    const { S, scale, depth } = fit;
    if (mode === 'move') {
      const axes = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
      const addArrows = (origin, keys, px, prefix, paramKeys) => {
        for (const k of keys) {
          const dir = axes[k];
          const a = S(origin);
          const b = S(add(origin, mul(dir, px / scale)));
          out.push({
            id: `${prefix}${k}`, kind: 'axis', color: AXIS_COLORS[k],
            a, b, origin, dir, param: paramKeys[k],
            hit: (p) => (Math.hypot(b[0] - a[0], b[1] - a[1]) < 6 ? Infinity : segDist(p, a, b)),
          });
        }
      };
      addArrows(desc.position, ['x', 'y', 'z'], ARROW_PX, 'cam-', { x: 'cameraX', y: 'cameraY', z: 'cameraZ' });
      addArrows(desc.target, ['x', 'y'], TARGET_ARROW_PX, 'tgt-', { x: 'cameraTargetX', y: 'cameraTargetY' });
    } else {
      const C = desc.position;
      const R = RING_PX / scale;
      // (u, v, n) right-handed so +angle about n moves a ring point u → v.
      const rings = [
        { id: 'pitch', color: AXIS_COLORS.x, n: desc.right, u: desc.up, v: desc.forward },
        { id: 'yaw', color: AXIS_COLORS.y, n: desc.up, u: desc.forward, v: desc.right },
        { id: 'roll', color: AXIS_COLORS.z, n: desc.forward, u: desc.right, v: desc.up },
      ];
      const dC = depth(C);
      for (const r of rings) {
        const pts = [];
        for (let i = 0; i <= RING_SEGMENTS; i++) {
          const th = (i / RING_SEGMENTS) * Math.PI * 2;
          const p = add(C, add(mul(r.u, R * Math.cos(th)), mul(r.v, R * Math.sin(th))));
          pts.push({ s: S(p), front: depth(p) >= dC });
        }
        out.push({
          ...r, kind: 'ring', pts, C, R,
          hit: (p) => {
            let best = Infinity;
            for (let i = 1; i < pts.length; i++) {
              const d = segDist(p, pts[i - 1].s, pts[i].s);
              if (d < best) best = d;
            }
            return best;
          },
        });
      }
    }
    return out;
  }

  function hitTest(sx, sy) {
    let best = null, bestD = HIT_PX;
    for (const h of handles) {
      const d = h.hit([sx, sy]);
      if (d < bestD) { bestD = d; best = h; }
    }
    return best;
  }

  /** Ring angle of the pointer: exact plane intersection of the view ray, or a
   *  screen-angle fallback when the ring is seen edge-on. */
  function ringAngle(h, fit, sx, sy) {
    const { origin, dir } = fit.unproject(sx, sy);
    const denom = dot(h.n, dir);
    if (Math.abs(denom) > 0.15) {
      const t = dot(h.n, sub(h.C, origin)) / denom;
      const p = sub(add(origin, mul(dir, t)), h.C);
      return Math.atan2(dot(p, h.v), dot(p, h.u));
    }
    const c = fit.S(h.C);
    const a = Math.atan2(sy - c[1], sx - c[0]);
    // Edge-on: spin direction follows which way the ring axis faces the viewer.
    return denom >= 0 ? a : -a;
  }

  /** Compute the param changes for the active gizmo drag at pointer (sx, sy). */
  function dragChanges(sx, sy) {
    const g = gizmoDrag;
    const h = g.handle;
    if (h.kind === 'axis') {
      // The arrow's screen vector (a→b) spans `L` world units along the axis;
      // project the pointer delta onto it to get the world displacement.
      const sd = [h.b[0] - h.a[0], h.b[1] - h.a[1]];
      const l2 = sd[0] * sd[0] + sd[1] * sd[1];
      if (l2 < 1e-6) return g.changes;
      const L = (h.id.startsWith('tgt-') ? TARGET_ARROW_PX : ARROW_PX) / g.fit.scale;
      const t = (((sx - g.x) * sd[0] + (sy - g.y) * sd[1]) / l2) * L;
      let v = g.start[h.param] + t;
      if (h.param === 'cameraZ') v = Math.max(1, v);
      return { [h.param]: Math.round(v * 10) / 10 };
    }
    // Ring: rotate the start basis about the ring axis by the pointer's angle
    // change, then express the result as look-at target + roll.
    const th = ringAngle(h, g.fit, sx, sy);
    return applyRingRotation(g.desc, h.id, h.n, th - g.theta0, g.start.cameraRoll ?? 0) || g.changes;
  }

  // === Pointer interaction ===
  function localXY(e) {
    const r = canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }
  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const [sx, sy] = localXY(e);
    const h = lastParams ? hitTest(sx, sy) : null;
    if (h && frozenFit == null && lastFit) {
      const { width: fw, height: fh } = env.getFrameSize();
      const desc = createCamera(lastParams, fw, fh).describe();
      frozenFit = lastFit;
      gizmoDrag = {
        handle: h, x: sx, y: sy, start: { ...lastParams }, fit: lastFit, desc,
        theta0: h.kind === 'ring' ? ringAngle(h, lastFit, sx, sy) : 0,
        changes: {},
      };
    } else {
      orbitDrag = { x: e.clientX, y: e.clientY, yaw, pitch };
    }
    try { canvas.setPointerCapture(e.pointerId); } catch { /* synthetic events have no active pointer */ }
    e.preventDefault();
  });
  canvas.addEventListener('pointermove', (e) => {
    if (gizmoDrag) {
      const [sx, sy] = localXY(e);
      const changes = dragChanges(sx, sy);
      gizmoDrag.changes = changes;
      const next = { ...gizmoDrag.start, ...changes };
      if (env.onInput) env.onInput(changes, next);
      else render(next);
      return;
    }
    if (orbitDrag) {
      yaw = orbitDrag.yaw + (e.clientX - orbitDrag.x) * 0.5;
      pitch = Math.max(-89, Math.min(89, orbitDrag.pitch + (e.clientY - orbitDrag.y) * 0.5));
      render(lastParams);
      return;
    }
    // Hover highlight.
    const [sx, sy] = localXY(e);
    const h = lastParams ? hitTest(sx, sy) : null;
    const id = h ? h.id : null;
    if (id !== hoverId) {
      hoverId = id;
      canvas.style.cursor = id ? 'pointer' : 'grab';
      render(lastParams);
    }
  });
  const endDrag = (e) => {
    if (gizmoDrag) {
      const { changes, start } = gizmoDrag;
      gizmoDrag = null;
      frozenFit = null;
      if (Object.keys(changes).length > 0) {
        if (env.onChange) env.onChange(changes, { ...start, ...changes });
      } else {
        render(lastParams);
      }
    }
    orbitDrag = null;
    if (e && canvas.hasPointerCapture?.(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('pointerleave', () => {
    if (!gizmoDrag && !orbitDrag && hoverId) { hoverId = null; canvas.style.cursor = 'grab'; render(lastParams); }
  });
  canvas.addEventListener('dblclick', () => {
    yaw = DEFAULT_YAW;
    pitch = DEFAULT_PITCH;
    render(lastParams);
  });

  // === Drawing ===
  function render(params) {
    lastParams = params;
    // Hidden (panel not shown) → nothing to draw; the panel switch re-renders.
    if (!canvas.isConnected || canvas.offsetParent === null) return;
    const cssW = canvas.clientWidth || 256;
    const cssH = Math.round(cssW * ASPECT);
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
      canvas.style.height = cssH + 'px';
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    ctx.fillStyle = '#1e1e1e';
    ctx.fillRect(0, 0, cssW, cssH);
    if (!params) return;

    const { width: fw, height: fh } = env.getFrameSize();
    const d = createCamera(params, fw, fh).describe();
    const hw = fw / 2, hh = fh / 2;
    // Plane corners (world, z = 0): TL, TR, BR, BL.
    const plane = [[-hw, -hh, 0], [hw, -hh, 0], [hw, hh, 0], [-hw, hh, 0]];
    const fit = frozenFit || computeFit(cssW, cssH, plane, d);
    lastFit = fit;
    const { S } = fit;

    const poly = (pts, { fill, stroke, lw = 1, dash } = {}) => {
      ctx.beginPath();
      pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.closePath();
      if (fill) { ctx.fillStyle = fill; ctx.fill(); }
      if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = lw; ctx.setLineDash(dash || []); ctx.stroke(); ctx.setLineDash([]); }
    };
    const line = (a, b, stroke, lw = 1, dash) => {
      ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]);
      ctx.strokeStyle = stroke; ctx.lineWidth = lw; ctx.setLineDash(dash || []); ctx.stroke(); ctx.setLineDash([]);
    };
    const dotAt = (p, r, fill) => { ctx.beginPath(); ctx.arc(p[0], p[1], r, 0, Math.PI * 2); ctx.fillStyle = fill; ctx.fill(); };

    // --- Plane (frame) ---
    const planeS = plane.map(S);
    poly(planeS, { fill: 'rgba(255,255,255,0.06)', stroke: 'rgba(255,255,255,0.45)', lw: 1 });
    // Top edge emphasised so the frame's orientation reads.
    line(planeS[0], planeS[1], 'rgba(255,255,255,0.85)', 2);
    // Center cross.
    const c = S([0, 0, 0]);
    line(S([-hw * 0.08, 0, 0]), S([hw * 0.08, 0, 0]), 'rgba(255,255,255,0.35)');
    line(S([0, -hh * 0.14, 0]), S([0, hh * 0.14, 0]), 'rgba(255,255,255,0.35)');

    // --- Axes gizmo at the plane origin (x red, y green, z blue) ---
    const axLen = Math.min(fw, fh) * 0.18;
    line(c, S([axLen, 0, 0]), AXIS_COLORS.x, 1.5);
    line(c, S([0, axLen, 0]), AXIS_COLORS.y, 1.5);
    line(c, S([0, 0, axLen]), AXIS_COLORS.z, 1.5);

    // --- Frustum: camera → plane footprint ---
    const camS = S(d.position);
    const feetS = d.frustum.map(f => S([f.x, f.y, f.z]));
    const allHit = d.frustum.every(f => f.hit);
    poly(feetS, {
      fill: allHit ? 'rgba(74,158,255,0.14)' : 'rgba(74,158,255,0.06)',
      stroke: 'rgba(74,158,255,0.9)', lw: 1, dash: allHit ? null : [4, 3],
    });
    for (const f of feetS) line(camS, f, 'rgba(74,158,255,0.55)', 1);

    // --- Look-at line + target ---
    const tgtS = S(d.target);
    line(camS, tgtS, 'rgba(255,200,80,0.9)', 1, [3, 3]);
    dotAt(tgtS, 3.5, '#ffc850');

    // --- Camera body: dot + short "up" tick so roll is visible ---
    const upLen = Math.min(fw, fh) * 0.12;
    const upEnd = S(add(d.position, mul(d.up, upLen)));
    line(camS, upEnd, 'rgba(255,255,255,0.8)', 1.5);
    dotAt(camS, 5, '#4a9eff');
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(camS[0], camS[1], 5, 0, Math.PI * 2); ctx.stroke();

    // --- Gizmo handles (on top) ---
    handles = buildHandles(fit, d);
    const activeId = gizmoDrag ? gizmoDrag.handle.id : hoverId;
    for (const h of handles) {
      const hot = h.id === activeId;
      const color = hot ? HOVER_COLOR : h.color;
      if (h.kind === 'axis') {
        const len = Math.hypot(h.b[0] - h.a[0], h.b[1] - h.a[1]);
        if (len < 6) { dotAt(h.a, 3, color); continue; } // axis points at the viewer
        line(h.a, h.b, color, hot ? 2.5 : 1.75);
        // Arrowhead.
        const ux = (h.b[0] - h.a[0]) / len, uy = (h.b[1] - h.a[1]) / len;
        const hs = 7;
        ctx.beginPath();
        ctx.moveTo(h.b[0] + ux * hs * 0.6, h.b[1] + uy * hs * 0.6);
        ctx.lineTo(h.b[0] - ux * hs * 0.6 - uy * hs * 0.5, h.b[1] - uy * hs * 0.6 + ux * hs * 0.5);
        ctx.lineTo(h.b[0] - ux * hs * 0.6 + uy * hs * 0.5, h.b[1] - uy * hs * 0.6 - ux * hs * 0.5);
        ctx.closePath();
        ctx.fillStyle = color; ctx.fill();
      } else {
        // Sphere silhouette (faint) once, then the ring: back half dim, front full.
        if (h.id === 'pitch') {
          ctx.beginPath(); ctx.arc(camS[0], camS[1], RING_PX, 0, Math.PI * 2);
          ctx.strokeStyle = 'rgba(255,255,255,0.18)'; ctx.lineWidth = 1; ctx.stroke();
        }
        for (const pass of ['back', 'front']) {
          ctx.beginPath();
          let open = false;
          for (let i = 0; i < h.pts.length; i++) {
            const p = h.pts[i];
            const inPass = pass === 'front' ? p.front : !p.front;
            if (inPass) {
              if (open) ctx.lineTo(p.s[0], p.s[1]); else { ctx.moveTo(p.s[0], p.s[1]); open = true; }
            } else open = false;
          }
          ctx.strokeStyle = pass === 'front' ? color : (hot ? 'rgba(255,213,74,0.35)' : h.color + '55');
          ctx.lineWidth = hot ? 2.5 : 1.75;
          ctx.stroke();
        }
      }
    }

    // --- Readout ---
    ctx.font = '10px ui-monospace, Menlo, monospace';
    ctx.textBaseline = 'top';
    ctx.fillStyle = 'rgba(255,255,255,0.65)';
    const [px, py, pz] = d.position.map(Math.round);
    const [tx, ty] = d.target.map(Math.round);
    ctx.fillText(`cam ${px}, ${py}, ${pz}`, 6, 5);
    ctx.fillText(`look ${tx}, ${ty}   roll ${Math.round(params.cameraRoll ?? 0)}°   f ${Math.round(d.focal)}`, 6, 17);
    ctx.textAlign = 'right';
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.fillText(`yaw ${Math.round(yaw)}° pitch ${Math.round(pitch)}°`, cssW - 6, cssH - 14);
    ctx.textAlign = 'left';
  }

  return { el, render, setMode };
}
