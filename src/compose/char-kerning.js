/**
 * Per-character kerning (文字個別の字間調整), shared by the compose panel and
 * the animation editor.
 *
 * Values are stored in EM units (fraction of fontSize) so they scale with the
 * font size, and are ADDED on top of the global Kerning (字間) property — the
 * two never overwrite each other. `charKerning[i]` is the extra advance after
 * the i-th code point of the text (indexing includes '\n', which itself never
 * advances).
 *
 * Adjustment UI: Option/Alt + ←→ in a text field nudges the gap at the caret
 * (between the characters on either side of it); with a selection, every gap
 * between the selected characters is nudged (tracking-style). Shift multiplies
 * the step.
 */

export const KERN_STEP = 0.02;       // em per keypress
export const KERN_STEP_LARGE = 0.1;  // em per keypress with Shift

/**
 * Kerning indices targeted by the current caret / selection.
 * `selStart` / `selEnd` are UTF-16 offsets (textarea.selectionStart/End);
 * returned indices are code-point positions (the unit layoutText iterates in).
 * A gap is adjustable only when characters exist on both sides and neither is
 * a newline (there is no visible gap across a line break).
 */
export function kernIndicesForSelection(text, selStart, selEnd) {
  const cps = [...text];
  const cpIndex = (u) => [...text.slice(0, u)].length;
  const valid = (i) => i >= 0 && i + 1 < cps.length && cps[i] !== '\n' && cps[i + 1] !== '\n';
  if (selStart === selEnd) {
    const i = cpIndex(selStart) - 1;
    return valid(i) ? [i] : [];
  }
  const s = cpIndex(selStart);
  const e = cpIndex(selEnd);
  const out = [];
  for (let i = s; i < e - 1; i++) if (valid(i)) out.push(i);
  return out;
}

/**
 * Return a new kerning array (length = textLen) with `delta` em added at each
 * of `indices`. Values are rounded to 3 decimals to avoid float drift.
 */
export function applyKernDelta(kern, indices, delta, textLen) {
  const next = [];
  for (let i = 0; i < textLen; i++) next.push((Array.isArray(kern) && kern[i]) || 0);
  for (const i of indices) {
    if (i >= 0 && i < textLen) next[i] = Math.round((next[i] + delta) * 1000) / 1000;
  }
  return next;
}

/**
 * Re-align a kerning array after a text edit so per-character settings stick
 * to their characters. The edit is located via common prefix/suffix (which
 * covers a textarea's single insert/delete/replace); inserted characters get
 * 0, removed characters drop their entries. Returns a new array whose length
 * equals the new text's code-point count.
 */
export function remapCharKerning(oldText, newText, kern) {
  if (!Array.isArray(kern) || kern.length === 0) return [];
  const a = [...(oldText || '')];
  const b = [...(newText || '')];
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  const removed = a.length - p - s;
  const inserted = b.length - p - s;
  const next = [];
  for (let i = 0; i < p; i++) next.push(kern[i] || 0);
  for (let i = 0; i < inserted; i++) next.push(0);
  for (let i = p + removed; i < a.length; i++) next.push(kern[i] || 0);
  return next;
}

/**
 * Wire Option/Alt+←→ (Shift for the large step) on a textarea. `getKerning`
 * returns the current array, `setKerning` stores the adjusted copy, and
 * `onAdjust(indices, next, delta)` lets the caller persist/redraw/hint.
 * When the caret has no adjustable gap the event is left to the browser
 * (default word-jump caret movement).
 */
export function attachCharKerningKeys(textarea, { getKerning, setKerning, onAdjust }) {
  textarea.addEventListener('keydown', (e) => {
    if (!e.altKey || e.metaKey || e.ctrlKey) return;
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const text = textarea.value;
    const indices = kernIndicesForSelection(text, textarea.selectionStart, textarea.selectionEnd);
    if (indices.length === 0) return;
    e.preventDefault();
    const delta = (e.key === 'ArrowRight' ? 1 : -1) * (e.shiftKey ? KERN_STEP_LARGE : KERN_STEP);
    const next = applyKernDelta(getKerning(), indices, delta, [...text].length);
    setKerning(next);
    onAdjust?.(indices, next, delta);
  });
}

/** Human-readable summary of an adjustment, e.g. 「あ」「い」 +0.04em. */
export function kernHintText(text, indices, kern) {
  const cps = [...text];
  const fmt = (v) => `${v > 0 ? '+' : ''}${Math.round(v * 1000) / 1000}em`;
  if (indices.length === 1) {
    const i = indices[0];
    return `「${cps[i]}」「${cps[i + 1]}」 ${fmt(kern[i] || 0)}`;
  }
  return `${indices.length}箇所 ${fmt(kern[indices[0]] || 0)}`;
}

/**
 * Transient overlay showing the latest kerning value over a canvas area.
 * `parent` must be positioned (both canvas areas are position:relative).
 */
export function createKernHint(parent) {
  const el = document.createElement('div');
  el.className = 'kern-hint';
  el.style.display = 'none';
  parent.appendChild(el);
  let timer = null;
  return {
    show(text) {
      el.textContent = text;
      el.style.display = '';
      clearTimeout(timer);
      timer = setTimeout(() => { el.style.display = 'none'; }, 1400);
    },
    destroy() {
      clearTimeout(timer);
      el.remove();
    },
  };
}
