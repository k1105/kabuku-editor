import { renderIndexPage } from './pages/index-page.js';
import { renderComposePage } from './pages/compose-page.js';
import { renderAnimationPage } from './pages/animation-page.js';
import { startAutoTranslate, createLangToggle } from './ui/i18n.js';
import { loadProject } from './core/project.js';
import { initHistory, commit, undo, redo, subscribe } from './core/history.js';

function getRoute() {
  const hash = location.hash || '#/';
  if (hash === '#/compose') return { page: 'compose' };
  if (hash === '#/animation') return { page: 'animation' };
  return { page: 'index' };
}

function injectLangToggle(app) {
  const header = app.querySelector('.header');
  if (!header) return;
  const headerNav = header.querySelector('.header-nav');
  (headerNav || header).appendChild(createLangToggle());
}

function render() {
  const app = document.getElementById('app');
  app.innerHTML = '';
  const route = getRoute();

  if (route.page === 'compose') {
    renderComposePage(app);
  } else if (route.page === 'animation') {
    renderAnimationPage(app);
  } else {
    renderIndexPage(app);
  }

  injectLangToggle(app);
}

initHistory(loadProject());

window.addEventListener('hashchange', render);
render();
startAutoTranslate(document.getElementById('app'));

// Re-render only on undo/redo (when localStorage was rewritten). Defer to a
// microtask so the original handler can return before the DOM is rebuilt.
let pendingRender = false;
subscribe(({ isRestore }) => {
  if (!isRestore) return;
  if (pendingRender) return;
  pendingRender = true;
  queueMicrotask(() => { pendingRender = false; render(); });
});

// Delegated commit on input commits (range release, number/text blur, select).
// Listen on capture so the snapshot is taken AFTER the element handlers ran
// their own save logic on bubble.
document.addEventListener('change', (e) => {
  const t = e.target;
  if (!t || !t.matches?.('input, select, textarea')) return;
  // 'input' event is too noisy (per-keystroke); 'change' is the natural
  // commit boundary the browser provides for sliders, numbers, text, select.
  queueMicrotask(() => commit(`change:${t.name || t.type || t.tagName}`));
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
    if (e.shiftKey) redo(); else undo();
  } else if (key === 'y') {
    if (isInputTarget(e.target)) return;
    e.preventDefault();
    redo();
  }
});

// Expose for page modules that need to commit on non-input events
// (paint mouseup, button clicks). Pages import `commit` directly via history.js.
export { commit };
