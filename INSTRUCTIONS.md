# KABUKU Editor v2 — 実装指示書

## これは何

超指向性書体「KABUKU」の新しいWebエディター。フォント画像からの自動メッシュ化、複数グリッドタイプのプラグイン式切り替え、マルチレイヤー合成、方向依存変形を備えたツール。

既存エディター（Pixel Editor / Fibonacci Spiral / Circle Grid の3タブ構成）の後継。根本から新規開発する。

## ゴール

「触りながら書体デザインを探れる」エディター。メッシュ化 → 変形 → SVG書き出しのパイプラインをインタラクティブに回せること。

## 技術スタック

| 要素 | 技術 |
|---|---|
| ビルド | **Vite** |
| フレームワーク | **Vanilla JS**（or TypeScript） |
| 描画 | **Canvas API（2D）** |
| SVG書き出し | 自前実装（CellのpathをSVGに変換） |
| ルーティング | URLハッシュベース or vanilla router（indexページ ↔ 編集画面） |

## ページ構成

### 1. Indexページ（`/`）
- 全文字のサムネイル一覧（グリッド表示）
- 各サムネイルはCanvas描画（現在のメッシュ状態を反映）
- クリックで個別編集画面に遷移
- 「画像一括インポート」ボタン：フォルダ内のPNG画像を一括読み込み

### 2. 編集画面（`/#/edit/:charId`）
- メインCanvas（大きく表示。操作・プレビュー兼用）
- 左サイドバー：ツール・パラメータ
- 上部：文字ナビゲーション（前へ/次へ）

## コアアーキテクチャ

### Cell構造（全グリッド共通）

```typescript
interface Cell {
  id: string;            // セルの一意ID
  path: Path2D;          // 描画形状（Canvas用）
  center: { x: number; y: number };  // 中心座標
  filled: boolean;       // ON/OFF
  manualOverride: boolean;  // 手動で上書きしたか（再メッシュ化時に保護）
}
```

すべてのグリッドタイプがこのCell型を返す。描画・操作・保存のロジックはグリッド非依存。

### グリッドプラグインインターフェース

```typescript
interface GridPlugin {
  name: string;
  // キャンバスサイズとパラメータからセル配列を生成
  generateCells(width: number, height: number, params: Record<string, number>): Cell[];
  // このグリッドのパラメータ定義（UIのスライダー生成用）
  getParamDefs(): ParamDef[];
}

interface ParamDef {
  key: string;
  label: string;
  min: number;
  max: number;
  default: number;
  step: number;
}
```

### 初期実装するグリッドプラグイン

1. **PixelGrid** — 正方形マス目。パラメータ: gridSize, width, height
2. **CircleGrid** — 同心円配置。パラメータ: layers, radius, spacing, rotation
3. **FibonacciGrid** — フィボナッチ螺旋配置。パラメータ: count, rotation, scale, dotRadius
4. **EllipseGrid** — 楕円形ベース。パラメータ: aspectRatio, layers, spacing

今後追加予定（実装しない）: VoronoiGrid, HexGrid 等

### レイヤーシステム

```typescript
interface Layer {
  id: string;
  name: string;
  gridPlugin: GridPlugin;
  gridParams: Record<string, number>;
  cells: Cell[];
  opacity: number;       // 0.0 - 1.0
  visible: boolean;
}
```

- 各レイヤーは独立したグリッドタイプ・パラメータを持つ
- レイヤー追加/削除/並び替え
- レイヤーごとに不透明度スライダー
- レイヤーごとに表示/非表示トグル
- **レイヤーごとにSVG書き出し可能**（イラレで合成検証するため）

## 機能詳細

### 1. 画像インポート → 自動メッシュ化

- PNG画像をCanvasに読み込み
- 各Cellの領域で黒ピクセル占有率を計算
- 閾値（スライダーで調整可能、デフォルト50%）を超えたCellを `filled: true` にする
- `manualOverride: false` のセルのみ上書き（手動編集を保護）

### 2. 手動編集（ペイントツール）

- セルをクリックでON/OFFトグル
- ドラッグでペイント（連続塗り）
- 消しゴムモード（ドラッグで連続消し）
- 手動で編集したセルは `manualOverride: true` になる

### 3. 変形機能

#### アスペクト比変形
- **変形方向**: 角度（0°〜180°）で指定。水平・垂直に限定しない
- **変形量**: スライダーで調整
- 各セルの中心座標が指定方向に引き伸ばされる
- 描画時にリアルタイム適用（元データは変更しない）

#### Gap挿入（方向依存）
- セル間の隙間を挿入
- **引き伸ばされた方向ほどGapが大きくなる**重み付け
- 計算式: `gap = base_gap * (cos²(θ - stretch_dir) * weight + (1 - weight))`
  - θ = セル間ベクトルの角度
  - stretch_dir = アスペクト比変形の方向
  - weight = 方向重み付けの強さ（スライダー）
