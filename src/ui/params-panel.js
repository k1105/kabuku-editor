/**
 * Build the override-state circle button. Always present in the row layout
 * (visibility hidden when off-without-callback) so labels stay aligned.
 * When `isOverridden` is true the circle is filled accent and clicking it
 * triggers `onClick` (intended to reset the override).
 */
function createOverrideBadge(isOverridden, onClick) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'override-badge';
  if (isOverridden) {
    btn.title = 'Click to reset override';
    btn.addEventListener('click', onClick);
  } else {
    btn.classList.add('is-off');
    btn.tabIndex = -1;
  }
  return btn;
}

/**
 * Creates a Global/Local toggle header row.
 * Returns { el, isGlobal() }
 */
function createModeToggle(titleText, initialMode, onToggle) {
  const header = document.createElement('div');
  header.className = 'param-header';

  const title = document.createElement('h3');
  title.textContent = titleText;

  const toggle = document.createElement('button');
  toggle.className = 'mode-toggle';
  let mode = initialMode; // 'global' or 'local'

  function updateToggle() {
    toggle.textContent = mode === 'global' ? 'Global' : 'Local';
    toggle.classList.toggle('mode-global', mode === 'global');
    toggle.classList.toggle('mode-local', mode === 'local');
  }
  updateToggle();

  toggle.addEventListener('click', () => {
    mode = mode === 'global' ? 'local' : 'global';
    updateToggle();
    onToggle(mode);
  });

  header.appendChild(title);
  header.appendChild(toggle);
  return { el: header, isGlobal: () => mode === 'global' };
}

/**
 * Creates slider UI for grid parameters.
 * Supports Global/Local toggle.
 *
 * callbacks:
 *   onLocalChange(key, val)  — edit per-character override
 *   onGlobalChange(key, val) — edit global default
 *   onReset(key)             — reset local override to global
 */
export function createParamsPanel(paramDefs, values, globalDefaults, callbacks) {
  const el = document.createElement('div');
  el.className = 'param-group';
  const localOnly = !!callbacks.localOnly;
  let mode = localOnly ? 'local' : 'global';

  const modeToggle = localOnly ? null : createModeToggle('Grid Parameters', mode, (m) => {
    mode = m;
    render();
  });

  function render() {
    el.innerHTML = '';
    if (modeToggle) {
      el.appendChild(modeToggle.el);
    } else {
      const title = document.createElement('h3');
      title.textContent = 'Grid Parameters';
      el.appendChild(title);
    }

    const isGlobal = mode === 'global';
    const activeValues = isGlobal ? globalDefaults : values;

    for (const def of paramDefs) {
      const row = document.createElement('div');
      row.className = 'param-row';

      const isOverridden = !isGlobal && globalDefaults && def.key in globalDefaults &&
        values[def.key] !== undefined && values[def.key] !== globalDefaults[def.key];

      const badge = createOverrideBadge(isOverridden, () => {
        callbacks.onReset?.(def.key);
        render();
      });

      const label = document.createElement('label');
      label.textContent = def.label;
      if (isOverridden) label.classList.add('overridden');

      const input = document.createElement('input');
      input.type = 'range';
      input.min = def.min;
      input.max = def.max;
      input.step = def.step;
      input.value = activeValues[def.key] ?? def.default;

      const valSpan = document.createElement('span');
      valSpan.className = 'value';
      valSpan.textContent = input.value;

      input.addEventListener('input', () => {
        const v = parseFloat(input.value);
        valSpan.textContent = v;
        if (isGlobal) {
          callbacks.onGlobalChange(def.key, v);
        } else {
          activeValues[def.key] = v;
          callbacks.onLocalChange(def.key, v);
        }
      });

      row.appendChild(badge);
      row.appendChild(label);
      row.appendChild(input);
      row.appendChild(valSpan);

      el.appendChild(row);
    }
  }

  render();

  return {
    el,
    update(newParamDefs, newValues, newGlobalDefaults) {
      paramDefs = newParamDefs;
      values = newValues;
      if (newGlobalDefaults !== undefined) globalDefaults = newGlobalDefaults;
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
 * Creates slider UI for transform parameters.
 * Supports Global/Local toggle.
 *
 * callbacks:
 *   onLocalChange(key, val)  — edit per-character override
 *   onGlobalChange(key, val) — edit global default
 *   onReset(key)             — reset local override to global
 */
export function createTransformPanel(transform, globalValues, callbacks) {
  const el = document.createElement('div');
  el.className = 'param-group';
  const localOnly = !!callbacks.localOnly;
  let mode = localOnly ? 'local' : 'global';

  const sliderDefs = [
    { key: 'baseGap', label: 'Gap', min: 0, max: 20, default: 0, step: 0.5 },
    { key: 'gapDirectionWeight', label: 'Gap Dir Weight', min: 0, max: 1, default: 0, step: 0.05 },
    { key: 'metaballRadius', label: 'Blur', min: 0, max: 30, default: 10, step: 1 },
  ];

  const modeToggle = localOnly ? null : createModeToggle('Transform', mode, (m) => {
    mode = m;
    render();
  });

  function render() {
    el.innerHTML = '';
    if (modeToggle) {
      el.appendChild(modeToggle.el);
    } else {
      const title = document.createElement('h3');
      title.textContent = 'Transform (Local Override)';
      el.appendChild(title);
    }

    const isGlobal = mode === 'global';

    for (const def of sliderDefs) {
      const row = document.createElement('div');
      row.className = 'param-row';

      const isOverridden = !isGlobal && globalValues && def.key in globalValues &&
        transform[def.key] !== undefined && transform[def.key] !== globalValues[def.key];

      const badge = createOverrideBadge(isOverridden, () => {
        callbacks.onReset?.(def.key);
        render();
      });

      const label = document.createElement('label');
      label.textContent = def.label;
      if (isOverridden) label.classList.add('overridden');

      const input = document.createElement('input');
      input.type = 'range';
      input.min = def.min;
      input.max = def.max;
      input.step = def.step;
      input.value = isGlobal ? (globalValues[def.key] ?? def.default) : (transform[def.key] ?? def.default);

      const valSpan = document.createElement('span');
      valSpan.className = 'value';
      valSpan.textContent = input.value;

      input.addEventListener('input', () => {
        const v = parseFloat(input.value);
        valSpan.textContent = v;
        if (isGlobal) {
          callbacks.onGlobalChange(def.key, v);
        } else {
          transform[def.key] = v;
          callbacks.onLocalChange(def.key, v);
        }
      });

      row.appendChild(badge);
      row.appendChild(label);
      row.appendChild(input);
      row.appendChild(valSpan);

      el.appendChild(row);
    }
  }

  render();
  return { el, render };
}
