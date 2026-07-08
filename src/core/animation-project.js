/**
 * AnimationProject store backed by Firestore + Cloud Storage.
 *
 *   /animationProjects/{id}          Firestore: meta + animation data + snapshot global
 *   animationProjects/{id}/snapshot-{ts}.json.gz
 *                                    Storage: gzipped JSON of the font project chars
 *
 * The character snapshot lives in ONE Storage object instead of a Firestore
 * subcollection: heavy typesets used to blow the 10 MiB batched-write limit
 * mid-copy and leave a glyph-less (all-tofu) project behind. Projects created
 * before this change still carry a `characters` subcollection; boot falls back
 * to reading it, and refreshSnapshotFromOrigin migrates them to Storage.
 *
 * Each animation project is independent: it carries its own frozen copy of a
 * font project (snapshot). Use refreshSnapshotFromOrigin() to re-pull the
 * latest FontProject state.
 */
import {
  collection, doc, getDoc, getDocs, setDoc, updateDoc,
  writeBatch, serverTimestamp, query, orderBy,
} from 'firebase/firestore';
import { ref as storageRef, uploadBytes, getBytes, deleteObject } from 'firebase/storage';
import { gzipSync, gunzipSync, strToU8, strFromU8 } from 'fflate';
import { getDb, getBucket } from './firebase.js';
import { userInfo } from './auth.js';
import { fetchFontProjectSnapshot, createDefaultAnimation, ANIMATED_PARAM_KEYS, stripUndefined, docIdToCharId } from './project.js';
import { createChangeBus, createDebouncedWriter } from './store-utils.js';

const WRITE_DEBOUNCE_MS = 1500;

// =========================================================================
// In-memory state for the active AnimationProject
// =========================================================================
let _ap = null;       // { id, name, fontProjectId, fontProjectName, snapshotAt, snapshotGlobal, characters, animation }
let _apId = null;
let _animDirty = false;
let _metaDirty = false;
const _changes = createChangeBus();
const _writer = createDebouncedWriter(() => { flushNow(); }, {
  debounceMs: WRITE_DEBOUNCE_MS,
  onSchedule: () => notifyChange(),
});

function notifyChange() {
  _changes.notify();
}

/** Subscribe to in-memory state changes (e.g. for unsaved-indicator UI). */
export function subscribeAnimationProject(fn) {
  return _changes.subscribe(fn);
}

/** True when there are edits not yet committed to Firestore. */
export function hasUnsavedChanges() {
  return _animDirty || _metaDirty;
}

export function currentAnimationProjectId() { return _apId; }
export function currentAnimationProjectName() { return _ap?.name || null; }
export function getOriginFontProjectId() { return _ap?.fontProjectId || null; }
export function getOriginFontProjectName() { return _ap?.fontProjectName || null; }
export function getSnapshotAt() { return _ap?.snapshotAt || null; }
export function getSnapshotGlobal() { return _ap?.snapshotGlobal || null; }
export function getSnapshotCharacters() { return _ap?.characters || {}; }

/** Project-shaped view for code paths that expect { characters, global }. */
export function getSnapshotProject() {
  return {
    characters: _ap?.characters || {},
    global: _ap?.snapshotGlobal || null,
  };
}

export function getAnimation() {
  if (!_ap) return null;
  if (!_ap.animation) _ap.animation = createDefaultAnimation();
  // Ensure baseValues has all expected keys (defensive)
  for (const key of ANIMATED_PARAM_KEYS) {
    if (_ap.animation.baseValues?.[key] === undefined) {
      _ap.animation.baseValues = _ap.animation.baseValues || {};
      _ap.animation.baseValues[key] = createDefaultAnimation().baseValues[key];
    }
  }
  return _ap.animation;
}

export function saveAnimation(animation) {
  if (!_ap) return false;
  _ap.animation = animation;
  _animDirty = true;
  scheduleWrite();
  return true;
}

/**
 * Apply an undo/redo snapshot by mutating the live animation object in
 * place. Preserves the object identity so closures held by timeline-ui /
 * sliders that captured the original `animation` reference continue to see
 * the current data without being rewired.
 */
export function restoreAnimationSnapshot(snapshot) {
  if (!_ap) return false;
  if (!_ap.animation) _ap.animation = {};
  const dst = _ap.animation;
  for (const key of Object.keys(dst)) {
    if (!(key in snapshot)) delete dst[key];
  }
  for (const [key, value] of Object.entries(snapshot)) {
    dst[key] = value;
  }
  _animDirty = true;
  scheduleWrite();
  return true;
}

export async function unloadAnimationProject() {
  await flushNow();
  _ap = null;
  _apId = null;
  _animDirty = false;
  _metaDirty = false;
}

// =========================================================================
// Character snapshot blob (Cloud Storage)
// =========================================================================
function snapshotBlobPath(projectId) {
  return `animationProjects/${projectId}/snapshot-${Date.now()}.json.gz`;
}

