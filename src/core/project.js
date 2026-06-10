/**
 * FontProject store backed by Firestore.
 *
 *   /fontProjects/{id}              meta + global settings
 *   /fontProjects/{id}/characters/{charId}  one doc per glyph
 *
 * Pages still call the synchronous API (loadProject, getGlobal, etc.) — the
 * active project is kept in memory and flushed to Firestore via a debounced
 * write batch (1.5s after the last edit). Switch projects with
 * bootFontProject(id), which awaits any pending writes before reloading.
 */
import {
  collection, doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc,
  writeBatch, serverTimestamp, addDoc, query, orderBy,
} from 'firebase/firestore';
import { getDb } from './firebase.js';
import { currentUser, userInfo } from './auth.js';
import { getAllGrids } from '../grids/grid-plugin.js';
import { createChangeBus, createDebouncedWriter } from './store-utils.js';

const VERSION = 8;
const WRITE_DEBOUNCE_MS = 1500;

export const DEFAULT_FONT_METRICS = {
  ascender: 0.05,
  xHeight: 0.30,
  baseline: 0.80,
  descender: 0.95,
};

export const DEFAULT_FONT_INFO = {
  familyName: 'Kabuku',
  styleName: 'Regular',
  version: '1.000',
  copyright: '',
};

const DEFAULT_GLOBAL = {
  stretchAngle: 0,
  stretchAmount: 0,
  baseGap: 20,
  gapDirectionWeight: 1,
  metaballStrength: 1,
  metaballRadius: 8,
  gridDefaults: {},
  // Default stroke width (KanjiVG 109-unit space) for kanjivg-sourced glyphs;
  // per-character overrides live on charData.kanjivgSource.strokeWidth.
  kanjivgStrokeWidth: 5.5,
  defaultLayers: [
    { gridName: 'FibonacciGrid', gridParams: { count: 1000, scale: 20, dotRadius: 14, rotation: 228 }, name: 'FibonacciGrid' },
  ],
  fontMetrics: { ...DEFAULT_FONT_METRICS },
  fontInfo: { ...DEFAULT_FONT_INFO },
};

export const ANIMATED_PARAM_KEYS = [
  'stretchAngle',
  'stretchAmount',
  'baseGap',
  'gapDirectionWeight',
  'metaballRadius',
  'fontSize',
  'textBoxWidth',
  'kerning',
  'lineHeight',
  'cameraX',
  'cameraY',
  'cameraDistance',
  'cameraRotation',
];

export const DEFAULT_ANIMATION_BASE_VALUES = {
  stretchAngle: 0,
  stretchAmount: 0,
  baseGap: 0,
  gapDirectionWeight: 0,
  metaballRadius: 8,
  fontSize: 64,
  textBoxWidth: 800,
  kerning: 0,
  lineHeight: 1.5,
  cameraX: 0,
  cameraY: 0,
  cameraDistance: 1,
  cameraRotation: 0,
};

function initialTracks(baseValues) {
  const out = {};
  for (const key of ANIMATED_PARAM_KEYS) {
    out[key] = [{ time: 0, value: baseValues[key], easing: 'linear' }];
  }
  return out;
}

export function createDefaultAnimation() {
  const baseValues = { ...DEFAULT_ANIMATION_BASE_VALUES };
  return {
    duration: 5,
    fps: 30,
    text: '',
    writingMode: 'horizontal',
    canvasWidth: 1920,
    canvasHeight: 1080,
    tracks: initialTracks(baseValues),
    // Step-keyframed text changes (no interpolation): { time, value:string }[].
    // Empty until the user stamps a text keyframe.
    textTrack: [],
    // Guide audio for lyric-video editing. Null until a file is imported.
    // Shape: { url, name, duration, offset, gain, peaks }. Not included in the
    // rendered/exported output — it is an editing reference only.
    audio: null,
    baseValues,
  };
}

