/**
 * Gyro preview page (#/preview/{fontProjectId}) — a read-only, mobile-first
 * viewer: pick a typeset, tilt the device, and the text stretches toward the
 * tilt direction (stretchAngle/stretchAmount driven by DeviceOrientation).
 *
 * Rendering strategy: glyphs are rasterized ONCE per charId with stretch
 * zeroed (only bounded params — gap/blur — baked in), then stretch is applied
 * every frame as a draw-time affine on the cached bitmap. This is the
 * approximation documented in glyph-cache.js (cells squash into ellipses
 * instead of repositioning), but it's the only way to track the gyro at 60fps
 * — baking stretch like compose-view does costs a 1024px renderCanvas per
 * glyph per change.
 *
 * The project is loaded via fetchFontProjectSnapshot: no store, no edit lock,
 * no autosave — this page can never write.
 */
import { fetchFontProjectSnapshot, resolveTransform } from '../core/project.js';
import { buildRuntimeLayers } from '../core/layer-builder.js';
import { renderCanvas } from '../render/canvas-renderer.js';
import { computeCacheScale, RENDER_SIZE } from '../compose/glyph-cache.js';
import { layoutText, layoutBounds } from '../compose/text-layout.js';
import { stretchMatrix } from '../core/transform-math.js';

const PAD = 16;            // CSS-px margin the layout is fitted into
const MAX_AMOUNT = 1.5;    // stretchAmount at full tilt (slider range is 0–2)
const TILT_RANGE = 45;     // degrees of tilt that map to full stretch
const SMOOTHING = 0.12;    // per-frame lerp factor toward the gyro target

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

  // --- Glyph cache (unstretched, colors baked) ------------------------------
  // charId -> { bmp, cacheScale } | null
  const cache = new Map();
  function getGlyph(charId) {
    if (cache.has(charId)) return cache.get(charId);
    const charData = project.characters[charId];
    let entry = null;
    if (charData) {
      const t = resolveTransform(global, charData.transformOverrides || {});
      const cacheT = { ...t, stretchAmount: 0, stretchAngle: 0 };
      const layers = buildRuntimeLayers(global, charData, RENDER_SIZE);
      if (layers.length > 0) {
        const cacheScale = computeCacheScale(cacheT);
        const off = document.createElement('canvas');
        off.width = off.height = Math.ceil(RENDER_SIZE * cacheScale);
        renderCanvas(off.getContext('2d'), layers, {
          transform: cacheT,
          glyphSize: RENDER_SIZE,
          preview: true,
          fontMetrics: global?.fontMetrics,
          fillColor: global.composeTextColor,
        });
        entry = { bmp: off, cacheScale };
      }
    }
    cache.set(charId, entry);
    return entry;
  }

  // --- Layout ----------------------------------------------------------------
  let fontSize = Number(sizeInput.value);
  let positions = [];
  let fitScale = 1;
  let offX = 0;
  let offY = 0;
  let dirty = true;
  const dpr = window.devicePixelRatio || 1;

  function relayout() {
    const cssW = wrap.clientWidth;
    const cssH = wrap.clientHeight;
    if (cssW === 0 || cssH === 0) return;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    positions = layoutText(textarea.value, charIdSet, {
      fontSize,
      textBoxWidth: Math.max(fontSize, cssW - PAD * 2),
      kerning: 0,
      lineHeight: 1.4,
      writingMode: 'horizontal',
    });
    const bounds = layoutBounds(positions, fontSize);
    fitScale = Math.min(
      1,
      (cssW - PAD * 2) / Math.max(1, bounds.width),
      (cssH - PAD * 2) / Math.max(1, bounds.height),
    );
    offX = (cssW - bounds.width * fitScale) / 2;
    offY = (cssH - bounds.height * fitScale) / 2;
    dirty = true;
  }

  // --- Draw ------------------------------------------------------------------
  const baselineRatio = global.fontMetrics?.baseline ?? 0.5;

  function draw(angleDeg, amount) {
    const { a, b, d } = stretchMatrix(angleDeg, amount);
    const halfW = fontSize / 2;
    const above = fontSize * baselineRatio;
    const s = dpr * fitScale;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = global.composeBgColor || '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    for (const pos of positions) {
      // Stretch pivots on the row baseline center, matching compose-view.
      const tx = dpr * (offX + (pos.x + halfW) * fitScale);
      const ty = dpr * (offY + (pos.y + above) * fitScale);
      ctx.setTransform(s * a, s * b, s * b, s * d, tx, ty);

      if (pos.missing) {
        ctx.strokeStyle = '#bbb';
        ctx.lineWidth = 1 / fitScale;
        ctx.strokeRect(-halfW, -above, fontSize, fontSize);
        continue;
      }
      const entry = getGlyph(pos.charId);
      if (!entry) continue;
      const drawSize = fontSize * entry.cacheScale;
      const drawOffset = (drawSize - fontSize) / 2;
      ctx.drawImage(
        entry.bmp,
        -halfW - drawOffset, -above - drawOffset,
        drawSize, drawSize,
      );
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
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
  sizeInput.addEventListener('input', () => {
    fontSize = Number(sizeInput.value);
    relayout();
  });

  const ro = new ResizeObserver(relayout);
  ro.observe(wrap);

  // --- Teardown on navigation --------------------------------------------
  // main.js rebuilds #app on hashchange but knows nothing about our window
  // listeners / rAF loop — release them ourselves.
  function destroy() {
    window.removeEventListener('hashchange', destroy);
    window.removeEventListener('deviceorientation', onOrientation);
    ro.disconnect();
    cancelAnimationFrame(rafId);
    cache.clear();
  }
  window.addEventListener('hashchange', destroy);

  relayout();
  frame();
}
