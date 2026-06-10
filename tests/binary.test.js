import { describe, it, expect } from 'vitest';
import { BinaryWriter, tableChecksum, buildSfnt } from '../src/render/font/binary.js';

describe('BinaryWriter', () => {
  it('u8/u16/u32 はビッグエンディアン', () => {
    const w = new BinaryWriter();
    w.u8(0xab);
    w.u16(0x1234);
    w.u32(0xdeadbeef);
    expect([...w.toUint8Array()]).toEqual([0xab, 0x12, 0x34, 0xde, 0xad, 0xbe, 0xef]);
  });

  it('i16 は負数を 2 の補数で書く', () => {
    const w = new BinaryWriter();
    w.i16(-1);
    w.i16(-32768);
    expect([...w.toUint8Array()]).toEqual([0xff, 0xff, 0x80, 0x00]);
  });

  it('fixed は 16.16 固定小数', () => {
    const w = new BinaryWriter();
    w.fixed(1.5);
    expect([...w.toUint8Array()]).toEqual([0x00, 0x01, 0x80, 0x00]);
  });

  it('f2dot14 は 2.14 固定小数', () => {
    const w = new BinaryWriter();
    w.f2dot14(1.0);
    expect([...w.toUint8Array()]).toEqual([0x40, 0x00]);
  });

  it('tag は 4 文字 ASCII、それ以外は例外', () => {
    const w = new BinaryWriter();
    w.tag('glyf');
    expect([...w.toUint8Array()]).toEqual([0x67, 0x6c, 0x79, 0x66]);
    expect(() => w.tag('abc')).toThrow();
  });

  it('pad は 4 バイト境界までゼロ詰め', () => {
    const w = new BinaryWriter();
    w.u8(1);
    w.pad(4);
    expect(w.length).toBe(4);
    w.pad(4);
    expect(w.length).toBe(4);
  });

  it('初期容量を超えて自動拡張する', () => {
    const w = new BinaryWriter(2);
    for (let i = 0; i < 1000; i++) w.u32(i);
    expect(w.length).toBe(4000);
  });
});

describe('tableChecksum', () => {
  it('4 バイト単位の和（mod 2^32）', () => {
    expect(tableChecksum(new Uint8Array([0, 0, 0, 1, 0, 0, 0, 2]))).toBe(3);
  });

  it('端数はゼロパディングとして扱う', () => {
    expect(tableChecksum(new Uint8Array([0x12]))).toBe(0x12000000);
  });

  it('32bit オーバーフローはラップする', () => {
    const bytes = new Uint8Array([0xff, 0xff, 0xff, 0xff, 0x00, 0x00, 0x00, 0x02]);
    expect(tableChecksum(bytes)).toBe(1);
  });
});

describe('buildSfnt', () => {
  function makeTables() {
    // head: checkSumAdjustment (offset 8) はゼロで渡す決まり
    const head = new Uint8Array(54);
    head[0] = 0x00;
    head[1] = 0x01; // majorVersion
    return [
      { tag: 'head', bytes: head },
      { tag: 'maxp', bytes: new Uint8Array([0, 1, 0, 0, 0, 3]) },
      { tag: 'cmap', bytes: new Uint8Array([0, 0, 0, 1]) },
    ];
  }

  it('sfnt 全体のチェックサムが 0xB1B0AFBA になるよう head が修正される', () => {
    const bin = buildSfnt(makeTables());
    expect(tableChecksum(bin)).toBe(0xb1b0afba);
  });

  it('テーブルディレクトリはタグ昇順', () => {
    const bin = buildSfnt(makeTables());
    const tag = (off) => String.fromCharCode(bin[off], bin[off + 1], bin[off + 2], bin[off + 3]);
    expect([tag(12), tag(28), tag(44)]).toEqual(['cmap', 'head', 'maxp']);
  });

  it('head が無いと例外', () => {
    expect(() => buildSfnt([{ tag: 'maxp', bytes: new Uint8Array(4) }])).toThrow();
  });
});
