/**
 * Undo/redo history scoped to the active AnimationProject.
 *
 * Snapshots the `animation` object (duration/fps/text/writingMode/tracks/
 * baseValues) on each commit. The font-side history (history.js) stays
 * untouched — these are independent stacks. main.js dispatches Cmd+Z to
 * whichever is active based on the current route.
 */
import { getAnimation, restoreAnimationSnapshot } from './animation-project.js';
import { createHistory } from './base-history.js';

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

const history = createHistory({
  getState: getAnimation,
  buildSnapshot: clone,
  restoreSnapshot: (snap) => restoreAnimationSnapshot(clone(snap)),
});

export const initAnimationHistory = history.init;
export const commit = history.commit;
export const canUndo = history.canUndo;
export const canRedo = history.canRedo;
export const undo = history.undo;
export const redo = history.redo;
export const subscribe = history.subscribe;
/** Reset the history (used when navigating away from the animation page). */
export const resetAnimationHistory = history.reset;