export const DEFAULT_LAYER = {
  gridName: 'FibonacciGrid',
  gridParams: { count: 500, scale: 10, dotRadius: 7, rotation: 228 },
};

export const DEFAULT_TRANSFORM = {
  baseGap: 20,
  gapDirectionWeight: 1,
  metaballStrength: 1,
  metaballRadius: 8,
};

/** Build gridDefaults from registered grid plugins' getParamDefs() */
export function buildGridDefaults() {
  const defaults = {};
  for (const grid of getAllGrids()) {
    const params = {};
    for (const def of grid.getParamDefs()) {
      params[def.key] = def.default;
    }
    defaults[grid.name] = params;
  }
  return defaults;
}

function defaultGlobal() {
  return {
    ...DEFAULT_GLOBAL,
    gridDefaults: buildGridDefaults(),
    fontMetrics: { ...DEFAULT_FONT_METRICS },
    fontInfo: { ...DEFAULT_FONT_INFO },
  };
}

function ensureGlobalDefaults(g) {
  if (!g.gridDefaults || Object.keys(g.gridDefaults).length === 0) g.gridDefaults = buildGridDefaults();
  if (!g.defaultLayers || g.defaultLayers.length === 0) g.defaultLayers = [...DEFAULT_GLOBAL.defaultLayers];
  if (!g.fontMetrics) g.fontMetrics = { ...DEFAULT_FONT_METRICS };
  if (!g.fontInfo) g.fontInfo = { ...DEFAULT_FONT_INFO };
  if (g.kanjivgStrokeWidth === undefined) g.kanjivgStrokeWidth = DEFAULT_GLOBAL.kanjivgStrokeWidth;
  return g;
}

/**
 * Strip `undefined` values out of plain objects/arrays. Firestore rejects
 * documents containing `undefined` (e.g. `transformOverrides: undefined` when
 * a glyph has no overrides). Recurses into plain Object / Array only —
 * server-side sentinels like serverTimestamp() are never user payload, so
 * we never run them through this function.
 */
export function stripUndefined(value) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (Array.isArray(value)) {
    return value
      .map(stripUndefined)
      .filter(v => v !== undefined);
  }
  if (typeof value === 'object' && value.constructor === Object) {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      const cleaned = stripUndefined(v);
      if (cleaned !== undefined) out[k] = cleaned;
    }
    return out;
  }
  return value;
}

/**
 * Whether a string is usable as a Firestore document id. Firestore rejects
 * empty ids, "." / "..", and any id containing "/" (a path separator).
 */
export function isValidDocId(id) {
  return typeof id === 'string' && id.length > 0 && id !== '.' && id !== '..' && !id.includes('/');
}

// Glyph ids are the literal characters ('A', 'あ', '/', '.', …) — fonts must be
// able to hold punctuation glyphs, so we can't drop ids that Firestore won't
// accept as a document id. Instead we encode the unsafe ones (empty, '.', '..',
// anything containing '/', or anything that already looks encoded) as
// `enc__<utf8-hex>`, and store doc-safe ids verbatim so existing projects (and
// the Firestore console) stay readable. The in-memory key is always the real
// character, so font export — which maps charId → codepoint — is unaffected.
const DOC_ID_ENC_PREFIX = 'enc__';

export function charIdToDocId(charId) {
  if (isValidDocId(charId) && !charId.startsWith(DOC_ID_ENC_PREFIX)) return charId;
  const bytes = new TextEncoder().encode(charId);
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return DOC_ID_ENC_PREFIX + hex;
}

export function docIdToCharId(docId) {
  if (typeof docId !== 'string' || !docId.startsWith(DOC_ID_ENC_PREFIX)) return docId;
  const hex = docId.slice(DOC_ID_ENC_PREFIX.length);
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return new TextDecoder().decode(bytes);
}

