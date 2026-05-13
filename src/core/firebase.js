/**
 * Firebase SDK init. Reads VITE_FIREBASE_* env vars; throws on the project
 * list page if any are missing so the user gets a clear setup hint.
 */
import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';
import { getStorage } from 'firebase/storage';

const cfg = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

export function isFirebaseConfigured() {
  return !!(cfg.apiKey && cfg.authDomain && cfg.projectId && cfg.storageBucket && cfg.appId);
}

let _app = null;
let _auth = null;
let _db = null;
let _storage = null;

export function getApp() {
  if (!_app) {
    if (!isFirebaseConfigured()) {
      throw new Error('Firebase が未設定です。プロジェクトルートの .env を確認してください。');
    }
    _app = initializeApp(cfg);
  }
  return _app;
}

export function getFirebaseAuth() {
  if (!_auth) _auth = getAuth(getApp());
  return _auth;
}

export function getDb() {
  if (!_db) _db = getFirestore(getApp());
  return _db;
}

export function getBucket() {
  if (!_storage) _storage = getStorage(getApp());
  return _storage;
}
