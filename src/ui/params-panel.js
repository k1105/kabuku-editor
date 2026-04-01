/**
 * Creates slider UI for grid parameters.
 */
export function createParamsPanel(paramDefs, values, onChange) {
  const el = document.createElement('div');
  el.className = 'param-group';

  function render() {
    el.innerHTML = '';
    const title = document.createElement('h3');
    title.textContent = 'Grid Parameters';
    el.appendChild(title);

    for (const def of paramDefs) {
      const row = document.createElement('div');
      row.className = 'param-row';

      const label = document.createElement('label');
      label.textContent = def.label;

      const input = document.createElement('input');
      input.type = 'range';
      input.min = def.min;
      input.max = def.max;
      input.step = def.step;
      input.value = values[def.key] ?? def.default;

      const valSpan = document.createElement('span');
      valSpan.className = 'value';
      valSpan.textContent = input.value;

      input.addEventListener('input', () => {
        const v = parseFloat(input.value);
        values[def.key] = v;
        valSpan.textContent = v;
        onChange(def.key, v);
      });

      row.appendChild(label);
      row.appendChild(input);
      row.appendChild(valSpan);
      el.appendChild(row);
    }
  }

  render();

  return {
    el,
    update(newParamDefs, newValues) {
      paramDefs = newParamDefs;
      values = newValues;
      render();
    },
  };
}

/**
 * Creates slider UI for global stretch parameters (shared across all characters).
 */
export function createStretchPanel(global, onChange) {
  const el = document.createElement('div');
  el.className = 'param-group';

  const defs = [
    { key: 'stretchAngle', label: 'Stretch Angle', min: 0, max: 180, default: 0, step: 1 },
    { key: 'stretchAmount', label: 'Stretch Amount', min: 0, max: 2, default: 0, step: 0.05 },
  ];

  function render() {
    el.innerHTML = '';
    const title = document.createElement('h3');
    title.textContent = 'Stretch (Global)';
    el.appendChild(title);

    for (const def of defs) {
      const row = document.createElement('div');
      row.className = 'param-row';

      const label = document.createElement('label');
      label.textContent = def.label;

      const input = document.createElement('input');
      input.type = 'range';
      input.min = def.min;
      input.max = def.max;
      input.step = def.step;
      input.value = global[def.key] ?? def.default;

      const valSpan = document.createElement('span');
      valSpan.className = 'value';
      valSpan.textContent = input.value;

      input.addEventListener('input', () => {
        const v = parseFloat(input.value);
        global[def.key] = v;
        valSpan.textContent = v;
        onChange(def.key, v);
      });

      row.appendChild(label);
      row.appendChild(input);
      row.appendChild(valSpan);
      el.appendChild(row);
    }
  }

  render();
  return { el, render };
}

/**
 * Creates slider UI for per-character transform parameters.
 */
export function createTransformPanel(transform, onChange) {
  const el = document.createElement('div');
  el.className = 'param-group';

  const defs = [
    { key: 'baseGap', label: 'Gap', min: 0, max: 20, default: 0, step: 0.5 },
    { key: 'gapDirectionWeight', label: 'Gap Dir Weight', min: 0, max: 1, default: 0, step: 0.05 },
    { key: 'metaballRadius', label: 'Blur', min: 0, max: 30, default: 10, step: 1 },
    { key: 'metaballStrength', label: 'Contrast', min: 0, max: 1, default: 0, step: 0.05 },
  ];

  function render() {
    el.innerHTML = '';
    const title = document.createElement('h3');
    title.textContent = 'Transform';
    el.appendChild(title);

    for (const def of defs) {
      const row = document.createElement('div');
      row.className = 'param-row';

      const label = document.createElement('label');
      label.textContent = def.label;

      const input = document.createElement('input');
      input.type = 'range';
      input.min = def.min;
      input.max = def.max;
      input.step = def.step;
      input.value = transform[def.key] ?? def.default;

      const valSpan = document.createElement('span');
      valSpan.className = 'value';
      valSpan.textContent = input.value;

      input.addEventListener('input', () => {
        const v = parseFloat(input.value);
        transform[def.key] = v;
        valSpan.textContent = v;
        onChange(def.key, v);
      });

      row.appendChild(label);
      row.appendChild(input);
      row.appendChild(valSpan);
      el.appendChild(row);
    }
  }

  render();
  return { el, render };
}
