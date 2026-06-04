import { ANIMATED_PARAM_KEYS } from '../core/project.js';
import { EASING_NAMES, EASING_TO_BEZIER, sampleBezierSegment } from './interpolation.js';
import { removeKeyframe, setKeyframeTime, findKeyframeAt, ensureBezierHandles, clampTrackHandles } from './animation.js';

const ROW_HEIGHT = 22;
const ROW_HEIGHT_EXPANDED = 90;
const LABEL_WIDTH = 140;
const KEYFRAME_RADIUS = 5;
const SELECT_EPSILON = 1e-4;
const CURVE_VERT_PAD = 10;
// Bezier segments are flattened into this many line pieces when drawing.
const CURVE_SEGMENTS = 24;
// Double-click window (ms) for toggling a keyframe's handle mode. Detected
// manually from mousedown timestamps because render() re-creates the dot
// between clicks, which would defeat the native dblclick event.
const DBLCLICK_MS = 300;

/**
 * Create timeline UI.
 * @param {object} animation - the animation object (mutated by this component)
 * @param {object} callbacks - { onSeek(time), onChange(), getCurrentTime() }
 */
export function createTimelineUI(animation, callbacks) {
  const el = document.createElement('div');
  el.className = 'anim-timeline';

  // Human-friendly row label resolver (e.g. 'grid.0.scale' -> 'Scale').
  // Falls back to the raw track key.
  const labelFor = callbacks.labelFor || ((key) => key);

  // Current keyframe selection: { key: string, time: number } or null.
  // Persists across re-renders; matching dot gets `.selected` class.
  let selectedKf = null;

  // Last keyframe mousedown, for manual double-click detection.
  // { key, time, at }.
  let lastClick = null;

  // Set of param keys whose row is expanded into the curve-graph view.
  // Clicking a label toggles membership.
  const expandedRows = new Set();

  /**
   * Track keys to show, in a stable order: only params that actually hold
   * keyframes get a row (instead of the full fixed ANIMATED_PARAM_KEYS list),
   * so the panel stays compact as more animatable params (e.g. grid params)
   * are introduced. Canonical params come first in their declared order, then
   * any extra tracks (grid.*) sorted lexically.
   */
  function activeKeys() {
    const tracks = animation.tracks || {};
    const seen = new Set();
    const keys = [];
    for (const k of ANIMATED_PARAM_KEYS) {
      if (tracks[k] && tracks[k].length > 0) { keys.push(k); seen.add(k); }
    }
    const rest = Object.keys(tracks)
      .filter(k => !seen.has(k) && tracks[k] && tracks[k].length > 0)
      .sort();
    return [...keys, ...rest];
  }

  function rowHeight(key) {
    return expandedRows.has(key) ? ROW_HEIGHT_EXPANDED : ROW_HEIGHT;
  }

  /** Per-key top offsets within rowsInner; total height of the rows column. */
  function computeRowLayout() {
    const tops = {};
    let y = 0;
    for (const key of activeKeys()) {
      tops[key] = y;
      y += rowHeight(key);
    }
    return { tops, total: y };
  }

  /**
   * Compute a value-axis range for a track. Auto-fits to the keyframe values
   * with 10% headroom; falls back to ±1 around the base value when the
   * track has a single value (or no spread).
   */
  function computeValueRange(track, baseValue) {
    let min = Infinity, max = -Infinity;
    for (const kf of track) {
      // Include handle endpoints so bezier overshoot (anticipation, bounce)
      // and the draggable grips stay on-screen instead of clipping.
      const vals = [kf.value];
      if (kf.hIn) vals.push(kf.value + kf.hIn.dv);
      if (kf.hOut) vals.push(kf.value + kf.hOut.dv);
      for (const v of vals) {
        if (v < min) min = v;
        if (v > max) max = v;
      }
    }
    if (typeof baseValue === 'number') {
      if (baseValue < min) min = baseValue;
      if (baseValue > max) max = baseValue;
    }
    if (!isFinite(min) || !isFinite(max)) { min = -1; max = 1; }
    const span = max - min;
    if (span < 1e-9) {
      const v = min;
      return { min: v - 1, max: v + 1 };
    }
    return { min: min - span * 0.1, max: max + span * 0.1 };
  }

  function valueToY(value, range, totalH) {
    const usable = totalH - CURVE_VERT_PAD * 2;
    const norm = (value - range.min) / (range.max - range.min);
    return CURVE_VERT_PAD + (1 - norm) * usable;
  }

  function yToValue(y, range, totalH) {
    const usable = totalH - CURVE_VERT_PAD * 2;
    const norm = 1 - (y - CURVE_VERT_PAD) / usable;
    return range.min + norm * (range.max - range.min);
  }

  function drawCurve(canvas, w, h, track, key, range) {
    const dpr = window.devicePixelRatio || 1;
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    canvas.width = Math.max(1, Math.floor(w * dpr));
    canvas.height = Math.max(1, Math.floor(h * dpr));
    const c = canvas.getContext('2d');
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, w, h);

    // Zero-line (when 0 is inside the visible range)
    if (range.min < 0 && range.max > 0) {
      c.strokeStyle = 'rgba(255,255,255,0.08)';
      c.lineWidth = 1;
      const zy = valueToY(0, range, h);
      c.beginPath();
      c.moveTo(0, zy);
      c.lineTo(w, zy);
      c.stroke();
    }

    if (track.length === 0) return;

    // Plot each segment as its own flattened cubic bezier; flat lead-in/out
    // before the first and after the last keyframe match sampleTrack()'s hold
    // behaviour. Sampling by bezier parameter (not by time) needs no root
    // finding and is exact at the control points.
    c.strokeStyle = '#4a9eff';
    c.lineWidth = 1.5;
    c.beginPath();
    const first = track[0];
    const firstY = valueToY(first.value, range, h);
    c.moveTo(0, firstY);
    c.lineTo(timeToX(first.time, w), firstY);
    for (let i = 0; i < track.length - 1; i++) {
      const a = track[i];
      const b = track[i + 1];
      for (let s = 1; s <= CURVE_SEGMENTS; s++) {
        const pt = sampleBezierSegment(a, b, s / CURVE_SEGMENTS);
        c.lineTo(timeToX(pt.time, w), valueToY(pt.value, range, h));
      }
    }
    const last = track[track.length - 1];
    c.lineTo(w, valueToY(last.value, range, h));
    c.stroke();
  }

  /**
   * Draw the in/out handle lines of the selected keyframe onto the curve
   * canvas. Reuses the context state left by drawCurve (same CSS-unit
   * transform). Only handles that affect a real segment are drawn — the first
   * keyframe has no in-handle segment, the last has no out-handle segment.
   */
  function drawHandleLines(canvas, w, h, track, idx, range) {
    const kf = track[idx];
    const c = canvas.getContext('2d');
    const cx = timeToX(kf.time, w);
    const cy = valueToY(kf.value, range, h);
    c.strokeStyle = 'rgba(255,204,0,0.7)';
    c.lineWidth = 1;
    const line = (handle) => {
      if (!handle) return;
      c.beginPath();
      c.moveTo(cx, cy);
      c.lineTo(timeToX(kf.time + handle.dt, w), valueToY(kf.value + handle.dv, range, h));
      c.stroke();
    };
    if (idx > 0) line(kf.hIn);
    if (idx < track.length - 1) line(kf.hOut);
  }

  /**
   * Re-align a keyframe's two handles so they are collinear in screen space
   * (preserving each length) — used when switching back to 'smooth'. Screen
   * space, not data space, so the handle line looks straight despite the
   * non-uniform time vs value axes.
   */
  function realignSmooth(kf, w, h, range) {
    if (!kf.hIn || !kf.hOut) return;
    const usable = h - CURVE_VERT_PAD * 2;
    const dur = Math.max(0.001, animation.duration);
    const span = range.max - range.min;
    const inSx = (kf.hIn.dt / dur) * w, inSy = -(kf.hIn.dv / span) * usable;
    const outSx = (kf.hOut.dt / dur) * w, outSy = -(kf.hOut.dv / span) * usable;
    let tx = outSx - inSx, ty = outSy - inSy;
    const tl = Math.hypot(tx, ty);
    if (tl < 1e-6) return;
    tx /= tl; ty /= tl;
    const inLen = Math.hypot(inSx, inSy);
    const outLen = Math.hypot(outSx, outSy);
    kf.hIn.dt = Math.min(0, (-tx * inLen / w) * dur);
    kf.hIn.dv = -(-ty * inLen / usable) * span;
    kf.hOut.dt = Math.max(0, (tx * outLen / w) * dur);
    kf.hOut.dv = -(ty * outLen / usable) * span;
  }

  /**
   * Create a draggable handle endpoint for keyframe `idx` (which = 'in' |
   * 'out') in an expanded row. Dragging edits the handle's length + direction.
   * The handle's time offset is clamped to the segment span so the curve stays
   * single-valued (no time reversal). In 'smooth' mode the opposite handle is
   * mirrored in screen space (preserving its length); Alt-drag breaks the pair
   * into 'broken' mode and moves only this handle.
   */
  function addHandleDot(row, key, track, idx, which, w, h, range) {
    const kf = track[idx];
    const handle = which === 'in' ? kf.hIn : kf.hOut;
    if (!handle) return;
    const hdot = document.createElement('div');
    hdot.className = 'anim-handle' + (kf.handleMode === 'broken' ? ' broken' : '');
    hdot.style.left = timeToX(kf.time + handle.dt, w) + 'px';
    hdot.style.top = valueToY(kf.value + handle.dv, range, h) + 'px';

    const prevKf = idx > 0 ? track[idx - 1] : null;
    const nextKf = idx < track.length - 1 ? track[idx + 1] : null;
    // Clamp a handle's time offset to its segment so X(u) stays monotonic.
    const clampDt = (w_, dt) => {
      if (w_ === 'out') {
        const max = nextKf ? nextKf.time - kf.time : animation.duration - kf.time;
        return Math.max(0, Math.min(max, dt));
      }
      const min = prevKf ? prevKf.time - kf.time : -kf.time;
      return Math.min(0, Math.max(min, dt));
    };

    hdot.addEventListener('mousedown', (e) => {
      e.stopPropagation();
      if (e.button !== 0) return;
      const rect = row.getBoundingClientRect();
      const trackWidth = rect.width;
      const trackHeight = rect.height;
      const usable = trackHeight - CURVE_VERT_PAD * 2;
      const dur = Math.max(0.001, animation.duration);
      const span = range.max - range.min;
      if (e.altKey) kf.handleMode = 'broken';
      selectedKf = { key, time: kf.time };

      const onMove = (ev) => {
        if (trackWidth <= 0) return;
        const localX = ev.clientX - rect.left;
        const localY = ev.clientY - rect.top;
        const me = which === 'in' ? kf.hIn : kf.hOut;
        me.dt = clampDt(which, xToTime(localX, trackWidth) - kf.time);
        me.dv = yToValue(localY, range, trackHeight) - kf.value;

        // Smooth: keep the opposite handle collinear in screen space, with its
        // own length preserved.
        if (kf.handleMode !== 'broken') {
          const opp = which === 'in' ? kf.hOut : kf.hIn;
          const oppWhich = which === 'in' ? 'out' : 'in';
          if (opp) {
            const sx = (me.dt / dur) * trackWidth, sy = -(me.dv / span) * usable;
            const len = Math.hypot(sx, sy);
            const oppSx = (opp.dt / dur) * trackWidth, oppSy = -(opp.dv / span) * usable;
            const oppLen = Math.hypot(oppSx, oppSy);
            if (len > 1e-6 && oppLen > 1e-6) {
              const nx = -sx / len * oppLen, ny = -sy / len * oppLen;
              opp.dt = clampDt(oppWhich, (nx / trackWidth) * dur);
              opp.dv = -(ny / usable) * span;
            }
          }
        }
        callbacks.onChange?.();
        render();
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
      render();
    });

    row.appendChild(hdot);
  }

  function isDotSelected(key, kf) {
    return selectedKf
      && selectedKf.key === key
      && Math.abs(selectedKf.time - kf.time) < SELECT_EPSILON;
  }

  function clearSelection() {
    if (selectedKf === null) return false;
    selectedKf = null;
    return true;
  }

  const header = document.createElement('div');
  header.className = 'anim-timeline-header';
  el.appendChild(header);

  const body = document.createElement('div');
  body.className = 'anim-timeline-body';
  el.appendChild(body);

  // Scrubber SVG sits inside body and overlays rows
  const rowsWrap = document.createElement('div');
  rowsWrap.className = 'anim-timeline-rows';
  body.appendChild(rowsWrap);

  // Build label column. Rebuilt every render() so heights and chevrons can
  // track the expandedRows state.
  const labelCol = document.createElement('div');
  labelCol.className = 'anim-timeline-labels';
  labelCol.style.width = LABEL_WIDTH + 'px';
  rowsWrap.appendChild(labelCol);

  function renderLabels() {
    labelCol.innerHTML = '';
    for (const key of activeKeys()) {
      const isExpanded = expandedRows.has(key);
      const lbl = document.createElement('div');
      lbl.className = 'anim-timeline-label' + (isExpanded ? ' expanded' : '');
      lbl.style.height = rowHeight(key) + 'px';
      lbl.dataset.key = key;

      const chevron = document.createElement('span');
      chevron.className = 'anim-timeline-chevron';
      chevron.textContent = isExpanded ? '▼' : '▶';
      lbl.appendChild(chevron);

      const text = document.createElement('span');
      text.className = 'anim-timeline-label-text';
      text.textContent = labelFor(key);
      lbl.appendChild(text);

      lbl.addEventListener('click', () => {
        if (expandedRows.has(key)) expandedRows.delete(key);
        else expandedRows.add(key);
        render();
      });
      labelCol.appendChild(lbl);
    }
  }

  // Canvas area for tracks + playhead
  const trackArea = document.createElement('div');
  trackArea.className = 'anim-timeline-tracks';
  rowsWrap.appendChild(trackArea);

  // Ruler
  const ruler = document.createElement('div');
  ruler.className = 'anim-timeline-ruler';
  trackArea.appendChild(ruler);

  // Cached-frame indicator strip. Painted as a 1-D canvas just below the
  // ruler — green segments mark frame ranges that have been rendered and are
  // playback-cache hits. Driven by updateFrameCacheIndicator() from the page.
  const cacheStrip = document.createElement('canvas');
  cacheStrip.className = 'anim-timeline-cache-strip';
  trackArea.appendChild(cacheStrip);
  let _cacheState = null;
  let _cacheRedrawScheduled = false;

  // Rows container (abs positioning inside). Height is updated on each
  // renderRows() since expanded rows are taller than collapsed.
  const rowsInner = document.createElement('div');
  rowsInner.className = 'anim-timeline-rows-inner';
  trackArea.appendChild(rowsInner);

  // Playhead line (overlay, span both ruler + rows)
  const playheadOverlay = document.createElement('div');
  playheadOverlay.className = 'anim-timeline-playhead';
  trackArea.appendChild(playheadOverlay);

  // Keyframe context menu
  const ctxMenu = document.createElement('div');
  ctxMenu.className = 'anim-timeline-ctxmenu';
  ctxMenu.style.display = 'none';
  document.body.appendChild(ctxMenu);

  function hideCtxMenu() {
    ctxMenu.style.display = 'none';
  }
  // Close the menu only on outside clicks. Clicks inside (opening the easing
  // <select>, the Delete button, etc.) must not dismiss it — otherwise the
  // first interaction collapses the panel before the user can choose.
  function onDocClick(e) {
    if (ctxMenu.contains(e.target)) return;
    hideCtxMenu();
  }
  document.addEventListener('click', onDocClick);

  function showCtxMenu(x, y, trackKey, kfIndex) {
    ctxMenu.innerHTML = '';
    const track = animation.tracks[trackKey];
    const kf = track[kfIndex];
    if (!kf) return;
    const isFirst = kfIndex === 0;
    const prevKf = isFirst ? null : track[kfIndex - 1];

    const header = document.createElement('div');
    header.className = 'anim-ctx-header';
    header.textContent = `${trackKey} @ ${kf.time.toFixed(2)}s`;
    ctxMenu.appendChild(header);

    // Hint: which segment the easing affects. The first keyframe has no
    // segment leading into it, so the select is disabled with an explanation.
    const hint = document.createElement('div');
    hint.className = 'anim-ctx-hint';
    hint.textContent = isFirst
      ? '(no segment before the first keyframe)'
      : `easing for ${prevKf.time.toFixed(2)}s → ${kf.time.toFixed(2)}s`;
    ctxMenu.appendChild(hint);

    const easingRow = document.createElement('div');
    easingRow.className = 'anim-ctx-row';
    const easeLbl = document.createElement('span');
    easeLbl.textContent = 'Easing:';
    const easeSel = document.createElement('select');
    easeSel.disabled = isFirst;
    for (const name of EASING_NAMES) {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      if (kf.easing === name) opt.selected = true;
      easeSel.appendChild(opt);
    }
    // Choosing a preset reshapes the incoming segment's bezier handles
    // (prevKf's out-handle + this kf's in-handle) to match — a shortcut to a
    // known curve that the user can then fine-tune by dragging the handles.
    easeSel.addEventListener('change', () => {
      kf.easing = easeSel.value;
      if (!isFirst) {
        ensureBezierHandles(track);
        const c = EASING_TO_BEZIER[easeSel.value] || EASING_TO_BEZIER.linear;
        const spanT = kf.time - prevKf.time;
        const spanV = kf.value - prevKf.value;
        prevKf.hOut = { dt: c[0] * spanT, dv: c[1] * spanV };
        kf.hIn = { dt: (c[2] - 1) * spanT, dv: (c[3] - 1) * spanV };
      }
      callbacks.onChange?.();
      render();
    });
    easingRow.appendChild(easeLbl);
    easingRow.appendChild(easeSel);
    ctxMenu.appendChild(easingRow);

    // Reminder of the manual handle-mode control.
    const modeHint = document.createElement('div');
    modeHint.className = 'anim-ctx-hint';
    modeHint.textContent = `handles: ${kf.handleMode || 'smooth'} — double-click the keyframe to toggle`;
    ctxMenu.appendChild(modeHint);

    const delBtn = document.createElement('button');
    delBtn.textContent = 'Delete Keyframe';
    delBtn.className = 'anim-ctx-del';
    delBtn.addEventListener('click', () => {
      removeKeyframe(track, kfIndex);
      clampTrackHandles(track);
      callbacks.onChange?.();
      render();
      hideCtxMenu();
    });
    ctxMenu.appendChild(delBtn);

    // まず表示してサイズを計測してから、画面外にはみ出さないよう位置を補正する
    ctxMenu.style.display = '';
    const margin = 8;
    const rect = ctxMenu.getBoundingClientRect();
    let left = x;
    let top = y;
    if (left + rect.width > window.innerWidth - margin) {
      left = Math.max(margin, window.innerWidth - rect.width - margin);
    }
    if (top + rect.height > window.innerHeight - margin) {
      top = Math.max(margin, window.innerHeight - rect.height - margin);
    }
    ctxMenu.style.left = left + 'px';
    ctxMenu.style.top = top + 'px';
  }

  function timeToX(time, trackWidth) {
    return (time / Math.max(0.001, animation.duration)) * trackWidth;
  }
  function xToTime(x, trackWidth) {
    return (x / trackWidth) * animation.duration;
  }

  function renderRuler() {
    ruler.innerHTML = '';
    const w = ruler.clientWidth;
    if (w <= 0) return;
    const dur = animation.duration;
    const step = dur <= 2 ? 0.2 : dur <= 10 ? 1 : dur <= 30 ? 5 : 10;
    for (let t = 0; t <= dur + 1e-6; t += step) {
      const tick = document.createElement('div');
      tick.className = 'anim-timeline-tick';
      tick.style.left = timeToX(t, w) + 'px';
      const label = document.createElement('span');
      label.textContent = t.toFixed(step < 1 ? 1 : 0) + 's';
      tick.appendChild(label);
      ruler.appendChild(tick);
    }
  }

  function renderRows() {
    rowsInner.innerHTML = '';
    const w = rowsInner.clientWidth;
    if (w <= 0) return;

    const { tops, total } = computeRowLayout();
    rowsInner.style.height = total + 'px';

    for (const key of activeKeys()) {
      const isExpanded = expandedRows.has(key);
      const h = rowHeight(key);
      const top = tops[key];

      const row = document.createElement('div');
      row.className = 'anim-timeline-row' + (isExpanded ? ' expanded' : '');
      row.style.top = top + 'px';
      row.style.height = h + 'px';
      row.dataset.key = key;

      const track = animation.tracks[key] || [];

      // Expanded rows: draw the curve canvas behind the keyframes. The canvas
      // is decorative (pointer-events:none in CSS) — drag interaction still
      // goes through the dots themselves.
      let valueRange = null;
      let curveCanvas = null;
      if (isExpanded) {
        // Realise bezier handles for this track (idempotent migration) so the
        // editor has handles to draw and drag.
        ensureBezierHandles(track);
        valueRange = computeValueRange(track, animation.baseValues?.[key]);
        curveCanvas = document.createElement('canvas');
        curveCanvas.className = 'anim-curve-canvas';
        row.appendChild(curveCanvas);
        // drawCurve sizes the canvas — must happen after it's in the DOM if
        // we ever switch to clientWidth-based sizing, but we already have w
        // from rowsInner here.
        drawCurve(curveCanvas, w, h, track, key, valueRange);
      }

      for (let j = 0; j < track.length; j++) {
        const kf = track[j];
        const dot = document.createElement('div');
        dot.className = 'anim-keyframe';
        if (isDotSelected(key, kf)) dot.classList.add('selected');
        dot.style.left = timeToX(kf.time, w) + 'px';
        if (isExpanded && valueRange) {
          dot.style.top = valueToY(kf.value, valueRange, h) + 'px';
        }

        let dragging = false;
        let dragStartX = 0;
        let dragStartY = 0;
        let dragStartTime = 0;
        let dragStartValue = 0;
        let moved = false;
        let currentIndex = j;

        dot.addEventListener('mousedown', (e) => {
          e.stopPropagation();
          if (e.button !== 0) return;
          // Double-click on a keyframe toggles its handle mode (smooth ⇄
          // broken). Detected manually since render() swaps the dot between
          // clicks. Only meaningful in expanded (curve) rows where handles show.
          const now = performance.now();
          const isDouble = lastClick
            && lastClick.key === key
            && Math.abs(lastClick.time - kf.time) < SELECT_EPSILON
            && (now - lastClick.at) < DBLCLICK_MS;
          if (isDouble) {
            lastClick = null;
            if (isExpanded && valueRange) {
              kf.handleMode = kf.handleMode === 'broken' ? 'smooth' : 'broken';
              if (kf.handleMode === 'smooth') realignSmooth(kf, w, h, valueRange);
              selectedKf = { key, time: kf.time };
              callbacks.onChange?.();
              render();
            }
            return;
          }
          lastClick = { key, time: kf.time, at: now };
          // Cache row geometry NOW — render() below detaches `row`, after which
          // row.getBoundingClientRect() returns zeros and would snap the
          // keyframe to garbage coordinates.
          const rect = row.getBoundingClientRect();
          const trackWidth = rect.width;
          const trackHeight = rect.height;
          const startValueRange = valueRange; // frozen at drag start
          selectedKf = { key, time: kf.time };
          dragging = true;
          moved = false;
          dragStartX = e.clientX;
          dragStartY = e.clientY;
          dragStartTime = kf.time;
          dragStartValue = kf.value;
          render();

          const onMove = (ev) => {
            if (!dragging || trackWidth <= 0) return;
            const dx = ev.clientX - dragStartX;
            const dy = ev.clientY - dragStartY;
            if (Math.abs(dx) > 2 || Math.abs(dy) > 2) moved = true;
            // Horizontal: time. Shift locks vertical-only when in expanded
            // mode, so the user can re-time without nudging the value.
            let newT = dragStartTime;
            if (!(ev.shiftKey && isExpanded)) {
              const rawT = dragStartTime + (dx / trackWidth) * animation.duration;
              const fps = animation.fps || 30;
              const snapped = Math.round(rawT * fps) / fps;
              newT = Math.max(0, Math.min(animation.duration, snapped));
            }
            const idx = setKeyframeTime(track, currentIndex, newT);
            currentIndex = idx;
            clampTrackHandles(track);
            // Vertical: value (expanded rows only). Drag stays anchored to the
            // value-range computed at mousedown — the curve auto-fits as values
            // change, but using the live range would feel like the cursor was
            // dragging the axis with it.
            if (isExpanded && startValueRange && trackHeight > 0) {
              const yLocal = dragStartY - rect.top + dy;
              const newV = yToValue(yLocal, startValueRange, trackHeight);
              const cur = track[idx];
              if (cur) cur.value = newV;
            }
            selectedKf = { key, time: newT };
            callbacks.onChange?.();
            render();
          };
          const onUp = () => {
            dragging = false;
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
          };
          document.addEventListener('mousemove', onMove);
          document.addEventListener('mouseup', onUp);
        });

        dot.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          e.stopPropagation();
          const latest = findKeyframeAt(animation.tracks[key], kf.time);
          if (latest) showCtxMenu(e.clientX, e.clientY, key, latest.index);
        });

        row.appendChild(dot);

        // Bezier handles for the selected keyframe (expanded rows only). Draw
        // the handle lines on the curve canvas and overlay draggable dots at
        // the handle endpoints. Endpoints whose handle drives no real segment
        // (first kf's in-handle, last kf's out-handle) are omitted.
        if (isExpanded && valueRange && isDotSelected(key, kf)) {
          drawHandleLines(curveCanvas, w, h, track, j, valueRange);
          if (j > 0) addHandleDot(row, key, track, j, 'in', w, h, valueRange);
          if (j < track.length - 1) addHandleDot(row, key, track, j, 'out', w, h, valueRange);
        }
      }

      rowsInner.appendChild(row);
    }
  }

  function renderPlayhead() {
    const w = trackArea.clientWidth;
    if (w <= 0) return;
    const t = callbacks.getCurrentTime?.() ?? 0;
    playheadOverlay.style.left = timeToX(t, w) + 'px';
  }

  function renderCacheStrip() {
    const w = trackArea.clientWidth;
    if (w <= 0) return;
    const cssH = 4;
    const dpr = window.devicePixelRatio || 1;
    cacheStrip.style.width = w + 'px';
    cacheStrip.style.height = cssH + 'px';
    cacheStrip.width = Math.max(1, Math.floor(w * dpr));
    cacheStrip.height = Math.max(1, Math.floor(cssH * dpr));
    const cctx = cacheStrip.getContext('2d');
    cctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    cctx.clearRect(0, 0, w, cssH);
    if (!_cacheState?.frames?.length || !_cacheState.fps) return;
    cctx.fillStyle = '#4caf50';
    const { frames, fps } = _cacheState;
    // Coalesce runs of cached frames into a single rect — paint is per-pixel
    // anyway, so emit one fillRect per contiguous segment instead of per-frame.
    let segStart = -1;
    for (let i = 0; i <= frames.length; i++) {
      const cached = i < frames.length && !!frames[i];
      if (cached && segStart < 0) segStart = i;
      if (!cached && segStart >= 0) {
        const x0 = timeToX(segStart / fps, w);
        const x1 = timeToX(i / fps, w);
        cctx.fillRect(x0, 0, Math.max(1, x1 - x0), cssH);
        segStart = -1;
      }
    }
  }

  /**
   * Set the cache state used to draw the green indicator strip.
   * Pass `null` to clear. Repaints are coalesced via rAF so progressive
   * onCacheUpdate callbacks during render don't thrash the DOM.
   */
  function updateFrameCacheIndicator(cache) {
    _cacheState = cache;
    if (_cacheRedrawScheduled) return;
    _cacheRedrawScheduled = true;
    requestAnimationFrame(() => {
      _cacheRedrawScheduled = false;
      renderCacheStrip();
    });
  }

  function render() {
    renderRuler();
    renderLabels();
    renderRows();
    renderPlayhead();
    renderCacheStrip();
  }

  // Seek by clicking ruler (the only area from which the playhead can be scrubbed).
  ruler.addEventListener('mousedown', (e) => {
    if (clearSelection()) renderRows();
    const rect = ruler.getBoundingClientRect();
    const t = xToTime(e.clientX - rect.left, rect.width);
    callbacks.onSeek?.(Math.max(0, Math.min(animation.duration, t)));

    const onMove = (ev) => {
      const t2 = xToTime(ev.clientX - rect.left, rect.width);
      callbacks.onSeek?.(Math.max(0, Math.min(animation.duration, t2)));
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });

  const resizeObserver = new ResizeObserver(() => render());
  resizeObserver.observe(trackArea);

  // Arrow keys move the selected keyframe by 1 frame (Shift: 10 frames).
  function onKeyDown(e) {
    if (!selectedKf) return;
    if (e.code !== 'ArrowLeft' && e.code !== 'ArrowRight') return;
    const t = e.target;
    const tag = t?.tagName;
    const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t?.isContentEditable;
    if (typing) return;

    const track = animation.tracks[selectedKf.key];
    if (!track) return;
    const found = findKeyframeAt(track, selectedKf.time);
    if (!found) return;

    e.preventDefault();
    const fps = animation.fps || 30;
    const step = (e.shiftKey ? 10 : 1) / fps;
    const dir = e.code === 'ArrowLeft' ? -1 : 1;
    const newT = Math.max(0, Math.min(animation.duration, selectedKf.time + dir * step));
    setKeyframeTime(track, found.index, newT);
    clampTrackHandles(track);
    selectedKf = { key: selectedKf.key, time: newT };
    callbacks.onChange?.();
    render();
  }
  document.addEventListener('keydown', onKeyDown);

  return {
    el,
    render,
    renderPlayhead,
    updateFrameCacheIndicator,
    destroy() {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('click', onDocClick);
      ctxMenu.remove();
      resizeObserver.disconnect();
    },
  };
}
