import 'iconify-icon';
import { renderIndexPage } from './pages/index-page.js';
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
 *   #/font/{id}            → font edit page (a.k.a. index-page; Compose lives
 *                            inside it as a sidebar panel)
 *   #/animation/{id}       → animation page
 *
 * The old #/font/{id}/compose route is rewritten to the font edit page so
 * stale bookmarks still resolve (Compose was merged into the editor).
 */
function getRoute() {
  const hash = location.hash || '#/';
  let m;
  if ((m = hash.match(/^#\/font\/([^/]+)\/compose\/?$/))) {
    return { page: 'font', fontProjectId: decodeURIComponent(m[1]) };
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
  // Pages with a Settings panel host the language toggle inside it (gear menu)
  // instead of cluttering the header.
  if (app.querySelector('.settings-modal')) return;
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

// The currently active route. Cached so undo/redo can re-render the page
// without re-running the bootstrap flow (which would re-authenticate,
// re-fetch the project from Firestore, and reset the undo/redo stack).
let _activeRoute = null;
// Optional in-place refresh callback returned by the active page. When set,
// undo/redo calls it instead of tearing down and rebuilding the page DOM.
let _activePageRefresh = null;

function renderActivePage(app, route) {
  if (route.page !== 'font' && route.page !== 'animation') return;
  app.innerHTML = '';
  let result;
  if (route.page === 'font') result = renderIndexPage(app);
  else if (route.page === 'animation') result = renderAnimationPage(app);
  injectLangToggle(app);
  _activePageRefresh = result?.refresh || null;
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
    _activeRoute = null;
    renderLoginScreen(app, () => render());
    return;
  }

  const route = getRoute();

  if (route.page === 'list') {
    await unloadFontProject();
    await unloadAnimationProject();
    await setActiveLock(null, null);
    resetAnimationHistory();
    _activeRoute = route;
    _activePageRefresh = null;
    await renderProjectListPage(app);
    injectLangToggle(app);
    return;
  }

  if (route.page === 'font') {
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
    _activeRoute = route;
    renderActivePage(app, route);
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
    _activeRoute = route;
    renderActivePage(app, route);
    return;
  }

  // Fallback
  location.hash = '#/';
}

window.addEventListener('hashchange', render);
render();
startAutoTranslate(document.getElementById('app'));

// Re-render on undo/redo restore. Prefer the active page's in-place
// refresh() hook so the page DOM is reused; fall back to a full
// renderActivePage() when the page hasn't exposed one yet. Coalesce
// rapid undo+redo pairs by accumulating their change sets — partial
// thumbnail refresh still covers every glyph that flipped between calls.
let pendingRender = false;
let pendingChanges = null;
function mergeChanges(dst, src) {
  if (!src) return dst || { changedCharIds: null, removedCharIds: null, globalChanged: true };
  if (!dst) return src;
  dst.globalChanged = dst.globalChanged || src.globalChanged;
  for (const c of src.changedCharIds || []) dst.changedCharIds?.add(c);
  for (const c of src.removedCharIds || []) dst.removedCharIds?.add(c);
  return dst;
}
function scheduleRender({ isRestore, changes }) {
  if (!isRestore) return;
  pendingChanges = mergeChanges(pendingChanges, changes);
  if (pendingRender) return;
  pendingRender = true;
  queueMicrotask(() => {
    pendingRender = false;
    const ch = pendingChanges;
    pendingChanges = null;
    if (_activePageRefresh) {
      _activePageRefresh(ch);
      return;
    }
    if (!_activeRoute) return;
    const app = document.getElementById('app');
    renderActivePage(app, _activeRoute);
  });
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

// Only swallow Cmd+Z for surfaces where the browser's native text undo is
// useful. Sliders / selects / checkboxes etc. have no native undo, so we
// still fire the app-level shortcut when focus is on those.
const TEXT_INPUT_TYPES = new Set([
  'text', 'search', 'url', 'email', 'tel', 'password', 'number',
]);
function isInputTarget(t) {
  if (!t) return false;
  if (t.isContentEditable) return true;
  const tag = t.tagName;
  if (tag === 'TEXTAREA') return true;
  if (tag === 'INPUT') {
    const type = (t.type || 'text').toLowerCase();
    return TEXT_INPUT_TYPES.has(type);
  }
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
