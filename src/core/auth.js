import {
  GoogleAuthProvider,
  signInWithPopup,
  signOut as fbSignOut,
  onAuthStateChanged,
} from 'firebase/auth';
import { getFirebaseAuth } from './firebase.js';

let _currentUser = null;
const subscribers = new Set();

/**
 * Returns the current user when Auth has reported its initial state.
 * Resolves to `null` if no user is signed in.
 */
export function waitForAuth() {
  const auth = getFirebaseAuth();
  return new Promise((resolve) => {
    const unsub = onAuthStateChanged(auth, (user) => {
      _currentUser = user;
      unsub();
      // Subsequent changes notify subscribers (e.g. sign-out from a menu).
      onAuthStateChanged(auth, (u) => {
        _currentUser = u;
        for (const fn of subscribers) fn(u);
      });
      resolve(user);
    });
  });
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
