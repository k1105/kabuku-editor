import { createSliderInput } from './slider-input.js';

/**
 * Builds one `.param-row`: an optional override badge, a `<label>`, and a
 * paired range slider + numeric input (see createSliderInput). This is the
 * row layout repeated across the editor, compose and animation sidebars.
 *
 * `sliderConfig` is forwarded verbatim to createSliderInput
 * (min / max / step / value / hardMin / hardMax / formatter / onInput / onChange).
 *
 * Options:
 *   - badge:      element prepended before the label (e.g. an override badge).
 *   - overridden: add the `overridden` class to the label.
 *
 * Returns { row, api, label } — `api` is the createSliderInput handle
 * ({ slider, valueInput, getValue, setValue }) and `label` is the <label>
 * element (callers that toggle override styling need a handle to it).
 */
export function createParamRow(labelText, sliderConfig, opts = {}) {
  const row = document.createElement('div');
  row.className = 'param-row';

  if (opts.badge) row.appendChild(opts.badge);

  const label = document.createElement('label');
  label.textContent = labelText;
  if (opts.overridden) label.classList.add('overridden');

  const api = createSliderInput(sliderConfig);

  row.appendChild(label);
  row.appendChild(api.slider);
  row.appendChild(api.valueInput);

  return { row, api, label };
}
