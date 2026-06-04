/**
 * Browser file I/O helpers shared by the editor and compose views.
 */

/** Read a File/Blob as a `data:` URL. */
export function fileToDataURL(file) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.readAsDataURL(file);
  });
}

/**
 * Load an image from a URL. crossOrigin is set before src so HTTPS Storage
 * URLs can be drawn into a canvas without tainting it (data: URLs ignore it).
 */
export function loadImage(src) {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.src = src;
  });
}

/**
 * Save a Blob through the OS save dialog (Chrome/Edge) so the user picks the
 * filename and folder. Falls back to anchor-download on Safari/Firefox.
 * Silently no-ops if the user cancels the picker.
 */
export async function saveBlobWithPicker(blob, suggestedName, { description = '', accept } = {}) {
  if (typeof window.showSaveFilePicker === 'function') {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName,
        types: accept ? [{ description, accept }] : undefined,
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return;
    } catch (e) {
      if (e?.name === 'AbortError') return;
      console.warn('Save picker failed, falling back to download:', e);
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = suggestedName;
  a.click();
  URL.revokeObjectURL(url);
}
