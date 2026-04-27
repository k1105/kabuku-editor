/**
 * Export option dialogs.
 *
 * Each helper opens a small modal, lets the user pick options + a filename,
 * then writes the bytes via showSaveFilePicker (Chromium) or falls back to
 * the legacy <a download> approach for Safari/Firefox.
 *
 * All helpers return a Promise that resolves once the user has saved or
 * cancelled. Cancellation throws nothing — it just resolves with `null`.
 */
import { t } from './i18n.js';

// ─── Modal infrastructure ──────────────────────────────────────────────────

let stylesInjected = false;
function ensureStyles() {
  if (stylesInjected) return;
  stylesInjected = true;
  const style = document.createElement('style');
  style.textContent = `
.export-modal-backdrop {
  position: fixed; inset: 0;
  background: rgba(0,0,0,0.55);
  display: flex; align-items: center; justify-content: center;
  z-index: 9999;
}
.export-modal {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 20px;
  min-width: 320px; max-width: 420px;
  color: var(--text);
  font-size: 13px;
  box-shadow: 0 12px 40px rgba(0,0,0,0.5);
}
.export-modal h3 {
  margin: 0 0 14px 0;
  font-size: 14px;
  font-weight: 600;
}
.export-modal .row {
  display: flex; align-items: center; gap: 10px;
  margin-bottom: 10px;
}
.export-modal .row label {
  flex: 0 0 110px;
  color: var(--text-dim);
  font-size: 12px;
}
.export-modal .row input[type="number"],
.export-modal .row input[type="text"],
.export-modal .row select {
  flex: 1;
  background: var(--bg);
  border: 1px solid var(--border);
  color: var(--text);
  padding: 5px 8px;
  border-radius: 3px;
  font-size: 12px;
  min-width: 0;
}
.export-modal .row input[type="range"] {
  flex: 1;
}
.export-modal .row .value {
  flex: 0 0 50px;
  color: var(--text-dim);
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.export-modal .note {
  margin-top: 4px;
  padding: 8px 10px;
  background: var(--bg);
  border-left: 2px solid var(--accent);
  border-radius: 3px;
  color: var(--text-dim);
  font-size: 11px;
  line-height: 1.4;
}
.export-modal .actions {
  display: flex; justify-content: flex-end; gap: 8px;
  margin-top: 16px;
}
.export-modal .actions button {
  background: var(--bg);
  border: 1px solid var(--border);
  color: var(--text);
  padding: 6px 14px;
  border-radius: 3px;
  cursor: pointer;
  font-size: 12px;
}
.export-modal .actions button.primary {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
}
.export-modal .actions button:hover { border-color: var(--accent); }
`;
  document.head.appendChild(style);
}

/**
 * Open a modal with the given DOM body. Returns a Promise that resolves with
 * either the value passed to `confirm` or null if cancelled.
 *
 * The `build(container, confirm, cancel)` callback fills the modal and is
 * expected to call `confirm(value)` when the user clicks the primary button.
 */
function openModal(title, build, opts = {}) {
  const okLabel = opts.okLabel || 'Export';
  ensureStyles();

  return new Promise(resolve => {
    const backdrop = document.createElement('div');
    backdrop.className = 'export-modal-backdrop';

    const modal = document.createElement('div');
    modal.className = 'export-modal';
    backdrop.appendChild(modal);

    const heading = document.createElement('h3');
    heading.textContent = title;
    modal.appendChild(heading);

    const body = document.createElement('div');
    modal.appendChild(body);

    const actions = document.createElement('div');
    actions.className = 'actions';
    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = 'Cancel';
    const okBtn = document.createElement('button');
    okBtn.textContent = okLabel;
    okBtn.className = 'primary';
    actions.appendChild(cancelBtn);
    actions.appendChild(okBtn);
    modal.appendChild(actions);

    function close(value) {
      backdrop.remove();
      document.removeEventListener('keydown', onKey);
      resolve(value);
    }
    cancelBtn.addEventListener('click', () => close(null));
    backdrop.addEventListener('click', e => { if (e.target === backdrop) close(null); });
    function onKey(e) {
      if (e.key === 'Escape') close(null);
      else if (e.key === 'Enter' && document.activeElement?.tagName !== 'TEXTAREA') {
        okBtn.click();
      }
    }
    document.addEventListener('keydown', onKey);

    const collect = build(body, okBtn);
    okBtn.addEventListener('click', () => {
      const v = collect();
      if (v != null) close(v);
    });

    // Append to #app so the auto-translate observer picks up labels.
    (document.getElementById('app') || document.body).appendChild(backdrop);
  });
}

