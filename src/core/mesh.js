/**
 * Auto-mesh: analyze image pixels against cells to determine filled state.
 *
 * Algorithm (O(N + pixels) instead of O(N × pixels)):
 *   1. Render all target cells onto a single ID-mask canvas, each cell painted
 *      in a unique color encoding its index in R+G channels (B=0, alpha=255).
 *   2. Single pass over source pixels: decode cell ID from mask, accumulate
 *      total/dark counts per cell.
 *   3. For each cell, set filled = (dark/total) >= threshold.
 *
 * Anti-aliased edge pixels (mask alpha < 200) are skipped — they have ambiguous
 * colors at cell boundaries. The resulting per-cell ratio is unaffected.
 */

const ALPHA_THRESHOLD = 200;
const DARK_BRIGHTNESS = 128;

export function autoMesh(imgCtx, cells, threshold = 0.5) {
  const W = imgCtx.canvas.width;
  const H = imgCtx.canvas.height;
  const targetCells = collectTargets(cells);
  if (targetCells.length === 0) return;

  const sourceData = imgCtx.getImageData(0, 0, W, H).data;
  const maskData = renderIdMask(W, H, targetCells);
  const { dark, total } = accumulate(sourceData, maskData, targetCells.length);
  applyResults(targetCells, dark, total, threshold);
}

/** Async variant: pixel-loop runs on a Worker thread. Mask rendering stays on
 *  main thread because Path2D is not transferable. */
export async function autoMeshAsync(imgCtx, cells, threshold = 0.5) {
  const W = imgCtx.canvas.width;
  const H = imgCtx.canvas.height;
  const targetCells = collectTargets(cells);
  if (targetCells.length === 0) return;

  const sourceData = imgCtx.getImageData(0, 0, W, H);
  const maskData = renderIdMaskImageData(W, H, targetCells);

  const { dark, total } = await runWorker({
    sourceBuf: sourceData.data.buffer,
    maskBuf: maskData.data.buffer,
    cellCount: targetCells.length,
    alphaThreshold: ALPHA_THRESHOLD,
    darkBrightness: DARK_BRIGHTNESS,
  });

  applyResults(targetCells, dark, total, threshold);
}

function collectTargets(cells) {
  const out = [];
  for (const c of cells) {
    if (!c.manualOverride) out.push(c);
  }
  return out;
}

function renderIdMaskImageData(W, H, cells) {
  const off = new OffscreenCanvas(W, H);
  const ctx = off.getContext('2d');
  for (let i = 0; i < cells.length; i++) {
    const id = i + 1; // 0 reserved for background
    ctx.fillStyle = `rgb(${id & 0xFF},${(id >> 8) & 0xFF},0)`;
    ctx.fill(cells[i].path);
  }
  return ctx.getImageData(0, 0, W, H);
}

function renderIdMask(W, H, cells) {
  return renderIdMaskImageData(W, H, cells).data;
}

function accumulate(source, mask, cellCount) {
  const dark = new Uint32Array(cellCount);
  const total = new Uint32Array(cellCount);
  const len = source.length;
  for (let i = 0; i < len; i += 4) {
    if (mask[i + 3] < ALPHA_THRESHOLD) continue;
    const id = mask[i] | (mask[i + 1] << 8);
    if (id === 0 || id > cellCount) continue;
    const idx = id - 1;
    total[idx]++;
    const brightness = (source[i] + source[i + 1] + source[i + 2]) / 3;
    if (brightness < DARK_BRIGHTNESS) dark[idx]++;
  }
  return { dark, total };
}

function applyResults(cells, dark, total, threshold) {
  for (let i = 0; i < cells.length; i++) {
    if (total[i] > 0) {
      cells[i].filled = (dark[i] / total[i]) >= threshold;
    }
  }
}

let _worker = null;
function getWorker() {
  if (!_worker) {
    _worker = new Worker(new URL('./mesh-worker.js', import.meta.url), { type: 'module' });
  }
  return _worker;
}

let _msgId = 0;
function runWorker(payload) {
  const id = ++_msgId;
  return new Promise((resolve) => {
    const worker = getWorker();
    const onMessage = (e) => {
      if (e.data?.id !== id) return;
      worker.removeEventListener('message', onMessage);
      resolve(e.data);
    };
    worker.addEventListener('message', onMessage);
    worker.postMessage({ id, ...payload }, [payload.sourceBuf, payload.maskBuf]);
  });
}
