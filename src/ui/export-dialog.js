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

/** Collapse whitespace for PostScript-style names used in filenames. */
const psName = (s) => String(s || '').replace(/\s+/g, '');

/** Compact number label: 2.00 → "2", 2.50 → "2.5". */
const trimNum = (v) => String(parseFloat(Number(v).toFixed(2)));

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
 * Static font dialog: pick family/style names + Stretch/Angle, then filename.
 *
 * The family/style names go into the font's name table, so each export can be
 * installed and recognized as a distinct typeface (filename alone doesn't
 * matter to the OS). Style name follows the sliders (Regular when no stretch)
 * and the filename follows family/style — each stops auto-updating once the
 * user edits it directly.
 *
 * @returns {Promise<{familyName: string, styleName: string, stretchAmount: number, stretchAngle: number, filename: string} | null>}
 */
export function staticFontDialog({ defaultFamilyName = 'Kabuku', defaultStretch = 0, defaultAngle = 0 }) {
  return openModal('Static Font Export', (body) => {
    const famInput = document.createElement('input');
    famInput.type = 'text';
    famInput.value = defaultFamilyName;
    body.appendChild(labeledRow('Family Name', famInput).row);

    const sApi = createSliderInput({
      min: 0, max: 10, step: 0.05,
      value: defaultStretch,
      formatter: (v) => v.toFixed(2),
      onInput: () => sync(),
      onChange: () => sync(),
    });
    body.appendChild(labeledRow('Stretch', sApi.slider, sApi.valueInput).row);

    const aApi = createSliderInput({
      min: 0, max: 180, step: 1,
      value: defaultAngle,
      hardMin: 0, hardMax: 180,
      onInput: () => sync(),
      onChange: () => sync(),
    });
    body.appendChild(labeledRow('Angle (deg)', aApi.slider, aApi.valueInput).row);

    const styInput = document.createElement('input');
    styInput.type = 'text';
    body.appendChild(labeledRow('Style Name', styInput).row);

    const nInput = document.createElement('input');
    nInput.type = 'text';
    body.appendChild(labeledRow('Filename', nInput).row);

    let styleEdited = false;
    let nameEdited = false;
    const autoStyle = () => {
      const s = sApi.getValue();
      return s === 0 ? 'Regular' : `Stretch${trimNum(s)} Angle${trimNum(aApi.getValue())}`;
    };
    function sync() {
      if (!styleEdited) styInput.value = autoStyle();
      if (!nameEdited) {
        nInput.value = `${psName(famInput.value) || 'Kabuku'}-${psName(styInput.value) || 'Regular'}.otf`;
      }
    }
    famInput.addEventListener('input', sync);
    styInput.addEventListener('input', () => { styleEdited = true; sync(); });
    nInput.addEventListener('input', () => { nameEdited = true; });
    sync();

    return () => {
      const familyName = famInput.value.trim() || defaultFamilyName;
      const styleName = styInput.value.trim() || autoStyle();
      return {
        familyName,
        styleName,
        stretchAmount: sApi.getValue(),
        stretchAngle: aApi.getValue(),
        filename: nInput.value || `${psName(familyName)}-${psName(styleName)}.otf`,
      };
    };
  });
}

/**
 * Variable font dialog: pick family name + angle (or "All"), then filename.
 *
 * The family name goes into the fonts' name tables so each export installs
 * as a distinct typeface. The filename follows the family/angle selection
 * until the user edits it directly.
 *
 * @param {Object} opts
 * @param {number[]} opts.angles - selectable angles
 * @param {string} [opts.defaultFamilyName]
 * @returns {Promise<{mode: 'single'|'all', angle?: number, familyName: string, filename: string} | null>}
 */
export function variableFontDialog({ angles, defaultFamilyName = 'Kabuku' }) {
  return openModal('Variable Font Export', (body) => {
    const famInput = document.createElement('input');
    famInput.type = 'text';
    famInput.value = defaultFamilyName;
    body.appendChild(labeledRow('Family Name', famInput).row);

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
    body.appendChild(labeledRow('Angle', aSel).row);

    // Note: metaball is a raster post-process and isn't preserved in VF outlines.
    const note = document.createElement('div');
    note.className = 'note';
    note.textContent = t('Note: metaball effect is not applied in variable fonts.');
    body.appendChild(note);

    const nInput = document.createElement('input');
    nInput.type = 'text';
    body.appendChild(labeledRow('Filename', nInput).row);

    let nameEdited = false;
    const autoName = () => {
      const fam = psName(famInput.value) || 'Kabuku';
      return aSel.value === 'all' ? `${fam}-VF-Family.zip` : `${fam}-Angle${aSel.value}.ttf`;
    };
    const sync = () => { if (!nameEdited) nInput.value = autoName(); };
    famInput.addEventListener('input', sync);
    aSel.addEventListener('change', sync);
    nInput.addEventListener('input', () => { nameEdited = true; });
    sync();

    return () => {
      const familyName = famInput.value.trim() || defaultFamilyName;
      const v = aSel.value;
      if (v === 'all') return { mode: 'all', familyName, filename: nInput.value || autoName() };
      return {
        mode: 'single',
        angle: parseFloat(v),
        familyName,
        filename: nInput.value || autoName(),
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