// =========================================================================
// In-memory state for the active FontProject
// =========================================================================
let _fp = null;            // { id, name, global, characters, version }
let _fpId = null;
const _dirtyChars = new Set();
const _deletedChars = new Set();
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
export function subscribeProject(fn) {
  return _changes.subscribe(fn);
}

/** True when there are edits not yet committed to Firestore. */
export function hasUnsavedChanges() {
  return _metaDirty || _dirtyChars.size > 0 || _deletedChars.size > 0;
}

/** Reset the in-memory state (used when signing out / switching). */
export async function unloadFontProject() {
  await flushNow();
  _fp = null;
  _fpId = null;
  _dirtyChars.clear();
  _deletedChars.clear();
  _metaDirty = false;
}

export function currentFontProjectId() { return _fpId; }
export function currentFontProjectName() { return _fp?.name || null; }

export async function bootFontProject(projectId) {
  if (_fpId && _fpId !== projectId) await flushNow();
  const db = getDb();
  const metaSnap = await getDoc(doc(db, 'fontProjects', projectId));
  if (!metaSnap.exists()) throw new Error(`Font project not found: ${projectId}`);
  const meta = metaSnap.data();
  const charsSnap = await getDocs(collection(db, 'fontProjects', projectId, 'characters'));
  const characters = {};
  for (const d of charsSnap.docs) characters[docIdToCharId(d.id)] = d.data();
  _fp = {
    id: projectId,
    name: meta.name || 'Untitled',
    global: ensureGlobalDefaults({ ...defaultGlobal(), ...(meta.global || {}) }),
    characters,
    version: meta.version || VERSION,
  };
  _fpId = projectId;
  _dirtyChars.clear();
  _deletedChars.clear();
  _metaDirty = false;
  notifyChange();
  return _fp;
}

function scheduleWrite() {
  _writer.schedule();
}

/**
 * Flush any pending writes immediately. Called before nav-away / unload.
 * Splits across multiple write batches when needed (Firestore caps at 500 ops).
 */
export async function flushNow() {
  _writer.cancel();
  if (!_fp || !_fpId) return;
  if (!_metaDirty && _dirtyChars.size === 0 && _deletedChars.size === 0) return;
  const db = getDb();
  const lastEditor = userInfo() || null;

  // Build a flat op list, then chunk into <= 450 ops per batch.
  const ops = [];
  if (_metaDirty) {
    ops.push({
      kind: 'set',
      ref: doc(db, 'fontProjects', _fpId),
      data: {
        name: _fp.name || 'Untitled',
        global: stripUndefined(_fp.global),
        version: _fp.version || VERSION,
        updatedAt: serverTimestamp(),
        lastEditor,
      },
      options: { merge: true },
    });
  }
  for (const cid of _dirtyChars) {
    const cd = _fp.characters[cid];
    if (!cd) continue;
    // An empty id is not a real glyph (e.g. an image whose filename had no
    // stem); skip it. Every other id — including punctuation like '/' or '.' —
    // is encoded into a valid Firestore doc id.
    if (cid === '') continue;
    ops.push({
      kind: 'set',
      ref: doc(db, 'fontProjects', _fpId, 'characters', charIdToDocId(cid)),
      data: stripUndefined(cd),
    });
  }
  for (const cid of _deletedChars) {
    if (cid === '') continue;
    ops.push({
      kind: 'delete',
      ref: doc(db, 'fontProjects', _fpId, 'characters', charIdToDocId(cid)),
    });
  }
  _metaDirty = false;
  _dirtyChars.clear();
  _deletedChars.clear();

  try {
    while (ops.length > 0) {
      const chunk = ops.splice(0, 450);
      const batch = writeBatch(db);
      for (const op of chunk) {
        if (op.kind === 'set') {
          if (op.options) batch.set(op.ref, op.data, op.options);
          else batch.set(op.ref, op.data);
        } else if (op.kind === 'delete') {
          batch.delete(op.ref);
        }
      }
      await batch.commit();
    }
  } catch (e) {
    console.error('Failed to flush font project:', e);
  }
  // Dirty flags were cleared above; tell unsaved-indicator UIs to refresh.
  notifyChange();
}

