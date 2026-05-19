/**
 * Paired range slider + numeric input.
 *
 * The slider stays visually clamped to its declared [min, max]; the numeric
 * input accepts any real value the user types. For mathematically bounded
 * parameters (angles, probabilities, normalized fractions) pass `hardMin` /
 * `hardMax` to clamp the value on commit.
 *
 * Returns { slider, valueInput, getValue, setValue }.
 *   - getValue(): current logical value (may exceed slider's [min, max])
 *   - setValue(v): updates both inputs without firing onInput / onChange
 *
 * Callbacks:
 *   - onInput(v): fired while dragging the slider OR when the value input is
 *     committed (Enter / blur).
 *   - onChange(v): fired on slider 'change' (mouseup) OR value input commit.
 *
 * Empty / non-finite text in the value input reverts to the current value.
 */
export function createSliderInput({
  min, max, step,
  value,
  hardMin, hardMax,
  formatter,
  onInput,
  onChange,
}) {
  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = min;
  slider.max = max;
  slider.step = step;

  const valueInput = document.createElement('input');
  valueInput.type = 'number';
  valueInput.className = 'value';
  valueInput.step = 'any';
  valueInput.inputMode = 'decimal';

  const sMin = parseFloat(min);
  const sMax = parseFloat(max);

  const fmt = formatter || defaultFormatter(step);

  let current = Number.isFinite(parseFloat(value)) ? parseFloat(value) : 0;

  function clampToSlider(v) {
    let s = v;
    if (Number.isFinite(sMin) && s < sMin) s = sMin;
    if (Number.isFinite(sMax) && s > sMax) s = sMax;
    return s;
  }

  function applyHardClamp(v) {
    let r = v;
    if (hardMin !== undefined && r < hardMin) r = hardMin;
    if (hardMax !== undefined && r > hardMax) r = hardMax;
    return r;
  }

  function paint() {
    slider.value = String(clampToSlider(current));
    valueInput.value = fmt(current);
  }

  paint();

  slider.addEventListener('input', () => {
    current = parseFloat(slider.value);
    valueInput.value = fmt(current);
    onInput?.(current);
  });
  slider.addEventListener('change', () => {
    onChange?.(current);
  });

  function commitInput() {
    const raw = valueInput.value;
    if (raw === '' || raw === '-') {
      valueInput.value = fmt(current);
      return;
    }
    let v = parseFloat(raw);
    if (!Number.isFinite(v)) {
      valueInput.value = fmt(current);
      return;
    }
    v = applyHardClamp(v);
    if (v === current) {
      valueInput.value = fmt(current);
      return;
    }
    current = v;
    slider.value = String(clampToSlider(v));
    valueInput.value = fmt(v);
    onInput?.(current);
    onChange?.(current);
  }

  valueInput.addEventListener('change', commitInput);
  valueInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      valueInput.blur();
    }
  });

  return {
    slider,
    valueInput,
    getValue: () => current,
    setValue(v) {
      if (!Number.isFinite(v)) return;
      current = v;
      paint();
    },
  };
}

function defaultFormatter(step) {
  const s = parseFloat(step);
  if (!Number.isFinite(s) || s >= 1) {
    return (v) => Number.isInteger(v) ? String(v) : String(+v.toFixed(2));
  }
  const decimals = Math.min(4, Math.max(1, -Math.floor(Math.log10(s))));
  return (v) => (+v.toFixed(decimals)).toString();
}
