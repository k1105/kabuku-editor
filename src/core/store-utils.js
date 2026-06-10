/**
 * Shared store mechanics for the two Firestore-backed project stores
 * (project.js / animation-project.js): a change-notification bus and a
 * debounced write scheduler. The flush bodies themselves stay domain-specific
 * (batched character subcollection vs. single doc merge) — full unification
 * is deferred to the repository-layer work (REFACTORING_PLAN.md Phase 4-2).
 */

/** Subscriber set with a notify-all helper. */
export function createChangeBus() {
  const subs = new Set();
  return {
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    notify() {
      for (const fn of subs) fn();
    },
  };
}

/**
 * Debounced flush timer. `schedule()` (re)arms the timer; `cancel()` disarms
 * it (call at the top of the flush itself so an explicit flush doesn't get a
 * trailing duplicate).
 */
export function createDebouncedWriter(flushFn, { debounceMs = 1500, onSchedule } = {}) {
  let timer = null;
  return {
    schedule() {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { flushFn(); }, debounceMs);
      onSchedule?.();
    },
    cancel() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}