// Flush on tab close so debounced writes don't get dropped.
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => { flushNow(); });
}

// =========================================================================
// Synchronous API used by pages
// =========================================================================
function blankProject() {
  return {
    characters: {},
    global: defaultGlobal(),
    version: VERSION,
  };
}

export function loadProject() {
  return _fp || blankProject();
}

/**
 * Apply an undo/redo snapshot. Diffs each character against the current
 * in-memory project and only marks actually-changed ones dirty, so undoing
 * a single-glyph edit doesn't rewrite the entire project to Firestore.
 *
 * Returns a description of what changed so callers (e.g. page refresh
 * handlers) can do partial UI updates instead of redrawing every glyph:
 *   { changedCharIds, removedCharIds, globalChanged }
 *
 * Safe to compare via JSON equality because snapshots from history.js are
 * fresh deep clones (never aliased with _fp).
 */
export function restoreFromSnapshot(data) {
  if (!_fpId) return { changedCharIds: new Set(), removedCharIds: new Set(), globalChanged: false };
  if (!_fp) {
    saveProject(data);
    return {
      changedCharIds: new Set(Object.keys(data.characters || {})),
      removedCharIds: new Set(),
      globalChanged: true,
    };
  }
  const nextName = data.name || _fp.name || 'Untitled';
  const nextVersion = data.version || VERSION;
  const nextGlobal = data.global;
  const nextChars = data.characters || {};

  const globalChanged = (
    nextName !== _fp.name ||
    nextVersion !== _fp.version ||
    JSON.stringify(_fp.global) !== JSON.stringify(nextGlobal)
  );
  if (globalChanged) _metaDirty = true;

  const oldIds = new Set(Object.keys(_fp.characters || {}));
  const newIds = new Set(Object.keys(nextChars));
  const removedCharIds = new Set();
  const changedCharIds = new Set();
  for (const oldId of oldIds) {
    if (!newIds.has(oldId)) {
      _deletedChars.add(oldId);
      _dirtyChars.delete(oldId);
      removedCharIds.add(oldId);
    }
  }
  for (const cid of newIds) {
    const before = _fp.characters?.[cid];
    const after = nextChars[cid];
    if (!before || JSON.stringify(before) !== JSON.stringify(after)) {
      _dirtyChars.add(cid);
      _deletedChars.delete(cid);
      changedCharIds.add(cid);
    }
  }

  _fp = {
    id: _fpId,
    name: nextName,
    global: nextGlobal,
    characters: nextChars,
    version: nextVersion,
  };
  if (_metaDirty || _dirtyChars.size > 0 || _deletedChars.size > 0) {
    scheduleWrite();
  }
  return { changedCharIds, removedCharIds, globalChanged };
}

/**
 * Full-project overwrite (used by bulk imports — undo/redo uses
 * restoreFromSnapshot for fine-grained dirty tracking).
 *
 * Callers commonly mutate the in-memory project in place and then call
 * saveProject(_fp) — i.e. the data arg shares references with _fp. A
 * reference-based diff would miss those mutations entirely, so saveProject
 * marks every character dirty unconditionally.
 */
export function saveProject(data) {
  if (!_fpId) return false;
  const next = {
    id: _fpId,
    name: data.name || _fp?.name || 'Untitled',
    global: data.global,
    characters: data.characters || {},
    version: data.version || VERSION,
  };
  const oldIds = new Set(Object.keys(_fp?.characters || {}));
  const newIds = new Set(Object.keys(next.characters));
  for (const oldId of oldIds) {
    if (!newIds.has(oldId)) {
      _deletedChars.add(oldId);
      _dirtyChars.delete(oldId);
    }
  }
  for (const cid of newIds) {
    _dirtyChars.add(cid);
    _deletedChars.delete(cid);
  }
  _metaDirty = true;
  _fp = next;
  scheduleWrite();
  return true;
}

