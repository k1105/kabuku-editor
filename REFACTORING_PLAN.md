# kabuku リファクタリング計画

作成日: 2026-06-11（行番号はこの日時点のもの。着手時に再確認すること）

## 現状診断サマリ

- 総量: 約19,000行（lockファイル除く）の Vanilla JS + Vite
- **God-file**: `src/pages/index-page.js`（2371行、実体は1つの巨大関数 `renderIndexPage` にローカル変数60個超）、`src/pages/animation-page.js`（1637行）、`src/animation/timeline-ui.js`（1483行）、`src/compose/compose-view.js`（1150行）、`src/ui/export-dialog.js`（735行）
- **二重実装**: `core/project.js` と `core/animation-project.js` が同じ状態管理パターン（dirty追跡・debounce書き込み・subscribe）を別々に実装。`core/history.js` と `core/animation-history.js` も undo/redo スタックをほぼ丸ごと重複（計約190行）
- **レンダリング変換の4重複**: stretch+gap のセル座標変換が `render/canvas-renderer.js`（3箇所）、`animation/render.js`、`render/svg-exporter.js`、`render/font-exporter.js` にコピペ
- **リソースリーク**: index-page の ResizeObserver、i18n の MutationObserver、compose-view の画像キャッシュ等が解放されない
- **安全網ゼロ**: テスト・リンタ・フォーマッタ・CI が存在しない。`yarn.lock` と `package-lock.json` が両方コミットされている
- **i18n バイパス**: i18n.js の外に日本語ハードコードが約79箇所
- **style.css**: 2291行の単一ファイル。重複ルール（`.anim-audio-remove` が2回定義）、デッドセレクタあり

ディレクトリ構成自体（core / grids / transform / render / pages / ui / utils）は INSTRUCTIONS.md の設計どおりで健全。問題は「構成」ではなく「ファイル内部の肥大と層をまたぐ重複」。

---

## 進め方の原則

1. **各フェーズは独立してマージ可能**にする。フェーズ途中でもアプリは常に動く状態を保つ
2. **挙動変更ゼロが原則**。リファクタリングコミットと機能修正コミットを混ぜない
3. 抽出（Phase 2）→ 分割（Phase 3）の順。共通ユーティリティが先にあるほうが分割が小さくなる
4. 各フェーズ完了時に**手動スモークテスト**（下記チェックリスト）+ Phase 0 で作る自動テストを通す
5. 本番投入前に **30分連続稼働テスト**（アニメーション再生しっぱなし + ページ往復）でリーク再発を確認

### 手動スモークテストチェックリスト（全フェーズ共通）

- [ ] プロジェクト一覧 → フォントプロジェクトを開く → 文字選択 → ペン編集 → 保存される
- [ ] グリッドパラメータ変更 → undo/redo が効く
- [ ] 画像インポート / フォントインポート / KanjiVG インポート
- [ ] 組版（compose）パネルでテキスト入力 → ストレッチ操作 → ダブルクリックでグリフ編集
- [ ] SVG エクスポート / 静的フォント / バリアブルフォントのエクスポート
- [ ] アニメーションページ: 再生・シーク・キーフレーム追加・ベジェハンドル操作・音声トラック
- [ ] PNG / GIF / JSON エクスポート・インポート
- [ ] ページ間を10往復してメモリが単調増加しない（DevTools Performance Monitor で listeners / JS heap を確認）

---

## Phase 0: 安全網の整備（コード変更なし）

リファクタリングの前提条件。これ以降のフェーズの「壊していないことの証明」をここで用意する。

| # | タスク | 対象 | 備考 |
|---|--------|------|------|
| 0-1 | パッケージマネージャ統一 | `yarn.lock` を削除し npm に統一（または逆） | 両方コミットされている現状はビルド再現性を壊す |
| 0-2 | ESLint + Prettier 導入 | ルート | `no-unused-vars`, `no-undef` だけでも未使用 export 検出に効く。既存コードは `--fix` せず warning 運用から開始 |
| 0-3 | Vitest 導入 + 特性テスト（characterization tests） | 純粋ロジック層 | DOM 非依存の関数を現状の出力で固定する: `core/transform-math.js`、`transform/stretch.js`・`gap.js`、`animation/interpolation.js`、`grids/*`（generateCells の出力セル数・座標）、`render/font/binary.js`・`glyf.js`・`char-ranges.js` |
| 0-4 | 出力スナップショットテスト | `render/svg-exporter.js`（SVG文字列）、`render/font-exporter.js` / `font/vf-builder.js`（バイト列ハッシュ） | 固定のテストプロジェクト JSON を fixtures に置き、エクスポート結果のハッシュ一致を検証。Phase 2 のレンダリング統合の命綱 |
| 0-5 | GitHub Actions: build + lint + test | `.github/workflows/` | PR ごとに回す |

