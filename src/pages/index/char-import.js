/**
 * Bulk glyph importers (image files / font family / KanjiVG strokes).
 *
 * Each importer drives the same pipeline per glyph: build layers from the
 * global defaults, rasterize the source, auto-mesh the cells, persist
 * layerOverrides. Progress + card creation are delegated through the `ui`
 * hooks object built by the page (see makeImportHooks in index-page.js):
 *   { progressWrap, progressBar, progressText, getStrip(), insertBefore(),
 *     createCard(charId, charData), onDone() }
 */
import { getGlobal, saveProject, serializeLayerOverrides } from '../../core/project.js';
import { getGrid } from '../../grids/grid-plugin.js';
import { createLayer, regenerateCells } from '../../core/layer.js';
import { autoMeshAsync } from '../../core/mesh.js';
import { uploadCharacterImage } from '../../core/storage.js';
import { ensureFontLoaded, renderCharToContext } from '../../render/font/font-import.js';
import { loadKanjiVGPaths, renderKanjiVGToContext } from '../../render/font/kanjivg-import.js';
import { fileToDataURL, loadImage } from '../../utils/file-io.js';
import { GLYPH_SIZE } from './constants.js';

/** Layers built from the configured global defaults, freshly meshed. */
function buildImportLayers(g) {
  const importLayers = [];
  for (const gl of g.defaultLayers) {
    const gridPlugin = getGrid(gl.gridName);
    if (!gridPlugin) continue;
    // Build from the configured global layer's own params, not the
    // per-grid-type fallback in gridDefaults — otherwise every key
    // gets serialized as a spurious per-char override.
    const layer = createLayer(gridPlugin, { ...(gl.gridParams || {}) });
    layer.name = gl.name || gl.gridName;
    regenerateCells(layer, GLYPH_SIZE, GLYPH_SIZE);
    importLayers.push(layer);
  }
  return importLayers;
}

function makeOffscreen() {
  const offscreen = document.createElement('canvas');
  offscreen.width = GLYPH_SIZE;
  offscreen.height = GLYPH_SIZE;
  return offscreen.getContext('2d');
}

function hideEmptyState() {
  const empty = document.querySelector('.empty-state');
  if (empty) empty.style.display = 'none';
}

function appendCard(ui, strip, card) {
  const before = ui.insertBefore?.();
  if (before && before.parentNode === strip) {
    strip.insertBefore(card, before);
  } else {
    strip.appendChild(card);
  }
}

function makeProgress(ui, total) {
  let done = 0;
  ui.progressBar.style.width = '0%';
  ui.progressText.textContent = `0 / ${total}`;
  return async function step() {
    done++;
    ui.progressBar.style.width = Math.round((done / total) * 100) + '%';
    ui.progressText.textContent = `${done} / ${total}`;
    await new Promise(r => requestAnimationFrame(r));
  };
}

export function importImages(project, ui) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/png,image/jpeg,image/gif';
  input.multiple = true;
  input.addEventListener('change', async () => {
    const files = Array.from(input.files);
    if (files.length === 0) return;
    hideEmptyState();
    ui.progressWrap.style.display = '';
    const step = makeProgress(ui, files.length);
    const offCtx = makeOffscreen();
    const strip = ui.getStrip();
    for (const file of files) {
      const charId = file.name.replace(/\.[^.]+$/, '');
      // A file with no name stem (e.g. ".png") yields an empty id — not a real
      // glyph — so skip it. Punctuation ids like '.' or '/' are fine; they're
      // encoded when persisted.
      if (!charId) {
        console.warn(`Skipping import for "${file.name}" — empty glyph id`);
        await step();
        continue;
      }
      if (!project.characters[charId]) {
        const g = getGlobal();
        const importLayers = buildImportLayers(g);
        // Local mesh from the file bytes, plus parallel Storage upload — the
        // upload result (HTTPS URL) is what we persist as imagePath.
        const localPreview = await fileToDataURL(file);
        const img = await loadImage(localPreview);
        offCtx.clearRect(0, 0, GLYPH_SIZE, GLYPH_SIZE);
        offCtx.drawImage(img, 0, 0, GLYPH_SIZE, GLYPH_SIZE);
        for (const layer of importLayers) await autoMeshAsync(offCtx, layer.cells, 0.5);
        let imageUrl;
        try {
          imageUrl = await uploadCharacterImage({ charId, file });
        } catch (e) {
          console.warn(`Upload failed for ${charId}:`, e);
          // Skip the failing glyph entirely to avoid persisting a giant data
          // URL that won't sync to Firestore.
          await step();
          continue;
        }
        const charData = {
          imagePath: imageUrl,
          layerOverrides: serializeLayerOverrides(importLayers, g),
        };
        project.characters[charId] = charData;
        appendCard(ui, strip, ui.createCard(charId, charData));
      }
      await step();
    }
    saveProject(project);
    ui.progressWrap.style.display = 'none';
    if (ui.onDone) ui.onDone();
  });
  input.click();
}