export function getGlobal() {
  return ensureGlobalDefaults(_fp?.global || defaultGlobal());
}

export function saveGlobal(global) {
  if (!_fp) return false;
  _fp.global = global;
  _metaDirty = true;
  scheduleWrite();
  return true;
}

export function getCharacter(charId) {
  return _fp?.characters?.[charId] || null;
}

export function saveCharacter(charId, charData) {
  if (!_fp) return false;
  _fp.characters[charId] = charData;
  _dirtyChars.add(charId);
  _deletedChars.delete(charId);
  scheduleWrite();
  return true;
}

export function getAllCharIds() {
  return Object.keys(_fp?.characters || {});
}

export function deleteCharacter(charId) {
  if (!_fp || !(charId in _fp.characters)) return false;
  delete _fp.characters[charId];
  _deletedChars.add(charId);
  _dirtyChars.delete(charId);
  scheduleWrite();
  return true;
}

/** Rename a character, preserving insertion order. */
export function renameCharacter(oldId, newId) {
  if (oldId === newId) return { ok: true };
  if (!newId) return { ok: false, reason: 'empty' };
  if (!_fp) return { ok: false, reason: 'missing' };
  if (!(oldId in _fp.characters)) return { ok: false, reason: 'missing' };
  if (newId in _fp.characters) return { ok: false, reason: 'conflict' };
  const rebuilt = {};
  for (const [k, v] of Object.entries(_fp.characters)) {
    rebuilt[k === oldId ? newId : k] = v;
  }
  _fp.characters = rebuilt;
  _deletedChars.add(oldId);
  _dirtyChars.add(newId);
  scheduleWrite();
  return { ok: true };
}

export function generateUniqueCharId(prefix = 'new') {
  if (!_fp) return prefix;
  if (!(prefix in _fp.characters)) return prefix;
  let i = 1;
  while (`${prefix}_${i}` in _fp.characters) i++;
  return `${prefix}_${i}`;
}

export function createEmptyCharacter(charId) {
  if (!_fp) return false;
  if (charId in _fp.characters) return false;
  _fp.characters[charId] = { imagePath: '' };
  _dirtyChars.add(charId);
  scheduleWrite();
  return true;
}

