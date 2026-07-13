/**
 * Top-level project selection page. Lists FontProjects and AnimationProjects
 * side by side; both can be created, renamed, deleted, and opened from here.
 *
 * AnimationProjects are independent entities that carry a frozen snapshot of
 * a FontProject — creating one prompts for which typeset to snapshot from.
 */
import {iconButton} from "../ui/icons.js";
import {createUserBadge} from "../ui/auth-gate.js";
import {
  listFontProjects,
  createFontProject,
  renameFontProject,
  deleteFontProject,
  duplicateFontProject,
} from "../core/project.js";
import {
  listAnimationProjects,
  createAnimationProject,
  renameAnimationProject,
  deleteAnimationProject,
  duplicateAnimationProject,
} from "../core/animation-project.js";

function formatTimestamp(ts) {
  if (!ts) return "";
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  if (Number.isNaN(d.getTime?.())) return "";
  return d.toLocaleString();
}

function formatEditor(meta) {
  const e = meta.lastEditor || meta.createdBy;
  return e?.name || "";
}

/** Shared Duplicate action button for project cards. */
function duplicateButton(item, duplicateFn, refresh) {
  const btn = iconButton("copy", "Duplicate", {title: "Duplicate"});
  btn.addEventListener("click", async (e) => {
    e.stopPropagation();
    const name = prompt("複製後の名前", `${item.name || "Untitled"} copy`);
    if (!name) return;
    btn.disabled = true;
    try {
      await duplicateFn(item.id, name.trim());
      await refresh();
    } catch (err) {
      alert(`複製に失敗しました: ${err.message}`);
      btn.disabled = false;
    }
  });
  return btn;
}

export async function renderProjectListPage(app) {
  app.innerHTML = "";

  // Header (simplified — no page-tabs, no undo/redo)
  const header = document.createElement("header");
  header.className = "header header-list";
  const title = document.createElement("h1");
  title.textContent = "KABUKU Editor";
  header.appendChild(title);
  const headerNav = document.createElement("div");
  headerNav.className = "header-nav";
  headerNav.appendChild(createUserBadge());
  header.appendChild(headerNav);
  app.appendChild(header);

  const page = document.createElement("div");
  page.className = "project-list-page";
  app.appendChild(page);

  // Two columns
  const fontCol = document.createElement("section");
  fontCol.className = "project-col";
  page.appendChild(fontCol);

  const animCol = document.createElement("section");
  animCol.className = "project-col";
  page.appendChild(animCol);

  await renderFontColumn(fontCol);
  await renderAnimationColumn(animCol);
}

async function renderFontColumn(col) {
  col.innerHTML = "";
  const head = document.createElement("div");
  head.className = "project-col-head";
  const title = document.createElement("h2");
  title.textContent = "Typeset (Font Project)";
  head.appendChild(title);

  const addBtn = iconButton("plus", "New Typeset", {withText: true});
  addBtn.addEventListener("click", async () => {
    const name = prompt("Typeset 名を入力", "Untitled Typeset");
    if (!name) return;
    addBtn.disabled = true;
    try {
      const id = await createFontProject(name.trim());
      location.hash = `#/font/${id}`;
    } catch (e) {
      alert(`作成に失敗しました: ${e.message}`);
    } finally {
      addBtn.disabled = false;
    }
  });
  head.appendChild(addBtn);
  col.appendChild(head);

  const list = document.createElement("ul");
  list.className = "project-list";
  col.appendChild(list);

  let items;
  try {
    items = await listFontProjects();
  } catch (e) {
    list.innerHTML = `<li class="project-error">読み込みに失敗しました: ${e.message}</li>`;
    return;
  }

  if (items.length === 0) {
    list.innerHTML = `<li class="project-empty">まだ Typeset はありません。「New Typeset」で作成してください。</li>`;
    return;
  }

  for (const item of items) {
    list.appendChild(createFontProjectCard(item, () => renderFontColumn(col)));
  }
}

function createFontProjectCard(item, refresh) {
  const li = document.createElement("li");
  li.className = "project-card";

  const main = document.createElement("button");
  main.type = "button";
  main.className = "project-card-main";
  main.addEventListener("click", () => {
    location.hash = `#/font/${item.id}`;
  });

  const name = document.createElement("div");
  name.className = "project-card-name";
  name.textContent = item.name || "(no name)";

  const meta = document.createElement("div");
  meta.className = "project-card-meta";
  const ed = formatEditor(item);
  const ts = formatTimestamp(item.updatedAt);
  meta.textContent = [ts, ed].filter(Boolean).join(" · ");

  main.appendChild(name);
  main.appendChild(meta);
  li.appendChild(main);

  const actions = document.createElement("div");
  actions.className = "project-card-actions";
  const renameBtn = iconButton("paintbrush", "Rename", {title: "Rename"});
  renameBtn.addEventListener("click", async (e) => {
    e.stopPropagation();
    const next = prompt("新しい名前", item.name);
    if (!next || next === item.name) return;
    try {
      await renameFontProject(item.id, next.trim());
      await refresh();
    } catch (err) {
      alert(err.message);
    }
  });
  const delBtn = iconButton("trash", "Delete", {title: "Delete"});
  delBtn.addEventListener("click", async (e) => {
    e.stopPropagation();
    if (
      !confirm(`Typeset「${item.name}」を削除しますか? (関連アニメは残ります)`)
    )
      return;
    try {
      await deleteFontProject(item.id);
      await refresh();
    } catch (err) {
      alert(err.message);
    }
  });
  actions.appendChild(renameBtn);
  actions.appendChild(duplicateButton(item, duplicateFontProject, refresh));
  actions.appendChild(delBtn);
  li.appendChild(actions);
  return li;
}

