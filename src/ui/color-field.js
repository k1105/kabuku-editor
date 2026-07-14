/** Labelled <input type=color> row (mirrors form-utils' addNumberField).
 *  Fires onInput on every swatch drag (live preview) and onChange when the
 *  picker closes (commit point). Value must be a 7-char hex ('#rrggbb'). */
export function addColorField(parent, label, value, onInput, onChange) {
  const row = document.createElement('div');
  row.className = 'param-row';
  const lbl = document.createElement('label');
  lbl.textContent = label;
  const input = document.createElement('input');
  input.type = 'color';
  input.value = value;
  input.addEventListener('input', () => onInput?.(input.value));
  input.addEventListener('change', () => onChange?.(input.value));
  row.appendChild(lbl);
  row.appendChild(input);
  parent.appendChild(row);
  return input;
}
