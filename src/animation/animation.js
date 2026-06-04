import { ANIMATED_PARAM_KEYS } from '../core/project.js';
import { sampleTrack, segmentControls } from './interpolation.js';

const EPSILON = 1e-4;

/**
 * Populate per-keyframe bezier handles (hIn / hOut / handleMode) on any
 * keyframe that lacks them, derived from the legacy `easing` field and
 * neighbours. This realises the "every keyframe is a bezier" model so the
 * editor always has handles to draw and drag.
 *
 * Idempotent: keyframes that already carry handles are left untouched, so it
 * is safe to call on every render. An interior keyframe's out-handle comes
 * from the segment to its right and its in-handle from the segment to its
 * left (each segment's shape was encoded by the easing stored on its right
 * keyframe). Endpoints mirror their single real handle so the dot still has
 * two grabbable handles.
 */
export function ensureBezierHandles(track) {
  if (!track || track.length === 0) return;
  for (let i = 0; i < track.length; i++) {
    const kf = track[i];
    if (kf.handleMode == null) kf.handleMode = 'smooth';
    if (!kf.hOut && i < track.length - 1) {
      const { p1 } = segmentControls(kf, track[i + 1]);
      kf.hOut = { dt: p1.x - kf.time, dv: p1.y - kf.value };
    }
    if (!kf.hIn && i > 0) {
      const { p2 } = segmentControls(track[i - 1], kf);
      kf.hIn = { dt: p2.x - kf.time, dv: p2.y - kf.value };
    }
  }
  const first = track[0];
  if (!first.hIn) {
    first.hIn = first.hOut
      ? { dt: -first.hOut.dt, dv: -first.hOut.dv }
      : { dt: 0, dv: 0 };
  }
  const last = track[track.length - 1];
  if (!last.hOut) {
    last.hOut = last.hIn
      ? { dt: -last.hIn.dt, dv: -last.hIn.dv }
      : { dt: 0, dv: 0 };
  }
}

/**
 * Upsert a keyframe into a track at given time.
 * If an existing keyframe is within EPSILON of time, its value is replaced.
 * Returns the keyframe that was inserted or updated.
 */
export function upsertKeyframe(track, time, value, defaultEasing = 'linear') {
  for (let i = 0; i < track.length; i++) {
    if (Math.abs(track[i].time - time) < EPSILON) {
      track[i].value = value;
      return track[i];
    }
  }
  const kf = { time, value, easing: defaultEasing };
  track.push(kf);
  track.sort((a, b) => a.time - b.time);
  return kf;
}

export function removeKeyframe(track, index) {
  if (index >= 0 && index < track.length) {
    track.splice(index, 1);
  }
}

export function setKeyframeTime(track, index, newTime) {
  if (index < 0 || index >= track.length) return index;
  track[index].time = newTime;
  track.sort((a, b) => a.time - b.time);
  return track.findIndex(k => Math.abs(k.time - newTime) < EPSILON);
}

/** Return the exact keyframe at a given time, or null. */
export function findKeyframeAt(track, time) {
  for (let i = 0; i < track.length; i++) {
    if (Math.abs(track[i].time - time) < EPSILON) return { kf: track[i], index: i };
  }
  return null;
}

/**
 * Sample all animated parameters at given time.
 * Returns object keyed by param name.
 *
 * Besides the fixed ANIMATED_PARAM_KEYS, any extra track present on the
 * animation is sampled too — this covers the dynamic `grid.<layerIndex>.<param>`
 * tracks added when glyph grid params are animated. Missing tracks fall back to
 * baseValues, so a param the user hasn't keyframed yet still resolves to its
 * snapshot/global value.
 */
export function sampleAnimation(animation, time) {
  const out = {};
  const tracks = animation.tracks || {};
  const baseValues = animation.baseValues || {};
  for (const key of ANIMATED_PARAM_KEYS) {
    out[key] = sampleTrack(tracks[key] || [], time, baseValues[key] ?? 0);
  }
  for (const key of Object.keys(tracks)) {
    if (key in out) continue;
    out[key] = sampleTrack(tracks[key], time, baseValues[key] ?? 0);
  }
  return out;
}

/**
 * Clamp every handle's time-offset to its segment span so the curve stays
 * single-valued in time. Call after any edit that changes keyframe times
 * (drag, arrow nudge, delete), since a handle set when a segment was wide can
 * otherwise overshoot a now-closer neighbour and reverse time.
 */
export function clampTrackHandles(track) {
  if (!track || track.length === 0) return;
  for (let i = 0; i < track.length; i++) {
    const kf = track[i];
    if (kf.hOut && i < track.length - 1) {
      const max = track[i + 1].time - kf.time;
      kf.hOut.dt = Math.max(0, Math.min(max, kf.hOut.dt));
    }
    if (kf.hIn && i > 0) {
      const min = track[i - 1].time - kf.time;
      kf.hIn.dt = Math.min(0, Math.max(min, kf.hIn.dt));
    }
  }
}

/** Clamp a time to [0, duration] */
export function clampTime(t, duration) {
  if (t < 0) return 0;
  if (t > duration) return duration;
  return t;
}

/**
 * Collect all keyframe times across all tracks, deduped and sorted ascending.
 */
export function collectKeyframeTimes(animation) {
  const times = new Set();
  for (const key of Object.keys(animation.tracks || {})) {
    const track = animation.tracks[key];
    if (!track) continue;
    for (const kf of track) times.add(kf.time);
  }
  return [...times].sort((a, b) => a - b);
}

/**
 * Next keyframe time strictly after `time`. Returns null if none.
 */
export function nextKeyframeTime(animation, time) {
  const times = collectKeyframeTimes(animation);
  for (const t of times) {
    if (t > time + EPSILON) return t;
  }
  return null;
}

/**
 * Previous keyframe time strictly before `time`. Returns null if none.
 */
export function prevKeyframeTime(animation, time) {
  const times = collectKeyframeTimes(animation);
  for (let i = times.length - 1; i >= 0; i--) {
    if (times[i] < time - EPSILON) return times[i];
  }
  return null;
}
