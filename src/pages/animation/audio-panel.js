/**
 * AUDIO (guide) sidebar panel: import/replace/remove the guide clip, the
 * head-start offset field, gain, and the standalone "listen" transport that
 * auditions the song without touching the playhead or animation state.
 *
 * `state` is the page's accessor state object; `deps` are page hooks
 * (persist / markDirty / renderTimeline / playback control). The page owns
 * `audioPlayer` (timeline-synced) and `listenAudio` (audition element) and
 * disposes them on teardown.
 */
import { iconEl } from '../../ui/icons.js';
import { createParamRow } from '../../ui/param-row.js';
import { uploadAnimationAudio } from '../../core/storage.js';
import { decodeAudioPeaks } from '../../animation/audio-track.js';
import { addNumberField } from './form-utils.js';

export function createAudioPanel({ state, audioPlayer, listenAudio, deps }) {
  // AUDIO group — guide audio for lyric-video editing. The clip plays during
  // preview/playback in sync with the playhead but is never part of the
  // rendered/exported output. See audio-track.js for the data model.
  const audioGroup = document.createElement('div');
  audioGroup.className = 'param-group anim-audio-group';
  const audioTitle = document.createElement('h3');
  audioTitle.textContent = 'AUDIO (guide)';
  audioGroup.appendChild(audioTitle);

  const audioHint = document.createElement('p');
  audioHint.className = 'anim-audio-hint';
  audioHint.textContent = '編集用のガイド音源です。書き出し動画には含まれません。';
  audioGroup.appendChild(audioHint);

  // Hidden file input + import button.
  const audioFileInput = document.createElement('input');
  audioFileInput.type = 'file';
  audioFileInput.accept = 'audio/*';
  audioFileInput.style.display = 'none';
  const importAudioBtn = document.createElement('button');
  importAudioBtn.className = 'tool-btn anim-audio-import';
  importAudioBtn.appendChild(iconEl('upload'));
  const importAudioLbl = document.createElement('span');
  importAudioLbl.textContent = '音源を読み込む';
  importAudioBtn.appendChild(importAudioLbl);
  importAudioBtn.addEventListener('click', () => audioFileInput.click());
  audioFileInput.addEventListener('change', () => {
    const file = audioFileInput.files?.[0];
    audioFileInput.value = ''; // allow re-selecting the same file later
    if (file) doImportAudio(file);
  });
  audioGroup.appendChild(importAudioBtn);
  audioGroup.appendChild(audioFileInput);

  // Loaded-clip controls (filename, listen player, volume, remove). Shown only
  // when a clip is loaded; refreshAudioPanel() toggles visibility + values.
  const audioControls = document.createElement('div');
  audioControls.className = 'anim-audio-controls';

  const audioNameRow = document.createElement('div');
  audioNameRow.className = 'anim-audio-name';
  audioControls.appendChild(audioNameRow);

  // Head-start field: how many seconds INTO the song to begin at the state.animation's
  // start (= the song position at timeline t=0 = -offset). Skipping an intro
  // reads as a positive number, which is what users expect. Internally we still
  // store `offset` (the timeline time where the song's start sits), so the field
  // edits `-offset`. Editable here OR by dragging the waveform clip; the drag
  // updates this live via refreshAudioPanel().
  const offsetInput = addNumberField(audioControls, '頭出し (s)', 0, -600, 600, 0.01, (v) => {
    if (!state.animation.audio) return;
    state.animation.audio.offset = -v;
    deps.persist(); deps.renderTimeline();
    if (state.playing) deps.syncAudioToTime(true);
    deps.commitHistory('audio-offset');
  });

  // Standalone "listen" UI: a custom transport to audition the whole song
  // independently of the editing timeline. It only plays sound — it never
  // touches the playhead, offset, or state.animation state ("他の状態を汚さない").
  // Use it to find the spot you want, then set 開始位置 / drag the waveform clip
  // to line the song up with the state.animation.
  const listenHint = document.createElement('p');
  listenHint.className = 'anim-audio-hint';
  listenHint.textContent = '試聴用プレイヤー（タイムラインとは独立）。';
  audioControls.appendChild(listenHint);

  const listenPlayer = document.createElement('div');
  listenPlayer.className = 'anim-listen-player';
  // Full-width seek bar on its own row so it's as long as possible.
  const listenSeek = document.createElement('input');
  listenSeek.type = 'range';
  listenSeek.className = 'anim-listen-seek';
  listenSeek.min = 0;
  listenSeek.max = 1;
  listenSeek.step = 0.001;
  listenSeek.value = 0;
  listenPlayer.appendChild(listenSeek);
  // Transport row: play/pause button + time readout.
  const listenRow = document.createElement('div');
  listenRow.className = 'anim-listen-row';
  const listenPlayBtn = document.createElement('button');
  listenPlayBtn.type = 'button';
  listenPlayBtn.className = 'anim-listen-play';
  listenPlayBtn.appendChild(iconEl('play'));
  const listenTime = document.createElement('span');
  listenTime.className = 'anim-listen-time';
  listenTime.textContent = '0:00 / 0:00';
  listenRow.appendChild(listenPlayBtn);
  listenRow.appendChild(listenTime);
  listenPlayer.appendChild(listenRow);
  audioControls.appendChild(listenPlayer);

  // --- listen transport wiring (all isolated to listenAudio) ---
  const fmtTime = (s) => {
    if (!Number.isFinite(s) || s < 0) s = 0;
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec < 10 ? '0' : ''}${sec}`;
  };
  const listenDuration = () => {
    const d = listenAudio.duration;
    return Number.isFinite(d) && d > 0 ? d : (state.animation.audio?.duration || 0);
  };
  let listenScrubbing = false;
  function refreshListenIcon() {
    listenPlayBtn.innerHTML = '';
    listenPlayBtn.appendChild(iconEl(listenAudio.paused ? 'play' : 'pause'));
  }
  function refreshListenProgress() {
    const dur = listenDuration();
    if (!listenScrubbing) {
      listenSeek.value = dur > 0 ? listenAudio.currentTime / dur : 0;
    }
    listenTime.textContent = `${fmtTime(listenAudio.currentTime)} / ${fmtTime(dur)}`;
  }
  listenPlayBtn.addEventListener('click', () => {
    if (!state.animation.audio) return;
    if (listenAudio.paused) {
      // Don't sound the audition over timeline playback.
      if (state.playing) deps.pausePlayback();
      listenAudio.play().catch(() => { /* not ready / gesture — ignore */ });
    } else {
      listenAudio.pause();
    }
  });
  listenSeek.addEventListener('input', () => {
    listenScrubbing = true;
    const dur = listenDuration();
    if (dur > 0) {
      try { listenAudio.currentTime = parseFloat(listenSeek.value) * dur; } catch { /* not seekable */ }
    }
    listenTime.textContent = `${fmtTime(listenAudio.currentTime)} / ${fmtTime(dur)}`;
  });
  listenSeek.addEventListener('change', () => { listenScrubbing = false; });
  listenAudio.addEventListener('play', refreshListenIcon);
  listenAudio.addEventListener('pause', refreshListenIcon);
  listenAudio.addEventListener('ended', () => { refreshListenIcon(); refreshListenProgress(); });
  listenAudio.addEventListener('timeupdate', refreshListenProgress);
  listenAudio.addEventListener('loadedmetadata', refreshListenProgress);

  const { row: gainRow, api: gainApi } = createParamRow('音量', {
    min: 0, max: 1, step: 0.01, value: 1,
    onInput: (v) => { if (state.animation.audio) audioPlayer.setGain(v); },
    onChange: (v) => {
      if (!state.animation.audio) return;
      state.animation.audio.gain = v;
      audioPlayer.setGain(v);
      deps.persist();
      deps.commitHistory('audio-gain');
    },
  });
  audioControls.appendChild(gainRow);

  const removeAudioBtn = document.createElement('button');
  removeAudioBtn.className = 'tool-btn anim-audio-remove';
  removeAudioBtn.appendChild(iconEl('trash'));
  const removeAudioLbl = document.createElement('span');
  removeAudioLbl.textContent = '音源を削除';
  removeAudioBtn.appendChild(removeAudioLbl);
  removeAudioBtn.addEventListener('click', () => {
    if (!state.animation.audio) return;
    if (!confirm('ガイド音源を削除します。よろしいですか?')) return;
    state.animation.audio = null;
    audioPlayer.dispose();
    deps.persist();
    deps.renderTimeline();
    refreshAudioPanel();
    deps.commitHistory('audio-remove');
  });
  audioControls.appendChild(removeAudioBtn);

  audioGroup.appendChild(audioControls);

  // Reflect the current state.animation.audio state into the panel controls.
  function refreshAudioPanel() {
    const a = state.animation.audio;
    if (a) {
      audioControls.style.display = '';
      importAudioLbl.textContent = '音源を差し替える';
      audioNameRow.textContent = a.name || 'audio';
      // Field shows head-start (= -offset); see the field's definition above.
      offsetInput.value = -(a.offset ?? 0);
      gainApi.setValue(a.gain ?? 1);
      // Point the listen player at the clip. Only reassign on a real URL change
      // so refreshes (offset drag, undo) don't reset its playback position.
      if (listenAudio.dataset.url !== a.url) {
        listenAudio.src = a.url;
        listenAudio.dataset.url = a.url;
      }
      refreshListenIcon();
      refreshListenProgress();
    } else {
      audioControls.style.display = 'none';
      importAudioLbl.textContent = '音源を読み込む';
      listenAudio.pause();
      listenAudio.removeAttribute('src');
      delete listenAudio.dataset.url;
    }
  }

  /**
   * Import a guide-audio file: decode peaks from its bytes (for the waveform),
   * upload the file to Storage, then attach it to the state.animation. Peaks are
   * computed up front and persisted so reloads never re-decode.
   */
  async function doImportAudio(file) {
    importAudioBtn.disabled = true;
    const prevLbl = importAudioLbl.textContent;
    importAudioLbl.textContent = '読み込み中…';
    try {
      const bytes = await file.arrayBuffer();
      // decodeAudioData detaches its buffer — decode from a copy so the
      // original bytes remain intact for the upload.
      const { peaks, duration } = await decodeAudioPeaks(bytes.slice(0));
      const url = await uploadAnimationAudio({ file });
      state.animation.audio = {
        url, name: file.name || 'audio',
        duration, offset: 0, gain: state.animation.audio?.gain ?? 1, peaks,
      };
      audioPlayer.load(url);
      audioPlayer.setGain(state.animation.audio.gain);
      deps.persist();
      deps.markDirty();
      deps.renderTimeline();
      refreshAudioPanel();
      deps.commitHistory('audio-import');
    } catch (e) {
      console.error('Audio import failed:', e);
      alert('音源の読み込みに失敗しました: ' + e.message);
    } finally {
      importAudioBtn.disabled = false;
      importAudioLbl.textContent = state.animation.audio ? '音源を差し替える' : prevLbl;
    }
  }


  return { el: audioGroup, refresh: refreshAudioPanel };
}
