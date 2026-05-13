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
