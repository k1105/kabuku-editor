import { describe, it, expect } from 'vitest';
import {
  kernIndicesForSelection,
  applyKernDelta,
  remapCharKerning,
} from '../src/compose/char-kerning.js';
import { layoutText } from '../src/compose/text-layout.js';
import { sampleCharKerning, sampleAnimation, upsertTextKeyframe } from '../src/animation/animation.js';
import { createDefaultAnimation } from '../src/core/project.js';

const chars = (...ids) => new Set(ids);

describe('layoutText charKerning', () => {
  it('文字ごとの追加送り（em）がグローバル字間に加算される', () => {
    const pos = layoutText('あいう', chars('あ', 'い', 'う'), {
      fontSize: 100, textBoxWidth: Infinity, kerning: 10,
      lineHeight: 1.5, writingMode: 'horizontal',
      charKerning: [0.5, 0, 0],
    });
    expect(pos.map(p => p.x)).toEqual([0, 160, 270]); // 100+10+50, then 100+10
  });

  it('fontSize を変えても em 比率が保たれる（スケール不変）', () => {
    const layoutAt = (fontSize) => layoutText('あい', chars('あ', 'い'), {
      fontSize, textBoxWidth: Infinity, kerning: 0,
      lineHeight: 1.5, writingMode: 'horizontal',
      charKerning: [0.25],
    });
    const small = layoutAt(64);
    const large = layoutAt(128);
    expect(small[1].x / 64).toBeCloseTo(1.25);
    expect(large[1].x / 128).toBeCloseTo(1.25); // 同じ em 比率
  });

  it('縦書きでも適用される', () => {
    const pos = layoutText('あい', chars('あ', 'い'), {
      fontSize: 100, textBoxWidth: Infinity, kerning: 0,
      lineHeight: 1.5, writingMode: 'vertical',
      charKerning: [0.1],
    });
    expect(pos[1].y).toBe(110);
  });

  it('改行もインデックスを消費する（改行以降の対応が保たれる）', () => {
    const pos = layoutText('あ\nい う', chars('あ', 'い', 'う'), {
      fontSize: 100, textBoxWidth: Infinity, kerning: 0,
      lineHeight: 1.0, writingMode: 'horizontal',
      charKerning: [0, 0, 0.5, 0, 0], // index2 = 'い' の後の送り
    });
    // 'い' は2行目先頭 x=0、スペースは x=150（100 + 0.5em）
    expect(pos[1].x).toBe(0);
    expect(pos[2].x).toBe(150);
  });

  it('charKerning なしでは従来のレイアウトと一致する', () => {
    const base = layoutText('あい', chars('あ', 'い'), {
      fontSize: 64, textBoxWidth: Infinity, kerning: 5,
      lineHeight: 1.5, writingMode: 'horizontal',
    });
    const withEmpty = layoutText('あい', chars('あ', 'い'), {
      fontSize: 64, textBoxWidth: Infinity, kerning: 5,
      lineHeight: 1.5, writingMode: 'horizontal',
      charKerning: [],
    });
    expect(withEmpty).toEqual(base);
  });
});

describe('kernIndicesForSelection', () => {
  it('キャレット位置は前後の文字ペアの間隙を指す', () => {
    expect(kernIndicesForSelection('あいう', 1, 1)).toEqual([0]);
    expect(kernIndicesForSelection('あいう', 2, 2)).toEqual([1]);
  });

  it('端（先頭・末尾）では調整対象なし', () => {
    expect(kernIndicesForSelection('あいう', 0, 0)).toEqual([]);
    expect(kernIndicesForSelection('あいう', 3, 3)).toEqual([]);
  });

  it('改行をまたぐ間隙は対象外', () => {
    expect(kernIndicesForSelection('あ\nい', 1, 1)).toEqual([]);
    expect(kernIndicesForSelection('あ\nい', 2, 2)).toEqual([]);
  });

  it('選択範囲は内部の全間隙（トラッキング）', () => {
    expect(kernIndicesForSelection('あいうえ', 0, 3)).toEqual([0, 1]);
    expect(kernIndicesForSelection('あいうえ', 1, 2)).toEqual([]); // 1文字選択に内部間隙なし
  });

  it('サロゲートペアを含むテキストでもコードポイント単位で数える', () => {
    // '𩸽' は UTF-16 で2単位。キャレットがその直後 (UTF-16 offset 2) にある場合
    expect(kernIndicesForSelection('𩸽あ', 2, 2)).toEqual([0]);
  });
});

describe('applyKernDelta', () => {
  it('指定インデックスに delta を加算し、丸める', () => {
    const next = applyKernDelta([0.1], [0, 2], 0.02, 4);
    expect(next).toEqual([0.12, 0, 0.02, 0]);
  });

  it('元の配列は変更しない', () => {
    const orig = [0.1];
    applyKernDelta(orig, [0], 0.02, 2);
    expect(orig).toEqual([0.1]);
  });
});

describe('remapCharKerning', () => {
  it('挿入位置以降の値がずれずに保持される', () => {
    // 'あい' の間隙 0 に 0.5、'い' の後に 0.2。'あ' の後ろに 'X' を挿入。
    expect(remapCharKerning('あいう', 'あXいう', [0.5, 0.2, 0])).toEqual([0.5, 0, 0.2, 0]);
  });

  it('削除で対応エントリが落ちる', () => {
    expect(remapCharKerning('あXいう', 'あいう', [0.5, 0.9, 0.2, 0])).toEqual([0.5, 0.2, 0]);
  });

  it('末尾追記は 0 で伸びる', () => {
    expect(remapCharKerning('あい', 'あいう', [0.5, 0])).toEqual([0.5, 0, 0]);
  });

  it('空のカーニングは空のまま', () => {
    expect(remapCharKerning('あ', 'あい', [])).toEqual([]);
  });
});

describe('sampleCharKerning', () => {
  it('ベーステキストとテキストキーフレームでそれぞれの charKerning を返す', () => {
    const anim = createDefaultAnimation();
    anim.text = 'あい';
    anim.charKerning = [0.1, 0];
    const kf = upsertTextKeyframe(anim.textTrack, 2, 'かき');
    kf.charKerning = [0.3, 0];

    expect(sampleCharKerning(anim, 0)).toEqual([0.1, 0]);
    expect(sampleCharKerning(anim, 3)).toEqual([0.3, 0]);
    // 同一区間内では同じ配列参照（renderFrames の paramsEqual が同一視できる）
    expect(sampleAnimation(anim, 0.5).charKerning).toBe(sampleAnimation(anim, 1.0).charKerning);
  });

  it('未設定・空配列は null（レイアウトへの影響なし）', () => {
    const anim = createDefaultAnimation();
    anim.text = 'あい';
    expect(sampleCharKerning(anim, 0)).toBeNull();
  });
});