**完了条件**: `npm run lint` / `npm run test` / `npm run build` が CI で通る。
**リスク**: 低（プロダクトコード変更なし）。

---

## Phase 1: リーク修正と即効クリーンアップ

挙動に実害がある箇所の修正。小さい独立コミットの積み重ねで、それぞれ単独レビュー可能。

### 1a. リソースリーク修正（ユーザー影響あり・最優先）

| # | 問題 | 場所 | 修正 |
|---|------|------|------|
| 1-1 | ResizeObserver が hashchange で disconnect されない | `src/pages/index-page.js:509` 付近 | ✅ 修正済（2026-06-11）。detach パターンを追加 |
| 1-2 | ~~i18n の MutationObserver が永続~~ | `src/ui/i18n.js` | **誤検出**: main.js 起動時に1回だけ生成されるアプリ寿命のオブザーバで、遷移ごとに増えない。修正不要 |
| 1-3 | settings modal の destroy 漏れ | `src/pages/animation-page.js` | ✅ 追加済。ただし closeOnEscape 未使用のため実害は無かった（一貫性のための追加） |
| 1-4 | ~~compose-view のキャッシュが destroy で残る~~ | `src/compose/compose-view.js` | **誤検出**: destroy() がリスナを解放すればクロージャごと GC される。ビューはページにつき1個で堆積もしない。修正不要 |
| 1-5 | auth-gate の document クリックリスナ | `src/ui/auth-gate.js` | ✅ 修正済。バッジが DOM から外れたら自己解除する |
| 1-6 | ~~toolbar / layer-panel のリスナ堆積~~ | `src/ui/toolbar.js`、`src/ui/layer-panel.js` | **誤検出**: リスナは render ごとに破棄されるボタン要素側に付くため GC で回収される。修正不要 |

### 1b. デッドコード削除

- ✅ `core/project.js`: `resolveGridParams` / `serializeLayerData` / `exportProject` / `importProject` を削除、`computeOverrides` を内部関数化（grep で未使用を確認済み）
- ✅ `style.css`: `.header-center-nav` の5ブロックを削除。~~`.anim-audio-remove` の重複~~は**誤検出**（1389行はセレクタグループの width 指定、1409行は margin 指定で別宣言）
- ✅ `ui/i18n.js`: `Compose` / `Animation` キーの重複定義を削除（no-dupe-keys、値は同一だったため挙動変化なし）
- ✅ ESLint v10 新ルールの指摘5件を解消（no-useless-assignment ×3、preserve-caught-error ×2）

**完了条件**: スモークテストの「ページ10往復でメモリ増加なし」が通る。
**リスク**: 低〜中（cleanup の追加はタイミング依存バグの可能性があるため、ページ遷移パターンを重点テスト）。

---

## Phase 2: 横断ユーティリティの抽出（重複排除）

God-file 分割（Phase 3）の前にやる。分割対象のコード量自体をここで減らす。

### 2a. core 層の二重実装統合

| # | 新モジュール | 統合元 | 状況 |
|---|--------------|--------|-----------|
| 2-1 | `core/base-history.js` — 汎用 undo/redo スタック | `history.js` と `animation-history.js` | ✅ 完了。ユニットテスト9件追加 |
| 2-2 | `core/store-utils.js` — change-bus と debounce 書き込みタイマーを共通化 | `project.js` と `animation-project.js` | ✅ 保守的に完了。dirty フラグの形が両者で異なるため、フル統合は Phase 4-2（repository 分離、エミュレータテスト付き）で実施 |
| 2-3 | セル最近傍マッチング → `cell.js` の `nearestCell()` + `CELL_MATCH_DIST_SQ` | `layer.js` と `layer-builder.js` | ✅ 完了。`manualOverride` の扱いの差（true固定 vs 保存値コピー）は意図的なので呼び出し側に残した |
| 2-4 | ピクセル集計ループ → `core/mesh-accumulate.js` | `mesh.js` と `mesh-worker.js` | ✅ 完了。worker は module worker だったので import で共有。ユニットテスト5件追加 |

