/**
 * Generic undo/redo stack shared by the font-side history (history.js) and
 * the animation-side history (animation-history.js). The two stacks stay
 * independent — each module creates its own instance.
 *
 * @param {Object} opts
 * @param {() => any} opts.getState - current state for commit(); commit is a
 *   no-op when this returns null/undefined.
 * @param {(state: any) => any} opts.buildSnapshot - state → storable snapshot.
 * @param {(snapshot: any) => any} opts.restoreSnapshot - write a snapshot back
 *   to the live store. May return a `changes` descriptor, which is forwarded
 *   to subscribers on restore notifications.
 */
export function createHistory({ getState, buildSnapshot, restoreSnapshot }) {
  const MAX_HISTORY = 50;

  let undoStack = []; // [{ snapshot, label }]
  let redoStack = [];
  const subscribers = new Set();

  function snapsEqual(a, b) {
    return JSON.stringify(a) === JSON.stringify(b);
  }

  function notify(isRestore = false, changes = null) {
    const state = { canUndo: canUndo(), canRedo: canRedo(), isRestore, changes };
    for (const fn of subscribers) fn(state);
  }

  function init(state) {
    undoStack = [{ snapshot: buildSnapshot(state), label: 'init' }];
    redoStack = [];
    notify();
  }

  /**
   * Snapshot the current state. Idempotent: skipped when the new state
   * matches the top of the stack (e.g. slider released at its start value).
   */
  function commit(label = '') {
    const state = getState();
    if (state == null) return;
    if (undoStack.length === 0) {
      init(state);
      return;
    }
    const snap = buildSnapshot(state);
    const last = undoStack[undoStack.length - 1];
    if (snapsEqual(last.snapshot, snap)) return;
    undoStack.push({ snapshot: snap, label });
    if (undoStack.length > MAX_HISTORY + 1) undoStack.shift();
    redoStack = [];
    notify();
  }

  function canUndo() { return undoStack.length > 1; }
  function canRedo() { return redoStack.length > 0; }

  function undo() {
    if (!canUndo()) return false;
    const current = undoStack.pop();
    redoStack.push(current);
    const target = undoStack[undoStack.length - 1];
    const changes = restoreSnapshot(target.snapshot);
    notify(true, changes);
    return true;
  }

  function redo() {
    if (!canRedo()) return false;
    const target = redoStack.pop();
    undoStack.push(target);
    const changes = restoreSnapshot(target.snapshot);
    notify(true, changes);
    return true;
  }

  function subscribe(fn) {
    subscribers.add(fn);
    fn({ canUndo: canUndo(), canRedo: canRedo() });
    return () => subscribers.delete(fn);
  }

  /** Empty both stacks (used when navigating away from the owning page). */
  function reset() {
    undoStack = [];
    redoStack = [];
    notify();
  }

  return { init, commit, canUndo, canRedo, undo, redo, subscribe, reset };
}
