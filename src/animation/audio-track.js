/**
 * Guide-audio support for the animation editor (lyric-video editing).
 *
 * The audio is an editing reference only — it is never part of the rendered /
 * exported output. The animation carries it as:
 *
 *   animation.audio = { url, name, duration, offset, gain, peaks }
 *
 * `offset` is the animation-timeline time (seconds) at which the song's start
 * (songTime = 0) is placed; it may be negative. The song position playing at
 * animation time `t` is therefore `t - offset`, audible only while that value
 * is within [0, duration].
 *
 * `peaks` is a small downsampled abs-peak array computed once at import time
 * from the file's bytes and persisted, so reloads draw the waveform without
 * re-fetching / re-decoding the audio (which would depend on Storage CORS).
 * Playback uses an HTMLAudioElement pointed at the download URL — media
 * elements load cross-origin without CORS.
 */

// Waveform resolution. Peaks are downsampled at import and persisted, so the
// bucket count is the upper bound on on-screen detail. We size it by duration
// (a denser song needs more buckets) within a clamp that keeps the persisted
// JSON small enough for the Firestore animation doc (~6 bytes/bucket).
const PEAKS_PER_SECOND = 240;
const MIN_PEAK_BUCKETS = 2000;
const MAX_PEAK_BUCKETS = 16000;

/** The song position (seconds) playing at animation time `t`. */
export function songTimeAt(audio, t) {
  return t - (audio?.offset || 0);
}

/** Whether the song is sounding at animation time `t`. */
export function isAudible(audio, t) {
  if (!audio) return false;
  const s = songTimeAt(audio, t);
  return s >= 0 && s <= (audio.duration || 0);
}

/**
 * Decode an audio file's bytes into a downsampled abs-peak array + duration.
 * Uses a throwaway AudioContext that is closed once decoding completes (so we
 * don't leak contexts across imports). Channel 0 is split into `numBuckets`
 * windows and the max absolute sample of each window is kept.
 */
export async function decodeAudioPeaks(arrayBuffer, numBuckets) {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  const ctx = new Ctx();
  try {
    // decodeAudioData detaches the ArrayBuffer; callers that still need the
    // bytes (e.g. to upload) must pass a copy.
    const buf = await ctx.decodeAudioData(arrayBuffer);
    const ch = buf.getChannelData(0);
    const len = ch.length;
    // Default the bucket count from the clip length; honour an explicit
    // override. Clamp to the size budget, then to the sample count.
    let target = numBuckets ?? Math.round(buf.duration * PEAKS_PER_SECOND);
    target = Math.max(MIN_PEAK_BUCKETS, Math.min(MAX_PEAK_BUCKETS, target));
    const buckets = Math.max(1, Math.min(target, len));
    const step = len / buckets;
    const peaks = new Array(buckets);
    for (let i = 0; i < buckets; i++) {
      const start = Math.floor(i * step);
      const end = Math.min(len, Math.floor((i + 1) * step));
      let peak = 0;
      for (let j = start; j < end; j++) {
        const v = ch[j] < 0 ? -ch[j] : ch[j];
        if (v > peak) peak = v;
      }
      // Round to keep the persisted JSON compact.
      peaks[i] = Math.round(peak * 1000) / 1000;
    }
    return { peaks, duration: buf.duration };
  } finally {
    // close() returns a promise; we don't need to await it.
    ctx.close?.();
  }
}

/**
 * Thin HTMLAudioElement wrapper for guide playback. The animation's wall-clock
 * remains the master timeline; this player is kept in sync by the page (start /
 * seek / drift-correct). All times passed in are SONG times (post-offset).
 */
export function createAudioPlayer() {
  const el = new Audio();
  el.preload = 'auto';
  // No crossOrigin: a media element plays cross-origin (Firebase Storage)
  // without CORS, and we never read its samples (waveform peaks come from the
  // imported File's bytes). Setting it would require Storage CORS headers and
  // break playback when they're absent.
  let url = null;

  function load(u) {
    if (u === url) return;
    url = u;
    el.src = u || '';
  }

  return {
    /** Set / change the source URL. */
    load,
    /** Current song position (seconds). */
    get currentTime() { return el.currentTime; },
    /** Begin playing from `songTime`. Out-of-range times are clamped/ignored. */
    play(songTime) {
      if (!url) return;
      const dur = Number.isFinite(el.duration) ? el.duration : Infinity;
      if (songTime < 0 || songTime > dur) return;
      try { el.currentTime = songTime; } catch { /* not seekable yet */ }
      el.play().catch(() => { /* autoplay gesture / not ready — ignore */ });
    },
    pause() { el.pause(); },
    /** Move the playhead without changing play/pause state. */
    seek(songTime) {
      if (!url) return;
      const dur = Number.isFinite(el.duration) ? el.duration : Infinity;
      const clamped = Math.max(0, Math.min(dur, songTime));
      try { el.currentTime = clamped; } catch { /* not seekable yet */ }
    },
    setGain(g) { el.volume = Math.max(0, Math.min(1, g)); },
    isPlaying() { return !el.paused; },
    /** Release the media resource (pause + detach src). */
    dispose() {
      el.pause();
      el.removeAttribute('src');
      el.src = '';
      el.load?.();
      url = null;
    },
  };
}