### 2b. レンダリングパイプラインの統合（このフェーズの本丸）

| # | 新モジュール | 統合元 | 状況 |
|---|--------------|--------|------|
| 2-5 | `render/transform-utils.js` — `cellDisplacement(center, t, w, h, baselineY) → {dx, dy, pos}` | canvas-renderer（3箇所）、animation/render、svg-exporter、font-exporter の**6箇所** | ✅ 完了。SVG/フォントのスナップショット完全一致を確認 |
| 2-6 | ~~`render/geometry-utils.js`~~ | svg-exporter (geometryToSVG) と font-exporter (appendCellSubpath) | **見送り**: 出力形式（SVG要素 vs Y反転+巻き方向付き opentype パス）が根本的に異なり、統合すると悪い抽象になる。並列実装として維持 |
| 2-7 | `render/font/glyph-collect.js` — `collectGlyphEntries()` + `fontVerticalMetrics()` + `glyphName()` + `EM_SIZE` | font-exporter (buildFont) と vf-builder (buildVariableTTF) | ✅ 完了。TTF バイト列の SHA-256 スナップショット一致を確認 |
| 2-8 | metaball ブラー半径スケーリング | canvas-renderer（生半径）と animation/render（`scale * camDist`） | **意図的な差異と確認**: animation 側はラスタ解像度が異なるためスケール補正が必要（render.js 内コメントに既記載） |

**検証**: Phase 0-4 の SVG / フォントバイト列スナップショットが**完全一致**すること。これがこのフェーズの合否判定。

### 2c. grids / UI 層の小規模抽出

| # | 内容 | 対象 | 状況 |
|---|------|------|------|
| 2-9 | `grids/circle-utils.js` — `circleCell()` / `circleCellInBounds()` | circle / ellipse / fibonacci の3グリッド | ✅ 完了。グリッド特性スナップショット一致を確認 |
| 2-10 | モーダルCSSの style.css 移動 | export-dialog.js のJS内ハードコードCSS（~100行） | ✅ CSS移動完了。openModal と createSettingsModal の基盤統一は Phase 3e（ダイアログ分割）と同時に実施 |
| 2-11 | 文字範囲チェックボックス・行ヘルパ（`rangeCheckboxRow` / `customTextRow` / `labeledRow`） | export-dialog.js の3重コピペ | ✅ 完了（735行 → 523行）。タブ基盤の抽出は Phase 3e で |
| 2-12 | ファイル保存の一本化 — `saveFile` / `saveBlobWithPicker` / `downloadBlob` を file-io.js に集約 | export-dialog.js、animation/export.js | ✅ 完了 |
| 2-13 | JSON インポートの共通化 — `file-io.js: pickAndApplyJson()` | index-page.js と animation-page.js | ✅ 完了 |
| 2-14 | アイコンレールの共通化 `ui/icon-rail.js` | index-page.js と animation-page.js | ✅ 完了 |

**完了条件**: 重複6箇所の座標変換が1関数に集約され、スナップショット一致。推定 ~500行削減。
**リスク**: 中。特に 2-5 は座標計算の微差（baselineY の扱い等）が4経路で本当に同一か、統合前に diff で精査すること。

---

## Phase 3: God-file の分割

Phase 2 で共通部品が揃った状態で、巨大ファイルを責務単位に分割する。**1ファイルずつ**、1ファイル = 1〜2 PR で進める。

### 3a. `pages/index-page.js`（2371行 → 目標 400行以下のオーケストレータ + モジュール群）

現状は60個超のローカル変数を閉包する単一関数。クロージャ共有状態を **コンテキストオブジェクト（または class `GlyphEditorState`）** に集約してから切り出す。

抽出順（依存が浅い順）:

