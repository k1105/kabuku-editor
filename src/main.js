import { renderIndexPage } from './pages/index-page.js';
import { renderComposePage } from './pages/compose-page.js';
import { renderAnimationPage } from './pages/animation-page.js';
import { renderProjectListPage } from './pages/project-list-page.js';
import { startAutoTranslate, createLangToggle } from './ui/i18n.js';
import {
  loadProject, bootFontProject, unloadFontProject, flushNow as flushFontNow,
} from './core/project.js';
import {
  bootAnimationProject, unloadAnimationProject, flushNow as flushAnimNow,
  getAnimation,
} from './core/animation-project.js';
import {
  initHistory, commit as fontCommit, undo as fontUndo, redo as fontRedo,
  subscribe as subscribeFontHistory,
} from './core/history.js';
import {
  initAnimationHistory, commit as animCommit, undo as animUndo, redo as animRedo,
  subscribe as subscribeAnimHistory, resetAnimationHistory,
} from './core/animation-history.js';
import { isFirebaseConfigured } from './core/firebase.js';
import { waitForAuth } from './core/auth.js';
import { renderSetupRequiredScreen, renderLoginScreen } from './ui/auth-gate.js';
import { acquireEditLock, releaseEditLock, checkEditLock } from './core/edit-lock.js';

/**
 * Route shape:
 *   #/                     → project list
 *   #/font/{id}            → font edit page (a.k.a. index-page)
 *   #/font/{id}/compose    → compose page (uses the font as its typeset)
 *   #/animation/{id}       → animation page
 *
 * Older routes (#/compose, #/animation without id) are rewritten to the
 * project list so stale bookmarks don't error out.
 */
