import { renderIndexPage } from './pages/index-page.js';
import { renderEditPage } from './pages/edit-page.js';
import { renderComposePage } from './pages/compose-page.js';
import { renderAnimationPage } from './pages/animation-page.js';
import { startAutoTranslate, createLangToggle } from './ui/i18n.js';

function getRoute() {
  const hash = location.hash || '#/';
  if (hash === '#/compose') return { page: 'compose' };
  if (hash === '#/animation') return { page: 'animation' };
  const match = hash.match(/^#\/edit\/(.+)$/);
  if (match) {
    return { page: 'edit', charId: decodeURIComponent(match[1]) };
  }
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
  } else if (route.page === 'edit') {
    renderEditPage(app, route.charId);
  } else {
    renderIndexPage(app);
  }

  injectLangToggle(app);
}

window.addEventListener('hashchange', render);
render();
startAutoTranslate(document.getElementById('app'));