- base_gap, weightをスライダーで調整

#### メタボール結合
- 近接する`filled`セル同士を有機的に融合
- 融合の強さ（半径・閾値）をスライダーで調整
- Canvas描画で実装（marching squares or metaball rendering）

### 4. SVG書き出し

- レイヤーごとに個別SVG書き出し
- 全レイヤー合成SVG書き出し
- 変形適用済みの状態で書き出す
- ファイル名: `{charId}_{layerName}.svg`

### 5. データ保存

- 全文字のデータをJSON形式でlocalStorageに保存
- エクスポート/インポート機能（JSONファイル）
- 自動保存（編集のたびにlocalStorageに保存）

```typescript
interface ProjectData {
  characters: {
    [charId: string]: {
      imagePath: string;
      layers: LayerData[];
      transform: TransformParams;
    }
  }
}

interface TransformParams {
  stretchAngle: number;      // 変形方向（0-180°）
  stretchAmount: number;     // 変形量
  baseGap: number;           // Gap基本値
  gapDirectionWeight: number; // Gap方向重み付け
  metaballStrength: number;   // メタボール強さ
  metaballRadius: number;     // メタボール半径
}
```

## ディレクトリ構成

```
projects/kabuku/
├── README.md              # プロジェクト概要
├── INSTRUCTIONS.md        # この指示書
├── src/
│   ├── index.html
│   ├── main.js            # エントリポイント、ルーティング
│   ├── style.css
│   ├── pages/
│   │   ├── index-page.js  # 書体一覧ページ
│   │   └── edit-page.js   # 個別編集ページ
│   ├── core/
│   │   ├── cell.js        # Cell型定義
│   │   ├── layer.js       # レイヤー管理
│   │   ├── project.js     # プロジェクトデータ管理（保存/読込）
│   │   └── mesh.js        # 画像→メッシュ化ロジック
│   ├── grids/
│   │   ├── grid-plugin.js # GridPluginインターフェース
│   │   ├── pixel-grid.js
│   │   ├── circle-grid.js
│   │   ├── fibonacci-grid.js
│   │   └── ellipse-grid.js
│   ├── transform/
│   │   ├── stretch.js     # アスペクト比変形
│   │   ├── gap.js         # 方向依存Gap挿入
│   │   └── metaball.js    # メタボール結合
│   ├── render/
│   │   ├── canvas-renderer.js  # Canvas描画
│   │   └── svg-exporter.js     # SVG書き出し
│   └── ui/
│       ├── toolbar.js     # ペイントツール切り替え
│       ├── params-panel.js # パラメータスライダー群
│       └── layer-panel.js  # レイヤー管理UI
├── package.json
└── vite.config.js
```

## 実装手順

### Phase 1: 基盤
1. Viteプロジェクト初期化
2. ルーティング（index ↔ edit）
3. Cell型・GridPluginインターフェース定義
4. PixelGridプラグイン実装
5. Canvas描画（セル描画・クリックでON/OFFトグル）

### Phase 2: メッシュ化 + 編集
6. 画像インポート → 自動メッシュ化
7. ペイントツール（塗り/消し/ドラッグ）
8. 閾値スライダー
9. manualOverride保護ロジック

### Phase 3: グリッドプラグイン追加
10. CircleGrid実装
11. FibonacciGrid実装
12. EllipseGrid実装
13. グリッド切り替えUI

### Phase 4: レイヤー
14. レイヤー追加/削除/並び替え
15. レイヤーごとの不透明度・表示切替
16. レイヤーごとのグリッドタイプ・パラメータ

### Phase 5: 変形
17. アスペクト比変形（角度指定 + 変形量）
18. 方向依存Gap挿入
19. メタボール結合

### Phase 6: 書き出し + 保存
20. SVG書き出し（レイヤー別 + 合成）
21. localStorage自動保存
22. JSON エクスポート/インポート

### Phase 7: Indexページ
23. 全文字サムネイル一覧
24. 画像一括インポート
25. 文字ナビゲーション（前へ/次へ）

## 完了条件

- `npm run dev` でローカルサーバーが起動する
- 画像をインポートして自動メッシュ化できる
- 複数グリッドタイプ（最低4種）を切り替えられる
- 手動でセルの塗り/消しができる
- マルチレイヤーで異なるグリッドを重ねられる
- アスペクト比変形 + 方向依存Gap + メタボール結合がリアルタイムで動く
- レイヤーごとにSVG書き出しできる
- indexページで全文字一覧が表示される

## 後回し（実装しない）

- VoronoiGrid / HexGrid（プラグイン構造は用意するが実装しない）
- fontTools連携（フォントファイル直接書き出し）
- バリアブルフォント書き出し
- Undo/Redo（あったら便利だが最小スコープ外）
- 複数プロジェクト管理
