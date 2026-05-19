import { saveGlobal } from '../core/project.js';
import { iconEl } from './icons.js';
import { createSliderInput } from './slider-input.js';

const STATE_KEY = 'kabuku.previewMode';
const SCALE_KEY = 'kabuku.previewScale';

let _previewMode = sessionStorage.getItem(STATE_KEY) === '1';
let _previewScale = (() => {
  const v = parseFloat(sessionStorage.getItem(SCALE_KEY));
  return Number.isFinite(v) && v > 0 ? v : 1;
})();

export function getPreviewMode() {
  return _previewMode;
}

export function setPreviewMode(v) {
  _previewMode = !!v;
  if (_previewMode) sessionStorage.setItem(STATE_KEY, '1');
  else sessionStorage.removeItem(STATE_KEY);
}

export function getPreviewScale() {
  return _previewScale;
}

export function setPreviewScale(v) {
  _previewScale = v;
  sessionStorage.setItem(SCALE_KEY, String(v));
}

const STRETCH_DEFS = [
  { key: 'stretchAngle', label: 'Angle', min: 0, max: 180, default: 0, step: 1, hardMin: 0, hardMax: 180 },
  { key: 'stretchAmount', label: 'Stretch', min: 0, max: 2, default: 0, step: 0.05 },
];

/**
 * Stretch sliders (Angle / Amount) bound to the shared `global` object.
 * Returns `rows` (one .param-row per param) so callers can append them into
 * any container — floating preview-controls or a sidebar group.
 */
export function createStretchControl({ global, onInput, onRelease }) {
  const rows = [];
  const inputs = {};
  for (const def of STRETCH_DEFS) {
    const row = document.createElement('div');
    row.className = 'param-row';
    const label = document.createElement('label');
    label.textContent = def.label;

    const api = createSliderInput({
      min: def.min,
      max: def.max,
      step: def.step,
      value: global[def.key] ?? def.default,
      hardMin: def.hardMin,
      hardMax: def.hardMax,
      onInput: (v) => {
        global[def.key] = v;
        saveGlobal(global);
        onInput?.(def.key, v);
      },
      onChange: (v) => {
        onRelease?.(def.key, v);
      },
    });

    row.appendChild(label);
    row.appendChild(api.slider);
    row.appendChild(api.valueInput);
    rows.push(row);
    inputs[def.key] = api;
  }

  function syncFromGlobal() {
    for (const def of STRETCH_DEFS) {
      const v = global[def.key] ?? def.default;
      inputs[def.key].setValue(v);
    }
  }

  return { rows, syncFromGlobal };
}

/**
 * Floating Preview / Angle / Stretch controls. Mounted at top-right of a
 * canvas area. `previewMode` persists across pages via sessionStorage;
 * stretch params are stored on the shared `global` object and saved to
 * project storage.
 */
export function createPreviewControls({ global, onPreviewChange, onStretchInput, onStretchRelease, onScaleChange }) {
  const el = document.createElement('div');
  el.className = 'preview-controls';

  const previewBtn = document.createElement('button');
  previewBtn.className = 'tool-btn preview-toggle-btn-inline';
  previewBtn.title = 'Toggle preview mode';
  previewBtn.appendChild(iconEl('preview'));
  const previewLabel = document.createElement('span');
  previewLabel.textContent = 'Preview';
  previewBtn.appendChild(previewLabel);
  if (_previewMode) previewBtn.classList.add('active');
  previewBtn.addEventListener('click', () => {
    setPreviewMode(!_previewMode);
    previewBtn.classList.toggle('active', _previewMode);
    onPreviewChange?.(_previewMode);
  });
  el.appendChild(previewBtn);

  // Scale slider
  {
    const row = document.createElement('div');
    row.className = 'param-row';
    const label = document.createElement('label');
    label.textContent = 'Scale';
    const { slider, valueInput } = createSliderInput({
      min: 0.25,
      max: 3,
      step: 0.05,
      value: _previewScale,
      onInput: (v) => {
        setPreviewScale(v);
        onScaleChange?.(v);
      },
    });
    row.appendChild(label);
    row.appendChild(slider);
    row.appendChild(valueInput);
    el.appendChild(row);
  }

  const stretch = createStretchControl({
    global,
    onInput: onStretchInput,
    onRelease: onStretchRelease,
  });
  for (const row of stretch.rows) el.appendChild(row);

  return { el, getPreviewMode: () => _previewMode, syncFromGlobal: stretch.syncFromGlobal };
}
