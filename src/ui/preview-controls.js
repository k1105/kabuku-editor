import { saveGlobal } from '../core/project.js';
import { iconEl } from './icons.js';

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
  { key: 'stretchAngle', label: 'Angle', min: 0, max: 180, default: 0, step: 1 },
  { key: 'stretchAmount', label: 'Stretch', min: 0, max: 2, default: 0, step: 0.05 },
];

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
    const input = document.createElement('input');
    input.type = 'range';
    input.min = 0.25;
    input.max = 3;
    input.step = 0.05;
    input.value = _previewScale;
    const valSpan = document.createElement('span');
    valSpan.className = 'value';
    valSpan.textContent = _previewScale.toFixed(2);
    input.addEventListener('input', () => {
      const v = parseFloat(input.value);
      setPreviewScale(v);
      valSpan.textContent = v.toFixed(2);
      onScaleChange?.(v);
    });
    row.appendChild(label);
    row.appendChild(input);
    row.appendChild(valSpan);
    el.appendChild(row);
  }

  const inputs = {};
  for (const def of STRETCH_DEFS) {
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
      saveGlobal(global);
      valSpan.textContent = v;
      onStretchInput?.(def.key, v);
    });
    input.addEventListener('change', () => {
      onStretchRelease?.(def.key, parseFloat(input.value));
    });
    row.appendChild(label);
    row.appendChild(input);
    row.appendChild(valSpan);
    el.appendChild(row);
    inputs[def.key] = { input, valSpan };
  }

  function syncFromGlobal() {
    for (const def of STRETCH_DEFS) {
      const v = global[def.key] ?? def.default;
      inputs[def.key].input.value = v;
      inputs[def.key].valSpan.textContent = v;
    }
  }

  return { el, getPreviewMode: () => _previewMode, syncFromGlobal };
}