// =========================================================================
// Project-list level operations (across collection)
// =========================================================================
export async function listFontProjects() {
  const db = getDb();
  const q = query(collection(db, 'fontProjects'), orderBy('updatedAt', 'desc'));
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

export async function createFontProject(name) {
  const db = getDb();
  const user = userInfo();
  const data = {
    name: name || 'Untitled',
    global: defaultGlobal(),
    version: VERSION,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    createdBy: user,
    lastEditor: user,
  };
  const ref = await addDoc(collection(db, 'fontProjects'), data);
  return ref.id;
}

export async function renameFontProject(projectId, newName) {
  const db = getDb();
  await updateDoc(doc(db, 'fontProjects', projectId), {
    name: newName,
    updatedAt: serverTimestamp(),
  });
}

export async function deleteFontProject(projectId) {
  const db = getDb();
  const charsSnap = await getDocs(collection(db, 'fontProjects', projectId, 'characters'));
  // Firestore batches cap at 500 ops; chunk just in case.
  const ops = [...charsSnap.docs.map(d => d.ref), doc(db, 'fontProjects', projectId)];
  while (ops.length > 0) {
    const chunk = ops.splice(0, 450);
    const batch = writeBatch(db);
    for (const ref of chunk) batch.delete(ref);
    await batch.commit();
  }
}

/** Fetch a font project's full state without making it active (for snapshots). */
export async function fetchFontProjectSnapshot(projectId) {
  const db = getDb();
  const metaSnap = await getDoc(doc(db, 'fontProjects', projectId));
  if (!metaSnap.exists()) throw new Error(`Font project not found: ${projectId}`);
  const meta = metaSnap.data();
  const charsSnap = await getDocs(collection(db, 'fontProjects', projectId, 'characters'));
  const characters = {};
  for (const d of charsSnap.docs) characters[docIdToCharId(d.id)] = d.data();
  return {
    id: projectId,
    name: meta.name || 'Untitled',
    global: ensureGlobalDefaults({ ...defaultGlobal(), ...(meta.global || {}) }),
    characters,
    version: meta.version || VERSION,
  };
}

/**
 * Resolve a single Unicode codepoint for a glyph from its charId.
 * Returns null when the id isn't a single character (e.g. "new_1") so the
 * caller can flag it for the user.
 */
export function resolveCodepoint(charId) {
  if (typeof charId !== 'string' || charId.length === 0) return null;
  const cp = charId.codePointAt(0);
  if (cp == null) return null;
  const expectedLen = cp > 0xFFFF ? 2 : 1;
  if (charId.length !== expectedLen) return null;
  return cp;
}

// =========================================================================
// Pure helpers (unchanged from previous version)
// =========================================================================
/** Resolve transform: global defaults merged with per-character overrides */
export function resolveTransform(global, overrides) {
  return {
    baseGap: global.baseGap,
    gapDirectionWeight: global.gapDirectionWeight,
    metaballStrength: global.metaballStrength,
    metaballRadius: global.metaballRadius,
    stretchAngle: global.stretchAngle,
    stretchAmount: global.stretchAmount,
    ...overrides,
  };
}

/** Compute overrides: returns only keys where resolved differs from global */
function computeOverrides(resolved, globalDefaults) {
  const overrides = {};
  for (const [k, v] of Object.entries(resolved)) {
    if (globalDefaults[k] !== v) overrides[k] = v;
  }
  return Object.keys(overrides).length > 0 ? overrides : undefined;
}

/**
 * Resolve character layers: build rendering data from global structure + character overrides.
 */
export function resolveCharacterLayers(global, charData) {
  const overrides = charData?.layerOverrides || [];
  return (global.defaultLayers || []).map((globalLayer, i) => {
    const charOverride = overrides[i] || {};
    const gridParamOverrides = charOverride.gridParamOverrides || {};
    const resolvedParams = { ...globalLayer.gridParams, ...gridParamOverrides };
    return {
      gridName: globalLayer.gridName,
      name: globalLayer.name || globalLayer.gridName,
      resolvedParams,
      gridParamOverrides,
      cells: (!charOverride.gridName || charOverride.gridName === globalLayer.gridName)
        ? (charOverride.cells || null)
        : null,
      opacity: charOverride.opacity ?? globalLayer.opacity ?? 1,
      visible: charOverride.visible ?? globalLayer.visible ?? true,
    };
  });
}

function compactCell(c) {
  const out = {
    center: {
      x: Math.round(c.center?.x ?? 0),
      y: Math.round(c.center?.y ?? 0),
    },
  };
  if (c.filled) out.filled = true;
  if (c.manualOverride) out.manualOverride = true;
  return out;
}

/** Serialize runtime layers to per-character overrides */
export function serializeLayerOverrides(layers, global) {
  return layers.map((layer, i) => {
    const globalLayer = global.defaultLayers?.[i];
    if (!globalLayer) return null;
    const overrides = computeOverrides(layer.gridParams, globalLayer.gridParams || {});
    const out = {
      gridName: globalLayer.gridName,
      gridParamOverrides: overrides,
      cells: layer.cells
        .filter(c => c.filled || c.manualOverride)
        .map(c => compactCell(c)),
    };
    const gOpacity = globalLayer.opacity ?? 1;
    const gVisible = globalLayer.visible ?? true;
    if (layer.opacity !== gOpacity) out.opacity = layer.opacity;
    if (layer.visible !== gVisible) out.visible = layer.visible;
    return out;
  }).filter(Boolean);
}
