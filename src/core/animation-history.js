/**
 * Undo/redo history scoped to the active AnimationProject.
 *
 * Snapshots the `animation` object (duration/fps/text/writingMode/tracks/
 * baseValues) on each commit. The font-side history (history.js) stays
 * untouched — these are independent stacks. main.js dispatches Cmd+Z to
 * whichever is active based on the current route.
 */
import { getAnimation, saveAnimation } from './animation-project.js';

const MAX_HISTORY = 50;

let undoStack = []; // [{ snapshot, label }]
let redoStack = [];
const subscribers = new Set();

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function snapsEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function notify(isRestore = false) {
  const state = { canUndo: canUndo(), canRedo: canRedo(), isRestore };
  for (const fn of subscribers) fn(state);
}

export function initAnimationHistory(animation) {
  undoStack = [{ snapshot: clone(animation), label: 'init' }];
  redoStack = [];
  notify();
}

/** Idempotent: skipped when the new state matches the top of the stack. */
export function commit(label = '') {
  const animation = getAnimation();
  if (!animation) return;
  if (undoStack.length === 0) {
    initAnimationHistory(animation);
    return;
  }
  const snap = clone(animation);
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
  saveAnimation(clone(target.snapshot));
  notify(true);
  return true;
}

export function redo() {
  if (!canRedo()) return false;
  const target = redoStack.pop();
  undoStack.push(target);
  saveAnimation(clone(target.snapshot));
  notify(true);
  return true;
}

export function subscribe(fn) {
  subscribers.add(fn);
  fn({ canUndo: canUndo(), canRedo: canRedo() });
  return () => subscribers.delete(fn);
}

/** Reset the history (used when navigating away from the animation page). */
export function resetAnimationHistory() {
  undoStack = [];
  redoStack = [];
  notify();
}
