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
 * Open a file picker for a .json file, parse it, and hand the result to
 * `apply`. Parse/apply errors surface via alert (shared import UX of the
 * font and animation editors).
 */
export function pickAndApplyJson(apply) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json';
  input.addEventListener('change', async () => {
    const file = input.files[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      await apply(data);
    } catch (e) {
      alert(`Import failed: ${e.message}`);
    }
  });
  input.click();
}

/** Trigger a plain anchor download (no save dialog). */
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * Save a Blob through the OS save dialog (Chrome/Edge) so the user picks the
 * filename and folder. Falls back to anchor-download on Safari/Firefox.
 * Returns false when the user cancels the picker, true otherwise.
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
      return true;
    } catch (e) {
      if (e?.name === 'AbortError') return false;
      console.warn('Save picker failed, falling back to download:', e);
    }
  }
  downloadBlob(blob, suggestedName);
  return true;
}

/**
 * Save bytes (Uint8Array or string) with a save dialog when supported, else
 * fall back to triggering an anchor download. Returns true on success, false
 * on cancellation. The picker's file-type filter is derived from the
 * suggested name's extension.
 */
export async function saveFile(bytes, suggestedName, mimeType) {
  const blob = new Blob([bytes], { type: mimeType });
  const ext = suggestedName.split('.').pop().toLowerCase();
  return saveBlobWithPicker(blob, suggestedName, {
    description: ext.toUpperCase() + ' file',
    accept: { [mimeType]: ['.' + ext] },
  });
}
