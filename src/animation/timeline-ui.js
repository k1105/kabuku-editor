import { ANIMATED_PARAM_KEYS } from '../core/project.js';
import { EASING_NAMES, EASING_TO_BEZIER, sampleBezierSegment } from './interpolation.js';
import { removeKeyframe, setKeyframeTime, findKeyframeAt, ensureBezierHandles, clampTrackHandles, collectKeyframeTimes } from './animation.js';
import { remapCharKerning } from '../compose/char-kerning.js';

const ROW_HEIGHT = 22;
const ROW_HEIGHT_EXPANDED = 90;
const LABEL_WIDTH = 140;
// Height (px) of the guide-audio waveform lane shown between the ruler and the
// rows. Zero-height (hidden) when no audio is loaded.
const WAVEFORM_HEIGHT = 56;
const KEYFRAME_RADIUS = 5;
const SELECT_EPSILON = 1e-4;
const CURVE_VERT_PAD = 10;
// Bezier segments are flattened into this many line pieces when drawing.
const CURVE_SEGMENTS = 24;
// Double-click window (ms) for toggling a keyframe's handle mode. Detected
// manually from mousedown timestamps because render() re-creates the dot
// between clicks, which would defeat the native dblclick event.
const DBLCLICK_MS = 300;
// Smallest allowed composition duration (s) when dragging the end handle in.
const MIN_DURATION = 0.5;
// Tail (s) left after the last keyframe / audio end when fitting the duration to
// content via a double-click on the end handle.
const FIT_TAIL = 0.5;
// Zoom limits, in pixels per second. The max is kept modest (frame-level
// editing needs only a few hundred px/s at 30fps) so the content — and the
// per-row curve / waveform canvases drawn at its full width — stay well under
// the browser's ~32767px canvas size limit for typical comp durations.
const MIN_PPS = 2;
const MAX_PPS = 800;
// Synthetic row key for the step-keyframed text track. It is NOT a numeric
// `animation.tracks` entry — text keyframes live in `animation.textTrack` as
// `{ time, value:string }` and hold (no interpolation), so this row is rendered
// specially and excluded from all curve / value-range / multi-select logic.
const TEXT_KEY = '__text__';

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

  // Current keyframe selection: array of { key: string, time: number }.
  // Persists across re-renders; each matching dot gets `.selected` class.
  // A single-element selection enables the per-keyframe affordances (bezier
  // handles, value drag); a multi-element selection (built by rubber-band) only
  // supports group time-shift and delete.
  let selectedKfs = [];

  // The lone selection when exactly one keyframe is selected, else null.
  function singleSelection() {
    return selectedKfs.length === 1 ? selectedKfs[0] : null;
  }

  // Last keyframe mousedown, for manual double-click detection.
  // { key, time, at }.
  let lastClick = null;

  // Set of param keys whose row is expanded into the curve-graph view.
  // Clicking a label toggles membership.
  const expandedRows = new Set();

  // --- Horizontal zoom + scroll (AE-style: time→pixels is governed by a zoom
  // factor, NOT by the total duration). `pxPerSecond === null` means "fit": the
  // whole duration is scaled to fill the viewport (the original behaviour). Once
  // the user zooms — or the duration auto-grows past the viewport — this holds a
  // concrete px/sec so extending the duration widens the (scrollable) content
  // instead of squishing every keyframe. Horizontal scroll is native, owned by
  // the `.anim-timeline-tracks` element (see CSS); we only read/set scrollLeft.
  let pxPerSecond = null;

  /** Visible width of the track viewport (excludes labels). */
  function viewportW() {
    return Math.max(1, trackArea.clientWidth);
  }
  /** px/sec that makes the whole duration exactly fill the viewport. */
  function fitPps() {
    return viewportW() / Math.max(0.001, animation.duration);
  }
  /** Effective px/sec — the fit value while in auto ("fit") mode. */
  function pps() {
    return pxPerSecond != null ? pxPerSecond : fitPps();
  }
  /**
   * Pixel width of the full timeline content. In fit mode this equals the
   * viewport (no horizontal scroll); when zoomed it is duration×pps, clamped to
   * be at least the viewport so a short comp never leaves a dead gap.
   */
  function contentW() {
    // Fit mode fills the viewport exactly (no horizontal scroll, original
    // behaviour). Float rounding on duration×fitPps could otherwise overflow by
    // a pixel and flicker a scrollbar.
    if (pxPerSecond == null) return viewportW();
    return Math.max(viewportW(), Math.ceil(animation.duration * pxPerSecond));
  }

  /**
   * Set the zoom to `newPps` px/sec (or back to fit when null), keeping the time
   * currently under viewport-x `anchorX` pinned in place. Re-renders and adjusts
   * scrollLeft so the zoom feels anchored at the cursor rather than the origin.
   */
  function setZoom(newPps, anchorX) {
    const ax = anchorX != null ? anchorX : viewportW() / 2;
    const timeAtAnchor = (trackArea.scrollLeft + ax) / pps();
    pxPerSecond = newPps == null ? null : Math.max(MIN_PPS, Math.min(MAX_PPS, newPps));
    render();
    if (pxPerSecond != null) {
      trackArea.scrollLeft = Math.max(0, timeAtAnchor * pps() - ax);
      positionPlayhead(); // keep the anchor; don't re-scroll to follow
    }
  }
  function zoomBy(factor, anchorX) {
    setZoom(pps() * factor, anchorX);
  }

  // --- BPM beat guide -------------------------------------------------------
  // When `animation.bpm` is set, a beat/bar grid is drawn over the ruler, the
  // waveform lane and the rows, and time edits snap to the grid instead of to
  // whole frames. Alt while dragging bypasses the beat snap.

  /** Beat grid derived from the animation's bpm settings, or null (guide off). */
  function beatGrid() {
    const bpm = animation.bpm;
    if (!(bpm > 0)) return null;
    return {
      spb: 60 / bpm, // seconds per beat
      offset: animation.beatOffset || 0,
      perBar: Math.max(1, Math.round(animation.beatsPerBar || 4)),
    };
  }

  /** Active beat-snap step in seconds, or null (guide off / snap toggled off). */
  function beatSnapStep() {
    const g = beatGrid();
    if (!g || animation.beatSnap === false) return null;
    return g.spb * (animation.beatSnapDiv || 1);
  }

  /**
   * Snap an absolute time: to the beat grid when it is active (and not
   * bypassed via Alt), otherwise to whole frames — the pre-BPM behaviour.
   */
  function snapTime(rawT, bypassBeat) {
    if (!bypassBeat) {
      const step = beatSnapStep();
      if (step) {
        const g = beatGrid();
        return g.offset + Math.round((rawT - g.offset) / step) * step;
      }
    }
    const fps = animation.fps || 30;
    return Math.round(rawT * fps) / fps;
  }

  /** Snap a time delta (group drag) to the beat step, else to whole frames. */
  function snapDelta(delta, bypassBeat) {
    const step = (!bypassBeat && beatSnapStep()) || 1 / (animation.fps || 30);
    return Math.round(delta / step) * step;
  }

  /**
   * Draw vertical beat/bar guide lines onto a 2d context whose x-axis is
   * content space (used by the beat-grid canvas behind the rows and by the
   * waveform lane). Density guards: beats disappear first as the zoom gets
   * tight, then bars.
   */
  function drawBeatLines(c, h) {
    const g = beatGrid();
    if (!g) return;
    const spbPx = g.spb * pps();
    const showBeats = spbPx >= 5;
    if (!showBeats && spbPx * g.perBar < 4) return;
    c.save();
    c.lineWidth = 1;
    const startI = Math.ceil((0 - g.offset) / g.spb - 1e-6);
    for (let i = startI; ; i++) {
      const t = g.offset + i * g.spb;
      if (t > animation.duration + 1e-6) break;
      const isBar = ((i % g.perBar) + g.perBar) % g.perBar === 0;
      if (!isBar && !showBeats) continue;
      const x = Math.round(timeToX(t)) + 0.5;
      c.strokeStyle = isBar ? 'rgba(255,204,0,0.22)' : 'rgba(255,255,255,0.07)';
      c.beginPath();
      c.moveTo(x, 0);
      c.lineTo(x, h);
      c.stroke();
    }
    c.restore();
  }

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
    // The text row (when it has keyframes) sits at the very top — it's the
    // coarsest, most structural parameter.
    if ((animation.textTrack || []).length > 0) keys.push(TEXT_KEY);
    for (const k of ANIMATED_PARAM_KEYS) {
      if (tracks[k] && tracks[k].length > 0) { keys.push(k); seen.add(k); }
    }
    const rest = Object.keys(tracks)
      .filter(k => !seen.has(k) && tracks[k] && tracks[k].length > 0)
      .sort();
    return [...keys, ...rest];
  }

  function rowHeight(key) {
    // The text row is never expandable (no curve), so it keeps the base height.
    if (key === TEXT_KEY) return ROW_HEIGHT;
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
      selectedKfs = [{ key, time: kf.time }];

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
    return selectedKfs.some(s =>
      s.key === key && Math.abs(s.time - kf.time) < SELECT_EPSILON);
  }

  function clearSelection() {
    if (selectedKfs.length === 0) return false;
    selectedKfs = [];
    return true;
  }

  /**
   * Shift every selected keyframe in time by `delta` seconds, clamped so the
   * whole group stays within [0, duration] (preserving relative spacing).
   * Used by the arrow-key nudge; group drag uses an absolute-from-start variant.
   */
  function nudgeSelection(delta) {
    const items = [];
    let dMin = -Infinity, dMax = Infinity;
    for (const s of selectedKfs) {
      const track = animation.tracks[s.key];
      if (!track) continue;
      const found = findKeyframeAt(track, s.time);
      if (!found) continue;
      items.push({ key: s.key, track, kf: found.kf });
      dMin = Math.max(dMin, -found.kf.time);
      dMax = Math.min(dMax, animation.duration - found.kf.time);
    }
    if (items.length === 0) return;
    const d = Math.max(dMin, Math.min(dMax, delta));
    const tracks = new Set();
    for (const it of items) { it.kf.time += d; tracks.add(it.track); }
    for (const track of tracks) {
      track.sort((a, b) => a.time - b.time);
      clampTrackHandles(track);
    }
    selectedKfs = items.map(it => ({ key: it.key, time: it.kf.time }));
  }

  /**
   * Select every keyframe whose dot falls inside the rubber-band box, given in
   * rowsInner-local pixel coordinates. Dot positions are recomputed here the
   * same way renderRows() draws them (x from time, y from row layout + value).
   */
  function selectKeyframesInBox(left, top, right, bottom) {
    const w = contentW();
    if (w <= 0) { selectedKfs = []; return; }
    const { tops } = computeRowLayout();
    const sel = [];
    for (const key of activeKeys()) {
      // Text keyframes aren't part of the numeric multi-select model.
      if (key === TEXT_KEY) continue;
      const track = animation.tracks[key] || [];
      const isExpanded = expandedRows.has(key);
      const h = rowHeight(key);
      const rowTop = tops[key];
      let range = null;
      if (isExpanded) {
        ensureBezierHandles(track);
        range = computeValueRange(track, animation.baseValues?.[key]);
      }
      for (const kf of track) {
        const x = timeToX(kf.time, w);
        const yInRow = (isExpanded && range) ? valueToY(kf.value, range, h) : h / 2;
        const y = rowTop + yInRow;
        if (x >= left && x <= right && y >= top && y <= bottom) {
          sel.push({ key, time: kf.time });
        }
      }
    }
    selectedKfs = sel;
  }

  const header = document.createElement('div');
  header.className = 'anim-timeline-header';
  el.appendChild(header);

  // Horizontal-zoom controls. Fit returns to auto (whole comp fills the view);
  // − / + step the zoom anchored on the viewport centre. Ctrl/⌘+wheel over the
  // tracks zooms at the cursor, Shift+wheel scrolls horizontally (see below).
  const zoomCtl = document.createElement('div');
  zoomCtl.className = 'anim-timeline-zoom';
  const mkZoomBtn = (label, title, onClick) => {
    const b = document.createElement('button');
    b.className = 'anim-zoom-btn';
    b.textContent = label;
    b.title = title;
    b.addEventListener('click', onClick);
    zoomCtl.appendChild(b);
    return b;
  };
  mkZoomBtn('−', '縮小', () => zoomBy(1 / 1.4));
  mkZoomBtn('全体', '全体表示（フィット）', () => setZoom(null));
  mkZoomBtn('＋', '拡大', () => zoomBy(1.4));
  mkZoomBtn('尺合わせ', '尺を内容に合わせる', () => fitDurationToContent());

  // BPM guide controls: bpm / bar-1 offset / snap unit / snap toggle. Settings
  // live on the animation object so they persist with the project. They are
  // guide-only (no effect on rendered frames), hence onGuideChange — a persist
  // that must NOT invalidate the frame cache.
  const bpmCtl = document.createElement('div');
  bpmCtl.className = 'anim-timeline-bpm';
  const mkBpmLbl = (text) => {
    const s = document.createElement('span');
    s.className = 'anim-bpm-lbl';
    s.textContent = text;
    return s;
  };

  bpmCtl.appendChild(mkBpmLbl('BPM'));
  const bpmInput = document.createElement('input');
  bpmInput.type = 'number';
  bpmInput.min = '1';
  bpmInput.max = '999';
  bpmInput.step = '0.1';
  bpmInput.className = 'anim-bpm-input';
  bpmInput.placeholder = '—';
  bpmInput.title = 'BPM（空欄でビートガイドをオフ）';
  bpmInput.addEventListener('change', () => {
    const v = parseFloat(bpmInput.value);
    animation.bpm = Number.isFinite(v) && v > 0 ? v : null;
    callbacks.onGuideChange?.();
    render();
  });
  bpmCtl.appendChild(bpmInput);

  bpmCtl.appendChild(mkBpmLbl('頭'));
  const beatOffsetInput = document.createElement('input');
  beatOffsetInput.type = 'number';
  beatOffsetInput.step = '0.01';
  beatOffsetInput.className = 'anim-bpm-offset';
  beatOffsetInput.title = '1小節1拍目の位置（秒）';
  beatOffsetInput.addEventListener('change', () => {
    const v = parseFloat(beatOffsetInput.value);
    animation.beatOffset = Number.isFinite(v) ? v : 0;
    callbacks.onGuideChange?.();
    render();
  });
  bpmCtl.appendChild(beatOffsetInput);

  const beatOffsetHereBtn = document.createElement('button');
  beatOffsetHereBtn.className = 'anim-zoom-btn';
  beatOffsetHereBtn.textContent = '頭=現在';
  beatOffsetHereBtn.title = '再生ヘッドの位置を1小節1拍目にする';
  beatOffsetHereBtn.addEventListener('click', () => {
    animation.beatOffset = Math.round((callbacks.getCurrentTime?.() ?? 0) * 1000) / 1000;
    callbacks.onGuideChange?.();
    render();
  });
  bpmCtl.appendChild(beatOffsetHereBtn);

  const beatSnapSel = document.createElement('select');
  beatSnapSel.className = 'anim-bpm-snap';
  beatSnapSel.title = 'スナップ単位';
  for (const [val, label] of [['4', '1小節'], ['1', '1拍'], ['0.5', '1/2拍'], ['0.25', '1/4拍']]) {
    const opt = document.createElement('option');
    opt.value = val;
    opt.textContent = label;
    beatSnapSel.appendChild(opt);
  }
  beatSnapSel.addEventListener('change', () => {
    animation.beatSnapDiv = parseFloat(beatSnapSel.value) || 1;
    callbacks.onGuideChange?.();
  });
  bpmCtl.appendChild(beatSnapSel);

  const beatSnapBtn = document.createElement('button');
  beatSnapBtn.className = 'anim-zoom-btn anim-bpm-snapbtn';
  beatSnapBtn.textContent = 'スナップ';
  beatSnapBtn.title = 'ビートスナップの ON/OFF（ドラッグ中は Alt で一時解除）';
  beatSnapBtn.addEventListener('click', () => {
    animation.beatSnap = animation.beatSnap === false;
    syncBpmCtl();
    callbacks.onGuideChange?.();
  });
  bpmCtl.appendChild(beatSnapBtn);

  /** Reflect the animation's beat-guide state into the header controls.
   *  Inputs being edited are left alone so typing isn't clobbered. */
  function syncBpmCtl() {
    const g = beatGrid();
    if (document.activeElement !== bpmInput) {
      bpmInput.value = animation.bpm > 0 ? String(animation.bpm) : '';
    }
    if (document.activeElement !== beatOffsetInput) {
      beatOffsetInput.value = String(animation.beatOffset || 0);
    }
    beatSnapSel.value = String(animation.beatSnapDiv || 1);
    beatSnapBtn.classList.toggle('active', !!g && animation.beatSnap !== false);
    beatOffsetInput.disabled = !g;
    beatOffsetHereBtn.disabled = !g;
    beatSnapSel.disabled = !g;
    beatSnapBtn.disabled = !g;
  }

  header.appendChild(bpmCtl);
  header.appendChild(zoomCtl);

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
      if (key === TEXT_KEY) {
        const lbl = document.createElement('div');
        lbl.className = 'anim-timeline-label anim-timeline-label-text-row';
        lbl.style.height = rowHeight(key) + 'px';
        lbl.dataset.key = key;
        const text = document.createElement('span');
        text.className = 'anim-timeline-label-text';
        text.textContent = 'Text';
        lbl.appendChild(text);
        labelCol.appendChild(lbl);
        continue;
      }
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

  // End-of-composition handle, parented to the ruler and positioned at the
  // duration each render. Horizontal drag resizes the comp (snapped to frames,
  // floored at MIN_DURATION); double-click fits the duration to content.
  const durationHandle = document.createElement('div');
  durationHandle.className = 'anim-duration-handle';
  durationHandle.title = 'ドラッグで尺を変更 / ダブルクリックで内容に合わせる';
  durationHandle.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    e.stopPropagation(); // don't let the ruler seek
    const startX = e.clientX;
    const startDur = animation.duration;
    const onMove = (ev) => {
      const dt = xToTime(ev.clientX - startX);
      const snapped = snapTime(startDur + dt, ev.altKey);
      animation.duration = Math.max(MIN_DURATION, snapped);
      callbacks.onChange?.();
      render();
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      callbacks.onDurationChange?.(animation.duration);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
  durationHandle.addEventListener('dblclick', (e) => {
    e.stopPropagation();
    fitDurationToContent();
  });

  /**
   * Shrink/grow the composition duration to just past the last piece of content
   * (keyframes, text keyframes, and the guide-audio clip end), leaving FIT_TAIL
   * seconds of tail. Snapped to a whole frame. Floored at MIN_DURATION.
   */
  function fitDurationToContent() {
    const times = collectKeyframeTimes(animation);
    let last = times.length ? times[times.length - 1] : 0;
    const audio = animation.audio;
    if (audio && audio.duration > 0) {
      last = Math.max(last, (audio.offset || 0) + audio.duration);
    }
    const fps = animation.fps || 30;
    const fitted = Math.ceil((last + FIT_TAIL) * fps) / fps;
    animation.duration = Math.max(MIN_DURATION, fitted);
    callbacks.onChange?.();
    callbacks.onDurationChange?.(animation.duration);
    render();
  }

  /**
   * Auto-grow the composition when a keyframe is dragged past the current end —
   * the AE-hybrid behaviour: the comp end is not a hard wall, it yields. Returns
   * true when the duration changed (so callers can notify the page). The zoom is
   * untouched, so growing the duration widens the scrollable content rather than
   * rescaling existing keyframes.
   */
  function growDurationTo(time) {
    if (time <= animation.duration) return false;
    // Leaving fit mode (pinning the current px/sec) is what makes growth widen
    // the scrollable content instead of rescaling — in fit mode a larger
    // duration would just re-fit and squish everything mid-drag.
    if (pxPerSecond == null) pxPerSecond = fitPps();
    animation.duration = time;
    callbacks.onDurationChange?.(animation.duration);
    return true;
  }

  // Guide-audio waveform lane. Sits between the ruler and the rows; hidden
  // (zero height) until an audio clip is loaded. The clip is drawn over the
  // animation-timeline span [offset, offset+duration] and dragged horizontally
  // to change `animation.audio.offset`. A plain click seeks like the ruler.
  const waveformLane = document.createElement('div');
  waveformLane.className = 'anim-timeline-waveform';
  waveformLane.style.display = 'none';
  const waveformCanvas = document.createElement('canvas');
  waveformCanvas.className = 'anim-waveform-canvas';
  waveformLane.appendChild(waveformCanvas);
  const waveformLabel = document.createElement('span');
  waveformLabel.className = 'anim-waveform-label';
  waveformLane.appendChild(waveformLabel);
  trackArea.appendChild(waveformLane);

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

  // Time→pixel maps onto the full content width, so X = time × pps. All callers
  // work in content (not viewport) coordinates; native scroll on the track area
  // translates content under the viewport, and getBoundingClientRect()-relative
  // mouse math therefore already yields content-space X without manual offset.
  function timeToX(time) {
    return time * pps();
  }
  function xToTime(x) {
    return x / pps();
  }

  function renderRuler() {
    ruler.innerHTML = '';
    const w = contentW();
    if (w <= 0) return;
    ruler.style.width = w + 'px';
    const dur = animation.duration;
    // Pick a tick interval that keeps labels ~70px apart at the current zoom, so
    // ruler density follows pps rather than the total duration. Snap to a 1-2-5
    // sequence of seconds (or 0.1-0.2-0.5 when zoomed in tight).
    const targetPx = 70;
    const rawStep = targetPx / pps();
    const niceSteps = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 30, 60, 120, 300];
    let step = niceSteps[niceSteps.length - 1];
    for (const s of niceSteps) { if (s >= rawStep) { step = s; break; } }
    const decimals = step < 1 ? (step < 0.5 ? 1 : 1) : 0;
    for (let t = 0; t <= dur + 1e-6; t += step) {
      const tick = document.createElement('div');
      tick.className = 'anim-timeline-tick';
      tick.style.left = timeToX(t) + 'px';
      const label = document.createElement('span');
      label.textContent = t.toFixed(decimals) + 's';
      tick.appendChild(label);
      ruler.appendChild(tick);
    }
    // Beat/bar tick marks (bottom-aligned so the seconds labels stay legible).
    // Bar ticks carry the bar number once there's room for it; beat ticks
    // appear only when beats are at least a few pixels apart.
    const g = beatGrid();
    if (g) {
      const spbPx = g.spb * pps();
      const barPx = spbPx * g.perBar;
      const showBeats = spbPx >= 5;
      const labelBars = barPx >= 26;
      if (showBeats || barPx >= 4) {
        const startI = Math.ceil((0 - g.offset) / g.spb - 1e-6);
        for (let i = startI; ; i++) {
          const t = g.offset + i * g.spb;
          if (t > dur + 1e-6) break;
          const isBar = ((i % g.perBar) + g.perBar) % g.perBar === 0;
          if (!isBar && !showBeats) continue;
          const tick = document.createElement('div');
          tick.className = 'anim-beat-tick' + (isBar ? ' bar' : '');
          tick.style.left = timeToX(t) + 'px';
          if (isBar && labelBars) {
            const lbl = document.createElement('span');
            lbl.textContent = String(Math.floor(i / g.perBar) + 1);
            tick.appendChild(lbl);
          }
          ruler.appendChild(tick);
        }
      }
    }
    // End-of-composition handle: a draggable marker at the duration. Dragging
    // resizes the comp (auto-grow / trim); double-click fits it to content.
    ruler.appendChild(durationHandle);
    durationHandle.style.left = timeToX(dur) + 'px';
  }

  /** Clamp the context menu inside the viewport, then show it at (x, y). */
  function positionCtxMenu(x, y) {
    ctxMenu.style.display = '';
    const margin = 8;
    const rect = ctxMenu.getBoundingClientRect();
    let left = x, top = y;
    if (left + rect.width > window.innerWidth - margin) {
      left = Math.max(margin, window.innerWidth - rect.width - margin);
    }
    if (top + rect.height > window.innerHeight - margin) {
      top = Math.max(margin, window.innerHeight - rect.height - margin);
    }
    ctxMenu.style.left = left + 'px';
    ctxMenu.style.top = top + 'px';
  }

  /** Prompt-edit a text keyframe's string value (secondary path; the primary
   *  editor is the sidebar Text field). */
  function editTextKeyframe(kf) {
    const v = window.prompt(`Text @ ${kf.time.toFixed(2)}s`, kf.value);
    if (v == null) return; // cancelled
    // Keep this keyframe's per-character kerning glued to its characters.
    kf.charKerning = remapCharKerning(kf.value, v, kf.charKerning);
    kf.value = v;
    callbacks.onChange?.();
    render();
  }

  function showTextCtxMenu(x, y, kf) {
    ctxMenu.innerHTML = '';
    const head = document.createElement('div');
    head.className = 'anim-ctx-header';
    head.textContent = `Text @ ${kf.time.toFixed(2)}s`;
    ctxMenu.appendChild(head);

    const editBtn = document.createElement('button');
    editBtn.textContent = 'Edit Text…';
    editBtn.className = 'anim-ctx-edit';
    editBtn.addEventListener('click', () => { hideCtxMenu(); editTextKeyframe(kf); });
    ctxMenu.appendChild(editBtn);

    const delBtn = document.createElement('button');
    delBtn.textContent = 'Delete Keyframe';
    delBtn.className = 'anim-ctx-del';
    delBtn.addEventListener('click', () => {
      const tr = animation.textTrack || [];
      const idx = tr.indexOf(kf);
      if (idx >= 0) tr.splice(idx, 1);
      callbacks.onChange?.();
      render();
      hideCtxMenu();
    });
    ctxMenu.appendChild(delBtn);

    positionCtxMenu(x, y);
  }

  /**
   * Render the step-keyframed text row: one square dot per text keyframe with
   * a value label. Click seeks, drag re-times (snapped to fps), double-click or
   * right-click edits / deletes. Text keyframes are NOT interpolated and never
   * join the numeric multi-select model.
   */
  function renderTextDots(row, w, h) {
    const tr = animation.textTrack || [];
    for (const kf of tr) {
      const dot = document.createElement('div');
      dot.className = 'anim-keyframe anim-text-keyframe';
      dot.style.left = timeToX(kf.time, w) + 'px';
      dot.style.top = (h / 2) + 'px';
      dot.title = kf.value;

      const lbl = document.createElement('span');
      lbl.className = 'anim-text-kf-label';
      lbl.textContent = kf.value;
      dot.appendChild(lbl);

      dot.addEventListener('mousedown', (e) => {
        e.stopPropagation();
        if (e.button !== 0) return;
        const now = performance.now();
        const isDouble = lastClick && lastClick.key === TEXT_KEY
          && Math.abs(lastClick.time - kf.time) < SELECT_EPSILON
          && (now - lastClick.at) < DBLCLICK_MS;
        if (isDouble) { lastClick = null; editTextKeyframe(kf); return; }
        lastClick = { key: TEXT_KEY, time: kf.time, at: now };

        const rect = row.getBoundingClientRect();
        const trackWidth = rect.width;
        const startX = e.clientX;
        const startTime = kf.time;
        let moved = false;

        const onMove = (ev) => {
          if (trackWidth <= 0) return;
          const dx = ev.clientX - startX;
          if (Math.abs(dx) > 2) moved = true;
          if (!moved) return;
          const rawT = startTime + xToTime(dx);
          const t = Math.max(0, snapTime(rawT, ev.altKey));
          growDurationTo(t);
          kf.time = t;
          (animation.textTrack || []).sort((a, b) => a.time - b.time);
          callbacks.onChange?.();
          render();
        };
        const onUp = () => {
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
          // A plain click (no drag) seeks the playhead to this keyframe so the
          // sidebar Text field reflects its value.
          if (!moved) callbacks.onSeek?.(kf.time);
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      });

      dot.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        showTextCtxMenu(e.clientX, e.clientY, kf);
      });

      row.appendChild(dot);
    }
  }

  function renderRows() {
    rowsInner.innerHTML = '';
    const w = contentW();
    if (w <= 0) return;
    rowsInner.style.width = w + 'px';

    const { tops, total } = computeRowLayout();
    rowsInner.style.height = total + 'px';

    // Beat-grid backdrop: appended first so the rows (and their keyframes)
    // stack above it; pointer-events:none keeps all interaction intact.
    if (beatGrid() && total > 0) {
      const bc = document.createElement('canvas');
      bc.className = 'anim-beatgrid-canvas';
      const dpr = window.devicePixelRatio || 1;
      bc.style.width = w + 'px';
      bc.style.height = total + 'px';
      bc.width = Math.max(1, Math.floor(w * dpr));
      bc.height = Math.max(1, Math.floor(total * dpr));
      const c = bc.getContext('2d');
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawBeatLines(c, total);
      rowsInner.appendChild(bc);
    }

    for (const key of activeKeys()) {
      if (key === TEXT_KEY) {
        const h = rowHeight(key);
        const row = document.createElement('div');
        row.className = 'anim-timeline-row anim-timeline-row-text';
        row.style.top = tops[key] + 'px';
        row.style.height = h + 'px';
        row.dataset.key = key;
        renderTextDots(row, w, h);
        rowsInner.appendChild(row);
        continue;
      }
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
              selectedKfs = [{ key, time: kf.time }];
              callbacks.onChange?.();
              render();
            }
            return;
          }
          lastClick = { key, time: kf.time, at: now };

          // Group drag: if this dot is part of a multi-keyframe selection, move
          // the whole group by a shared time delta (preserving relative spacing).
          // Value is left untouched — the group may span rows with different
          // value ranges, so only the time axis has a shared meaning.
          const inGroup = selectedKfs.length > 1 && isDotSelected(key, kf);
          if (inGroup) {
            const rect = row.getBoundingClientRect();
            const trackWidth = rect.width;
            const startX = e.clientX;
            const dur = animation.duration;
            const items = selectedKfs.map((s) => {
              const track2 = animation.tracks[s.key];
              const f = track2 ? findKeyframeAt(track2, s.time) : null;
              return f ? { key: s.key, track: track2, kf: f.kf, startTime: f.kf.time } : null;
            }).filter(Boolean);
            let minStart = Infinity, maxStart = -Infinity;
            for (const it of items) {
              minStart = Math.min(minStart, it.startTime);
              maxStart = Math.max(maxStart, it.startTime);
            }
            const dtMin = -minStart;
            const dtMax = dur - maxStart;
            const onMoveG = (ev) => {
              if (trackWidth <= 0) return;
              const dx = ev.clientX - startX;
              let delta = (dx / trackWidth) * dur;
              delta = snapDelta(delta, ev.altKey);
              delta = Math.max(dtMin, Math.min(dtMax, delta));
              const tracks = new Set();
              for (const it of items) { it.kf.time = it.startTime + delta; tracks.add(it.track); }
              for (const track2 of tracks) {
                track2.sort((a, b) => a.time - b.time);
                clampTrackHandles(track2);
              }
              selectedKfs = items.map(it => ({ key: it.key, time: it.kf.time }));
              callbacks.onChange?.();
              render();
            };
            const onUpG = () => {
              document.removeEventListener('mousemove', onMoveG);
              document.removeEventListener('mouseup', onUpG);
            };
            document.addEventListener('mousemove', onMoveG);
            document.addEventListener('mouseup', onUpG);
            return;
          }
          // Cache row geometry NOW — render() below detaches `row`, after which
          // row.getBoundingClientRect() returns zeros and would snap the
          // keyframe to garbage coordinates.
          const rect = row.getBoundingClientRect();
          const trackWidth = rect.width;
          const trackHeight = rect.height;
          const startValueRange = valueRange; // frozen at drag start
          selectedKfs = [{ key, time: kf.time }];
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
              const rawT = dragStartTime + xToTime(dx);
              newT = Math.max(0, snapTime(rawT, ev.altKey));
              growDurationTo(newT); // comp end yields instead of clamping
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
            selectedKfs = [{ key, time: newT }];
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
        if (isExpanded && valueRange && selectedKfs.length === 1 && isDotSelected(key, kf)) {
          drawHandleLines(curveCanvas, w, h, track, j, valueRange);
          if (j > 0) addHandleDot(row, key, track, j, 'in', w, h, valueRange);
          if (j < track.length - 1) addHandleDot(row, key, track, j, 'out', w, h, valueRange);
        }
      }

      rowsInner.appendChild(row);
    }
  }

  /** Position the playhead only (no scroll). Used by internal render() so an
   *  edit far from the playhead never yanks the view back to it. */
  function positionPlayhead() {
    if (contentW() <= 0) return;
    const t = callbacks.getCurrentTime?.() ?? 0;
    playheadOverlay.style.left = timeToX(t) + 'px';
  }

  /**
   * Public playhead update — repositions and, when zoomed in, scrolls to keep
   * the playhead visible. Called by the page on each playback tick and on seek,
   * so following happens during playback/scrubbing but not during arbitrary
   * re-renders. Only nudges at the viewport edges, so scrubbing inside the
   * visible span doesn't fight the user's manual scroll.
   */
  function renderPlayhead() {
    if (contentW() <= 0) return;
    const t = callbacks.getCurrentTime?.() ?? 0;
    const x = timeToX(t);
    playheadOverlay.style.left = x + 'px';
    const vw = viewportW();
    const sl = trackArea.scrollLeft;
    const margin = 24;
    if (x < sl + margin) trackArea.scrollLeft = Math.max(0, x - margin);
    else if (x > sl + vw - margin) trackArea.scrollLeft = x - vw + margin;
  }

  /**
   * Draw the guide-audio waveform clip. The clip occupies the animation
   * timeline span [offset, offset+duration]; peaks are a downsampled abs-peak
   * array (see audio-track.js). Hidden when no audio is loaded.
   */
  function renderWaveform() {
    const audio = animation.audio;
    if (!audio || !audio.peaks?.length || !(audio.duration > 0)) {
      waveformLane.style.display = 'none';
      return;
    }
    waveformLane.style.display = '';
    waveformLane.style.height = WAVEFORM_HEIGHT + 'px';
    waveformLabel.textContent = audio.name || 'audio';

    const w = contentW();
    const h = WAVEFORM_HEIGHT;
    if (w <= 0) return;
    waveformLane.style.width = w + 'px';
    const dpr = window.devicePixelRatio || 1;
    waveformCanvas.style.width = w + 'px';
    waveformCanvas.style.height = h + 'px';
    waveformCanvas.width = Math.max(1, Math.floor(w * dpr));
    waveformCanvas.height = Math.max(1, Math.floor(h * dpr));
    const c = waveformCanvas.getContext('2d');
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, w, h);

    const offset = audio.offset || 0;
    const startX = timeToX(offset, w);
    const endX = timeToX(offset + audio.duration, w);
    const clipW = endX - startX;
    if (clipW <= 0) return;

    // Clip background band so the song's placement on the timeline is obvious.
    c.fillStyle = 'rgba(74,158,255,0.10)';
    c.fillRect(startX, 0, clipW, h);

    // Beat guide behind the peaks — the main aid for aligning beatOffset (and
    // the clip itself) with the music.
    drawBeatLines(c, h);

    const peaks = audio.peaks;
    const n = peaks.length;
    const mid = h / 2;
    c.strokeStyle = 'rgba(74,158,255,0.9)';
    c.lineWidth = 1;
    c.beginPath();
    // One vertical line per on-screen pixel column inside the clip. Take the MAX
    // peak over every bucket that maps into the column's width — when the clip
    // holds more buckets than pixels, this keeps transients visible instead of
    // skipping the buckets between nearest-samples (which looked low-res).
    const x0 = Math.max(0, Math.floor(startX));
    const x1 = Math.min(w, Math.ceil(endX));
    for (let x = x0; x <= x1; x++) {
      const f0 = (x - startX) / clipW;
      const f1 = (x + 1 - startX) / clipW;
      if (f1 < 0 || f0 > 1) continue;
      let i0 = Math.floor(Math.max(0, f0) * n);
      let i1 = Math.ceil(Math.min(1, f1) * n);
      if (i1 <= i0) i1 = i0 + 1;
      let peak = 0;
      for (let i = i0; i < i1 && i < n; i++) {
        if (peaks[i] > peak) peak = peaks[i];
      }
      const amp = peak * (mid - 2);
      c.moveTo(x + 0.5, mid - amp);
      c.lineTo(x + 0.5, mid + amp);
    }
    c.stroke();
  }

  function renderCacheStrip() {
    const w = contentW();
    if (w <= 0) return;
    // Keep the cache strip pinned to the top of the rows, below the waveform
    // lane when one is shown (its height varies with audio presence).
    cacheStrip.style.top = rowsInner.offsetTop + 'px';
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
    syncBpmCtl();
    renderRuler();
    renderLabels();
    renderWaveform();
    renderRows();
    // Keep the label column's top padding aligned with the rows. The rows are
    // pushed down by the ruler plus the (variable-height) waveform lane, so a
    // static CSS padding-top would misalign labels against their keyframe rows
    // whenever a guide-audio clip is loaded.
    labelCol.style.paddingTop = rowsInner.offsetTop + 'px';
    positionPlayhead();
    renderCacheStrip();
  }

  // Waveform lane interaction: horizontal drag re-times the audio clip
  // (animation.audio.offset); a plain click seeks the playhead like the ruler.
  waveformLane.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    const audio = animation.audio;
    if (!audio) return;
    const rect = waveformLane.getBoundingClientRect();
    const w = rect.width;
    if (w <= 0) return;
    const startX = e.clientX;
    const startOffset = audio.offset || 0;
    const fps = animation.fps || 30;
    let moved = false;

    const onMove = (ev) => {
      const dx = ev.clientX - startX;
      if (Math.abs(dx) > 2) moved = true;
      if (!moved) return;
      const deltaT = (dx / w) * animation.duration;
      // Snap to whole frames so the clip lands on frame boundaries.
      audio.offset = Math.round((startOffset + deltaT) * fps) / fps;
      renderWaveform();
    };
    const onUp = (ev) => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      if (moved) {
        callbacks.onAudioOffsetChange?.(audio.offset);
      } else {
        const t = xToTime(ev.clientX - rect.left, w);
        callbacks.onSeek?.(Math.max(0, Math.min(animation.duration, t)));
      }
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });

  // Seek by clicking ruler (the only area from which the playhead can be scrubbed).
  // With the beat guide active the playhead snaps to the beat grid (Alt for a
  // free scrub); without it seeking stays continuous as before.
  ruler.addEventListener('mousedown', (e) => {
    if (clearSelection()) renderRows();
    const rect = ruler.getBoundingClientRect();
    const seekAt = (clientX, alt) => {
      let t = xToTime(clientX - rect.left);
      const step = alt ? null : beatSnapStep();
      if (step) {
        const g = beatGrid();
        t = g.offset + Math.round((t - g.offset) / step) * step;
      }
      callbacks.onSeek?.(Math.max(0, Math.min(animation.duration, t)));
    };
    seekAt(e.clientX, e.altKey);

    const onMove = (ev) => {
      seekAt(ev.clientX, ev.altKey);
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });

  // Rubber-band multi-selection: drag over the empty track area to box-select
  // keyframes. Keyframe/handle dots stopPropagation on their own mousedown, so
  // a mousedown reaching rowsInner is always on bare background.
  rowsInner.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    const rect = rowsInner.getBoundingClientRect();
    const x0 = e.clientX - rect.left;
    const y0 = e.clientY - rect.top;
    const box = document.createElement('div');
    box.className = 'anim-select-box';
    rowsInner.appendChild(box);
    let didMove = false;

    const onMove = (ev) => {
      const x1 = ev.clientX - rect.left;
      const y1 = ev.clientY - rect.top;
      if (Math.abs(x1 - x0) > 2 || Math.abs(y1 - y0) > 2) didMove = true;
      box.style.left = Math.min(x0, x1) + 'px';
      box.style.top = Math.min(y0, y1) + 'px';
      box.style.width = Math.abs(x1 - x0) + 'px';
      box.style.height = Math.abs(y1 - y0) + 'px';
    };
    const onUp = (ev) => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      box.remove();
      if (!didMove) {
        // Plain click on empty area clears the current selection.
        if (clearSelection()) renderRows();
        return;
      }
      const x1 = ev.clientX - rect.left;
      const y1 = ev.clientY - rect.top;
      selectKeyframesInBox(
        Math.min(x0, x1), Math.min(y0, y1),
        Math.max(x0, x1), Math.max(y0, y1),
      );
      renderRows();
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });

  // Wheel over the tracks: Ctrl/⌘ zooms anchored at the cursor; Shift turns
  // vertical wheel into horizontal scroll. Plain wheel falls through to the
  // rows' native vertical scroll. Re-fitting on plain resize is handled by the
  // observer below; an explicit zoom pins pxPerSecond so resize won't refit.
  trackArea.addEventListener('wheel', (e) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const ax = e.clientX - trackArea.getBoundingClientRect().left;
      zoomBy(e.deltaY < 0 ? 1.15 : 1 / 1.15, ax);
    } else if (e.shiftKey || e.deltaX !== 0) {
      const d = e.deltaX !== 0 ? e.deltaX : e.deltaY;
      if (contentW() > viewportW()) {
        trackArea.scrollLeft += d;
        e.preventDefault();
        // Manual scroll: the playhead rides along natively, so just reposition.
      }
    }
  }, { passive: false });

  const resizeObserver = new ResizeObserver(() => render());
  resizeObserver.observe(trackArea);

  function onKeyDown(e) {
    const t = e.target;
    const tag = t?.tagName;
    const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t?.isContentEditable;
    if (typing) return;
    if (selectedKfs.length === 0) return;

    // Delete / Backspace removes every selected keyframe.
    if (e.code === 'Delete' || e.code === 'Backspace') {
      e.preventDefault();
      // Group indices per track and splice in descending order so earlier
      // removals don't shift the indices still pending.
      const byTrack = new Map();
      for (const s of selectedKfs) {
        const track = animation.tracks[s.key];
        if (!track) continue;
        const found = findKeyframeAt(track, s.time);
        if (!found) continue;
        if (!byTrack.has(s.key)) byTrack.set(s.key, []);
        byTrack.get(s.key).push(found.index);
      }
      for (const [key, indices] of byTrack) {
        const track = animation.tracks[key];
        indices.sort((a, b) => b - a);
        for (const idx of indices) removeKeyframe(track, idx);
        clampTrackHandles(track);
      }
      selectedKfs = [];
      callbacks.onChange?.();
      render();
      return;
    }

    // Arrow keys nudge the whole selection by 1 frame (Shift: 10 frames).
    if (e.code !== 'ArrowLeft' && e.code !== 'ArrowRight') return;
    e.preventDefault();
    const fps = animation.fps || 30;
    const step = (e.shiftKey ? 10 : 1) / fps;
    const dir = e.code === 'ArrowLeft' ? -1 : 1;
    nudgeSelection(dir * step);
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
