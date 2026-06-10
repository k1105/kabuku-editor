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
import { createSliderInput } from './slider-input.js';

// ─── Modal infrastructure ──────────────────────────────────────────────────

/**
 * Open a modal with the given DOM body. Returns a Promise that resolves with
 * either the value passed to `confirm` or null if cancelled.
 *
 * The `build(container, confirm, cancel)` callback fills the modal and is
 * expected to call `confirm(value)` when the user clicks the primary button.
 */
function openModal(title, build, opts = {}) {
  const okLabel = opts.okLabel || 'Export';

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


/** A `.row` with a fixed-width label followed by the given controls. */
function labeledRow(labelText, ...controls) {
  const row = document.createElement('div');
  row.className = 'row';
  const label = document.createElement('label');
  label.textContent = labelText;
  row.appendChild(label);
  for (const c of controls) row.appendChild(c);
  return { row, label };
}

/**
 * "Ranges" row: one checkbox per character-set preset. Shared by the Font /
 * Font File / KanjiVG panes of the add-glyph dialog.
 */
function rangeCheckboxRow(presets, defaultPresetIds) {
  const col = document.createElement('div');
  col.style.display = 'flex';
  col.style.flexDirection = 'column';
  col.style.gap = '4px';
  col.style.flex = '1';
  const map = {};
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
    map[p.id] = cb;
    const span = document.createElement('span');
    span.textContent = p.label;
    lab.appendChild(cb);
    lab.appendChild(span);
    col.appendChild(lab);
  }
  const { row, label } = labeledRow('Ranges', col);
  label.style.alignSelf = 'flex-start';
  label.style.paddingTop = '4px';
  return { row, selectedIds: () => Object.keys(map).filter((id) => map[id].checked) };
}

