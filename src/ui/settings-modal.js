import { iconButton, iconEl } from './icons.js';

/**
 * The shared Settings modal (backdrop + panel + header), used by the font
 * editor and the animation editor. Controls inside apply live, so there's no
 * confirm/cancel — just open() / close().
 *
 * Returns:
 *   - el:              backdrop element; append to the page once.
 *   - body:            scrollable modal body to fill with groups.
 *   - open(), close()
 *   - addGroup(title): append a `.param-group` (with an <h3>) and return it.
 *   - destroy():       remove the Escape listener (call on page teardown).
 *
 * Closes on outside-click and, when `closeOnEscape` is set, on Escape.
 */
export function createSettingsModal({ title = 'Settings', closeOnEscape = false } = {}) {
  const backdrop = document.createElement('div');
  backdrop.className = 'settings-modal-backdrop';
  backdrop.style.display = 'none';

  const modal = document.createElement('div');
  modal.className = 'settings-modal';
  backdrop.appendChild(modal);

  const head = document.createElement('div');
  head.className = 'settings-modal-head';
  const titleEl = document.createElement('h2');
  titleEl.textContent = title;
  const closeBtn = iconButton('close', 'Close', { title: 'Close' });
  closeBtn.addEventListener('click', () => close());
  head.appendChild(titleEl);
  head.appendChild(closeBtn);
  modal.appendChild(head);

  const body = document.createElement('div');
  body.className = 'settings-modal-body';
  modal.appendChild(body);

  function open() { backdrop.style.display = 'flex'; }
  function close() { backdrop.style.display = 'none'; }
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) close();
  });

  let onKeyDown = null;
  if (closeOnEscape) {
    onKeyDown = (e) => {
      if (e.key === 'Escape' && backdrop.style.display !== 'none') close();
    };
    document.addEventListener('keydown', onKeyDown);
  }
  function destroy() {
    if (onKeyDown) document.removeEventListener('keydown', onKeyDown);
  }

  function addGroup(groupTitle) {
    const g = document.createElement('div');
    g.className = 'param-group';
    const h = document.createElement('h3');
    h.textContent = groupTitle;
    g.appendChild(h);
    body.appendChild(g);
    return g;
  }

  return { el: backdrop, body, open, close, destroy, addGroup };
}

/** A labelled icon button (icon + text) for the settings modal's button rows. */
export function settingsToolBtn(icon, label, onClick) {
  const btn = document.createElement('button');
  btn.className = 'tool-btn';
  btn.appendChild(iconEl(icon));
  const span = document.createElement('span');
  span.textContent = label;
  btn.appendChild(span);
  btn.addEventListener('click', onClick);
  return btn;
}
