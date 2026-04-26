const TRANSLATIONS = {
  // Page titles
  "KABUKU Editor": "KABUKU Editor",
  Glyphs: "文字",
  Compose: "組版",
  Animation: "動画",

  // Section / group headings
  Layers: "レイヤー",
  "Grid Type": "格子の種類",
  "Grid Parameters": "格子の設定",
  Transform: "変形",
  "Transform (Local Override)": "変形（個別設定）",
  "Stretch (Global)": "伸縮（全体）",
  Stretch: "伸縮",
  Glyph: "文字",
  Name: "名前",
  "Delete Glyph": "文字を削除",
  "Source Image": "元画像",
  Tools: "ツール",
  Export: "書き出し",
  Text: "文字",
  "Animated Parameters": "動かす項目",
  CAMERA: "視点",
  Playback: "再生",
  Typography: "組版",

  // Parameter labels
  Spacing: "間隔",
  "Dot Radius": "点の半径",
  Rotation: "回転",
  "Aspect Ratio": "縦横比",
  Count: "個数",
  Scale: "倍率",
  "Grid Size": "升目の大きさ",
  Seed: "種",
  Relaxation: "緩和",
  Gap: "スペーシング",
  "Gap Dir Weight": "隙間方向の比率",
  "Gap Dir": "隙間方向",
  Blur: "ぼかし",
  "Stretch Angle": "伸縮の角度",
  "Stretch Amount": "伸縮の量",
  Angle: "角度",
  Amount: "量",
  "Font Size": "文字の大きさ",
  "Box Width": "枠の幅",
  Kerning: "字間",
  "Line Height": "行送り",
  Direction: "組み方向",
  Threshold: "しきい値",
  "BG Opacity": "背景濃度",
  Distance: "距離",
  "Duration (s)": "長さ (秒)",
  FPS: "FPS",
  "Easing:": "緩急:",

  // Buttons — navigation / actions
  Back: "戻る",
  Prev: "前へ",
  Next: "次へ",
  Preview: "プレビュー",
  Paint: "塗る",
  Erase: "消す",
  "Local Edit": "個別編集",
  "Load Image": "画像読込",
  "Auto Mesh": "自動分割",
  "Auto Mesh All": "全て自動分割",
  "Refresh All": "全て再描画",
  "Import Images": "画像取込",
  "Import JSON": "JSON取込",
  "Export JSON": "JSON書出",
  Export: "エクスポート",
  "Import (.json)": "インポート(.json)",
  "SVG (Layer)": "SVG (レイヤー)",
  "SVG (All)": "SVG (全レイヤー)",
  "PNG Seq": "PNG連番",
  GIF: "GIF",
  Play: "再生",
  Pause: "一時停止",
  Render: "書き出す",
  "Rendering...": "書き出し中…",
  "Encoding...": "変換中…",
  "Meshing...": "分割中…",
  Compose: "組版",
  Animation: "動画",
  "+ Add Layer": "+ レイヤーを追加",
  "Delete Keyframe": "キー削除",

  // Mode / direction values
  Horizontal: "横書き",
  Vertical: "縦書き",
  Global: "全体",
  Local: "個別設定",
};

const STORAGE_KEY = "kabuku.lang";
let currentLang = localStorage.getItem(STORAGE_KEY) || "en";

export function getLang() {
  return currentLang;
}

export function setLang(lang) {
  currentLang = lang;
  localStorage.setItem(STORAGE_KEY, lang);
}

export function t(key) {
  if (currentLang === "jp" && TRANSLATIONS[key]) return TRANSLATIONS[key];
  return key;
}

const SELECTORS = "h1, h2, h3, h4, label, button, span";

function isTranslatableEl(el) {
  if (el.classList?.contains("lang-toggle")) return false;
  if (el.classList?.contains("value")) return false; // numeric value spans
  if (el.classList?.contains("visibility")) return false; // 👁/x icons
  if (el.classList?.contains("reset-btn")) return false; // reset arrow
  return true;
}

function translateEl(el) {
  if (!isTranslatableEl(el)) return;
  if (el.children.length > 0) return;
  const text = el.textContent;
  // For elements whose text changes dynamically (e.g. Play↔Pause), look up
  // current text against the dictionary on every pass instead of caching once.
  if (currentLang === "jp") {
    if (text in TRANSLATIONS) {
      el.dataset.i18nOrig = text;
      el.textContent = TRANSLATIONS[text];
    }
  } else if (el.dataset.i18nOrig !== undefined) {
    // Restore: we previously translated this node. Check if current text is a
    // known translation we should revert.
    for (const [en, jp] of Object.entries(TRANSLATIONS)) {
      if (text === jp) {
        el.textContent = en;
        return;
      }
    }
  }
}

export function translateSubtree(root) {
  if (!root || root.nodeType !== 1) return;
  if (root.matches?.(SELECTORS)) translateEl(root);
  const els = root.querySelectorAll?.(SELECTORS);
  if (els) for (const el of els) translateEl(el);
}

export function startAutoTranslate(root) {
  translateSubtree(root);
  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.type === "characterData") {
        const parent = m.target.parentElement;
        if (parent && parent.matches?.(SELECTORS)) translateEl(parent);
        continue;
      }
      for (const node of m.addedNodes) {
        if (node.nodeType === 1) translateSubtree(node);
      }
    }
  });
  observer.observe(root, {childList: true, subtree: true, characterData: true});
  return observer;
}

const GLOBE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14 14 0 0 1 0 18"/><path d="M12 3a14 14 0 0 0 0 18"/></svg>`;

export function createLangToggle() {
  const btn = document.createElement("button");
  btn.className = "lang-toggle";
  btn.title = currentLang === "jp" ? "Switch to English" : "日本語に切り替え";
  const icon = document.createElement("span");
  icon.className = "icon";
  icon.innerHTML = GLOBE_SVG;
  const label = document.createElement("span");
  label.textContent = currentLang === "jp" ? "JP" : "EN";
  btn.appendChild(icon);
  btn.appendChild(label);
  btn.addEventListener("click", () => {
    setLang(currentLang === "jp" ? "en" : "jp");
    location.reload();
  });
  return btn;
}
