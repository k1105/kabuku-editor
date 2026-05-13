/**
 * Advisory edit lock. When a user opens a project, we stamp an `editingBy`
 * field on the meta doc with their identity and a wall-clock timestamp.
 * Refreshed periodically (heartbeat) while the page is open and cleared on
 * unload.
 *
 * It is *advisory only*: another user can still proceed past the warning
 * and edit. Last-write-wins applies. The goal is to flag the situation,
 * not enforce exclusivity.
 */
import { doc, getDoc, updateDoc, deleteField } from 'firebase/firestore';
import { getDb } from './firebase.js';
import { userInfo } from './auth.js';

const STALE_AFTER_MS = 90 * 1000;   // older lock = stale, no warning
const HEARTBEAT_MS   = 30 * 1000;

let _active = null;  // { collection, projectId, timer }

function lockRef(coll, projectId) {
  return doc(getDb(), coll, projectId);
}

/**
 * Check whether another user is currently editing. Returns null when free or
 * an editor info object when occupied (and recent).
 */
export async function checkEditLock(coll, projectId) {
  const ref = lockRef(coll, projectId);
  const snap = await getDoc(ref);
  if (!snap.exists()) return null;
  const data = snap.data();
  const lock = data.editingBy;
  if (!lock || !lock.at) return null;
  const me = userInfo();
  if (me && lock.uid === me.uid) return null; // own lock, ignore
  const at = lock.at?.toDate ? lock.at.toDate().getTime() : new Date(lock.at).getTime();
  if (Number.isNaN(at)) return null;
  if (Date.now() - at > STALE_AFTER_MS) return null;
  return lock;
}

/** Start holding the lock with a periodic heartbeat. */
export async function acquireEditLock(coll, projectId) {
  await releaseEditLock(); // ensure no stale active lock
  const me = userInfo();
  if (!me) return;
  const lock = { uid: me.uid, name: me.name, at: new Date() };
  _active = { coll, projectId, timer: null };
  try {
    await updateDoc(lockRef(coll, projectId), { editingBy: lock });
  } catch (e) {
    console.warn('Failed to acquire edit lock:', e);
  }
  _active.timer = setInterval(async () => {
    try {
      await updateDoc(lockRef(coll, projectId), {
        editingBy: { uid: me.uid, name: me.name, at: new Date() },
      });
    } catch (e) {
      console.warn('Lock heartbeat failed:', e);
    }
  }, HEARTBEAT_MS);
}

export async function releaseEditLock() {
  if (!_active) return;
  const { coll, projectId, timer } = _active;
  if (timer) clearInterval(timer);
  _active = null;
  try {
    await updateDoc(lockRef(coll, projectId), { editingBy: deleteField() });
  } catch (e) {
    // Non-fatal: stale lock will expire by itself.
    console.warn('Failed to release edit lock:', e);
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => { releaseEditLock(); });
}