1. ✅ `pages/index/constants.js` — GLYPH_SIZE
2. ✅ `pages/index/char-cards.js` — createCharCard / renderThumbnail（元からクロージャ外のモジュール関数だったため移動のみ）
3. ✅ `pages/index/char-import.js` — importImages / importFromFont / importFromKanjiVG（共通の buildImportLayers / 進捗ヘルパも内部で重複排除）
4. ✅ `pages/index/settings-actions.js` — 設定モーダル + JSON入出力 + フォント書き出しアクション（project/global の参照と headerActions だけ受け取る自己完結ブロックだった）
5. ✅ `pages/index/kvg-editor.js` — KanjiVG パス編集を `createKvgEditor({canvas, ctx, getEnv, setBackgroundImage, redraw})` ファクトリに。kvgEdit/kvgDrag 状態を内包し、ページ側はマウスイベントを hitTest/startDrag/dragMove/endDrag/toggleAnchorModeAt で接続
6. ✅ `pages/index/sidebar-panels.js` — 4パネル + renderSourceImageSection / loadLocalImage / doAutoMesh（679行）。閉包変数は `pageState`（getter/setter のアクセサオブジェクト）経由で読み書きし、ページが唯一の状態保持者のまま。ページ側関数は `deps` で注入
7. ✅ `pages/index/guides-renderer.js` — renderTarget / renderLeft / blit / redraw（150行）。offCtx を露出してペイントのヒットテストに共用。ついでに「renderer 宣言が Init より後ろ」という元コード由来の潜在TDZ（ソース画像なしグリフ選択中のブート時にクラッシュしうる順序）を、宣言を Init 前に移動して解消

**3a 完了（2026-06-11）: 2350行 → 1025行 + モジュール7個**（char-cards 101 / char-import 219 / settings-actions 151 / kvg-editor 195 / sidebar-panels 679 / guides-renderer 150 / constants 2）。残る 1025 行はレイアウト構築・状態遷移（setPanel/setPreviewMode/syncCenterView）・グリフCRUD・undo/redo refresh というページ配線で、これ以上の分割は費用対効果が低いと判断

**注意点（調査で判明した罠）**:
- `selectChar()`（現 1737 行）は `rebuildLocalState()` → `loadBackgroundImage()` → `renderSidebarBody()` の**暗黙の実行順序**に依存。分割時にこの順序を `GlyphEditorState` のメソッドとして明示化する
- `regenerateCells()` が async で UI コールバックと競合しうる（renderPenPanel 内）。分割ついでに in-flight ガードを入れる

### 3b. `pages/animation-page.js` ✅ 完了（2026-06-12: 1608行 → 970行 + モジュール5個）

index-page と同じ pageState アクセサ方式（`animation` は JSON インポートで**再代入**されるため、モジュールは必ず getter 経由で読む）:

1. ✅ `pages/animation/preview.js`（269行）— 表示ズーム / フレームキャッシュ / 共有フレームレンダラ / drawFull / redrawFast / redrawPreview。ResizeObserver も内包し `destroy()` で解放
2. ✅ `pages/animation/playback.js`（117行）— rAF マスタークロック / ガイド音声同期 / seek。playStartWallTime / rafId はモジュール内部状態に縮退
3. ✅ `pages/animation/audio-panel.js`（256行）— ガイド音源の取込/差替/削除・頭出し・音量・試聴トランスポート
4. ✅ `pages/animation/typeface-link.js`（123行）— スナップショットの再リンク + Refresh（完全自己完結だった）
5. ✅ `pages/animation/form-utils.js`（22行）— addNumberField 共有
- timeline ↔ コールバックの循環は deps の遅延ラムダ（`() => timeline.render()`）で実用上解消。EventTarget 化は不要と判断
- 残る 970 行はヘッダ/設定モーダル/テキスト・パラメータパネル/タイムライン配線/エクスポートで、ページ配線として許容

### 3c. `animation/timeline-ui.js`（1483行）

1. `animation/timeline/layout.js` — zoom / pps / computeRowLayout / computeValueRange（現 79-251 行）
2. `animation/timeline/ruler.js` + `waveform.js` + `cache-strip.js`（現 541-1303 行）
3. `animation/timeline/rows.js` — renderRows / renderTextDots（現 926-1146 行）
4. `animation/timeline/context-menu.js` — showCtxMenu / showTextCtxMenu / イージングUI（現 651-856 行）
5. `animation/timeline/interactions.js` — ドラッグ・ラバーバンド選択・ホイールズーム・キーボード（現 1307-1469 行）
- ベジェ曲線数学（realignSmooth 等）は `animation/curve-utils.js` に分離し Phase 0 のユニットテスト対象に追加

### 3d. `compose/compose-view.js`（1150行）

1. `compose/layout.js` — computeLayout（現 256-331 行）
2. `compose/draw.js` — redraw / redrawFast / getStretchedGlyph を**単一のパラメトリックな描画経路**に統合（現 333-460 行）
3. `compose/glyph-editor.js` — ズーム編集・ペイント/消しゴム・編集パネル（現 468-591, 799-1083 行）

