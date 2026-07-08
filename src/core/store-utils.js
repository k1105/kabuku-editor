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

// Firestore hard limits (https://firebase.google.com/docs/firestore/quotas):
// 1 MiB per document, 10 MiB per API request (= per batched write). Chunks
// stay well under both so a heavy typeset can't take a whole batch down.
export const FIRESTORE_MAX_DOC_BYTES = 1048576;
export const BATCH_MAX_BYTES = 8 * 1024 * 1024;
export const BATCH_MAX_OPS = 450;

/** Approximate Firestore payload size of a document body, in bytes. */
export function estimateDocBytes(data) {
  try {
    return new TextEncoder().encode(JSON.stringify(data)).length;
  } catch {
    return FIRESTORE_MAX_DOC_BYTES; // unserializable — treat as oversized
  }
}

/**
 * Split write ops into batches that respect both the op-count limit and the
 * 10 MiB request limit. Each op may carry a `bytes` estimate (deletes are
 * treated as free).
 */
export function chunkOpsBySize(ops, { maxOps = BATCH_MAX_OPS, maxBytes = BATCH_MAX_BYTES } = {}) {
  const chunks = [];
  let current = [];
  let currentBytes = 0;
  for (const op of ops) {
    const bytes = op.bytes || 0;
    if (current.length > 0 && (current.length >= maxOps || currentBytes + bytes > maxBytes)) {
      chunks.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(op);
    currentBytes += bytes;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
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
