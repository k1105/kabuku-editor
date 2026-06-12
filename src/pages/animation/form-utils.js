/** Labelled <input type=number> row that fires onChange with a parsed float. */
export function addNumberField(parent, label, value, min, max, step, onChange) {
  const row = document.createElement('div');
  row.className = 'param-row';
  const lbl = document.createElement('label');
  lbl.textContent = label;
  const input = document.createElement('input');
  input.type = 'number';
  input.min = min;
  input.max = max;
  input.step = step;
  input.value = value;
  input.addEventListener('change', () => {
    const v = parseFloat(input.value);
    if (!Number.isFinite(v)) return;
    onChange(v);
  });
  row.appendChild(lbl);
  row.appendChild(input);
  parent.appendChild(row);
  return input;
}
