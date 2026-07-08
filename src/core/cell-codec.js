/**
 * Compact per-character cell storage (cellsV2).
 *
 * Grids are deterministic: gridName + gridParams + the canonical 1024px glyph
 * space fully determine every cell's position. So instead of persisting each
 * saved cell as `{center:{x,y}, filled, manualOverride, orientation, ...}`
 * (~100 bytes/cell — heavy typesets used to produce multi-hundred-KB glyph
 * docs), we persist *indices into the generated cell array* plus quantized
 * orientation data:
 *
 *   cellsV2: {
 *     params,     // full grid params the indices were captured under
 *     n,          // generated cell count at capture time (index-validity guard)
 *     filled,     // indices of filled cells
 *     manual,     // indices of manualOverride cells
 *     orientIdx,  // indices of cells carrying an orientation…
 *     orient,     // …their angle in deci-degrees [0, 1800)
 *     coher,      // …their coherence in percent [0, 100]
 *     src,        // …their source, one char each: i(mage) / p(ropagated) / m(anual)
 *   }
 *
 * Decoding regenerates the reference grid from `params` and maps indices back
 * to centers, so the nearest-center matching in layer-builder keeps working
 * even when the current grid params have drifted from the saved ones. Legacy
 * `cells` arrays (with centers) remain readable; they are rewritten to
 * cellsV2 the next time the character is saved.
 */

/** Canonical glyph-space size every editor generates grids at. */
export const GRID_SPACE = 1024;

const SRC_TO_CHAR = { image: 'i', propagated: 'p', manual: 'm' };
export const CHAR_TO_SRC = { i: 'image', p: 'propagated', m: 'manual' };

/**
 * Encode runtime cells into the compact cellsV2 payload.
 * Returns null when there is nothing worth persisting.
 */
export function encodeCellsV2(cells, gridParams) {
  const filled = [];
  const manual = [];
  const orientIdx = [];
  const orient = [];
  const coher = [];
  let src = '';
  cells.forEach((c, i) => {
    if (c.filled) filled.push(i);
    if (c.manualOverride) manual.push(i);
    if ((c.filled || c.manualOverride) && c.orientation != null) {
      orientIdx.push(i);
      orient.push(Math.round(c.orientation * 10));
      coher.push(Math.round((c.coherence ?? 0) * 100));
      src += SRC_TO_CHAR[c.orientationSource] || 'i';
    }
  });
  if (filled.length === 0 && manual.length === 0) return null;
  return {
    params: { ...gridParams },
    n: cells.length,
    filled,
    manual,
    orientIdx,
    orient,
    coher,
    src,
  };
}

/**
 * Expand a cellsV2 payload back into the legacy saved-cell shape
 * (`[{center, filled, manualOverride, orientation, coherence,
 * orientationSource}]`) by regenerating the reference grid it was captured
 * against. Returns null when the payload can't be resolved (unknown grid,
 * generation mismatch) — callers then simply skip applying saved cells.
 */
export function decodeCellsV2(v2, gridPlugin) {
  if (!v2 || !gridPlugin) return null;
  const refCells = gridPlugin.generateCells(GRID_SPACE, GRID_SPACE, v2.params || {});
  if (typeof v2.n === 'number' && refCells.length !== v2.n) {
    // The grid implementation no longer reproduces the capture-time layout —
    // indices can't be trusted.
    console.warn(`cellsV2: generated ${refCells.length} cells but ${v2.n} were saved — skipping`);
    return null;
  }
  const byIndex = new Map();
  const savedAt = (i) => {
    if (i < 0 || i >= refCells.length) return null;
    let s = byIndex.get(i);
    if (!s) {
      s = {
        center: refCells[i].center,
        filled: false,
        manualOverride: false,
        orientation: null,
        coherence: 0,
        orientationSource: null,
      };
      byIndex.set(i, s);
    }
    return s;
  };
  for (const i of v2.filled || []) {
    const s = savedAt(i);
    if (s) s.filled = true;
  }
  for (const i of v2.manual || []) {
    const s = savedAt(i);
    if (s) s.manualOverride = true;
  }
  (v2.orientIdx || []).forEach((i, k) => {
    const s = savedAt(i);
    if (!s) return;
    s.orientation = (v2.orient?.[k] ?? 0) / 10;
    s.coherence = (v2.coher?.[k] ?? 0) / 100;
    s.orientationSource = CHAR_TO_SRC[v2.src?.[k]] || 'image';
  });
  return [...byIndex.values()];
}

/** Shallow param equality — grid params are flat maps of numbers/strings. */
export function gridParamsEqual(a, b) {
  const ka = Object.keys(a || {});
  const kb = Object.keys(b || {});
  if (ka.length !== kb.length) return false;
  return ka.every((k) => a[k] === b[k]);
}
