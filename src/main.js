import { renderIndexPage } from './pages/index-page.js';
import { renderEditPage } from './pages/edit-page.js';

function getRoute() {
  const hash = location.hash || '#/';
  const match = hash.match(/^#\/edit\/(.+)$/);
  if (match) {
    return { page: 'edit', charId: decodeURIComponent(match[1]) };
  }
  return { page: 'index' };
}

function render() {
  const app = document.getElementById('app');
  app.innerHTML = '';
  const route = getRoute();

  if (route.page === 'edit') {
    renderEditPage(app, route.charId);
  } else {
    renderIndexPage(app);
  }
}

window.addEventListener('hashchange', render);
render();