function getRoute() {
  const hash = location.hash || '#/';
  let m;
  if ((m = hash.match(/^#\/font\/([^/]+)\/compose\/?$/))) {
    return { page: 'compose', fontProjectId: decodeURIComponent(m[1]) };
  }
  if ((m = hash.match(/^#\/font\/([^/]+)\/?$/))) {
    return { page: 'font', fontProjectId: decodeURIComponent(m[1]) };
  }
  if ((m = hash.match(/^#\/animation\/([^/]+)\/?$/))) {
    return { page: 'animation', animationProjectId: decodeURIComponent(m[1]) };
  }
  return { page: 'list' };
}

function isAnimationRoute() {
  return (location.hash || '').startsWith('#/animation/');
}

function injectLangToggle(app) {
  const header = app.querySelector('.header');
  if (!header) return;
  const headerNav = header.querySelector('.header-nav');
  (headerNav || header).appendChild(createLangToggle());
}

function showLoading(app, msg = 'Loading...') {
  app.innerHTML = `<div class="loading-screen"><div class="loading-card"><p>${msg}</p></div></div>`;
}

// Track which project type is currently active so we can release locks on
// navigation. Strings ('fontProjects' / 'animationProjects') match the
// Firestore collection names used by edit-lock.
let _activeLockColl = null;
let _activeLockId = null;

async function setActiveLock(coll, id) {
  if (_activeLockColl && (_activeLockColl !== coll || _activeLockId !== id)) {
    await releaseEditLock();
  }
  _activeLockColl = coll;
  _activeLockId = id;
  if (coll && id) await acquireEditLock(coll, id);
}

async function maybeWarnLock(coll, id) {
  try {
    const lock = await checkEditLock(coll, id);
    if (!lock) return true;
    return confirm(`${lock.name} さんが編集中です。続行しますか? (同時編集すると変更が上書きされる可能性があります)`);
  } catch {
    return true; // network failure → don't block
  }
}

async function render() {
  const app = document.getElementById('app');
  app.innerHTML = '';

  if (!isFirebaseConfigured()) {
    renderSetupRequiredScreen(app);
    return;
  }

  showLoading(app, 'Authenticating...');
  const user = await waitForAuth();
  if (!user) {
    renderLoginScreen(app, () => render());
    return;
  }

  const route = getRoute();

  if (route.page === 'list') {
    await unloadFontProject();
    await unloadAnimationProject();
    await setActiveLock(null, null);
    resetAnimationHistory();
    await renderProjectListPage(app);
    injectLangToggle(app);
    return;
  }

  if (route.page === 'font' || route.page === 'compose') {
    showLoading(app, 'Loading typeset...');
    try {
      const ok = await maybeWarnLock('fontProjects', route.fontProjectId);
      if (!ok) { location.hash = '#/'; return; }
      await unloadAnimationProject();
      await bootFontProject(route.fontProjectId);
      await setActiveLock('fontProjects', route.fontProjectId);
    } catch (e) {
      console.error(e);
      alert(`プロジェクトの読み込みに失敗しました: ${e.message}`);
      location.hash = '#/';
      return;
    }
    initHistory(loadProject());
    resetAnimationHistory();
    app.innerHTML = '';
    if (route.page === 'compose') renderComposePage(app);
    else renderIndexPage(app);
    injectLangToggle(app);
    return;
  }

  if (route.page === 'animation') {
    showLoading(app, 'Loading animation...');
    try {
      const ok = await maybeWarnLock('animationProjects', route.animationProjectId);
      if (!ok) { location.hash = '#/'; return; }
      await unloadFontProject();
      await bootAnimationProject(route.animationProjectId);
      await setActiveLock('animationProjects', route.animationProjectId);
    } catch (e) {
      console.error(e);
      alert(`Animation の読み込みに失敗しました: ${e.message}`);
      location.hash = '#/';
      return;
    }
    // Each page owns its own history stack — clear the other so stale
    // snapshots can't sneak into keyboard shortcuts.
    initHistory(loadProject());
    initAnimationHistory(getAnimation());
    app.innerHTML = '';
    renderAnimationPage(app);
    injectLangToggle(app);
    return;
  }

  // Fallback
  location.hash = '#/';
}

window.addEventListener('hashchange', render);
render();
startAutoTranslate(document.getElementById('app'));

// Re-render on undo/redo restore. Both histories trigger the same re-render
// path — the active one (per route) is the only one that fires meaningfully,
// since we reset the other on navigation.
let pendingRender = false;
function scheduleRender({ isRestore }) {
  if (!isRestore) return;
  if (pendingRender) return;
  pendingRender = true;
  queueMicrotask(() => { pendingRender = false; render(); });
}
subscribeFontHistory(scheduleRender);
subscribeAnimHistory(scheduleRender);

// Delegated commit on input commits (range release, number/text blur, select).
// Dispatch to whichever history is currently active for the route — font edit
// pages drive history.js, the animation page drives animation-history.js.
function activeCommit(label) {
  if (isAnimationRoute()) return animCommit(label);
  return fontCommit(label);
}

document.addEventListener('change', (e) => {
  const t = e.target;
  if (!t || !t.matches?.('input, select, textarea')) return;
  queueMicrotask(() => activeCommit(`change:${t.name || t.type || t.tagName}`));
}, false);

function isInputTarget(t) {
  if (!t) return false;
  const tag = t.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (t.isContentEditable) return true;
  return false;
}

document.addEventListener('keydown', (e) => {
  const meta = e.metaKey || e.ctrlKey;
  if (!meta) return;
  const key = e.key.toLowerCase();
  if (key === 'z') {
    if (isInputTarget(e.target)) return;
    e.preventDefault();
    if (isAnimationRoute()) {
      if (e.shiftKey) animRedo(); else animUndo();
    } else {
      if (e.shiftKey) fontRedo(); else fontUndo();
    }
  } else if (key === 'y') {
    if (isInputTarget(e.target)) return;
    e.preventDefault();
    if (isAnimationRoute()) animRedo();
    else fontRedo();
  }
});

// Best-effort flush on unload (most browsers don't await async work here,
// but Firestore batches the request into the queue).
window.addEventListener('beforeunload', () => {
  flushFontNow();
  flushAnimNow();
});

// Backward-compat re-export: pages that pulled the font-side `commit` from
// main.js (rather than directly from core/history.js) keep working.
export { fontCommit as commit };
