/**
 * The auto-mesh pixel accumulation loop, shared by the sync path (mesh.js)
 * and the worker thread (mesh-worker.js — a module worker, so it can import
 * this directly).
 *
 * Single pass over source pixels: decode the cell ID from the mask's R+G
 * channels, count total and dark pixels per cell. Anti-aliased mask edges
 * (alpha < alphaThreshold) are skipped — their colors are ambiguous at cell
 * boundaries.
 *
 * @param {Uint8ClampedArray} source - RGBA source image pixels
 * @param {Uint8ClampedArray} mask   - RGBA ID-mask pixels
 * @param {number} cellCount
 * @param {number} alphaThreshold
 * @param {number} darkBrightness
 * @returns {{dark: Uint32Array, total: Uint32Array}}
 */
export function accumulateCellPixels(source, mask, cellCount, alphaThreshold, darkBrightness) {
  const dark = new Uint32Array(cellCount);
  const total = new Uint32Array(cellCount);
  const len = source.length;
  for (let i = 0; i < len; i += 4) {
    if (mask[i + 3] < alphaThreshold) continue;
    const id = mask[i] | (mask[i + 1] << 8);
    if (id === 0 || id > cellCount) continue;
    const idx = id - 1;
    total[idx]++;
    const brightness = (source[i] + source[i + 1] + source[i + 2]) / 3;
    if (brightness < darkBrightness) dark[idx]++;
  }
  return { dark, total };
}
