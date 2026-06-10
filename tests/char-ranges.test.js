import { describe, it, expect } from 'vitest';
import {
  asciiPrintable,
  hiragana,
  katakana,
  joyoKanji,
  buildCharSet,
  PRESETS,
} from '../src/render/font/char-ranges.js';

describe('char-ranges', () => {
  it('asciiPrintable は U+0021..U+007E の 94 文字', () => {
    const chars = asciiPrintable();
    expect(chars).toHaveLength(94);
    expect(chars[0]).toBe('!');
    expect(chars[chars.length - 1]).toBe('~');
  });

  it('hiragana は基本86 + 繰り返し記号3 = 89 文字', () => {
    const chars = hiragana();
    expect(chars).toHaveLength(89);
    expect(chars).toContain('あ');
    expect(chars).toContain('ゖ');
  });

  it('katakana は 90 + 3 = 93 文字', () => {
    const chars = katakana();
    expect(chars).toHaveLength(93);
    expect(chars).toContain('ア');
  });

  it('joyoKanji は 2136 文字・重複なし', () => {
    const chars = joyoKanji();
    expect(chars).toHaveLength(2136);
    expect(new Set(chars).size).toBe(2136);
  });

  it('各プリセット内に重複がない', () => {
    for (const p of PRESETS) {
      const chars = p.build();
      expect(new Set(chars).size, p.id).toBe(chars.length);
    }
  });

  it('buildCharSet はプリセット順 + カスタム文字で重複排除する', () => {
    const out = buildCharSet(['latin'], 'A!あ');
    expect(out.filter((c) => c === '!')).toHaveLength(1);
    expect(out[out.length - 1]).toBe('あ');
    expect(out.indexOf('A')).toBeLessThan(out.indexOf('あ'));
  });

  it('buildCharSet はサロゲートペアを 1 文字として扱う', () => {
    const out = buildCharSet([], '𠮷野家');
    expect(out).toEqual(['𠮷', '野', '家']);
  });
});