### 3e. `ui/export-dialog.js`（735行）

Phase 2-10/2-11 のモーダル/タブ基盤導入後、ダイアログ単位に分割:
`ui/dialogs/svg-export.js` / `static-font.js` / `variable-font.js` / `glyph-add.js`

**完了条件**: 1000行を超えるファイルがゼロになる。スモークテスト全項目パス。
**リスク**: 高（このプロジェクト最大の手術）。必ず1ファイルずつ、各PR後にスモークテスト全実施。途中で機能改修の依頼が来たら、未着手ファイルの改修は許容しつつ分割中ファイルへの変更は分割完了後に行う。

---

## Phase 4: アーキテクチャ層の整理

Phase 3 までで「読めるコード」になった後の構造改善。費用対効果を見ながら取捨選択してよい。

| # | 内容 | 詳細 |
|---|------|------|
| 4-1 | コンポーネントライフサイクル規約 | 全 UI コンポーネントを `{ el, update?, destroy }` に統一。ページが `destroy()` を一括呼び出しする registry を導入。Phase 1 の個別リーク修正をパターンとして恒久化する |
| 4-2 | 永続化層の分離（repository パターン） | `project.js` / `animation-project.js` から Firestore 依存（getDb, doc, writeBatch, バッチ450件分割, enc__ ID エンコード）を `core/repo/font-repo.js` / `anim-repo.js` に分離。`storage.js` → `project.js` の循環依存（`currentFontProjectId()` 呼び出し）もここで解消 |
| 4-3 | スキーマバージョン移行 | VERSION=8 が存在するのに移行ロジックがない。`core/migrations.js` に version N→N+1 の変換関数を集め、ロード時に順次適用する仕組みを入れる（今後のスキーマ変更の保険） |
| 4-4 | innerHTML 由来の文字列挿入排除 | `animation-page.js:861` の `playIcon.innerHTML = iconSvg(...)` 等を要素生成 API に置換 |

**リスク**: 4-2 は保存経路を触るため中〜高。Firestore エミュレータでの保存/読込テストを追加してから着手。

---

## Phase 5: 品質向上（継続的・任意）

| # | 内容 | 詳細 |
|---|------|------|
| 5-1 | i18n 完全化 | i18n.js 外の日本語ハードコード約79箇所（main.js:88,153,174 / export-dialog.js:445-693 / auth-gate.js:12-104 ほか）を `t()` 経由に置換し TRANSLATIONS に追加。MutationObserver ベースの自動翻訳（受動方式）は廃止候補 |
| 5-2 | style.css 分割 | ページ/コンポーネント単位に分割して Vite の CSS import で結合。モーダル系の重複（`.export-modal` / `.settings-modal` / `.compose-view-backdrop`）を共通クラスに統合。命名規約（`anim-` プレフィクス方式 or BEM）を1つに統一 |
| 5-3 | JSDoc 型注釈 | transform オブジェクト `{stretchAngle, stretchAmount, baseGap, gapDirectionWeight, metaballRadius}` や cell / layer / project のスキーマに `@typedef` を付与。`// @ts-check` で段階的に検査（TypeScript 全面移行はこの規模なら必須ではない） |
| 5-4 | テストカバレッジ拡大 | Phase 0 の特性テストを「仕様テスト」に育てる。特に interpolation（ベジェ）、font/ のテーブル生成 |

---

## 実施順序とマイルストーン

```
Phase 0 ── 安全網          （前提。これなしで Phase 2 以降に入らない）
Phase 1 ── リーク修正       （独立性高。Phase 0 と並行可）
Phase 2 ── 重複抽出         （スナップショットテストで挙動不変を担保）
Phase 3 ── God-file 分割    （1ファイルずつ。最も時間がかかる）
Phase 4 ── アーキテクチャ    （取捨選択可）
Phase 5 ── 品質向上         （継続タスク）
```

定量目標:

| 指標 | 現状 | 目標 |
|------|------|------|
| 最大ファイル行数 | 2371行（index-page.js） | < 600行 |
| 1000行超ファイル | 5個 | 0個 |
| 重複実装（history / store / 座標変換 / 保存ダイアログ等） | ~500行以上 | 解消 |
| 既知リソースリーク | 6件 | 0件（10往復テストで確認） |
| 自動テスト | 0 | 純関数層 + エクスポートスナップショット + CI |
