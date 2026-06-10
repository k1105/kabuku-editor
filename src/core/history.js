import { loadProject, restoreFromSnapshot } from './project.js';
import { createHistory } from './base-history.js';

/**
 * Undo/redo history (font side).
 *
 * Snapshots the entire project on each "commit" (button click, slider release,
 * paint stroke end). Image dataURLs are dedup'd into an in-memory registry
 * keyed by content, so snapshots stay small even with many large base64 PNGs.
 *
 * Restoration writes back to the store and notifies subscribers — pages
 * fully re-render from the restored state.
 */

const IMAGE_TAG = '__img:';

const imageToId = new Map(); // dataURL -> id
const idToImage = new Map(); // id -> dataURL
let nextImageId = 0;

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

const history = createHistory({
  getState: loadProject,
  buildSnapshot,
  restoreSnapshot: (snap) => restoreFromSnapshot(restoreSnapshot(snap)),
});

export const initHistory = history.init;
export const commit = history.commit;
export const canUndo = history.canUndo;
export const canRedo = history.canRedo;
export const undo = history.undo;
export const redo = history.redo;
export const subscribe = history.subscribe;
