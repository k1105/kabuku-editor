/**
 * KanjiVG base-path editor for the Guides pane.
 *
 * When the base-image layer (下地) of a kanjivg-sourced glyph is active, this
 * holds the editable subpaths (109-space) and draws draggable anchors/handles
 * over the canvas. The page wires its mouse events through hitTest / startDrag
 * / dragMove / endDrag.
 *
 * `getEnv()` returns the page's live state — { project, selectedCharId,
 * baseLayerActive, panel, previewMode, scaleL, global } — read lazily so the
 * editor always sees current values without holding its own copies.
 */
import { loadKanjiVGPaths, renderEditedKanjiVGToCanvas, KVG_VIEWBOX } from '../../render/font/kanjivg-import.js';
import { parsePaths, serializePaths, moveHandle, moveAnchor } from '../../render/font/kanjivg-path-edit.js';
import { GLYPH_SIZE } from './constants.js';

export function createKvgEditor({ canvas, ctx, getEnv, setBackgroundImage, redraw }) {
  // Editable subpaths, or null when not editing. A drag in progress is
  // { sp, ai, which: 'pt' | 'cIn' | 'cOut' }.
  let edit = null;
  let drag = null;

  // Build the editable subpaths for the active glyph's kanjivg base. Uses the
  // source's edited paths if present, else the fetched KanjiVG SVG (async — the
  // overlay appears once it resolves). No-op for non-kanjivg bases.
  function enterEdit() {
    edit = null;
    drag = null;
    const { project, selectedCharId } = getEnv();
    const src = project.characters[selectedCharId]?.kanjivgSource;
    if (!src) return;
    const targetId = selectedCharId;
    const build = (paths) => {
      const env = getEnv();
      if (env.selectedCharId !== targetId || !env.baseLayerActive) return;
      try {
        edit = parsePaths(paths);
      } catch (err) {
        console.warn('KanjiVG path parse failed; path editing disabled.', err);
        edit = null;
      }
      redraw();
    };
    if (src.editedPaths?.length) build(src.editedPaths);
    else loadKanjiVGPaths(src.char).then((r) => build(r.paths)).catch(() => {});
  }

  function exitEdit() {
    edit = null;
    drag = null;
  }

  // 109-space (KanjiVG) <-> glyph-space px, honoring the per-char image
  // offset/scale that positions the base within the glyph box.
  function kvgToGlyph(p) {
    const { project, selectedCharId } = getEnv();
    const cd = project.characters[selectedCharId] || {};
    const size = GLYPH_SIZE * (cd.imageScale ?? 1);
    const base = (GLYPH_SIZE - size) / 2;
    const f = size / KVG_VIEWBOX;
    return { x: base + (cd.imageOffsetX ?? 0) + p.x * f, y: base + (cd.imageOffsetY ?? 0) + p.y * f };
  }
  function glyphToKvg(g) {
    const { project, selectedCharId } = getEnv();
    const cd = project.characters[selectedCharId] || {};
    const size = GLYPH_SIZE * (cd.imageScale ?? 1);
    const base = (GLYPH_SIZE - size) / 2;
    const f = size / KVG_VIEWBOX;
    return { x: (g.x - base - (cd.imageOffsetX ?? 0)) / f, y: (g.y - base - (cd.imageOffsetY ?? 0)) / f };
  }
  // Pointer event -> glyph-space px (mirrors handlePaint's mapping).
  function eventToGlyph(e) {
    const { scaleL } = getEnv();
    const rect = canvas.getBoundingClientRect();
    const px = (e.clientX - rect.left) * (canvas.width / rect.width);
    const py = (e.clientY - rect.top) * (canvas.height / rect.height);
    const s = scaleL;
    return {
      x: (px - (canvas.width - GLYPH_SIZE * s) / 2) / s,
      y: (py - (canvas.height - GLYPH_SIZE * s) / 2) / s,
    };
  }

  function hitTest(e, { anchorsOnly = false } = {}) {
    if (!edit) return null;
    const { scaleL } = getEnv();
    const rect = canvas.getBoundingClientRect();
    const sx = canvas.width / rect.width; // = DPR
    const g = eventToGlyph(e);
    const r = 9 * sx / scaleL;            // ~9 CSS px tolerance in glyph-space
    const r2 = r * r;
    const near = (a) => { const dx = g.x - a.x, dy = g.y - a.y; return dx * dx + dy * dy <= r2; };
    if (!anchorsOnly) {
      for (let sp = 0; sp < edit.length; sp++) {
        const anchors = edit[sp].anchors;
        for (let ai = 0; ai < anchors.length; ai++) {
          const a = anchors[ai];
          if (a.cIn && near(kvgToGlyph(a.cIn))) return { sp, ai, which: 'cIn' };
          if (a.cOut && near(kvgToGlyph(a.cOut))) return { sp, ai, which: 'cOut' };
        }
      }
    }
    for (let sp = 0; sp < edit.length; sp++) {
      const anchors = edit[sp].anchors;
      for (let ai = 0; ai < anchors.length; ai++) {
        if (near(kvgToGlyph(anchors[ai].pt))) return { sp, ai, which: 'pt' };
      }
    }
    return null;
  }

  function dragMove(e) {
    if (!drag || !edit) return;
    const a = edit[drag.sp].anchors[drag.ai];
    const k = glyphToKvg(eventToGlyph(e));
    if (drag.which === 'pt') moveAnchor(a, k);
    else moveHandle(a, drag.which, k);
    syncBase();
  }

  // Serialize the edited subpaths back onto kanjivgSource, re-stroke the base
  // synchronously, and redraw (overlay included).
  function syncBase() {
    if (!edit) return;
    const { project, selectedCharId, global } = getEnv();
    const cd = project.characters[selectedCharId];
    if (!cd?.kanjivgSource) return;
    const paths = serializePaths(edit);
    cd.kanjivgSource = { ...cd.kanjivgSource, editedPaths: paths };
    const width = cd.kanjivgSource.strokeWidth ?? global.kanjivgStrokeWidth;
    setBackgroundImage(renderEditedKanjiVGToCanvas(paths, GLYPH_SIZE, width));
    redraw();
  }

  /**
   * Double-click on an anchor toggles smooth/broken handle continuity.
   * Returns true when an anchor mode actually changed (caller persists).
   */
  function toggleAnchorModeAt(e) {
    const hit = hitTest(e, { anchorsOnly: true });
    if (!hit) return false;
    const a = edit[hit.sp].anchors[hit.ai];
    if (!a.cIn || !a.cOut) return false; // endpoints have only one handle
    a.mode = a.mode === 'smooth' ? 'broken' : 'smooth';
    if (a.mode === 'smooth') moveHandle(a, 'cOut', a.cOut); // re-align cIn
    syncBase();
    return true;
  }

  // Draw anchors + bezier handles over the (already-blitted) base image.
  function drawOverlay() {
    const { previewMode, panel, baseLayerActive, scaleL } = getEnv();
    if (!edit || previewMode || panel !== 'pen' || !baseLayerActive) return;
    const dpr = window.devicePixelRatio || 1;
    const s = scaleL;
    const dx = (canvas.width - GLYPH_SIZE * s) / 2;
    const dy = (canvas.height - GLYPH_SIZE * s) / 2;
    const toScreen = (p) => { const g = kvgToGlyph(p); return { x: dx + g.x * s, y: dy + g.y * s }; };
    ctx.save();
    ctx.lineWidth = dpr;
    for (const sp of edit) {
      for (const a of sp.anchors) {
        const ps = toScreen(a.pt);
        ctx.strokeStyle = 'rgba(74,158,255,0.8)';
        ctx.fillStyle = '#4a9eff';
        for (const h of [a.cIn, a.cOut]) {
          if (!h) continue;
          const hs = toScreen(h);
          ctx.beginPath(); ctx.moveTo(ps.x, ps.y); ctx.lineTo(hs.x, hs.y); ctx.stroke();
          ctx.beginPath(); ctx.arc(hs.x, hs.y, 4 * dpr, 0, Math.PI * 2); ctx.fill();
        }
        const r = 4.5 * dpr;
        ctx.beginPath(); ctx.rect(ps.x - r, ps.y - r, r * 2, r * 2);
        ctx.fillStyle = a.mode === 'smooth' ? '#ffcc00' : '#ffffff';
        ctx.fill();
        ctx.strokeStyle = '#1a1a1a';
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  return {
    enterEdit,
    exitEdit,
    hitTest,
    dragMove,
    toggleAnchorModeAt,
    drawOverlay,
    isEditing: () => !!edit,
    hasDrag: () => !!drag,
    startDrag: (hit) => { drag = hit; },
    endDrag: () => { drag = null; },
  };
}
