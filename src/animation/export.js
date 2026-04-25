import { zipSync } from 'fflate';
import { GIFEncoder, quantize, applyPalette } from 'gifenc';

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function canvasToPngBytes(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(async (blob) => {
      if (!blob) { reject(new Error('toBlob returned null')); return; }
      const buf = await blob.arrayBuffer();
      resolve(new Uint8Array(buf));
    }, 'image/png');
  });
}

/**
 * Export rendered frames as a PNG sequence zipped into a single file.
 * @param {{frames: HTMLCanvasElement[], fps: number}} rendered
 */
export async function exportPngSequence(rendered) {
  const { frames } = rendered;
  const files = {};
  const pad = String(frames.length).length;
  for (let i = 0; i < frames.length; i++) {
    const name = `frame_${String(i).padStart(pad, '0')}.png`;
    files[name] = await canvasToPngBytes(frames[i]);
  }
  const zipped = zipSync(files, { level: 6 });
  const blob = new Blob([zipped], { type: 'application/zip' });
  downloadBlob(blob, 'kabuku_frames.zip');
}

/**
 * Export rendered frames as an animated GIF.
 */
export async function exportGif(rendered) {
  const { frames, fps, width, height } = rendered;
  const delay = Math.round(1000 / fps);
  const gif = GIFEncoder();

  for (let i = 0; i < frames.length; i++) {
    const fctx = frames[i].getContext('2d');
    const imgData = fctx.getImageData(0, 0, width, height);
    const palette = quantize(imgData.data, 256);
    const indexed = applyPalette(imgData.data, palette);
    gif.writeFrame(indexed, width, height, { palette, delay });
    // Yield occasionally
    if (i % 4 === 3) await new Promise(r => setTimeout(r, 0));
  }
  gif.finish();
  const bytes = gif.bytes();
  const blob = new Blob([bytes], { type: 'image/gif' });
  downloadBlob(blob, 'kabuku_animation.gif');
}