// ─── File save helper ──────────────────────────────────────────────────────

/**
 * Save bytes (Uint8Array or string) with a save dialog when supported, else
 * fall back to triggering an anchor download. Returns true on success, false
 * on cancellation.
 */
export async function saveFile(bytes, suggestedName, mimeType) {
  const data = (typeof bytes === 'string')
    ? new Blob([bytes], { type: mimeType })
    : new Blob([bytes], { type: mimeType });

  if (window.showSaveFilePicker) {
    try {
      const ext = suggestedName.split('.').pop().toLowerCase();
      const handle = await window.showSaveFilePicker({
        suggestedName,
        types: [{
          description: ext.toUpperCase() + ' file',
          accept: { [mimeType]: ['.' + ext] },
        }],
      });
      const writable = await handle.createWritable();
      await writable.write(data);
      await writable.close();
      return true;
    } catch (e) {
      if (e.name === 'AbortError') return false;
      // Permission errors / unsupported → fall through to legacy download
      console.warn('showSaveFilePicker failed, falling back:', e);
    }
  }

  const url = URL.createObjectURL(data);
  const a = document.createElement('a');
  a.href = url;
  a.download = suggestedName;
  a.click();
  URL.revokeObjectURL(url);
  return true;
}

// ─── Specific dialogs ──────────────────────────────────────────────────────

/**
 * SVG export dialog: choose layer scope + filename, then save.
 *
 * @param {Object} opts
 * @param {string} opts.defaultFilename
 * @param {boolean} [opts.hasActiveLayer] - whether "Active layer only" is offered
 * @returns {Promise<{scope: 'active'|'all', filename: string} | null>}
 */
export function svgExportDialog({ defaultFilename, hasActiveLayer = true }) {
  return openModal('SVG Export', (body) => {
    const scopeRow = document.createElement('div');
    scopeRow.className = 'row';
    const scopeLabel = document.createElement('label');
    scopeLabel.textContent = 'Layers';
    const scopeSel = document.createElement('select');
    if (hasActiveLayer) {
      const o1 = document.createElement('option');
      o1.value = 'active'; o1.textContent = 'Active layer only';
      scopeSel.appendChild(o1);
    }
    const o2 = document.createElement('option');
    o2.value = 'all'; o2.textContent = 'All layers';
    scopeSel.appendChild(o2);
    scopeRow.appendChild(scopeLabel);
    scopeRow.appendChild(scopeSel);
    body.appendChild(scopeRow);

    const nameRow = document.createElement('div');
    nameRow.className = 'row';
    const nameLabel = document.createElement('label');
    nameLabel.textContent = 'Filename';
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.value = defaultFilename;
    nameRow.appendChild(nameLabel);
    nameRow.appendChild(nameInput);
    body.appendChild(nameRow);

    return () => ({
      scope: scopeSel.value,
      filename: nameInput.value || defaultFilename,
    });
  });
}

/**
 * Static font dialog: pick Stretch + Angle, then filename.
 *
 * @returns {Promise<{stretchAmount: number, stretchAngle: number, filename: string} | null>}
 */