/** "Custom" free-text row for extra characters. */
function customTextRow() {
  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = 'extra characters (optional)';
  const { row } = labeledRow('Custom', input);
  return { row, input };
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
    const sApi = createSliderInput({
      min: 0, max: 10, step: 0.05,
      value: defaultStretch,
      formatter: (v) => v.toFixed(2),
    });
    sRow.appendChild(sLabel);
    sRow.appendChild(sApi.slider);
    sRow.appendChild(sApi.valueInput);
    body.appendChild(sRow);

    // Angle slider
    const aRow = document.createElement('div');
    aRow.className = 'row';
    const aLabel = document.createElement('label');
    aLabel.textContent = 'Angle (deg)';
    const aApi = createSliderInput({
      min: 0, max: 180, step: 1,
      value: defaultAngle,
      hardMin: 0, hardMax: 180,
    });
    aRow.appendChild(aLabel);
    aRow.appendChild(aApi.slider);
    aRow.appendChild(aApi.valueInput);
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
      stretchAmount: sApi.getValue(),
      stretchAngle: aApi.getValue(),
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
 * Unified add-glyph dialog. Lets the user choose one of:
 *   - 画像から取り込み  → { mode: 'image' }   (caller opens the file picker)
 *   - 書体から取り込み  → { mode: 'font', family, presetIds, customText }
 *   - 空のグリフ        → { mode: 'empty' }
 *
 * @returns {Promise<null | { mode: 'image' | 'font' | 'empty', ... }>}
 */
export function glyphAddDialog({
  presets,
  familySuggestions = [],
  defaultFamily = '',
  defaultPresetIds = [],
  defaultStrokeWidth = 5.5,
}) {
  return openModal('Add Glyph', (body, okBtn) => {
    // ── Tab strip ─────────────────────────────────────────────────────────
    const tabs = [
      { id: 'image',    label: 'Image',     okLabel: 'Choose Files' },
      { id: 'font',     label: 'Font',      okLabel: 'Generate' },
      { id: 'fontfile', label: 'Font File', okLabel: 'Generate' },
      { id: 'kanjivg',  label: 'KanjiVG',   okLabel: 'Generate' },
      { id: 'empty',    label: 'Empty',     okLabel: 'Add' },
    ];
    let activeTab = 'image';

    const tabBar = document.createElement('div');
    tabBar.className = 'tab-bar';
    const tabBtns = {};
    for (const t of tabs) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'tab-btn';
      btn.textContent = t.label;
      btn.addEventListener('click', () => setActive(t.id));
      tabBar.appendChild(btn);
      tabBtns[t.id] = btn;
    }
    body.appendChild(tabBar);

    // ── Tab panes ─────────────────────────────────────────────────────────
    // Image pane
    const imagePane = document.createElement('div');
    imagePane.className = 'tab-pane';
    const imgNote = document.createElement('div');
    imgNote.className = 'note';
    imgNote.textContent =
      'OK を押すとファイル選択ダイアログが開きます。' +
      '選択した PNG / JPEG / GIF ごとにグリフが追加されます (ファイル名がグリフID)。';
    imagePane.appendChild(imgNote);
    body.appendChild(imagePane);

    // Font pane
    const fontPane = document.createElement('div');
    fontPane.className = 'tab-pane';
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
    fontPane.appendChild(fRow);

    const fontRanges = rangeCheckboxRow(presets, defaultPresetIds);
    fontPane.appendChild(fontRanges.row);

    const fontCustom = customTextRow();
    const cInput = fontCustom.input;
    fontPane.appendChild(fontCustom.row);

    const fNote = document.createElement('div');
    fNote.className = 'note';
    fNote.textContent =
      '選んだ Google Fonts ファミリーから各文字をレンダリングし、ローカルでメッシュ化します。' +
      '同じIDの文字は既存のものを残してスキップします。';
    fontPane.appendChild(fNote);
    body.appendChild(fontPane);

    // Font File pane (import an arbitrary TTF/OTF from disk)
    const ffPane = document.createElement('div');
    ffPane.className = 'tab-pane';

    const ffFileRow = document.createElement('div');
    ffFileRow.className = 'row';
    const ffFileLabel = document.createElement('label');
    ffFileLabel.textContent = 'File';
    const ffFileInput = document.createElement('input');
    ffFileInput.type = 'file';
    ffFileInput.accept = '.ttf,.otf,font/ttf,font/otf,font/sfnt';
    ffFileInput.style.flex = '1';
    ffFileRow.appendChild(ffFileLabel);
    ffFileRow.appendChild(ffFileInput);
    ffPane.appendChild(ffFileRow);

    const ffRanges = rangeCheckboxRow(presets, defaultPresetIds);
    ffPane.appendChild(ffRanges.row);

    const ffCustom = customTextRow();
    const ffCustomInput = ffCustom.input;
    ffPane.appendChild(ffCustom.row);

    const ffNote = document.createElement('div');
    ffNote.className = 'note';
    ffNote.textContent =
      '手元の TTF / OTF ファイルを読み込み、各文字をレンダリングしてローカルでメッシュ化します。' +
      'フォントはこのブラウザ内（IndexedDB）にのみ保存されます。';
    ffPane.appendChild(ffNote);
    body.appendChild(ffPane);

    // KanjiVG pane
    const kvgPane = document.createElement('div');
    kvgPane.className = 'tab-pane';

    const kRanges = rangeCheckboxRow(presets, defaultPresetIds);
    kvgPane.appendChild(kRanges.row);

    const kCustom = customTextRow();
    const kCustomInput = kCustom.input;
    kvgPane.appendChild(kCustom.row);

    const kStrokeRow = document.createElement('div');
    kStrokeRow.className = 'row';
    const kStrokeLabel = document.createElement('label');
    kStrokeLabel.textContent = 'Stroke';
    const kStrokeInput = document.createElement('input');
    kStrokeInput.type = 'range';
    kStrokeInput.min = '1';
    kStrokeInput.max = '20';
    kStrokeInput.step = '0.5';
    kStrokeInput.value = String(defaultStrokeWidth);
    kStrokeInput.style.flex = '1';
    const kStrokeVal = document.createElement('span');
    kStrokeVal.style.minWidth = '36px';
    kStrokeVal.style.textAlign = 'right';
    kStrokeVal.style.fontSize = '12px';
    kStrokeVal.textContent = Number(defaultStrokeWidth).toFixed(1);
    kStrokeInput.addEventListener('input', () => {
      kStrokeVal.textContent = Number(kStrokeInput.value).toFixed(1);
    });
    kStrokeRow.appendChild(kStrokeLabel);
    kStrokeRow.appendChild(kStrokeInput);
    kStrokeRow.appendChild(kStrokeVal);
    kvgPane.appendChild(kStrokeRow);

    const kNote = document.createElement('div');
    kNote.className = 'note';
    kNote.textContent =
      'KanjiVG のストロークSVGを指定した線幅で描画し、ローカルでメッシュ化します。' +
      '漢字・かな・半角英数に対応（多くの記号・全角は未収録のためスキップされます）。';
    kvgPane.appendChild(kNote);
    body.appendChild(kvgPane);

    // Empty pane
    const emptyPane = document.createElement('div');
    emptyPane.className = 'tab-pane';
    const eNote = document.createElement('div');
    eNote.className = 'note';
    eNote.textContent =
      '画像も書体も指定しない空のグリフを1つ追加します。' +
      'あとから個別に画像を割り当てたり、メッシュを編集できます。';
    emptyPane.appendChild(eNote);
    body.appendChild(emptyPane);

    function setActive(id) {
      activeTab = id;
      for (const t of tabs) {
        tabBtns[t.id].classList.toggle('active', t.id === id);
      }
      imagePane.style.display = id === 'image'    ? '' : 'none';
      fontPane.style.display  = id === 'font'     ? '' : 'none';
      ffPane.style.display    = id === 'fontfile' ? '' : 'none';
      kvgPane.style.display   = id === 'kanjivg'  ? '' : 'none';
      emptyPane.style.display = id === 'empty'    ? '' : 'none';
      okBtn.textContent = tabs.find(t => t.id === id).okLabel;
    }
    setActive('image');

    return () => {
      if (activeTab === 'image') return { mode: 'image' };
      if (activeTab === 'empty') return { mode: 'empty' };
      if (activeTab === 'fontfile') {
        const file = ffFileInput.files && ffFileInput.files[0];
        if (!file) { ffFileInput.focus(); return null; }
        const presetIds = ffRanges.selectedIds();
        const customText = ffCustomInput.value || '';
        if (presetIds.length === 0 && customText.length === 0) return null;
        return { mode: 'fontfile', file, presetIds, customText };
      }
      if (activeTab === 'kanjivg') {
        const presetIds = kRanges.selectedIds();
        const customText = kCustomInput.value || '';
        if (presetIds.length === 0 && customText.length === 0) return null;
        return { mode: 'kanjivg', presetIds, customText, strokeWidth: Number(kStrokeInput.value) };
      }
      const family = fInput.value.trim();
      if (!family) { fInput.focus(); return null; }
      const presetIds = fontRanges.selectedIds();
      const customText = cInput.value || '';
      if (presetIds.length === 0 && customText.length === 0) return null;
      return { mode: 'font', family, presetIds, customText };
    };
  }, { okLabel: 'Choose Files' });
}
