import { describe, it, expect } from 'vitest';
import { PassThrough } from 'stream';
import { initialState, applyKey, renderLines, keyOf, pickItems, type PickerItem } from '../src/picker';

const items: PickerItem[] = ['a', 'b', 'c', 'd'].map((label) => ({ label, hint: `/repo/${label}` }));
const press = (keys: string[], rows = 4) =>
  keys.reduce((acc, k) => applyKey(acc.state, keyOf(k)), { state: initialState(items.length, rows), action: null as any });

describe('keyOf', () => {
  it('maps the keys the list reacts to', () => {
    expect(keyOf(' ')).toBe('toggle');
    expect(keyOf('a')).toBe('toggleAll');
    expect(keyOf('\r')).toBe('confirm');
    expect(keyOf('\u0003')).toBe('cancel');
    expect(keyOf('q')).toBe('cancel');
    expect(keyOf('\u001b[B')).toBe('down');
    expect(keyOf('j')).toBe('down');
    expect(keyOf('\u001b[A')).toBe('up');
    expect(keyOf('x')).toBe('');
  });
});

describe('applyKey', () => {
  it('starts with everything ticked', () => {
    expect(initialState(3, 10).checked).toEqual([true, true, true]);
  });

  it('unticks under the cursor and steps down, so space-space walks the list', () => {
    const { state } = press([' ', ' ']);
    expect(state.checked).toEqual([false, false, true, true]);
    expect(state.cursor).toBe(2);
  });

  it('clears all with "a" when everything is on, and restores all when not', () => {
    const cleared = press(['a']);
    expect(cleared.state.checked).toEqual([false, false, false, false]);
    const restored = applyKey(cleared.state, keyOf('a'));
    expect(restored.state.checked).toEqual([true, true, true, true]);
  });

  it('re-ticks a single item that was turned off', () => {
    const off = press([' ', '\u001b[A']);
    expect(off.state.checked[0]).toBe(false);
    expect(applyKey(off.state, keyOf(' ')).state.checked[0]).toBe(true);
  });

  it('stops at the ends instead of wrapping', () => {
    expect(press(['\u001b[A']).state.cursor).toBe(0);
    expect(press(['j', 'j', 'j', 'j', 'j']).state.cursor).toBe(items.length - 1);
  });

  it('reports confirm and cancel without changing the ticks', () => {
    const picked = press([' ']);
    const confirmed = applyKey(picked.state, keyOf('\r'));
    expect(confirmed.action).toBe('confirm');
    expect(confirmed.state.checked).toEqual(picked.state.checked);
    expect(applyKey(picked.state, keyOf('q')).action).toBe('cancel');
  });

  it('scrolls the window to follow the cursor on a long list', () => {
    const { state } = press(['j', 'j', 'j'], 2);
    expect(state.cursor).toBe(3);
    expect(state.offset).toBe(2);
    const back = applyKey(applyKey(state, 'up').state, 'up');
    expect(back.state.offset).toBe(1);
  });
});

describe('renderLines', () => {
  it('shows the tick boxes, the cursor and the count', () => {
    const { state } = press([' ']);
    const lines = renderLines(items, state, 60);
    expect(lines[0]).toBe('Select sessions to reopen (3/4)');
    expect(lines[2]).toBe('  [ ] a  /repo/a');
    expect(lines[3]).toBe('> [x] b  /repo/b');
  });

  it('shows only the window of a long list, with a position line', () => {
    const state = initialState(items.length, 2);
    const lines = renderLines(items, state, 60);
    expect(lines.filter((l) => l.includes('[x]'))).toHaveLength(2);
    expect(lines[lines.length - 1]).toContain('1-2 of 4');
  });

  it('truncates rows to the terminal width', () => {
    const lines = renderLines([{ label: 'x'.repeat(100) }], initialState(1, 1), 20);
    expect(lines[2]).toHaveLength(20);
    expect(lines[2].endsWith('…')).toBe(true);
  });
});

// Drives the real loop over a fake terminal: keys in, chosen items out.
function runPicker(items: PickerItem[], keys: string[]) {
  const input: any = new PassThrough();
  input.setRawMode = () => {};
  const written: string[] = [];
  const output: any = { write: (s: string) => written.push(s), rows: 24, columns: 80 };
  const done = pickItems(items, { input, output });
  for (const k of keys) input.write(k);
  return done.then((picked) => ({ picked, screen: written.join('') }));
}

describe('pickItems', () => {
  it('returns what is still ticked when enter is pressed', async () => {
    const { picked } = await runPicker(items, [' ', ' ', '\r']);
    expect(picked).toEqual([2, 3]);
  });

  it('reopening everything is just enter', async () => {
    const { picked } = await runPicker(items, ['\r']);
    expect(picked).toEqual([0, 1, 2, 3]);
  });

  it('allows picking one: clear all, then tick it', async () => {
    const { picked } = await runPicker(items, ['a', 'j', 'j', ' ', '\r']);
    expect(picked).toEqual([2]);
  });

  it('returns null when cancelled, and restores the cursor', async () => {
    const { picked, screen } = await runPicker(items, ['q']);
    expect(picked).toBeNull();
    expect(screen).toContain('\u001b[?25h');
  });
});