async function renderAnimationColumn(col) {
  col.innerHTML = "";
  const head = document.createElement("div");
  head.className = "project-col-head";
  const title = document.createElement("h2");
  title.textContent = "Animation";
  head.appendChild(title);

  const addBtn = iconButton("plus", "New Animation", {withText: true});
  addBtn.addEventListener("click", async () => {
    let typesets;
    try {
      typesets = await listFontProjects();
    } catch (e) {
      alert(`Typeset 一覧の取得に失敗: ${e.message}`);
      return;
    }
    if (typesets.length === 0) {
      alert(
        "先に Typeset を作成してください。Animation は Typeset のスナップショットを取り込みます。",
      );
      return;
    }
    const choice = await pickFontProjectDialog(typesets);
    if (!choice) return;
    const name = prompt("Animation 名を入力", `${choice.name} Animation`);
    if (!name) return;
    addBtn.disabled = true;
    try {
      const id = await createAnimationProject({
        name: name.trim(),
        fontProjectId: choice.id,
      });
      location.hash = `#/animation/${id}`;
    } catch (e) {
      alert(`作成に失敗しました: ${e.message}`);
    } finally {
      addBtn.disabled = false;
    }
  });
  head.appendChild(addBtn);
  col.appendChild(head);

  const list = document.createElement("ul");
  list.className = "project-list";
  col.appendChild(list);

  let items;
  try {
    items = await listAnimationProjects();
  } catch (e) {
    list.innerHTML = `<li class="project-error">読み込みに失敗しました: ${e.message}</li>`;
    return;
  }

  if (items.length === 0) {
    list.innerHTML = `<li class="project-empty">まだ Animation はありません。Typeset を選んで「New Animation」してください。</li>`;
    return;
  }

  for (const item of items) {
    list.appendChild(
      createAnimationCard(item, () => renderAnimationColumn(col)),
    );
  }
}

function createAnimationCard(item, refresh) {
  const li = document.createElement("li");
  li.className = "project-card";

  const main = document.createElement("button");
  main.type = "button";
  main.className = "project-card-main";
  main.addEventListener("click", () => {
    location.hash = `#/animation/${item.id}`;
  });

  const name = document.createElement("div");
  name.className = "project-card-name";
  name.textContent = item.name || "(no name)";

  const meta = document.createElement("div");
  meta.className = "project-card-meta";
  const ed = formatEditor(item);
  const ts = formatTimestamp(item.updatedAt);
  const origin = item.fontProjectName ? `from ${item.fontProjectName}` : "";
  meta.textContent = [ts, ed, origin].filter(Boolean).join(" · ");

  main.appendChild(name);
  main.appendChild(meta);
  li.appendChild(main);

  const actions = document.createElement("div");
  actions.className = "project-card-actions";
  const renameBtn = iconButton("paintbrush", "Rename", {title: "Rename"});
  renameBtn.addEventListener("click", async (e) => {
    e.stopPropagation();
    const next = prompt("新しい名前", item.name);
    if (!next || next === item.name) return;
    try {
      await renameAnimationProject(item.id, next.trim());
      await refresh();
    } catch (err) {
      alert(err.message);
    }
  });
  const delBtn = iconButton("trash", "Delete", {title: "Delete"});
  delBtn.addEventListener("click", async (e) => {
    e.stopPropagation();
    if (!confirm(`Animation「${item.name}」を削除しますか?`)) return;
    try {
      await deleteAnimationProject(item.id);
      await refresh();
    } catch (err) {
      alert(err.message);
    }
  });
  actions.appendChild(renameBtn);
  actions.appendChild(duplicateButton(item, duplicateAnimationProject, refresh));
  actions.appendChild(delBtn);
  li.appendChild(actions);
  return li;
}

function pickFontProjectDialog(typesets) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    const dialog = document.createElement("div");
    dialog.className = "modal-dialog";
    dialog.innerHTML = `
      <h2>取り込む Typeset を選択</h2>
      <p class="modal-help">選んだ Typeset のスナップショットを Animation に取り込みます。後で「Refresh」で最新を再取込できます。</p>
    `;
    const list = document.createElement("ul");
    list.className = "modal-pick-list";
    for (const ts of typesets) {
      const li = document.createElement("li");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "modal-pick-item";
      btn.innerHTML = `<strong>${escapeHtml(ts.name || "(no name)")}</strong><br><small>${formatTimestamp(ts.updatedAt)}</small>`;
      btn.addEventListener("click", () => {
        cleanup();
        resolve(ts);
      });
      li.appendChild(btn);
      list.appendChild(li);
    }
    dialog.appendChild(list);

    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "tool-btn modal-cancel";
    cancel.textContent = "キャンセル";
    cancel.addEventListener("click", () => {
      cleanup();
      resolve(null);
    });
    dialog.appendChild(cancel);

    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    function cleanup() {
      overlay.remove();
    }
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) {
        cleanup();
        resolve(null);
      }
    });
  });
}

function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"})[
        c
      ],
  );
}
