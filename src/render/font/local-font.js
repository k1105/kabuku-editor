/**
 * Locally-imported font files (TTF/OTF).
 *
 * Lets the user import an arbitrary font file and use it as a glyph base, the
 * same way Google Fonts families are used. The font binary is stored in
 * IndexedDB (this browser only — not synced with the project), and registered
 * with the browser via the FontFace API so the existing `fontSource`
 * ({family, char}) render pipeline (renderCharToContext / fillText) works
 * unchanged.
 *
 * The family name is the key throughout: importing returns the family, glyphs
 * store it in `fontSource.family`, and on a later session the family is found
 * back in IndexedDB and re-registered on demand.
 */

import opentype from 'opentype.js';

const DB_NAME = 'kabuku-fonts';
const STORE = 'fonts';
const DB_VERSION = 1;

let dbPromise = null;
function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        // keyPath = family name; value = { family, buffer, format }
        db.createObjectStore(STORE, { keyPath: 'family' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function idbPut(record) {
  return openDB().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  }));
}

function idbGet(family) {
  return openDB().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(family);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  }));
}

function idbKeys() {
  return openDB().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).getAllKeys();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  }));
}

function idbDelete(family) {
  return openDB().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(family);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  }));
}

// ── In-memory state ─────────────────────────────────────────────────────────

// Family names known to be local imports. Loaded once from IndexedDB so the
// sync-ish branch in ensureFontLoaded can route a family to local vs. Google.
let knownSetPromise = null;
const knownFamilies = new Set();
// family -> Promise that resolves once the FontFace is added to document.fonts.
const registered = new Map();

async function ensureKnownLoaded() {
  if (!knownSetPromise) {
    knownSetPromise = idbKeys()
      .then(keys => { for (const k of keys) knownFamilies.add(k); })
      .catch(() => {});
  }
  await knownSetPromise;
}

/**
 * True if `family` refers to a locally-imported font (vs. a Google Fonts
 * family). Loads the family-name index from IndexedDB on first call.
 */
export async function isLocalFont(family) {
  await ensureKnownLoaded();
  return knownFamilies.has(family.trim());
}

const FORMAT_BY_EXT = { ttf: 'truetype', otf: 'opentype' };

function extractFamilyName(font, fallback) {
  const names = font?.names || {};
  // Prefer the typographic/preferred family, then the basic family.
  const pick = (n) => n && (n.en || Object.values(n)[0]);
  return (
    pick(names.preferredFamily) ||
    pick(names.fontFamily) ||
    pick(names.fullName) ||
    fallback
  );
}

/**
 * Import a TTF/OTF file: parse it to read its family name, store the binary in
 * IndexedDB, and register it with the browser. Re-importing a file with the
 * same family name overwrites the stored copy.
 *
 * @param {File} file
 * @returns {Promise<{ family: string }>}
 */
export async function importLocalFontFile(file) {
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  const format = FORMAT_BY_EXT[ext];
  if (!format) {
    throw new Error(`Unsupported font format ".${ext}". Use TTF or OTF.`);
  }
  const buffer = await file.arrayBuffer();

  let font;
  try {
    font = opentype.parse(buffer);
  } catch (e) {
    throw new Error(`Failed to parse font file "${file.name}": ${e.message || e}`);
  }

  const fallback = file.name.replace(/\.[^.]+$/, '');
  const family = extractFamilyName(font, fallback).trim();
  if (!family) throw new Error('Could not determine a family name for the font.');

  await idbPut({ family, buffer, format });
  knownFamilies.add(family);
  registered.delete(family); // force re-register with the fresh bytes
  await ensureLocalFontRegistered(family);

  return { family };
}

/**
 * Make sure the FontFace for a locally-imported `family` is loaded into
 * `document.fonts`. Resolves once the glyphs are rasterizable. Safe to call
 * repeatedly — registration is memoized per family.
 *
 * @param {string} family
 * @param {string} [sampleText]  chars to probe via document.fonts.load
 */
export async function ensureLocalFontRegistered(family, sampleText = '') {
  const key = family.trim();
  if (!registered.has(key)) {
    registered.set(key, (async () => {
      const rec = await idbGet(key);
      if (!rec) throw new Error(`Local font "${key}" not found in storage.`);
      const face = new FontFace(key, rec.buffer);
      await face.load();
      document.fonts.add(face);
    })());
  }
  await registered.get(key);

  const sample = sampleText && sampleText.length > 0 ? sampleText : ' ';
  const probe = `64px "${key.replace(/"/g, '\\"')}"`;
  const CHUNK = 256;
  for (let i = 0; i < sample.length; i += CHUNK) {
    await document.fonts.load(probe, sample.slice(i, i + CHUNK));
  }
  await document.fonts.ready;
}

/** List the family names of all locally-imported fonts. */
export async function listLocalFonts() {
  await ensureKnownLoaded();
  return Array.from(knownFamilies);
}

/** Remove a locally-imported font from storage and the in-memory index. */
export async function deleteLocalFont(family) {
  const key = family.trim();
  await idbDelete(key);
  knownFamilies.delete(key);
  registered.delete(key);
}
