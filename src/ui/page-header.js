import { iconButton } from './icons.js';
import * as fontHistory from '../core/history.js';
import * as animHistory from '../core/animation-history.js';
import { createUserBadge } from './auth-gate.js';

/**
 * Shared top header used by font-project editing pages and the animation
 * page.
 *
 *   activePage:    'glyphs' | 'animation' (no longer drives any tab UI; kept
 *                  for callers / potential future use).
 *   fontProjectId: when set, the header drives the font undo/redo stack by
 *                  default. Pass null for the animation page.
 *   title:         page title text (default 'KABUKU Editor').
 *   historyMode:   'font' | 'animation' | null. Picks which undo/redo stack
 *                  to drive from the header buttons. Defaults to 'font' when
 *                  a fontProjectId is provided, otherwise null (no buttons).
 *
 * Returns { el, headerNav, progressEl }.
 */
export function createPageHeader({
  activePage,
  fontProjectId = null,
  title = 'KABUKU Editor',
  historyMode,
} = {}) {
  const header = document.createElement('div');
  header.className = 'header';

  // Back-to-list button
  const backBtn = iconButton('arrowLeft', 'Projects', { title: 'Back to projects' });
  backBtn.addEventListener('click', () => { location.hash = '#/'; });
  header.appendChild(backBtn);

  const titleEl = document.createElement('h1');
  titleEl.textContent = title;
  header.appendChild(titleEl);

  // Optional progress bar (used by Auto Mesh All, image import, etc.)
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

  // (Former Glyphs/Compose tabs removed: Compose is now a panel inside the
  // glyph editor, leaving a single destination — so the header tab group is
  // gone.)

  const headerNav = document.createElement('div');
  headerNav.className = 'header-nav';

  // Resolve which history module the buttons drive.
  const resolvedMode = historyMode ?? (fontProjectId ? 'font' : null);
  const historyMod = resolvedMode === 'animation'
    ? animHistory
    : resolvedMode === 'font'
      ? fontHistory
      : null;

  if (historyMod) {
    const undoBtn = iconButton('undo', 'Undo', { title: 'Undo (⌘Z)' });
    undoBtn.addEventListener('click', () => historyMod.undo());
    const redoBtn = iconButton('redo', 'Redo', { title: 'Redo (⌘⇧Z)' });
    redoBtn.addEventListener('click', () => historyMod.redo());
    headerNav.appendChild(undoBtn);
    headerNav.appendChild(redoBtn);
    let unsub;
    unsub = historyMod.subscribe(({ canUndo, canRedo }) => {
      if (!header.isConnected) { unsub?.(); return; }
      undoBtn.disabled = !canUndo;
      redoBtn.disabled = !canRedo;
    });
  }

  headerNav.appendChild(createUserBadge());
  header.appendChild(headerNav);

  return {
    el: header,
    headerNav,
    progressEl: { wrap: progressWrap, bar: progressBar, text: progressText },
  };
}
