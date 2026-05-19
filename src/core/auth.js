import {
  GoogleAuthProvider,
  signInWithPopup,
  signOut as fbSignOut,
  onAuthStateChanged,
} from 'firebase/auth';
import { getFirebaseAuth } from './firebase.js';

let _currentUser = null;
let _readyPromise = null;
const subscribers = new Set();

/**
 * Returns the current user when Auth has reported its initial state.
 * Resolves to `null` if no user is signed in. Idempotent: subsequent calls
 * reuse the same promise and never attach an extra Firebase listener.
 */
export function waitForAuth() {
  if (_readyPromise) return _readyPromise;
  const auth = getFirebaseAuth();
  _readyPromise = new Promise((resolve) => {
    let resolved = false;
    onAuthStateChanged(auth, (user) => {
      _currentUser = user;
      if (!resolved) {
        resolved = true;
        resolve(user);
        return;
      }
      for (const fn of subscribers) fn(user);
    });
  });
  return _readyPromise;
}

export function currentUser() {
  return _currentUser;
}

export function subscribeAuth(fn) {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

export async function signInWithGoogle() {
  const provider = new GoogleAuthProvider();
  const result = await signInWithPopup(getFirebaseAuth(), provider);
  _currentUser = result.user;
  return result.user;
}

export async function signOut() {
  await fbSignOut(getFirebaseAuth());
  _currentUser = null;
}

export function userInfo(user = _currentUser) {
  if (!user) return null;
  return {
    uid: user.uid,
    name: user.displayName || user.email || user.uid,
    email: user.email || '',
    photoURL: user.photoURL || '',
  };
}
