export const EASINGS = {
  linear: (t) => t,
  'ease-in': (t) => t * t * t,
  'ease-out': (t) => 1 - Math.pow(1 - t, 3),
  'ease-in-out': (t) => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2,
};

export const EASING_NAMES = Object.keys(EASINGS);

export function applyEasing(t, name) {
  const fn = EASINGS[name] || EASINGS.linear;
  return fn(Math.max(0, Math.min(1, t)));
}

/**
 * Sample a parameter track at given time.
 * Track = [{time, value, easing}, ...] sorted by time (ascending).
 *
 * Easing on a keyframe defines how the curve APPROACHES that keyframe — i.e.
 * the segment leading up to it from the previous keyframe. This matches the
 * intuitive UX ("right-click the keyframe you want to reach, set how to get
 * there"); the first keyframe's easing is unused since nothing precedes it.
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
      const t = (time - a.time) / span;
      const eased = applyEasing(t, b.easing || 'linear');
      return a.value + (b.value - a.value) * eased;
    }
  }
  return track[track.length - 1].value;
}
