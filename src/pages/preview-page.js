/**
 * Gyro preview page (#/preview/{fontProjectId}) — a read-only, mobile-first
 * viewer: pick a typeset, tilt the device, and the gyro drives the typeface's
 * own deformation parameters (stretchAngle / stretchAmount).
 *
 * Rendering goes through createFrameRenderer (animation/render.js) — the same
 * per-frame pipeline the animation page scrubs with: per-cell displacement
 * along the stretch direction, per-layer scaleParallel/scaleOrthogonal, grid
 * connect and metaball blur are all live. This is real parameter-space
 * deformation, not an affine squash of a cached bitmap.
 *
 * The project is loaded via fetchFontProjectSnapshot: no store, no edit lock,
 * no autosave — this page can never write.
 */
import { fetchFontProjectSnapshot } from '../core/project.js';
import { createFrameRenderer } from '../animation/render.js';
import { layoutText, layoutBounds } from '../compose/text-layout.js';

const PAD = 32;            // render-frame padding in device px
const MAX_AMOUNT = 1.5;    // stretchAmount at full tilt (slider range is 0–2)
const TILT_RANGE = 45;     // degrees of tilt that map to full stretch
const SMOOTHING = 0.12;    // per-frame lerp factor toward the gyro target
// Full-fidelity rendering (per-cell paths + blur per glyph per frame) is fill
// rate bound — cap the backing store so phones keep an interactive rate.
const MAX_CANVAS_PIXELS = 1_500_000;

