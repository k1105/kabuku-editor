/**
 * Auto-mesh: analyze image pixels against cells to determine filled state.
 * @param {CanvasRenderingContext2D} imgCtx - context with the source image drawn
 * @param {Cell[]} cells - cells to evaluate
 * @param {number} threshold - black pixel ratio threshold (0-1)
 */
export function autoMesh(imgCtx, cells, threshold = 0.5) {
  const imgData = imgCtx.getImageData(0, 0, imgCtx.canvas.width, imgCtx.canvas.height);
  const { data, width } = imgData;

  // Create an offscreen canvas to test cell paths
  const testCanvas = new OffscreenCanvas(imgCtx.canvas.width, imgCtx.canvas.height);
  const testCtx = testCanvas.getContext('2d');

  for (const cell of cells) {
    if (cell.manualOverride) continue;

    // Get bounding box of the cell by sampling center and path
    // Use the cell's path to create a mask
    testCtx.clearRect(0, 0, testCanvas.width, testCanvas.height);
    testCtx.fillStyle = '#000';
    testCtx.fill(cell.path);
    const maskData = testCtx.getImageData(0, 0, testCanvas.width, testCanvas.height);

    let totalPixels = 0;
    let darkPixels = 0;

    // Scan the bounding area around cell center
    const r = 50; // scan radius - generous
    const minX = Math.max(0, Math.floor(cell.center.x - r));
    const maxX = Math.min(width - 1, Math.ceil(cell.center.x + r));
    const minY = Math.max(0, Math.floor(cell.center.y - r));
    const maxY = Math.min(imgCtx.canvas.height - 1, Math.ceil(cell.center.y + r));

    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const idx = (y * width + x) * 4;
        // Check if pixel is inside the cell path (mask alpha > 0)
        if (maskData.data[idx + 3] > 0) {
          totalPixels++;
          // Check if source pixel is dark (low brightness)
          const brightness = (data[idx] + data[idx + 1] + data[idx + 2]) / 3;
          if (brightness < 128) {
            darkPixels++;
          }
        }
      }
    }

    if (totalPixels > 0) {
      cell.filled = (darkPixels / totalPixels) >= threshold;
    }
  }
}