async function uploadSnapshotBlob(path, characters) {
  const json = JSON.stringify({ version: 1, characters: stripUndefined(characters) });
  const bytes = gzipSync(strToU8(json));
  await uploadBytes(storageRef(getBucket(), path), bytes, { contentType: 'application/gzip' });
}

async function downloadSnapshotBlob(path) {
  const buf = await getBytes(storageRef(getBucket(), path));
  const json = strFromU8(gunzipSync(new Uint8Array(buf)));
  const parsed = JSON.parse(json);
  if (!parsed || typeof parsed.characters !== 'object' || parsed.characters === null) {
    throw new Error('スナップショットの形式が不正です');
  }
  return parsed.characters;
}

async function deleteSnapshotBlobQuiet(path) {
  if (!path) return;
  try {
    await deleteObject(storageRef(getBucket(), path));
  } catch (e) {
    // Best-effort cleanup — a stale blob is harmless.
    console.warn('Failed to delete snapshot blob:', path, e);
  }
}

/** Load snapshot characters: Storage blob first, legacy subcollection fallback. */
async function loadSnapshotCharacters(projectId, meta) {
  if (meta.snapshotPath) {
    return await downloadSnapshotBlob(meta.snapshotPath);
  }
  const db = getDb();
  const charsSnap = await getDocs(collection(db, 'animationProjects', projectId, 'characters'));
  const characters = {};
  for (const d of charsSnap.docs) characters[docIdToCharId(d.id)] = d.data();
  return characters;
}

export async function bootAnimationProject(projectId) {
  if (_apId && _apId !== projectId) await flushNow();
  const db = getDb();
  const metaSnap = await getDoc(doc(db, 'animationProjects', projectId));
  if (!metaSnap.exists()) throw new Error(`Animation project not found: ${projectId}`);
  const meta = metaSnap.data();
  const characters = await loadSnapshotCharacters(projectId, meta);
  _ap = {
    id: projectId,
    name: meta.name || 'Untitled',
    fontProjectId: meta.fontProjectId || null,
    fontProjectName: meta.fontProjectName || '',
    snapshotAt: meta.snapshotAt || null,
    snapshotGlobal: meta.snapshotGlobal || null,
    snapshotPath: meta.snapshotPath || null,
    characters,
    animation: meta.animation || createDefaultAnimation(),
  };
  _apId = projectId;
  _animDirty = false;
  _metaDirty = false;
  return _ap;
}

function scheduleWrite() {
  _writer.schedule();
}

// Last flush error we alerted about — debounced retries of the same failure
// shouldn't alert on every edit.
let _lastReportedFlushError = null;

export async function flushNow() {
  _writer.cancel();
  if (!_ap || !_apId) return;
  if (!_animDirty && !_metaDirty) return;
  const db = getDb();
  const lastEditor = userInfo() || null;
  const patch = {
    updatedAt: serverTimestamp(),
    lastEditor,
  };
  if (_animDirty) patch.animation = stripUndefined(_ap.animation);
  if (_metaDirty) {
    patch.name = _ap.name;
    if (_ap.fontProjectId) patch.fontProjectId = _ap.fontProjectId;
    if (_ap.fontProjectName) patch.fontProjectName = _ap.fontProjectName;
  }
  try {
    await setDoc(doc(db, 'animationProjects', _apId), patch, { merge: true });
    _animDirty = false;
    _metaDirty = false;
    _lastReportedFlushError = null;
  } catch (e) {
    // Dirty flags stay set (they are only cleared on success above), so the
    // unsaved indicator keeps showing — but tell the user too instead of
    // failing silently.
    console.error('Failed to flush animation project:', e);
    if (_lastReportedFlushError !== e.message) {
      _lastReportedFlushError = e.message;
      if (typeof alert === 'function') alert(`Animation の保存に失敗しました: ${e.message}`);
    }
  }
  // Tell unsaved-indicator UIs to refresh now that the dirty flags changed.
  notifyChange();
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => { flushNow(); });
}