export function staticFontDialog({ defaultFilename, defaultStretch = 0, defaultAngle = 0 }) {
  return openModal('Static Font Export', (body) => {
    // Stretch slider
    const sRow = document.createElement('div');
    sRow.className = 'row';
    const sLabel = document.createElement('label');
    sLabel.textContent = 'Stretch';
    const sInput = document.createElement('input');
    sInput.type = 'range';
    sInput.min = 0; sInput.max = 10; sInput.step = 0.05;
    sInput.value = defaultStretch;
    const sVal = document.createElement('span');
    sVal.className = 'value';
    sVal.textContent = (+defaultStretch).toFixed(2);
    sInput.addEventListener('input', () => sVal.textContent = (+sInput.value).toFixed(2));
    sRow.appendChild(sLabel);
    sRow.appendChild(sInput);
    sRow.appendChild(sVal);
    body.appendChild(sRow);

    // Angle slider
    const aRow = document.createElement('div');
    aRow.className = 'row';
    const aLabel = document.createElement('label');
    aLabel.textContent = 'Angle (deg)';
    const aInput = document.createElement('input');
    aInput.type = 'range';
    aInput.min = 0; aInput.max = 180; aInput.step = 1;
    aInput.value = defaultAngle;
    const aVal = document.createElement('span');
    aVal.className = 'value';
    aVal.textContent = `${defaultAngle}°`;
    aInput.addEventListener('input', () => aVal.textContent = `${aInput.value}°`);
    aRow.appendChild(aLabel);
    aRow.appendChild(aInput);
    aRow.appendChild(aVal);
    body.appendChild(aRow);

    const nRow = document.createElement('div');
    nRow.className = 'row';
    const nLabel = document.createElement('label');
    nLabel.textContent = 'Filename';
    const nInput = document.createElement('input');
    nInput.type = 'text';
    nInput.value = defaultFilename;
    nRow.appendChild(nLabel);
    nRow.appendChild(nInput);
    body.appendChild(nRow);

    return () => ({
      stretchAmount: parseFloat(sInput.value),
      stretchAngle: parseFloat(aInput.value),
      filename: nInput.value || defaultFilename,
    });
  });
}

/**
 * Variable font dialog: pick angle (or "All"), then filename.
 *
 * @param {Object} opts
 * @param {number[]} opts.angles - selectable angles
 * @param {string} opts.defaultFilenameSingle - filename pattern for single .ttf
 *   ($ANGLE will be replaced with the chosen angle)
 * @param {string} opts.defaultFilenameAll - filename for "All" .zip
 * @returns {Promise<{mode: 'single'|'all', angle?: number, filename: string} | null>}
 */
export function variableFontDialog({ angles, defaultFilenameSingle, defaultFilenameAll }) {
  return openModal('Variable Font Export', (body) => {
    const aRow = document.createElement('div');
    aRow.className = 'row';
    const aLabel = document.createElement('label');
    aLabel.textContent = 'Angle';
    const aSel = document.createElement('select');
    for (const a of angles) {
      const o = document.createElement('option');
      o.value = String(a); o.textContent = `Angle ${a}°`;
      aSel.appendChild(o);
    }
    const allOpt = document.createElement('option');
    allOpt.value = 'all'; allOpt.textContent = 'All (ZIP)';
    aSel.appendChild(allOpt);
    aSel.value = 'all';
    aRow.appendChild(aLabel);
    aRow.appendChild(aSel);
    body.appendChild(aRow);

    // Note: metaball is a raster post-process and isn't preserved in VF outlines.
    const note = document.createElement('div');
    note.className = 'note';
    note.textContent = t('Note: metaball effect is not applied in variable fonts.');
    body.appendChild(note);

    const nRow = document.createElement('div');
    nRow.className = 'row';
    const nLabel = document.createElement('label');
    nLabel.textContent = 'Filename';
    const nInput = document.createElement('input');
    nInput.type = 'text';
    const updateName = () => {
      if (aSel.value === 'all') nInput.value = defaultFilenameAll;
      else nInput.value = defaultFilenameSingle.replace('$ANGLE', aSel.value);
    };
    aSel.addEventListener('change', updateName);
    updateName();
    nRow.appendChild(nLabel);
    nRow.appendChild(nInput);
    body.appendChild(nRow);

    return () => {
      const v = aSel.value;
      if (v === 'all') return { mode: 'all', filename: nInput.value || defaultFilenameAll };
      return {
        mode: 'single',
        angle: parseFloat(v),
        filename: nInput.value || defaultFilenameSingle.replace('$ANGLE', v),
      };
    };
  });
}

