import { getGlobal, resolveTransform } from '../../core/project.js';
import { loadImageCached } from '../../core/image-cache.js';
import { buildRuntimeLayers } from '../../core/layer-builder.js';
import { renderCanvas } from '../../render/canvas-renderer.js';
import { renderFontSourceToCanvas } from '../../render/font/font-import.js';
import { renderKanjiVGSourceToCanvas } from '../../render/font/kanjivg-import.js';
import { GLYPH_SIZE } from './constants.js';

/** A thumbnail tile for the glyph strip: canvas preview + delete button. */
export function createCharCard(charId, charData, onSelect, onDelete) {
  const card = document.createElement('div');
  card.className = 'char-card';
  card.addEventListener('click', () => onSelect(charId));
  const canvas = document.createElement('canvas');
  canvas.width = 80;
  canvas.height = 80;
  renderThumbnail(canvas, charData);
  card.appendChild(canvas);
  if (onDelete) {
    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'char-card-delete';
    delBtn.title = `Delete glyph "${charId}"`;
    delBtn.textContent = '×';
    delBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      onDelete(charId);
    });
    card.appendChild(delBtn);
  }
  return card;
}

export function renderThumbnail(canvas, charData) {
  if (!charData) {
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    return;
  }
  const offscreen = document.createElement('canvas');
  offscreen.width = GLYPH_SIZE;
  offscreen.height = GLYPH_SIZE;
  const offCtx = offscreen.getContext('2d');
  const global = getGlobal();
  const layers = buildRuntimeLayers(global, charData, GLYPH_SIZE);
  const transformOverrides = charData.transformOverrides || {};
  // Thumbnails always render at neutral stretch so they don't update on every
  // slider tick (re-meshing every glyph is too expensive). The preview canvas
  // still reflects the live stretch state.
  const transform = {
    ...resolveTransform(global, transformOverrides),
    stretchAngle: 0,
    stretchAmount: 0,
  };
  const imageTransform = {
    imageOffsetX: charData.imageOffsetX ?? 0,
    imageOffsetY: charData.imageOffsetY ?? 0,
    imageScale: charData.imageScale ?? 1,
  };
  const drawWithBackground = (bg) => {
    renderCanvas(offCtx, layers, {
      backgroundImage: bg,
      backgroundOpacity: 0.3,
      transform,
      glyphSize: GLYPH_SIZE,
      preview: true,
      imageTransform,
      fontMetrics: global.fontMetrics,
    });
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(offscreen, 0, 0, canvas.width, canvas.height);
  };
  if (charData.imagePath) {
    loadImageCached(charData.imagePath).then(img => {
      if (img) drawWithBackground(img);
      else drawWithBackground(null);
    });
  } else if (charData.fontSource) {
    renderFontSourceToCanvas(charData.fontSource, GLYPH_SIZE, global.fontMetrics)
      .then(drawWithBackground)
      .catch(() => drawWithBackground(null));
  } else if (charData.kanjivgSource) {
    renderKanjiVGSourceToCanvas(charData.kanjivgSource, GLYPH_SIZE, global.kanjivgStrokeWidth)
      .then(drawWithBackground)
      .catch(() => drawWithBackground(null));
  } else {
    renderCanvas(offCtx, layers, {
      transform,
      glyphSize: GLYPH_SIZE,
      preview: true,
      fontMetrics: global.fontMetrics,
    });
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(offscreen, 0, 0, canvas.width, canvas.height);
  }
}