export async function renderPreviewPage(app, fontProjectId) {
  let project;
  try {
    project = await fetchFontProjectSnapshot(fontProjectId);
  } catch (e) {
    console.error(e);
    alert(`プロジェクトの読み込みに失敗しました: ${e.message}`);
    location.hash = '#/';
    return;
  }
  const global = project.global;
  const charIdSet = new Set(Object.keys(project.characters));

  // --- DOM -----------------------------------------------------------------
  app.innerHTML = '';
  const page = document.createElement('div');
  page.className = 'preview-page';
  app.appendChild(page);

  const header = document.createElement('header');
  header.className = 'preview-header';
  const backBtn = document.createElement('button');
  backBtn.type = 'button';
  backBtn.className = 'preview-back';
  backBtn.textContent = '← 一覧';
  backBtn.addEventListener('click', () => { location.hash = '#/'; });
  const title = document.createElement('h1');
  title.textContent = project.name;
  header.appendChild(backBtn);
  header.appendChild(title);
  page.appendChild(header);

  const wrap = document.createElement('div');
  wrap.className = 'preview-canvas-wrap';
  const canvas = document.createElement('canvas');
  wrap.appendChild(canvas);
  const hint = document.createElement('div');
  hint.className = 'preview-hint';
  hint.textContent = 'ポインタ / ドラッグで変形（ジャイロ未使用時）';
  wrap.appendChild(hint);
  page.appendChild(wrap);
  const ctx = canvas.getContext('2d');

  const controls = document.createElement('div');
  controls.className = 'preview-controls';
  const textarea = document.createElement('textarea');
  textarea.className = 'preview-textarea';
  textarea.rows = 1;
  textarea.value = Object.keys(project.characters).slice(0, 5).join('');
  const sizeInput = document.createElement('input');
  sizeInput.type = 'range';
  sizeInput.min = '24';
  sizeInput.max = '200';
  sizeInput.value = '72';
  sizeInput.className = 'preview-size';
  const gyroBtn = document.createElement('button');
  gyroBtn.type = 'button';
  gyroBtn.className = 'preview-gyro-btn';
  gyroBtn.textContent = 'ジャイロ開始';
  controls.appendChild(textarea);
  controls.appendChild(sizeInput);
  controls.appendChild(gyroBtn);
  page.appendChild(controls);

  // --- Renderer + layout -----------------------------------------------------
  // The frame renderer captures its canvas dimensions at creation (frame +
  // work canvas), so it's rebuilt on resize. Its per-char runtime-layer cache
  // is rebuilt too — acceptable, resize/rotation is rare.
  let renderer = null;
  let layout = null;
  let dirty = true;

  function rebuildRenderer() {
    const cssW = wrap.clientWidth;
    const cssH = wrap.clientHeight;
    if (cssW === 0 || cssH === 0) return;
    let dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (cssW * cssH * dpr * dpr > MAX_CANVAS_PIXELS) {
      dpr = Math.sqrt(MAX_CANVAS_PIXELS / (cssW * cssH));
    }
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    // Synthetic single-frame "animation": fixed frame the size of our canvas,
    // compose colors, no tracks (→ no per-frame auto-mesh path).
    renderer = createFrameRenderer({
      canvasWidth: canvas.width,
      canvasHeight: canvas.height,
      bgColor: global.composeBgColor || '#fff',
      textColor: global.composeTextColor,
      text: '',
      tracks: {},
    }, { project, global });
    relayout();
  }

  /** Layout in device px. Wraps at the canvas width and shrinks fontSize once
   *  when the block overflows, so the whole text fits the frame. Shape matches
   *  what renderInto() expects ({positions, pad, cw, ch}). */
  function relayout() {
    if (!renderer) return;
    const availW = canvas.width - PAD * 2;
    const availH = canvas.height - PAD * 2;
    const requested = Number(sizeInput.value) * (canvas.width / wrap.clientWidth);
    const layoutAt = (fs) => layoutText(textarea.value, charIdSet, {
      fontSize: fs,
      textBoxWidth: Math.max(fs, availW),
      kerning: 0,
      lineHeight: 1.4,
      writingMode: 'horizontal',
    });
    let fontSize = requested;
    let positions = layoutAt(fontSize);
    let bounds = layoutBounds(positions, fontSize);
    const fit = Math.min(
      1,
      availW / Math.max(1, bounds.width),
      availH / Math.max(1, bounds.height),
    );
    if (fit < 1) {
      fontSize = Math.max(8, fontSize * fit);
      positions = layoutAt(fontSize);
      bounds = layoutBounds(positions, fontSize);
    }
    layout = {
      positions,
      pad: PAD,
      cw: bounds.width + PAD * 2,
      ch: bounds.height + PAD * 2,
      fontSize,
    };
    dirty = true;
  }

  // --- Draw ------------------------------------------------------------------
  function draw(angleDeg, amount) {
    if (!renderer || !layout) return;
    renderer.renderInto(ctx, {
      fontSize: layout.fontSize,
      // The gyro drives the typeface's own deformation parameters; everything
      // else keeps the project's saved global values (per-char overrides are
      // still resolved inside renderInto).
      stretchAngle: angleDeg,
      stretchAmount: amount,
      baseGap: global.baseGap ?? 0,
      gapDirectionWeight: global.gapDirectionWeight ?? 0,
      metaballRadius: global.metaballRadius ?? 8,
    }, layout);
  }

  // --- Tilt state + animation loop -------------------------------------------
  // The tilt is smoothed as a 2D vector (not angle+amount) so the stretch
  // angle never snaps across the 0°/180° wrap while interpolating.
  const target = { x: 0, y: 0 };
  const current = { x: 0, y: 0 };
  let rafId = 0;

  function frame() {
    rafId = requestAnimationFrame(frame);
    current.x += (target.x - current.x) * SMOOTHING;
    current.y += (target.y - current.y) * SMOOTHING;
    const settled =
      Math.abs(target.x - current.x) < 0.001 &&
      Math.abs(target.y - current.y) < 0.001;
    if (settled && !dirty) return;
    dirty = false;
    const mag = Math.min(1, Math.hypot(current.x, current.y));
    const angle = ((Math.atan2(current.y, current.x) * 180) / Math.PI + 360) % 180;
    draw(angle, mag * MAX_AMOUNT);
  }

  // --- Gyro ------------------------------------------------------------------
  let gyroActive = false;
  // First orientation event after (re)start becomes the neutral pose, so the
  // resting hold position shows the undeformed text.
  let neutral = null;

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  function onOrientation(e) {
    if (e.beta == null || e.gamma == null) return;
    if (!neutral) neutral = { beta: e.beta, gamma: e.gamma };
    target.x = clamp((e.gamma - neutral.gamma) / TILT_RANGE, -1, 1);
    target.y = clamp((e.beta - neutral.beta) / TILT_RANGE, -1, 1);
  }

  gyroBtn.addEventListener('click', async () => {
    if (gyroActive) {
      neutral = null; // recalibrate: next event becomes the new neutral
      return;
    }
    try {
      // iOS 13+ requires an explicit permission grant from a user gesture
      // (and a secure context — HTTPS).
      if (typeof DeviceOrientationEvent !== 'undefined'
          && typeof DeviceOrientationEvent.requestPermission === 'function') {
        const res = await DeviceOrientationEvent.requestPermission();
        if (res !== 'granted') {
          hint.textContent = 'ジャイロの利用が許可されませんでした';
          return;
        }
      }
    } catch (e) {
      console.error(e);
      hint.textContent = `ジャイロを開始できません: ${e.message}`;
      return;
    }
    window.addEventListener('deviceorientation', onOrientation);
    gyroActive = true;
    gyroBtn.textContent = '基準リセット';
    hint.textContent = '端末を傾けて変形 / ボタンで基準リセット';
  });

  // Pointer fallback (PC / gyro permission not granted): offset from canvas
  // center drives the same tilt vector.
  wrap.addEventListener('pointermove', (e) => {
    if (gyroActive) return;
    const r = wrap.getBoundingClientRect();
    target.x = clamp(((e.clientX - r.left) / r.width) * 2 - 1, -1, 1);
    target.y = clamp(((e.clientY - r.top) / r.height) * 2 - 1, -1, 1);
  });
  wrap.addEventListener('pointerleave', () => {
    if (!gyroActive) { target.x = 0; target.y = 0; }
  });

  // --- Controls --------------------------------------------------------------
  textarea.addEventListener('input', relayout);
  sizeInput.addEventListener('input', relayout);

  const ro = new ResizeObserver(rebuildRenderer);
  ro.observe(wrap);

  // --- Teardown on navigation --------------------------------------------
  // main.js rebuilds #app on hashchange but knows nothing about our window
  // listeners / rAF loop — release them ourselves.
  function destroy() {
    window.removeEventListener('hashchange', destroy);
    window.removeEventListener('deviceorientation', onOrientation);
    ro.disconnect();
    cancelAnimationFrame(rafId);
    renderer = null;
  }
  window.addEventListener('hashchange', destroy);

  rebuildRenderer();
  frame();
}
