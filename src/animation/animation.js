import { ANIMATED_PARAM_KEYS } from '../core/project.js';
import { sampleTrack } from './interpolation.js';

const EPSILON = 1e-4;

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
 */
export function sampleAnimation(animation, time) {
  const out = {};
  for (const key of ANIMATED_PARAM_KEYS) {
    const track = animation.tracks?.[key] || [];
    const fallback = animation.baseValues?.[key] ?? 0;
    out[key] = sampleTrack(track, time, fallback);
  }
  return out;
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