/**
 * Generate glyphs for `chars` using a Google Fonts family, render each into
 * an offscreen canvas, and run the same autoMesh pipeline as the image-file
 * import. To keep storage usage sane (Joyo can be 2k+ glyphs) we omit
 * `imagePath` — the meshed result is stored directly in `layerOverrides`.
 */
export async function importFromFont(project, family, chars, ui) {
  hideEmptyState();
  ui.progressWrap.style.display = '';
  ui.progressBar.style.width = '0%';
  ui.progressText.textContent = `Loading font...`;

  try {
    await ensureFontLoaded(family, chars.join(''));
  } catch (e) {
    ui.progressWrap.style.display = 'none';
    alert(e.message || 'Font load failed');
    return;
  }

  const step = makeProgress(ui, chars.length);
  const offCtx = makeOffscreen();
  const strip = ui.getStrip();
  for (const ch of chars) {
    const charId = ch;
    if (!project.characters[charId]) {
      const g = getGlobal();
      const importLayers = buildImportLayers(g);
      renderCharToContext(offCtx, ch, family, GLYPH_SIZE, g.fontMetrics);
      for (const layer of importLayers) await autoMeshAsync(offCtx, layer.cells, 0.5);
      const charData = {
        layerOverrides: serializeLayerOverrides(importLayers, g),
        fontSource: { family, char: ch },
      };
      project.characters[charId] = charData;
      appendCard(ui, strip, ui.createCard(charId, charData));
    }
    await step();
  }
  saveProject(project);
  ui.progressWrap.style.display = 'none';
  if (ui.onDone) ui.onDone();
}

/**
 * Generate glyphs for `chars` from KanjiVG stroke SVGs, stroking each at
 * `strokeWidth` (KanjiVG 109-unit space) into an offscreen canvas and running
 * the same autoMesh pipeline as the font import. Characters KanjiVG doesn't
 * cover (most symbols, fullwidth forms) are skipped and reported.
 */
export async function importFromKanjiVG(project, chars, strokeWidth, ui) {
  hideEmptyState();
  ui.progressWrap.style.display = '';

  const step = makeProgress(ui, chars.length);
  const offCtx = makeOffscreen();
  const strip = ui.getStrip();
  const skipped = [];
  for (const ch of chars) {
    const charId = ch;
    if (!project.characters[charId]) {
      let paths;
      try {
        ({ paths } = await loadKanjiVGPaths(ch));
      } catch (e) {
        if (e?.kanjivgNotFound) skipped.push(ch);
        else console.error(e);
        await step();
        continue;
      }
      const g = getGlobal();
      const importLayers = buildImportLayers(g);
      renderKanjiVGToContext(offCtx, paths, GLYPH_SIZE, strokeWidth);
      for (const layer of importLayers) await autoMeshAsync(offCtx, layer.cells, 0.5);
      const charData = {
        layerOverrides: serializeLayerOverrides(importLayers, g),
        kanjivgSource: { char: ch },
      };
      project.characters[charId] = charData;
      appendCard(ui, strip, ui.createCard(charId, charData));
    }
    await step();
  }
  saveProject(project);
  ui.progressWrap.style.display = 'none';
  if (ui.onDone) ui.onDone();
  if (skipped.length > 0) {
    alert(`KanjiVG に未収録の ${skipped.length} 文字をスキップしました: ${skipped.join('')}`);
  }
}
