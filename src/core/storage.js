/**
 * Firebase Storage helpers for character images.
 *
 * Layout:
 *   /fontProjects/{projectId}/characters/{charId}-{timestamp}.{ext}
 *
 * Each upload uses a fresh timestamp suffix to keep CDN URLs cache-busted
 * and to avoid orphaned writes overwriting valid content. We don't try to
 * garbage-collect old image objects automatically — Storage costs are cheap
 * and a stale image is harmless. A future cleanup pass can list-and-purge.
 */
import { ref, uploadBytes, getDownloadURL } from 'firebase/storage';
import { getBucket } from './firebase.js';
import { currentFontProjectId } from './project.js';
import { currentAnimationProjectId } from './animation-project.js';

function safeName(charId) {
  // Storage object names can contain most chars, but `/` is treated as a
  // path separator and a few control codes confuse signed URLs. Pass
  // arbitrary glyphs through encodeURIComponent.
  return encodeURIComponent(charId);
}

function extFromFile(file) {
  const t = (file.type || '').toLowerCase();
  if (t.includes('png')) return 'png';
  if (t.includes('jpeg') || t.includes('jpg')) return 'jpg';
  if (t.includes('gif')) return 'gif';
  if (t.includes('webp')) return 'webp';
  const name = (file.name || '').toLowerCase();
  const m = name.match(/\.([a-z0-9]+)$/);
  return m ? m[1] : 'png';
}

/**
 * Upload a character image file or Blob and return its HTTPS download URL.
 *   uploadCharacterImage({ projectId?, charId, file })
 * projectId defaults to the active FontProject.
 */
export async function uploadCharacterImage({ projectId, charId, file }) {
  const pid = projectId || currentFontProjectId();
  if (!pid) throw new Error('No active font project — cannot determine upload path');
  const ext = extFromFile(file);
  const path = `fontProjects/${pid}/characters/${safeName(charId)}-${Date.now()}.${ext}`;
  const r = ref(getBucket(), path);
  await uploadBytes(r, file, { contentType: file.type || 'image/png' });
  return await getDownloadURL(r);
}

function audioExtFromFile(file) {
  const t = (file.type || '').toLowerCase();
  if (t.includes('mpeg') || t.includes('mp3')) return 'mp3';
  if (t.includes('wav')) return 'wav';
  if (t.includes('ogg')) return 'ogg';
  if (t.includes('aac')) return 'aac';
  if (t.includes('flac')) return 'flac';
  if (t.includes('mp4') || t.includes('m4a')) return 'm4a';
  const name = (file.name || '').toLowerCase();
  const m = name.match(/\.([a-z0-9]+)$/);
  return m ? m[1] : 'mp3';
}

/**
 * Upload a guide-audio file for an AnimationProject and return its HTTPS
 * download URL. Mirrors uploadCharacterImage; path is scoped to the animation
 * project. projectId defaults to the active AnimationProject.
 */
export async function uploadAnimationAudio({ projectId, file }) {
  const pid = projectId || currentAnimationProjectId();
  if (!pid) throw new Error('No active animation project — cannot determine upload path');
  const ext = audioExtFromFile(file);
  const path = `animationProjects/${pid}/audio/${Date.now()}.${ext}`;
  const r = ref(getBucket(), path);
  await uploadBytes(r, file, { contentType: file.type || 'audio/mpeg' });
  return await getDownloadURL(r);
}