// =========================================================================
// Project-list level operations
// =========================================================================
export async function listAnimationProjects() {
  const db = getDb();
  const q = query(collection(db, 'animationProjects'), orderBy('updatedAt', 'desc'));
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

/**
 * Create a new AnimationProject snapshotting the given FontProject.
 * Uploads the character snapshot to Storage first, then writes the meta doc —
 * so a failure at any point leaves no half-created (all-tofu) project behind.
 */
export async function createAnimationProject({ name, fontProjectId }) {
  if (!fontProjectId) throw new Error('fontProjectId is required to snapshot a typeset');
  const db = getDb();
  const user = userInfo();
  const fp = await fetchFontProjectSnapshot(fontProjectId);

  // Reserve a doc id locally (no write yet) so the blob path can include it.
  const metaRef = doc(collection(db, 'animationProjects'));
  const snapshotPath = snapshotBlobPath(metaRef.id);
  await uploadSnapshotBlob(snapshotPath, fp.characters);

  const metaData = {
    name: name || 'Untitled Animation',
    fontProjectId,
    fontProjectName: fp.name,
    snapshotAt: serverTimestamp(),
    snapshotGlobal: stripUndefined(fp.global),
    snapshotPath,
    animation: stripUndefined(createDefaultAnimation()),
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    createdBy: user,
    lastEditor: user,
  };
  try {
    await setDoc(metaRef, metaData);
  } catch (e) {
    await deleteSnapshotBlobQuiet(snapshotPath);
    throw e;
  }
  return metaRef.id;
}

export async function renameAnimationProject(projectId, newName) {
  const db = getDb();
  await updateDoc(doc(db, 'animationProjects', projectId), {
    name: newName,
    updatedAt: serverTimestamp(),
  });
}

export async function deleteAnimationProject(projectId) {
  const db = getDb();
  // Snapshot blob first (its path lives on the meta doc we're about to delete).
  const metaSnap = await getDoc(doc(db, 'animationProjects', projectId));
  if (metaSnap.exists()) await deleteSnapshotBlobQuiet(metaSnap.data().snapshotPath);
  const charsSnap = await getDocs(collection(db, 'animationProjects', projectId, 'characters'));
  const ops = [...charsSnap.docs.map(d => d.ref), doc(db, 'animationProjects', projectId)];
  while (ops.length > 0) {
    const chunk = ops.splice(0, 450);
    const batch = writeBatch(db);
    for (const ref of chunk) batch.delete(ref);
    await batch.commit();
  }
}

/**
 * Update which FontProject this AnimationProject is linked to, without
 * pulling a new snapshot. The character snapshot and snapshotGlobal keep the
 * previously-snapshotted state until the user explicitly refreshes.
 */
export async function setLinkedFontProject(projectId, fontProjectId, fontProjectName) {
  if (!projectId) throw new Error('No animation project specified');
  const db = getDb();
  await setDoc(doc(db, 'animationProjects', projectId), {
    fontProjectId: fontProjectId || null,
    fontProjectName: fontProjectName || '',
    updatedAt: serverTimestamp(),
    lastEditor: userInfo() || null,
  }, { merge: true });
  if (_apId === projectId && _ap) {
    _ap.fontProjectId = fontProjectId || null;
    _ap.fontProjectName = fontProjectName || '';
  }
}

/**
 * Re-snapshot from the origin FontProject. Uploads a fresh Storage blob,
 * points the meta doc at it, then cleans up the old blob and any legacy
 * characters subcollection (migrating pre-Storage projects in the process).
 * Keeps the AnimationProject's animation data untouched.
 */
export async function refreshSnapshotFromOrigin(projectId = _apId) {
  if (!projectId) throw new Error('No animation project to refresh');
  const db = getDb();
  const metaRef = doc(db, 'animationProjects', projectId);
  const metaSnap = await getDoc(metaRef);
  if (!metaSnap.exists()) throw new Error('Animation project missing');
  const meta = metaSnap.data();
  if (!meta.fontProjectId) throw new Error('This animation has no linked font project to refresh from');
  const fp = await fetchFontProjectSnapshot(meta.fontProjectId);

  // New blob first, meta switch second — a failure in between leaves the
  // project on its old, still-valid snapshot.
  const snapshotPath = snapshotBlobPath(projectId);
  await uploadSnapshotBlob(snapshotPath, fp.characters);
  try {
    await setDoc(metaRef, {
      snapshotAt: serverTimestamp(),
      snapshotGlobal: stripUndefined(fp.global),
      snapshotPath,
      fontProjectName: fp.name,
      updatedAt: serverTimestamp(),
      lastEditor: userInfo() || null,
    }, { merge: true });
  } catch (e) {
    await deleteSnapshotBlobQuiet(snapshotPath);
    throw e;
  }
  await deleteSnapshotBlobQuiet(meta.snapshotPath);

  // Drop the legacy characters subcollection (no longer read once
  // snapshotPath is set). Best-effort: leftovers are ignored by boot.
  try {
    const oldCharsSnap = await getDocs(collection(db, 'animationProjects', projectId, 'characters'));
    const ops = oldCharsSnap.docs.map(d => d.ref);
    while (ops.length > 0) {
      const chunk = ops.splice(0, 450);
      const batch = writeBatch(db);
      for (const ref of chunk) batch.delete(ref);
      await batch.commit();
    }
  } catch (e) {
    console.warn('Failed to clean up legacy characters subcollection:', e);
  }

  // If the refreshed project is the active one, reload in-memory state
  if (_apId === projectId) {
    await bootAnimationProject(projectId);
  }
}
