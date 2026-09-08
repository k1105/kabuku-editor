/**
 * Glyph ink bounds — the bounding box of a glyph's *filled* cells in glyph-local
 * (RENDER_SIZE) space, expressed as em fractions so callers can scale by any
 * fontSize.
 *
 * Used by the animation "Center" align mode (animation.alignMode): instead of
 * sitting glyphs on the shared baseline and centering the em-box block within
 * the frame, the union of the laid-out glyphs' ink boxes is what gets centered,
 * so a glyph's visible body — not its em box — lands on the frame center.
 *
 * Bounds are taken from the static (undisplaced, unscaled) cell geometry:
 * stretch/gap and per-cell scale are design effects applied on top, and the
 * anchor should not drift as they animate.
 */

/** Axis-aligned bounds of one cell geometry (rect / circle / polygon), or null. */
export function geometryBounds(geometry, center) {
  if (!geometry) {
    return center ? { minX: center.x, minY: center.y, maxX: center.x, maxY: center.y } : null;
  }
  switch (geometry.type) {
    case 'rect':
      return {
        minX: geometry.x, minY: geometry.y,
        maxX: geometry.x + geometry.width, maxY: geometry.y + geometry.height,
      };
    case 'circle':
      return {
        minX: geometry.cx - geometry.r, minY: geometry.cy - geometry.r,
        maxX: geometry.cx + geometry.r, maxY: geometry.cy + geometry.r,
      };
    case 'polygon': {
      const pts = geometry.points || [];
      if (pts.length === 0) return null;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const p of pts) {
        if (p.x < minX) minX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.x > maxX) maxX = p.x;
        if (p.y > maxY) maxY = p.y;
      }
      return { minX, minY, maxX, maxY };
    }
    default:
      return center ? { minX: center.x, minY: center.y, maxX: center.x, maxY: center.y } : null;
  }
}

function unionInto(acc, b) {
  if (!b) return acc;
  if (!acc) return { ...b };
  if (b.minX < acc.minX) acc.minX = b.minX;
  if (b.minY < acc.minY) acc.minY = b.minY;
  if (b.maxX > acc.maxX) acc.maxX = b.maxX;
  if (b.maxY > acc.maxY) acc.maxY = b.maxY;
  return acc;
}

/**
 * Ink bounds of a glyph's runtime layers, in em fractions (0..1 over the
 * glyph-local size). Returns null when no visible layer has a filled cell.
 *
 * @param {Array<{visible:boolean, cells:Array}>} layers
 * @param {number} glyphSize - the local size the cells were generated at
 */
export function layersInkBounds(layers, glyphSize) {
  let acc = null;
  for (const layer of layers || []) {
    if (!layer.visible) continue;
    for (const cell of layer.cells) {
      if (!cell.filled) continue;
      acc = unionInto(acc, geometryBounds(cell.geometry, cell.center));
    }
  }
  if (!acc) return null;
  return {
    minX: acc.minX / glyphSize, minY: acc.minY / glyphSize,
    maxX: acc.maxX / glyphSize, maxY: acc.maxY / glyphSize,
  };
}

/**
 * Union of the ink boxes of every laid-out glyph, in layout px. A glyph with no
 * ink data (whitespace / no layers) contributes nothing; a missing glyph draws
 * a placeholder box, so its full em box counts.
 *
 * @param {Array<{x:number,y:number,charId:string,missing:boolean}>} positions
 * @param {number} fontSize
 * @param {(charId:string) => ({minX,minY,maxX,maxY}|null)} inkBoundsFor - em-fraction bounds
 */
export function layoutInkBounds(positions, fontSize, inkBoundsFor) {
  let acc = null;
  for (const pos of positions) {
    if (pos.missing) {
      acc = unionInto(acc, { minX: pos.x, minY: pos.y, maxX: pos.x + fontSize, maxY: pos.y + fontSize });
      continue;
    }
    const b = inkBoundsFor?.(pos.charId);
    if (!b) continue;
    acc = unionInto(acc, {
      minX: pos.x + b.minX * fontSize, minY: pos.y + b.minY * fontSize,
      maxX: pos.x + b.maxX * fontSize, maxY: pos.y + b.maxY * fontSize,
    });
  }
  return acc;
}

/**
 * Shift `positions` so the ink union is centered on the em-box block described
 * by `blockWidth` × `blockHeight` (the box that the frame centering targets).
 * Returns a new positions array; the input is left untouched. No-op (returns
 * the input) when there is no ink to center on.
 */
export function centerPositionsOnInk(positions, fontSize, blockWidth, blockHeight, inkBoundsFor) {
  const ink = layoutInkBounds(positions, fontSize, inkBoundsFor);
  if (!ink) return positions;
  const shiftX = blockWidth / 2 - (ink.minX + ink.maxX) / 2;
  const shiftY = blockHeight / 2 - (ink.minY + ink.maxY) / 2;
  if (shiftX === 0 && shiftY === 0) return positions;
  return positions.map(p => ({ ...p, x: p.x + shiftX, y: p.y + shiftY }));
}
