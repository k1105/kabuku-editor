import { t } from './i18n.js';

/**
 * Vertical icon-button strip sitting left of the sidebar; each button swaps
 * the sidebar to a dedicated panel. Shared by the font editor and the
 * animation editor. Icons come from Iconify (Lucide set) via the
 * <iconify-icon> web component registered in main.js.
 *
 * @param {Array<{id: string, icon: string, title: string}>} items
 * @param {(id: string) => void} onSelect
 * @returns {{el: HTMLElement, setActive: (id: string) => void}}
 */
export function createIconRail(items, onSelect) {
  const el = document.createElement('div');
  el.className = 'icon-rail';
  const buttons = {};
  for (const item of items) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'rail-btn';
    btn.title = t(item.title);
    btn.setAttribute('aria-label', item.title);
    const ic = document.createElement('iconify-icon');
    ic.setAttribute('icon', item.icon);
    btn.appendChild(ic);
    btn.addEventListener('click', () => onSelect(item.id));
    buttons[item.id] = btn;
    el.appendChild(btn);
  }
  function setActive(id) {
    for (const [bid, btn] of Object.entries(buttons)) {
      btn.classList.toggle('active', bid === id);
    }
  }
  return { el, setActive };
}
