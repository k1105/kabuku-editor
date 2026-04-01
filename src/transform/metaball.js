/**
 * Metaball effect: blur the cell fills then apply contrast to sharpen edges.
 *
 * Workflow:
 *   1. Draw cells onto a white-background offscreen canvas
 *   2. Apply blur + contrast filter
 *   3. Extract result as alpha mask (dark pixels → opaque black)
 *   4. Composite back onto the main canvas
 *
 * @param {CanvasRenderingContext2D} ctx - main canvas (cells already drawn)
 * @param {number} blurRadius - blur radius in px
 * @param {number} contrast - contrast multiplier (1 = no change, >1 = sharper)
 */
export function applyMetaballFilter(ctx, blurRadius, contrast) {
  if (blurRadius <= 0 && contrast <= 1) return;

  const { width, height } = ctx.canvas;

  // Step 1: white bg + current cell fills → blur + contrast
  const off = new OffscreenCanvas(width, height);
  const offCtx = off.getContext('2d');

  // White background so contrast filter has something to work with
  offCtx.fillStyle = '#fff';
  offCtx.fillRect(0, 0, width, height);
  offCtx.drawImage(ctx.canvas, 0, 0);

  // Apply filter by drawing onto a second offscreen
  const filtered = new OffscreenCanvas(width, height);
  const fCtx = filtered.getContext('2d');
  fCtx.filter = `blur(${blurRadius}px) contrast(${contrast})`;
  fCtx.drawImage(off, 0, 0);

  // Step 2: convert to alpha mask — dark pixels become opaque black
  const imageData = fCtx.getImageData(0, 0, width, height);
  const data = imageData.data;
  for (let i = 0; i < data.length; i += 4) {
    const brightness = (data[i] + data[i + 1] + data[i + 2]) / 3;
    // Invert: dark → opaque, white → transparent
    const alpha = 255 - brightness;
    data[i] = 0;
    data[i + 1] = 0;
    data[i + 2] = 0;
    data[i + 3] = alpha;
  }
  fCtx.putImageData(imageData, 0, 0);

  // Step 3: replace main canvas content
  ctx.clearRect(0, 0, width, height);
  ctx.drawImage(filtered, 0, 0);
}
