/**
 * Compute glyph positions for text composition.
 *
 * @param {string} text - input text
 * @param {Set<string>} availableCharIds - characters available in the project
 * @param {object} opts
 * @param {number} opts.fontSize - pixel size per character
 * @param {number} opts.textBoxWidth - pixel width for wrapping (horizontal) or height for wrapping (vertical)
 * @param {number} opts.kerning - extra spacing in pixels
 * @param {number} opts.lineHeight - multiplier on fontSize for line/column spacing
 * @param {'horizontal'|'vertical'} opts.writingMode
 * @returns {Array<{char: string, charId: string, x: number, y: number, missing: boolean}>}
 */
export function layoutText(text, availableCharIds, opts) {
  const {
    fontSize = 64,
    textBoxWidth = 800,
    kerning = 0,
    lineHeight = 1.5,
    writingMode = 'horizontal',
  } = opts;

  const step = fontSize + kerning;
  const lineStep = fontSize * lineHeight;
  const result = [];

  if (writingMode === 'vertical') {
    let x = 0;
    let y = 0;
    for (const char of text) {
      if (char === '\n') {
        x -= lineStep;
        y = 0;
        continue;
      }
      if (y + fontSize > textBoxWidth && y > 0) {
        x -= lineStep;
        y = 0;
      }
      result.push({ char, charId: char, x, y, missing: !availableCharIds.has(char) });
      y += step;
    }
    // Shift all positions so the rightmost column is at x=0
    if (result.length > 0) {
      const minX = Math.min(...result.map(r => r.x));
      for (const r of result) r.x -= minX;
    }
  } else {
    let x = 0;
    let y = 0;
    for (const char of text) {
      if (char === '\n') {
        x = 0;
        y += lineStep;
        continue;
      }
      if (x + fontSize > textBoxWidth && x > 0) {
        x = 0;
        y += lineStep;
      }
      result.push({ char, charId: char, x, y, missing: !availableCharIds.has(char) });
      x += step;
    }
  }

  return result;
}

/**
 * Compute the bounding box of a layout result.
 */
export function layoutBounds(positions, fontSize) {
  if (positions.length === 0) return { width: 0, height: 0 };
  let maxX = 0, maxY = 0;
  for (const p of positions) {
    if (p.x + fontSize > maxX) maxX = p.x + fontSize;
    if (p.y + fontSize > maxY) maxY = p.y + fontSize;
  }
  return { width: Math.ceil(maxX), height: Math.ceil(maxY) };
}
