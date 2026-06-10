import { accumulateCellPixels } from './mesh-accumulate.js';

self.addEventListener('message', (e) => {
  const { id, sourceBuf, maskBuf, cellCount, alphaThreshold, darkBrightness } = e.data;
  const source = new Uint8ClampedArray(sourceBuf);
  const mask = new Uint8ClampedArray(maskBuf);
  const { dark, total } = accumulateCellPixels(source, mask, cellCount, alphaThreshold, darkBrightness);
  self.postMessage({ id, dark, total }, [dark.buffer, total.buffer]);
});
