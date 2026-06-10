import { describe, it, expect, beforeEach } from 'vitest';
import { createHistory } from '../src/core/base-history.js';

describe('createHistory', () => {
  let state;
  let restored;
  let h;

  beforeEach(() => {
    state = { value: 0 };
    restored = [];
    h = createHistory({
      getState: () => state,
      buildSnapshot: (s) => JSON.parse(JSON.stringify(s)),
      restoreSnapshot: (snap) => {
        state = JSON.parse(JSON.stringify(snap));
        restored.push(state.value);
        return { restoredValue: state.value };
      },
    });
  });

  it('init 直後は undo/redo 不可', () => {
    h.init(state);
    expect(h.canUndo()).toBe(false);
    expect(h.canRedo()).toBe(false);
  });

  it('commit → undo → redo の基本サイクル', () => {
    h.init(state);
    state.value = 1;
    h.commit('set 1');
    expect(h.canUndo()).toBe(true);

    expect(h.undo()).toBe(true);
    expect(state.value).toBe(0);
    expect(h.canRedo()).toBe(true);

    expect(h.redo()).toBe(true);
    expect(state.value).toBe(1);
  });

  it('同一状態の commit は積まれない（冪等）', () => {
    h.init(state);
    h.commit('noop');
    expect(h.canUndo()).toBe(false);
  });

  it('getState が null なら commit は no-op', () => {
    h.init(state);
    state = null;
    h.commit('x');
    expect(h.canUndo()).toBe(false);
  });

  it('undo 後の commit で redo スタックが消える', () => {
    h.init(state);
    state.value = 1;
    h.commit();
    h.undo();
    state.value = 2;
    h.commit();
    expect(h.canRedo()).toBe(false);
  });

  it('スタック上限 50 を超えると古いものから捨てる', () => {
    h.init(state);
    for (let i = 1; i <= 60; i++) {
      state.value = i;
      h.commit();
    }
    let undos = 0;
    while (h.undo()) undos++;
    expect(undos).toBe(50);
    expect(state.value).toBe(10); // 1..9 は捨てられた
  });

  it('subscribe は即時に現在の状態を受け取り、restore で changes を伝える', () => {
    h.init(state);
    const events = [];
    h.subscribe((e) => events.push(e));
    expect(events[0]).toEqual({ canUndo: false, canRedo: false });

    state.value = 5;
    h.commit();
    h.undo();
    const restoreEvent = events.find((e) => e.isRestore);
    expect(restoreEvent.changes).toEqual({ restoredValue: 0 });
  });

  it('unsubscribe 後は通知されない', () => {
    h.init(state);
    const events = [];
    const off = h.subscribe((e) => events.push(e));
    off();
    state.value = 9;
    h.commit();
    expect(events).toHaveLength(1); // subscribe時の初回のみ
  });

  it('reset で両スタックが空になる', () => {
    h.init(state);
    state.value = 1;
    h.commit();
    h.reset();
    expect(h.canUndo()).toBe(false);
    expect(h.canRedo()).toBe(false);
  });
});
