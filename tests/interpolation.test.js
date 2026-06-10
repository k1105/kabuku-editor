import { describe, it, expect } from 'vitest';
import {
  EASINGS,
  EASING_NAMES,
  applyEasing,
  segmentControls,
  sampleBezierSegment,
  sampleTrack,
} from '../src/animation/interpolation.js';

describe('applyEasing', () => {
  it('全イージングは端点 0→0, 1→1 を保つ', () => {
    for (const name of EASING_NAMES) {
      expect(applyEasing(0, name)).toBeCloseTo(0, 12);
      expect(applyEasing(1, name)).toBeCloseTo(1, 12);
    }
  });

  it('範囲外の t はクランプされる', () => {
    expect(applyEasing(-1, 'linear')).toBe(0);
    expect(applyEasing(2, 'linear')).toBe(1);
  });

  it('未知の名前は linear にフォールバック', () => {
    expect(applyEasing(0.3, 'nope')).toBe(0.3);
  });

  it('ease-in-out の中点は 0.5', () => {
    expect(EASINGS['ease-in-out'](0.5)).toBeCloseTo(0.5, 12);
  });
});

describe('segmentControls', () => {
  it('明示ハンドル (hOut/hIn) があればそれを使う', () => {
    const a = { time: 0, value: 0, hOut: { dt: 0.1, dv: 5 } };
    const b = { time: 1, value: 10, hIn: { dt: -0.2, dv: -3 } };
    const { p1, p2 } = segmentControls(a, b);
    expect(p1).toEqual({ x: 0.1, y: 5 });
    expect(p2).toEqual({ x: 0.8, y: 7 });
  });

  it('ハンドル無し + legacy easing から導出する', () => {
    const a = { time: 0, value: 0 };
    const b = { time: 2, value: 10, easing: 'linear' };
    const { p1, p2 } = segmentControls(a, b);
    expect(p1.x).toBeCloseTo(2 / 3, 10);
    expect(p1.y).toBeCloseTo(10 / 3, 10);
    expect(p2.x).toBeCloseTo(4 / 3, 10);
    expect(p2.y).toBeCloseTo(20 / 3, 10);
  });
});

describe('sampleBezierSegment', () => {
  it('u=0 / u=1 で端点を返す', () => {
    const a = { time: 0, value: 1 };
    const b = { time: 2, value: 5, easing: 'ease-in' };
    expect(sampleBezierSegment(a, b, 0)).toEqual({ time: 0, value: 1 });
    expect(sampleBezierSegment(a, b, 1)).toEqual({ time: 2, value: 5 });
  });
});

describe('sampleTrack', () => {
  const track = [
    { time: 1, value: 10 },
    { time: 3, value: 20, easing: 'linear' },
    { time: 5, value: -4, easing: 'ease-out' },
  ];

  it('空トラックは fallback', () => {
    expect(sampleTrack([], 1, 42)).toBe(42);
    expect(sampleTrack(null, 1, 42)).toBe(42);
  });

  it('最初のキーフレーム以前は最初の値', () => {
    expect(sampleTrack(track, 0, 0)).toBe(10);
    expect(sampleTrack(track, 1, 0)).toBe(10);
  });

  it('最後のキーフレーム以降は最後の値', () => {
    expect(sampleTrack(track, 5, 0)).toBe(-4);
    expect(sampleTrack(track, 99, 0)).toBe(-4);
  });

  it('linear セグメントの中点は線形補間値', () => {
    expect(sampleTrack(track, 2, 0)).toBeCloseTo(15, 6);
  });

  it('legacy easing と等価なベジェハンドルは同じ値にサンプルされる', () => {
    // ease-in 相当: cubic-bezier(0.42, 0, 1, 1)
    const legacy = [
      { time: 0, value: 0 },
      { time: 1, value: 100, easing: 'ease-in' },
    ];
    const withHandles = [
      { time: 0, value: 0, hOut: { dt: 0.42, dv: 0 } },
      { time: 1, value: 100, hIn: { dt: 0, dv: 0 }, easing: 'ease-in' },
    ];
    for (const t of [0.1, 0.25, 0.5, 0.75, 0.9]) {
      expect(sampleTrack(withHandles, t, 0)).toBeCloseTo(sampleTrack(legacy, t, 0), 6);
    }
  });

  it('単調性: linear トラックのサンプル値は時刻に対して単調', () => {
    const lin = [
      { time: 0, value: 0 },
      { time: 1, value: 100, easing: 'linear' },
    ];
    let prev = -Infinity;
    for (let i = 0; i <= 20; i++) {
      const v = sampleTrack(lin, i / 20, 0);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });
});
