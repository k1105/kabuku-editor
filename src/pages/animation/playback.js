/**
 * Playback engine for the animation editor: the rAF master clock, guide-audio
 * synchronisation, and seek. The wall-clock is the master timeline; while the
 * guide audio is audible the playhead is slaved to the audio element's clock
 * instead (see startPlayback for why).
 *
 * `state` is the page's accessor state object (animation / currentTime /
 * playing); `deps` are the page-level UI refresh hooks.
 */
import { clampTime } from '../../animation/animation.js';
import { songTimeAt, isAudible } from '../../animation/audio-track.js';

export function createPlayback({ state, audioPlayer, listenAudio, deps }) {
  let playStartWallTime = 0;
  let playStartAnimTime = 0;
  let rafId = null;

  // === Playback ===
  /**
   * Keep the guide-audio element aligned to the master wall-clock during
   * playback. Starts/pauses the clip as the playhead enters/leaves the song's
   * placed range, and re-seeks ONLY on explicit events (`force`: start, scrub,
   * offset change).
   *
   * It deliberately does NOT hard-correct drift every frame: the audio element
   * has output latency (tens to a couple hundred ms), so its clock trails the
   * wall-clock by more than any small tolerance, and per-frame seeking made the
   * sound stutter ("ぶつぶつ"). Once started the element free-runs at real time —
   * over a short guide clip the residual drift is inaudible.
   */
  function syncAudioToTime(force) {
    const a = state.animation.audio;
    if (!a || !state.playing) { return; }
    if (isAudible(a, state.currentTime)) {
      const desired = songTimeAt(a, state.currentTime);
      if (!audioPlayer.isPlaying()) {
        audioPlayer.setGain(a.gain ?? 1);
        audioPlayer.play(desired);
      } else if (force) {
        audioPlayer.seek(desired);
      }
    } else if (audioPlayer.isPlaying()) {
      audioPlayer.pause();
    }
  }

  function togglePlay() {
    if (state.playing) pausePlayback();
    else startPlayback();
  }
  function startPlayback() {
    if (state.currentTime >= state.animation.duration) state.currentTime = 0;
    state.playing = true;
    deps.setPlayState(true);
    playStartWallTime = performance.now();
    playStartAnimTime = state.currentTime;
    // Auditioning and timeline playback shouldn't sound at once.
    listenAudio.pause();
    syncAudioToTime(true);
    const tick = () => {
      if (!state.playing) return;
      const a = state.animation.audio;
      const offset = a?.offset || 0;
      // While the guide audio is actually sounding, slave the playhead to the
      // audio element's own clock so the playhead sits exactly over the part of
      // the waveform being heard (the wall-clock drifts ahead of the audio by
      // its output latency, which looked like the waveform was out of sync).
      // Re-anchor the wall-clock baseline each frame so handing back to it (out
      // of the song's range / after a clip ends) is seamless.
      if (a && audioPlayer.isPlaying()) {
        state.currentTime = offset + audioPlayer.currentTime;
        playStartWallTime = performance.now();
        playStartAnimTime = state.currentTime;
      } else {
        const elapsed = (performance.now() - playStartWallTime) / 1000;
        state.currentTime = playStartAnimTime + elapsed;
      }
      if (state.currentTime >= state.animation.duration) {
        state.currentTime = state.animation.duration;
        deps.updateSlidersFromTime();
        deps.renderPlayhead();
        deps.updateTimeDisplay();
        deps.redrawPreview();
        pausePlayback();
        return;
      }
      syncAudioToTime(false);
      deps.updateSlidersFromTime();
      deps.renderPlayhead();
      deps.updateTimeDisplay();
      deps.redrawPreview();
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
  }
  function pausePlayback() {
    state.playing = false;
    deps.setPlayState(false);
    audioPlayer.pause();
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    // On pause, fall through to redrawPreview — it picks up the cache when
    // available, or live-renders the frame otherwise.
    deps.redrawPreview();
  }

  function seekTo(t) {
    state.currentTime = clampTime(t, state.animation.duration);
    deps.updateSlidersFromTime();
    deps.renderPlayhead();
    deps.updateTimeDisplay();
    deps.redrawPreview();
    if (state.playing) syncAudioToTime(true);
  }


  return { togglePlay, startPlayback, pausePlayback, seekTo, syncAudioToTime };
}
