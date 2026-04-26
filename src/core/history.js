import { loadProject, saveProject } from './project.js';

/**
 * Undo/redo history.
 *
 * Snapshots the entire project on each "commit" (button click, slider release,
 * paint stroke end). Image dataURLs are dedup'd into an in-memory registry
 * keyed by content, so snapshots stay small even with many large base64 PNGs.
 *
 * Restoration writes back to localStorage and notifies subscribers — pages
 * fully re-render from the restored state.
 */

const MAX_HISTORY = 50;
const IMAGE_TAG = '__img:';

const imageToId = new Map(); // dataURL -> id
const idToImage = new Map(); // id -> dataURL
let nextImageId = 0;

let undoStack = []; // [{ snapshot, label }]
let redoStack = [];
const subscribers = new Set();

function registerImage(dataUrl) {
  let id = imageToId.get(dataUrl);
  if (id !== undefined) return id;
  id = `${nextImageId++}`;
  imageToId.set(dataUrl, id);
  idToImage.set(id, dataUrl);
  return id;
}

function buildSnapshot(project) {
  const out = JSON.parse(JSON.stringify(project));
  for (const cd of Object.values(out.characters || {})) {
    if (typeof cd.imagePath === 'string' && cd.imagePath.startsWith('data:')) {
      cd.imagePath = IMAGE_TAG + registerImage(cd.imagePath);
    }
  }
  return out;
}

function restoreSnapshot(snap) {
  const out = JSON.parse(JSON.stringify(snap));
  for (const cd of Object.values(out.characters || {})) {
    if (typeof cd.imagePath === 'string' && cd.imagePath.startsWith(IMAGE_TAG)) {
      const id = cd.imagePath.slice(IMAGE_TAG.length);
      cd.imagePath = idToImage.get(id) ?? '';
    }
  }
  return out;
}

function snapsEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function notify(isRestore = false) {
  const state = { canUndo: canUndo(), canRedo: canRedo(), isRestore };
  for (const fn of subscribers) fn(state);
}

export function initHistory(project) {
  undoStack = [{ snapshot: buildSnapshot(project), label: 'init' }];
  redoStack = [];
  notify();
}

/**
 * Snapshot current project (loaded from localStorage). Idempotent: skipped
 * when the new state matches the top of the stack (e.g. slider released at
 * its starting value).
 */
export function commit(label = '') {
  const project = loadProject();
  if (undoStack.length === 0) {
    initHistory(project);
    return;
  }
  const snap = buildSnapshot(project);
  const last = undoStack[undoStack.length - 1];
  if (snapsEqual(last.snapshot, snap)) return;
  undoStack.push({ snapshot: snap, label });
  if (undoStack.length > MAX_HISTORY + 1) undoStack.shift();
  redoStack = [];
  notify();
}

export function canUndo() { return undoStack.length > 1; }
export function canRedo() { return redoStack.length > 0; }

export function undo() {
  if (!canUndo()) return false;
  const current = undoStack.pop();
  redoStack.push(current);
  const target = undoStack[undoStack.length - 1];
  saveProject(restoreSnapshot(target.snapshot));
  notify(true);
  return true;
}

export function redo() {
  if (!canRedo()) return false;
  const target = redoStack.pop();
  undoStack.push(target);
  saveProject(restoreSnapshot(target.snapshot));
  notify(true);
  return true;
}

export function subscribe(fn) {
  subscribers.add(fn);
  fn({ canUndo: canUndo(), canRedo: canRedo() });
  return () => subscribers.delete(fn);
}
