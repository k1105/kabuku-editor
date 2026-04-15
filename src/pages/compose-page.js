import { loadProject, getGlobal, resolveTransform } from '../core/project.js';
import { layoutText, layoutBounds } from '../compose/text-layout.js';
import { createGlyphCache } from '../compose/glyph-cache.js';

export function renderComposePage(app) {
  const project = loadProject();
  const global = getGlobal();
  const charIds = new Set(Object.keys(project.characters));
  const glyphCache = createGlyphCache();
  const sourceImageCache = new Map(); // charId -> Image (base images for stretch preview)

  /** Get or load the source image for a character */
  function getSourceImage(charId) {
    if (sourceImageCache.has(charId)) return sourceImageCache.get(charId);
    const cd = project.characters[charId];
    if (!cd?.imagePath) return null;
    const img = new Image();
    img.src = cd.imagePath;
    img.onload = () => { sourceImageCache.set(charId, img); };
    sourceImageCache.set(charId, null); // placeholder to avoid re-loading
    return null;
  }

  // Preload all source images
  for (const cid of Object.keys(project.characters)) {
    getSourceImage(cid);
  }

  // State — default text from available characters
  const charIdList = Object.keys(project.characters);
  let inputText = charIdList.join('');
  let fontSize = 64;
  let textBoxWidth = 800;
  let kerning = 0;
  let lineHeight = 1.5;
  let writingMode = 'horizontal';
  let stretchAngle = global.stretchAngle ?? 0;
  let stretchAmount = global.stretchAmount ?? 0;
  let baseGap = global.baseGap ?? 0;
  let gapDirectionWeight = global.gapDirectionWeight ?? 0;
  let metaballRadius = global.metaballRadius ?? 8;

  function getTransform() {
    return {
      stretchAngle,
      stretchAmount,
      baseGap,
      gapDirectionWeight,
      metaballStrength: global.metaballStrength ?? 1,
      metaballRadius,
    };
  }

  // === Header ===
  const header = document.createElement('div');
  header.className = 'header';

  const backBtn = document.createElement('button');
  backBtn.textContent = 'Back';
  backBtn.addEventListener('click', () => { location.hash = '#/'; });

  const title = document.createElement('h1');
  title.textContent = 'Compose';

  header.appendChild(backBtn);
  header.appendChild(title);

  // === Page layout ===
  const page = document.createElement('div');
  page.className = 'edit-page';

  // --- Sidebar ---
  const sidebar = document.createElement('div');
  sidebar.className = 'sidebar';

  // Text input
  const textGroup = document.createElement('div');
  textGroup.className = 'param-group';
  const textTitle = document.createElement('h3');
  textTitle.textContent = 'Text';
  textTitle.style.marginTop = '0';
  const textarea = document.createElement('textarea');
  textarea.className = 'compose-textarea';
  textarea.value = inputText;
  textarea.addEventListener('input', () => {
    inputText = textarea.value;
    redraw();
  });
  const charListLabel = document.createElement('div');
  charListLabel.className = 'compose-char-list';
  charListLabel.textContent = charIdList.length > 0
    ? `Available: ${charIdList.join(' ')}`
    : 'No characters available. Import images first.';

  textGroup.appendChild(textTitle);
  textGroup.appendChild(textarea);
  textGroup.appendChild(charListLabel);
  sidebar.appendChild(textGroup);

  // Typography controls
  const typoGroup = document.createElement('div');
  typoGroup.className = 'param-group';
  const typoTitle = document.createElement('h3');
  typoTitle.textContent = 'Typography';
  typoGroup.appendChild(typoTitle);

  function addSlider(parent, label, value, min, max, step, onInput, onChange) {
    const row = document.createElement('div');
    row.className = 'param-row';
    const lbl = document.createElement('label');
    lbl.textContent = label;
    const input = document.createElement('input');
    input.type = 'range';
    input.min = min;
    input.max = max;
    input.step = step;
    input.value = value;
    const val = document.createElement('span');
    val.className = 'value';
    val.textContent = value;
    input.addEventListener('input', () => {
      val.textContent = input.value;
      onInput(parseFloat(input.value));
    });
    if (onChange) {
      input.addEventListener('change', () => {
        onChange(parseFloat(input.value));
      });
    }
    row.appendChild(lbl);
    row.appendChild(input);
    row.appendChild(val);
    parent.appendChild(row);
    return input;
  }

  addSlider(typoGroup, 'Font Size', fontSize, 16, 256, 1, (v) => {
    fontSize = v;
    redraw();
  });
  addSlider(typoGroup, 'Box Width', textBoxWidth, 200, 2000, 10, (v) => {
    textBoxWidth = v;
    redraw();
  });
  addSlider(typoGroup, 'Kerning', kerning, -20, 50, 1, (v) => {
    kerning = v;
    redraw();
  });
  addSlider(typoGroup, 'Line Height', lineHeight, 0.8, 3.0, 0.1, (v) => {
    lineHeight = v;
    redraw();
  });

  // Writing mode toggle
  const modeRow = document.createElement('div');
  modeRow.className = 'param-row';
  const modeLbl = document.createElement('label');
  modeLbl.textContent = 'Direction';
  const modeWrap = document.createElement('div');
  modeWrap.className = 'writing-mode-toggle';
  const hBtn = document.createElement('button');
  hBtn.className = 'tool-btn active';
  hBtn.textContent = 'Horizontal';
  const vBtn = document.createElement('button');
  vBtn.className = 'tool-btn';
  vBtn.textContent = 'Vertical';
  hBtn.addEventListener('click', () => {
    writingMode = 'horizontal';
    hBtn.classList.add('active');
    vBtn.classList.remove('active');
    redraw();
  });
  vBtn.addEventListener('click', () => {
    writingMode = 'vertical';
    vBtn.classList.add('active');
    hBtn.classList.remove('active');
    redraw();
  });
  modeWrap.appendChild(hBtn);
  modeWrap.appendChild(vBtn);
  modeRow.appendChild(modeLbl);
  modeRow.appendChild(modeWrap);
  typoGroup.appendChild(modeRow);

  sidebar.appendChild(typoGroup);

  // Stretch controls
  const stretchGroup = document.createElement('div');
  stretchGroup.className = 'param-group';
  const stretchTitle = document.createElement('h3');
  stretchTitle.textContent = 'Stretch';
  stretchGroup.appendChild(stretchTitle);

  addSlider(stretchGroup, 'Angle', stretchAngle, 0, 180, 1,
    (v) => { stretchAngle = v; redrawFast(); },
    (v) => { stretchAngle = v; onTransformRelease(); }
  );
  addSlider(stretchGroup, 'Amount', stretchAmount, 0, 2, 0.05,
    (v) => { stretchAmount = v; redrawFast(); },
    (v) => { stretchAmount = v; onTransformRelease(); }
  );

  sidebar.appendChild(stretchGroup);

  // Transform controls
  const transformGroup = document.createElement('div');
  transformGroup.className = 'param-group';
  const transformTitle = document.createElement('h3');
  transformTitle.textContent = 'Transform';
  transformGroup.appendChild(transformTitle);

  addSlider(transformGroup, 'Gap', baseGap, 0, 20, 0.5,
    (v) => { baseGap = v; },
    (v) => { baseGap = v; onTransformRelease(); }
  );
  addSlider(transformGroup, 'Gap Dir', gapDirectionWeight, 0, 1, 0.05,
    (v) => { gapDirectionWeight = v; },
    (v) => { gapDirectionWeight = v; onTransformRelease(); }
  );
  addSlider(transformGroup, 'Blur', metaballRadius, 0, 30, 1,
    (v) => { metaballRadius = v; },
    (v) => { metaballRadius = v; onTransformRelease(); }
  );

  sidebar.appendChild(transformGroup);

  // --- Main area ---
  const mainArea = document.createElement('div');
  mainArea.className = 'compose-canvas-area';

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  mainArea.appendChild(canvas);

  page.appendChild(sidebar);
  page.appendChild(mainArea);

  app.appendChild(header);
  app.appendChild(page);

  // === Rendering (shared layout) ===

  /** Compute shared layout + canvas sizing */
  function computeLayout() {
    const positions = layoutText(inputText, charIds, {
      fontSize, textBoxWidth, kerning, lineHeight, writingMode,
    });
    const overflow = fontSize * Math.max(stretchAmount, 0.5);
    const pad = 32 + overflow;
    const bounds = layoutBounds(positions, fontSize);
    const cw = Math.max(bounds.width + pad * 2, 200);
    const ch = Math.max(bounds.height + pad * 2, 200);
    // Expanded draw area per glyph so stretch doesn't clip
    const drawSize = fontSize + overflow * 2;
    const drawOffset = (drawSize - fontSize) / 2;
    return { positions, pad, cw, ch, drawSize, drawOffset };
  }

  function prepareCanvas(layout) {
    canvas.width = layout.cw;
    canvas.height = layout.ch;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, layout.cw, layout.ch);
  }

  function drawMissing(gx, gy) {
    ctx.fillStyle = '#f0f0f0';
    ctx.fillRect(gx, gy, fontSize, fontSize);
    ctx.strokeStyle = '#bbb';
    ctx.lineWidth = 1;
    ctx.strokeRect(gx, gy, fontSize, fontSize);
    ctx.fillStyle = '#999';
    ctx.font = `${Math.round(fontSize * 0.4)}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
  }

  function redraw() {
    canvas.style.transform = '';
    const layout = computeLayout();
    prepareCanvas(layout);
    const { positions, pad, drawSize, drawOffset } = layout;

    for (const pos of positions) {
      const gx = pad + pos.x;
      const gy = pad + pos.y;

      if (pos.missing) {
        drawMissing(gx, gy);
        ctx.fillText(pos.char, gx + fontSize / 2, gy + fontSize / 2);
        continue;
      }

      const charData = project.characters[pos.charId];
      const charTransform = resolveTransform(
        { ...global, stretchAngle, stretchAmount, baseGap, gapDirectionWeight, metaballRadius },
        charData?.transformOverrides || {}
      );
      const cached = glyphCache.get(pos.charId, charData, global, charTransform);
      if (cached) {
        ctx.drawImage(cached, gx - drawOffset, gy - drawOffset, drawSize, drawSize);
      }
    }
  }

  /** Lightweight preview: source images with stretch transform, same layout as redraw */
  function redrawFast() {
    const layout = computeLayout();
    prepareCanvas(layout);
    const { positions, pad, drawSize, drawOffset } = layout;

    // Stretch matrix: rotate(angle) * scaleX(1+amount) * rotate(-angle)
    const rad = (stretchAngle * Math.PI) / 180;
    const s = 1 + stretchAmount;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const a = cos * cos * s + sin * sin;
    const b = cos * sin * (s - 1);
    const d = sin * sin * s + cos * cos;

    for (const pos of positions) {
      const gx = pad + pos.x;
      const gy = pad + pos.y;
      // Draw at same expanded size as redraw
      const dx = gx - drawOffset;
      const dy = gy - drawOffset;
      const cx = dx + drawSize / 2;
      const cy = dy + drawSize / 2;

      if (pos.missing) {
        drawMissing(gx, gy);
        continue;
      }

      const srcImg = sourceImageCache.get(pos.charId);
      if (!srcImg) continue;

      ctx.save();
      ctx.globalCompositeOperation = 'multiply';
      // Apply stretch around glyph center
      ctx.transform(a, b, b, d, cx - (a * cx + b * cy), cy - (b * cx + d * cy));
      ctx.drawImage(srcImg, dx, dy, drawSize, drawSize);
      ctx.restore();
    }
  }

  function onTransformRelease() {
    canvas.style.transform = '';
    glyphCache.invalidateAll();
    redraw();
  }

  // Initial render
  requestAnimationFrame(() => redraw());
}
