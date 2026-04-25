import { ANIMATED_PARAM_KEYS } from '../core/project.js';
import { EASING_NAMES } from './interpolation.js';
import { removeKeyframe, setKeyframeTime, findKeyframeAt } from './animation.js';

const ROW_HEIGHT = 22;
const LABEL_WIDTH = 140;
const KEYFRAME_RADIUS = 5;
const SELECT_EPSILON = 1e-4;

/**
 * Create timeline UI.
 * @param {object} animation - the animation object (mutated by this component)
 * @param {object} callbacks - { onSeek(time), onChange(), getCurrentTime() }
 */
export function createTimelineUI(animation, callbacks) {
  const el = document.createElement('div');
  el.className = 'anim-timeline';

  // Current keyframe selection: { key: string, time: number } or null.
  // Persists across re-renders; matching dot gets `.selected` class.
  let selectedKf = null;

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

  // Build label column + track rows
  const labelCol = document.createElement('div');
  labelCol.className = 'anim-timeline-labels';
  labelCol.style.width = LABEL_WIDTH + 'px';
  for (const key of ANIMATED_PARAM_KEYS) {
    const lbl = document.createElement('div');
    lbl.className = 'anim-timeline-label';
    lbl.textContent = key;
    labelCol.appendChild(lbl);
  }
  rowsWrap.appendChild(labelCol);

  // Canvas area for tracks + playhead
  const trackArea = document.createElement('div');
  trackArea.className = 'anim-timeline-tracks';
  rowsWrap.appendChild(trackArea);

  // Ruler
  const ruler = document.createElement('div');
  ruler.className = 'anim-timeline-ruler';
  trackArea.appendChild(ruler);

  // Rows container (abs positioning inside)
  const rowsInner = document.createElement('div');
  rowsInner.className = 'anim-timeline-rows-inner';
  rowsInner.style.height = (ANIMATED_PARAM_KEYS.length * ROW_HEIGHT) + 'px';
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
  document.addEventListener('click', hideCtxMenu);

  function showCtxMenu(x, y, trackKey, kfIndex) {
    ctxMenu.innerHTML = '';
    const track = animation.tracks[trackKey];
    const kf = track[kfIndex];
    if (!kf) return;

    const header = document.createElement('div');
    header.className = 'anim-ctx-header';
    header.textContent = `${trackKey} @ ${kf.time.toFixed(2)}s`;
    ctxMenu.appendChild(header);

    const easingRow = document.createElement('div');
    easingRow.className = 'anim-ctx-row';
    const easeLbl = document.createElement('span');
    easeLbl.textContent = 'Easing:';
    const easeSel = document.createElement('select');
    for (const name of EASING_NAMES) {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      if (kf.easing === name) opt.selected = true;
      easeSel.appendChild(opt);
    }
    easeSel.addEventListener('change', () => {
      kf.easing = easeSel.value;
      callbacks.onChange?.();
      render();
    });
    easingRow.appendChild(easeLbl);
    easingRow.appendChild(easeSel);
    ctxMenu.appendChild(easingRow);

    const delBtn = document.createElement('button');
    delBtn.textContent = 'Delete Keyframe';
    delBtn.className = 'anim-ctx-del';
    delBtn.addEventListener('click', () => {
      removeKeyframe(track, kfIndex);
      callbacks.onChange?.();
      render();
      hideCtxMenu();
    });
    ctxMenu.appendChild(delBtn);

    ctxMenu.style.left = x + 'px';
    ctxMenu.style.top = y + 'px';
    ctxMenu.style.display = '';
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

    for (let i = 0; i < ANIMATED_PARAM_KEYS.length; i++) {
      const key = ANIMATED_PARAM_KEYS[i];
      const row = document.createElement('div');
      row.className = 'anim-timeline-row';
      row.style.top = (i * ROW_HEIGHT) + 'px';
      row.style.height = ROW_HEIGHT + 'px';
      row.dataset.key = key;

      const track = animation.tracks[key] || [];
      for (let j = 0; j < track.length; j++) {
        const kf = track[j];
        const dot = document.createElement('div');
        dot.className = 'anim-keyframe';
        if (isDotSelected(key, kf)) dot.classList.add('selected');
        dot.style.left = timeToX(kf.time, w) + 'px';

        let dragging = false;
        let dragStartX = 0;
        let dragStartTime = 0;
        let moved = false;
        let currentIndex = j;

        dot.addEventListener('mousedown', (e) => {
          e.stopPropagation();
          if (e.button !== 0) return;
          // Cache the track width NOW — render() below detaches `row`, after
          // which row.getBoundingClientRect() returns zeros and would cause
          // dx / 0 = Infinity, snapping the keyframe to the end.
          const trackWidth = row.getBoundingClientRect().width;
          selectedKf = { key, time: kf.time };
          dragging = true;
          moved = false;
          dragStartX = e.clientX;
          dragStartTime = kf.time;
          render();

          const onMove = (ev) => {
            if (!dragging || trackWidth <= 0) return;
            const dx = ev.clientX - dragStartX;
            if (Math.abs(dx) > 2) moved = true;
            const rawT = dragStartTime + (dx / trackWidth) * animation.duration;
            const fps = animation.fps || 30;
            const snapped = Math.round(rawT * fps) / fps;
            const newT = Math.max(0, Math.min(animation.duration, snapped));
            const idx = setKeyframeTime(track, currentIndex, newT);
            currentIndex = idx;
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

  function render() {
    renderRuler();
    renderRows();
    renderPlayhead();
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
    selectedKf = { key: selectedKf.key, time: newT };
    callbacks.onChange?.();
    render();
  }
  document.addEventListener('keydown', onKeyDown);

  return {
    el,
    render,
    renderPlayhead,
    destroy() {
      document.removeEventListener('keydown', onKeyDown);
      resizeObserver.disconnect();
    },
  };
}
