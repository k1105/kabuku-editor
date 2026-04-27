/**
 * Inline SVG icon library (Lucide-style: 24×24, 1.75 stroke, currentColor).
 *
 * Usage: `iconEl('paintbrush')` returns an <svg> element ready to append.
 * Add a wrapping <span class="icon"> via `iconEl('paintbrush', 'icon')`.
 */
const PATHS = {
  // navigation / pages
  arrowLeft:  '<path d="M19 12H5"/><path d="M12 19l-7-7 7-7"/>',
  chevronLeft:  '<path d="M15 18l-6-6 6-6"/>',
  chevronRight: '<path d="M9 18l6-6-6-6"/>',

  // file io
  download:   '<path d="M12 3v12"/><path d="M7 10l5 5 5-5"/><path d="M5 21h14"/>',
  upload:     '<path d="M12 21V9"/><path d="M7 14l5-5 5 5"/><path d="M5 3h14"/>',
  imagePlus:  '<rect x="3" y="3" width="18" height="14" rx="2"/><path d="M3 14l5-5 5 5"/><circle cx="15" cy="8.5" r="1.25"/><path d="M16 19h6"/><path d="M19 16v6"/>',
  typeFont:   '<path d="M5 7V5h14v2"/><path d="M9 5v14"/><path d="M15 5v14"/><path d="M7 19h4"/><path d="M13 19h4"/>',

  // tools
  paintbrush: '<path d="M14 4l6 6-9 9-6-6z"/><path d="M11 7l6 6"/><path d="M8 18l-3 3"/>',
  eraser:     '<path d="M3 17l8-8 8 8-4 4H7z"/><path d="M21 21H8"/>',

  // visibility
  eye:        '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff:     '<path d="M3 3l18 18"/><path d="M10.6 6.2C11.06 6.07 11.52 6 12 6c6.5 0 10 6 10 6a17.9 17.9 0 0 1-3.07 3.95"/><path d="M6.6 6.6C3.7 8.6 2 12 2 12s3.5 7 10 7c1.6 0 3-.4 4.3-1"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',

  // actions
  plus:       '<path d="M12 5v14"/><path d="M5 12h14"/>',
  trash:      '<path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>',
  refresh:    '<path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M3 21v-5h5"/>',

  // playback
  play:       '<path d="M6 4l14 8-14 8z"/>',
  pause:      '<path d="M7 4h4v16H7z"/><path d="M13 4h4v16h-4z"/>',

  // history
  undo:       '<path d="M9 14l-5-5 5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>',
  redo:       '<path d="M15 14l5-5-5-5"/><path d="M20 9H9a5 5 0 0 0 0 10h3"/>',

  // misc
  globe:      '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14 14 0 0 1 0 18"/><path d="M12 3a14 14 0 0 0 0 18"/>',
  preview:    '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 9h18"/><circle cx="7" cy="7" r="0.5"/><circle cx="9" cy="7" r="0.5"/>',
  layers:     '<path d="M12 3l9 5-9 5-9-5z"/><path d="M3 13l9 5 9-5"/>',
};

export function iconSvg(name) {
  const inner = PATHS[name];
  if (!inner) return '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
}

export function iconEl(name, extraClass = '') {
  const span = document.createElement('span');
  span.className = `icon ${extraClass}`.trim();
  span.innerHTML = iconSvg(name);
  return span;
}

/**
 * Build a button containing an icon (and optional text label).
 * Text labels still get translated by the i18n pass; icons are decorative.
 */
export function iconButton(name, label, { className = '', title, onClick, withText = false } = {}) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = `icon-btn ${className}`.trim();
  btn.title = title ?? label ?? '';
  if (label) btn.setAttribute('aria-label', label);
  btn.appendChild(iconEl(name));
  if (withText && label) {
    const txt = document.createElement('span');
    txt.className = 'icon-btn-label';
    txt.textContent = label;
    btn.appendChild(txt);
  }
  if (onClick) btn.addEventListener('click', onClick);
  return btn;
}
