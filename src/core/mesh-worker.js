self.addEventListener('message', (e) => {
  const { id, sourceBuf, maskBuf, cellCount, alphaThreshold, darkBrightness } = e.data;
  const source = new Uint8ClampedArray(sourceBuf);
  const mask = new Uint8ClampedArray(maskBuf);
  const dark = new Uint32Array(cellCount);
  const total = new Uint32Array(cellCount);
  const len = source.length;
  for (let i = 0; i < len; i += 4) {
    if (mask[i + 3] < alphaThreshold) continue;
    const cid = mask[i] | (mask[i + 1] << 8);
    if (cid === 0 || cid > cellCount) continue;
    const idx = cid - 1;
    total[idx]++;
    const brightness = (source[i] + source[i + 1] + source[i + 2]) / 3;
    if (brightness < darkBrightness) dark[idx]++;
  }
  self.postMessage({ id, dark, total }, [dark.buffer, total.buffer]);
});
