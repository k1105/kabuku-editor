/**
 * The font editor's Settings modal (gear icon): JSON project import/export,
 * static/variable font export, language toggle.
 *
 * `project` and `global` are the page's live references — the page mutates
 * them in place across undo/redo, so reading them lazily here stays in sync.
 */
import { loadProject, saveProject, flushNow as flushProjectNow } from '../../core/project.js';
import { buildFontBytes } from '../../render/font-exporter.js';
import { buildVariableTTF, buildVariableFontFamilyZip, DEFAULT_FAMILY_ANGLES } from '../../render/font/vf-builder.js';
import { staticFontDialog, variableFontDialog } from '../../ui/export-dialog.js';
import { createSettingsModal, settingsToolBtn } from '../../ui/settings-modal.js';
import { iconButton } from '../../ui/icons.js';
import { createLangToggle } from '../../ui/i18n.js';
import { saveBlobWithPicker, saveFile, pickAndApplyJson } from '../../utils/file-io.js';

export function setupIndexSettings({ project, global, headerActions }) {
  const settings = createSettingsModal({ title: 'Settings', closeOnEscape: true });
  // Detach the Escape listener on hashchange so it doesn't leak across pages.
  window.addEventListener('hashchange', function detachSettings() {
    settings.destroy();
    window.removeEventListener('hashchange', detachSettings);
  });

  // --- Project (JSON import / export) ---
  const projectGroup = settings.addGroup('Project');
  const projectRow = document.createElement('div');
  projectRow.className = 'anim-button-row';
  const importJsonBtn = settingsToolBtn('upload', 'Import (.json)', () => doImportProject());
  importJsonBtn.title = 'Import a JSON project file';
  const exportProjectBtn = settingsToolBtn('download', 'Export (.json)', () => doExportProject());
  exportProjectBtn.title = 'Export full project (includes base images as data URLs)';
  projectRow.appendChild(importJsonBtn);
  projectRow.appendChild(exportProjectBtn);
  projectGroup.appendChild(projectRow);

  // --- Font Export ---
  const fontExportGroup = settings.addGroup('Font Export');
  const fontExportRow = document.createElement('div');
  fontExportRow.className = 'anim-button-row';
  fontExportRow.appendChild(settingsToolBtn('download', 'Static (.otf)', () => doStaticFontExport()));
  fontExportRow.appendChild(settingsToolBtn('download', 'Variable Font', () => doVariableFontExport()));
  fontExportGroup.appendChild(fontExportRow);

  // --- Language ---
  const langGroup = settings.addGroup('Language');
  langGroup.appendChild(createLangToggle());

  // Settings gear button in the header (first in the nav, like the animation
  // editor).
  const settingsBtn = iconButton('settings', 'Settings', { title: 'Settings' });
  settingsBtn.addEventListener('click', () => settings.open());
  headerActions.insertBefore(settingsBtn, headerActions.firstChild);

  async function doExportProject() {
    // Strip session-level globals (preview stretch state) so re-importing
    // doesn't lock in a transient view.
    const out = JSON.parse(JSON.stringify(project));
    if (out.global) {
      delete out.global.stretchAngle;
      delete out.global.stretchAmount;
    }
    const json = JSON.stringify(out, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    await saveBlobWithPicker(blob, 'kabuku_project.json', {
      description: 'KABUKU project',
      accept: { 'application/json': ['.json'] },
    });
  }

  function doImportProject() {
    pickAndApplyJson(async (data) => {
      if (data.global) {
        if (data.global.stretchAngle === undefined) data.global.stretchAngle = 0;
        if (data.global.stretchAmount === undefined) data.global.stretchAmount = 0;
      }
      saveProject(data);
      // Wait for Firestore write so the reload picks up the imported state.
      await flushProjectNow();
      location.reload();
    });
  }

  function fontFamilyName() {
    return (global.fontInfo?.familyName || 'Kabuku').replace(/\s+/g, '');
  }

  async function doStaticFontExport() {
    const familyName = fontFamilyName();
    const result = await staticFontDialog({
      defaultFilename: `${familyName}-Regular.otf`,
      defaultStretch: global.stretchAmount || 0,
      defaultAngle: global.stretchAngle || 0,
    });
    if (!result) return;
    try {
      const proj = loadProject();
      const { bytes, skipped } = buildFontBytes(proj, {
        transform: {
          stretchAmount: result.stretchAmount,
          stretchAngle: result.stretchAngle,
          baseGap: 0,
          gapDirectionWeight: 0,
        },
      });
      const ok = await saveFile(bytes, result.filename, 'font/otf');
      if (ok && skipped.length > 0) {
        alert(`次のグリフはスキップされました（charId が Unicode 1文字でない）:\n${skipped.join(', ')}`);
      }
    } catch (e) {
      console.error(e);
      alert(`Static font export failed: ${e.message}`);
    }
  }

  async function doVariableFontExport() {
    const familyName = fontFamilyName();
    const result = await variableFontDialog({
      angles: DEFAULT_FAMILY_ANGLES,
      defaultFilenameSingle: `${familyName}-Angle$ANGLE.ttf`,
      defaultFilenameAll: `${familyName}-VF-Family.zip`,
    });
    if (!result) return;
    try {
      const proj = loadProject();
      if (result.mode === 'all') {
        const { zip, skipped, fileCount } = buildVariableFontFamilyZip(proj);
        const ok = await saveFile(zip, result.filename, 'application/zip');
        if (ok) {
          let msg = `${fileCount} ファイルを書き出しました。`;
          if (skipped.length > 0) msg += `\n\nスキップ:\n${skipped.join(', ')}`;
          alert(msg);
        }
      } else {
        const { binary, skipped } = buildVariableTTF(proj, {
          angle: result.angle,
          styleName: `Angle ${result.angle}`,
        });
        const ok = await saveFile(binary, result.filename, 'font/ttf');
        if (ok && skipped.length > 0) {
          alert(`スキップ:\n${skipped.join(', ')}`);
        }
      }
    } catch (e) {
      console.error(e);
      alert(`Variable font export failed: ${e.message}`);
    }
  }

  return { el: settings.el };
}
