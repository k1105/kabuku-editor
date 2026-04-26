import { iconEl } from './icons.js';

/**
 * Build the shared top header used across all pages.
 *
 *   activePage: 'index' | 'compose' | 'animation'
 *   title: optional override for the H1 (defaults to "KABUKU Editor")
 *
 * Returns { el, headerNav, progressEl } where:
 *   - el         the <header> element ready to append to <#app>
 *   - headerNav  the right-side actions container (caller appends buttons)
 *   - progressEl an optional centered progress bar (initially hidden)
 *
 * The lang toggle is injected separately by main.js into `.header-nav`.
 */
export function createPageHeader({ activePage, title = 'KABUKU Editor' } = {}) {
  const header = document.createElement('div');
  header.className = 'header';

  const titleEl = document.createElement('h1');
  titleEl.textContent = title;
  header.appendChild(titleEl);

  // Optional progress bar (used by index for Auto Mesh All / image import)
  const progressWrap = document.createElement('div');
  progressWrap.className = 'import-progress';
  progressWrap.style.display = 'none';
  const progressTrack = document.createElement('div');
  progressTrack.className = 'import-progress-track';
  const progressBar = document.createElement('div');
  progressBar.className = 'import-progress-bar';
  progressTrack.appendChild(progressBar);
  const progressText = document.createElement('span');
  progressText.className = 'import-progress-text';
  progressWrap.appendChild(progressTrack);
  progressWrap.appendChild(progressText);
  header.appendChild(progressWrap);

  // Centered tabs
  const tabs = document.createElement('nav');
  tabs.className = 'header-tabs';

  const TABS = [
    { id: 'index',     label: 'Glyphs',    icon: 'layers',  hash: '#/' },
    { id: 'compose',   label: 'Compose',   icon: 'preview', hash: '#/compose' },
    { id: 'animation', label: 'Animation', icon: 'play',    hash: '#/animation' },
  ];
  for (const t of TABS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'header-tab' + (t.id === activePage ? ' active' : '');
    btn.appendChild(iconEl(t.icon));
    const lbl = document.createElement('span');
    lbl.textContent = t.label;
    btn.appendChild(lbl);
    btn.addEventListener('click', () => { location.hash = t.hash; });
    tabs.appendChild(btn);
  }
  header.appendChild(tabs);

  // Right-side actions slot (lang toggle injected here by main.js)
  const headerNav = document.createElement('div');
  headerNav.className = 'header-nav';
  header.appendChild(headerNav);

  return {
    el: header,
    headerNav,
    progressEl: { wrap: progressWrap, bar: progressBar, text: progressText },
  };
}
