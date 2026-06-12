/**
 * Typeface snapshot link control for the animation editor's Settings modal:
 * a selector to re-link the snapshot to any existing Typeset (important when
 * the origin was deleted) and a Refresh button that re-pulls the snapshot
 * from the linked Typeset. Selecting only updates the link; the snapshot is
 * overwritten only on explicit Refresh.
 */
import { listFontProjects } from '../../core/project.js';
import {
  currentAnimationProjectId, refreshSnapshotFromOrigin,
  getOriginFontProjectId, getOriginFontProjectName, setLinkedFontProject,
} from '../../core/animation-project.js';
import { iconEl } from '../../ui/icons.js';

export function createTypefaceLinkControl() {
  // Snapshot link selector + Refresh button.
  // The selector lets the user re-link the snapshot to any existing Typeset —
  // important when the original origin has been deleted. Selecting a new
  // entry only updates the link; the snapshot itself is re-pulled only when
  // the Refresh button is clicked explicitly.
  const linkWrap = document.createElement('div');
  linkWrap.className = 'snapshot-link-wrap';

  const linkSelect = document.createElement('select');
  linkSelect.className = 'snapshot-link-select';
  linkSelect.disabled = true;
  const loadingOpt = document.createElement('option');
  loadingOpt.textContent = getOriginFontProjectName() || '(loading...)';
  loadingOpt.value = getOriginFontProjectId() || '';
  linkSelect.appendChild(loadingOpt);

  const refreshBtn = document.createElement('button');
  refreshBtn.className = 'tool-btn snapshot-refresh-btn';
  refreshBtn.title = getOriginFontProjectName()
    ? `Linked to "${getOriginFontProjectName()}" — click to re-pull the latest`
    : 'No Typeset linked';
  const refreshIcon = iconEl('refresh');
  const refreshLabel = document.createElement('span');
  refreshLabel.textContent = 'Refresh Snapshot';
  refreshBtn.appendChild(refreshIcon);
  refreshBtn.appendChild(refreshLabel);
  refreshBtn.addEventListener('click', async () => {
    if (!getOriginFontProjectId()) {
      alert('リンク先の Typeset が設定されていません。プルダウンから選択してください。');
      return;
    }
    if (!confirm('リンク中の Typeset の最新状態でスナップショットを上書きします。よろしいですか?')) return;
    refreshBtn.disabled = true;
    refreshLabel.textContent = 'Refreshing...';
    try {
      await refreshSnapshotFromOrigin(currentAnimationProjectId());
      location.reload();
    } catch (e) {
      console.error(e);
      alert(`Refresh に失敗しました: ${e.message}`);
      refreshBtn.disabled = false;
      refreshLabel.textContent = 'Refresh Snapshot';
    }
  });

  linkWrap.appendChild(linkSelect);
  linkWrap.appendChild(refreshBtn);

  (async () => {
    let list;
    try {
      list = await listFontProjects();
    } catch (e) {
      console.error('Failed to load Typeset list:', e);
      return;
    }
    const currentId = getOriginFontProjectId();
    const currentName = getOriginFontProjectName();
    const currentExists = currentId && list.some(p => p.id === currentId);

    linkSelect.innerHTML = '';
    if (!currentId) {
      const noneOpt = document.createElement('option');
      noneOpt.value = '';
      noneOpt.textContent = '(未リンク)';
      linkSelect.appendChild(noneOpt);
    } else if (!currentExists) {
      // Origin Typeset has been deleted — keep a placeholder so the user can
      // see the broken link state and pick a replacement.
      const missingOpt = document.createElement('option');
      missingOpt.value = currentId;
      missingOpt.textContent = `${currentName || '(unknown)'}（削除済み）`;
      linkSelect.appendChild(missingOpt);
    }
    for (const p of list) {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.name || '(Untitled)';
      if (p.id === currentId) opt.selected = true;
      linkSelect.appendChild(opt);
    }
    linkSelect.disabled = false;

    linkSelect.addEventListener('change', async () => {
      const newId = linkSelect.value;
      const prevId = getOriginFontProjectId() || '';
      if (!newId || newId === prevId) return;
      const newName = list.find(p => p.id === newId)?.name || '';
      if (!confirm(`スナップショットのリンク先を "${newName}" に変更します。よろしいですか?\n（内容を取り込むには Refresh Snapshot を実行してください）`)) {
        linkSelect.value = prevId;
        return;
      }
      linkSelect.disabled = true;
      try {
        await setLinkedFontProject(currentAnimationProjectId(), newId, newName);
        refreshBtn.title = `Linked to "${newName}" — click to re-pull the latest`;
      } catch (e) {
        console.error(e);
        alert(`リンク変更に失敗しました: ${e.message}`);
        linkSelect.value = prevId;
      } finally {
        linkSelect.disabled = false;
      }
    });
  })();

  return linkWrap;
}