/**
 * Font-based import dialog: pick a Google Fonts family + character ranges.
 *
 * @param {Object} opts
 * @param {Array<{id:string,label:string}>} opts.presets
 * @param {string[]} [opts.familySuggestions]
 * @param {string}   [opts.defaultFamily]
 * @param {string[]} [opts.defaultPresetIds]
 * @returns {Promise<{family:string, presetIds:string[], customText:string} | null>}
 */
export function fontImportDialog({
  presets,
  familySuggestions = [],
  defaultFamily = '',
  defaultPresetIds = [],
}) {
  return openModal('Import from Font', (body) => {
    // Family input + datalist for suggestions
    const fRow = document.createElement('div');
    fRow.className = 'row';
    const fLabel = document.createElement('label');
    fLabel.textContent = 'Family';
    const fInput = document.createElement('input');
    fInput.type = 'text';
    fInput.value = defaultFamily;
    fInput.placeholder = 'e.g. Noto Sans JP';
    if (familySuggestions.length) {
      const listId = 'font-import-family-list';
      let datalist = document.getElementById(listId);
      if (!datalist) {
        datalist = document.createElement('datalist');
        datalist.id = listId;
        document.body.appendChild(datalist);
      }
      datalist.innerHTML = '';
      for (const name of familySuggestions) {
        const opt = document.createElement('option');
        opt.value = name;
        datalist.appendChild(opt);
      }
      fInput.setAttribute('list', listId);
    }
    fRow.appendChild(fLabel);
    fRow.appendChild(fInput);
    body.appendChild(fRow);

    // Range checkboxes
    const rangeRow = document.createElement('div');
    rangeRow.className = 'row';
    const rangeLabel = document.createElement('label');
    rangeLabel.textContent = 'Ranges';
    rangeLabel.style.alignSelf = 'flex-start';
    rangeLabel.style.paddingTop = '4px';
    const checks = document.createElement('div');
    checks.style.display = 'flex';
    checks.style.flexDirection = 'column';
    checks.style.gap = '4px';
    checks.style.flex = '1';
    const cbMap = {};
    for (const p of presets) {
      const lab = document.createElement('label');
      lab.style.display = 'flex';
      lab.style.alignItems = 'center';
      lab.style.gap = '6px';
      lab.style.fontSize = '12px';
      lab.style.color = 'var(--text)';
      lab.style.flex = 'unset';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = defaultPresetIds.includes(p.id);
      cbMap[p.id] = cb;
      const span = document.createElement('span');
      span.textContent = p.label;
      lab.appendChild(cb);
      lab.appendChild(span);
      checks.appendChild(lab);
    }
    rangeRow.appendChild(rangeLabel);
    rangeRow.appendChild(checks);
    body.appendChild(rangeRow);

    // Custom characters
    const cRow = document.createElement('div');
    cRow.className = 'row';
    const cLabel = document.createElement('label');
    cLabel.textContent = 'Custom';
    const cInput = document.createElement('input');
    cInput.type = 'text';
    cInput.placeholder = 'extra characters (optional)';
    cRow.appendChild(cLabel);
    cRow.appendChild(cInput);
    body.appendChild(cRow);

    const note = document.createElement('div');
    note.className = 'note';
    note.textContent =
      'Glyphs are rendered from the chosen Google Fonts family and meshed locally. ' +
      'Existing characters with the same ID are skipped.';
    body.appendChild(note);

    return () => {
      const family = fInput.value.trim();
      if (!family) {
        fInput.focus();
        return null;
      }
      const presetIds = Object.keys(cbMap).filter(id => cbMap[id].checked);
      const customText = cInput.value || '';
      if (presetIds.length === 0 && customText.length === 0) {
        return null;
      }
      return { family, presetIds, customText };
    };
  }, { okLabel: 'Generate' });
}
