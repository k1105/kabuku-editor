import { saveGlobal } from '../core/project.js';
import { createParamRow } from './param-row.js';

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
    const { row, api } = createParamRow(def.label, {
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
