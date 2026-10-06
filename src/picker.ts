// A checkbox list for the terminal: pick which sessions to reopen. No
// dependencies, so the state machine and the rendering are plain functions and
// only the last few lines touch stdin.

export interface PickerItem {
  label: string;
  hint?: string;
}

export interface PickerState {
  cursor: number;
  checked: boolean[];
  offset: number; // first visible row, for lists taller than the terminal
  rows: number;   // how many rows of the list are visible
}

export type PickerAction = 'confirm' | 'cancel' | null;

const ESC = '\u001b';

export function initialState(count: number, rows: number): PickerState {
  return { cursor: 0, checked: new Array(count).fill(true), offset: 0, rows: Math.max(1, Math.min(rows, count)) };
}

// Names the keys the loop cares about; anything else is ignored.
export function keyOf(data: string): string {
  switch (data) {
    case '\u0003': return 'cancel'; // Ctrl-C
    case '\u0004': return 'cancel'; // Ctrl-D
    case 'q': case ESC: return 'cancel';
    case '\r': case '\n': return 'confirm';
    case ' ': return 'toggle';
    case 'a': return 'toggleAll';
    case `${ESC}[A`: case 'k': return 'up';
    case `${ESC}[B`: case 'j': return 'down';
    case `${ESC}[H`: case 'g': return 'first';
    case `${ESC}[F`: case 'G': return 'last';
    default: return '';
  }
}

export function applyKey(state: PickerState, key: string): { state: PickerState; action: PickerAction } {
  const count = state.checked.length;
  const next = { ...state, checked: state.checked.slice() };
  switch (key) {
    case 'cancel': return { state, action: 'cancel' };
    case 'confirm': return { state, action: 'confirm' };
    case 'toggle':
      next.checked[next.cursor] = !next.checked[next.cursor];
      // Step down so space-space-space walks the list, as in most pickers.
      next.cursor = Math.min(count - 1, next.cursor + 1);
      break;
    case 'toggleAll': {
      // All on unless they already are, in which case clear them.
      const allOn = next.checked.every(Boolean);
      next.checked = next.checked.map(() => !allOn);
      break;
    }
    case 'up': next.cursor = Math.max(0, next.cursor - 1); break;
    case 'down': next.cursor = Math.min(count - 1, next.cursor + 1); break;
    case 'first': next.cursor = 0; break;
    case 'last': next.cursor = count - 1; break;
    default: return { state, action: null };
  }
  // Keep the cursor inside the visible window.
  if (next.cursor < next.offset) next.offset = next.cursor;
  if (next.cursor >= next.offset + next.rows) next.offset = next.cursor - next.rows + 1;
  return { state: next, action: null };
}

export function renderLines(items: PickerItem[], state: PickerState, width = 80): string[] {
  const lines: string[] = [];
  const picked = state.checked.filter(Boolean).length;
  lines.push(`Select sessions to reopen (${picked}/${items.length})`);
  lines.push('space toggle · a all/none · ↑↓ move · enter reopen · q cancel');
  const end = Math.min(items.length, state.offset + state.rows);
  for (let i = state.offset; i < end; i++) {
    const box = state.checked[i] ? '[x]' : '[ ]';
    const pointer = i === state.cursor ? '>' : ' ';
    const hint = items[i].hint ? `  ${items[i].hint}` : '';
    lines.push(truncate(`${pointer} ${box} ${items[i].label}${hint}`, width));
  }
  if (end < items.length || state.offset > 0) {
    lines.push(`    … ${state.offset + 1}-${end} of ${items.length}`);
  }
  return lines;
}

function truncate(s: string, width: number): string {
  return s.length <= width ? s : `${s.slice(0, Math.max(1, width - 1))}…`;
}

// Runs the list on a TTY and resolves with the chosen indices, or null if the
// user backed out. Callers must check process.stdin.isTTY first.
export function pickItems(items: PickerItem[], io: {
  input: NodeJS.ReadStream;
  output: NodeJS.WriteStream;
} = { input: process.stdin, output: process.stdout }): Promise<number[] | null> {
  const { input, output } = io;
  const viewRows = Math.max(3, (output.rows || 24) - 4);
  let state = initialState(items.length, viewRows);
  let drawn = 0;

  const draw = () => {
    if (drawn) output.write(`${ESC}[${drawn}A`); // back to the top of the list
    output.write(`${ESC}[J`); // clear from here down
    const lines = renderLines(items, state, (output.columns || 80) - 1);
    output.write(`${lines.join('\n')}\n`);
    drawn = lines.length;
  };

  return new Promise((resolve) => {
    const finish = (result: number[] | null) => {
      input.setRawMode?.(false);
      input.pause();
      input.removeListener('data', onData);
      output.write(`${ESC}[?25h`); // cursor back on
      resolve(result);
    };
    const onData = (buf: Buffer | string) => {
      const key = keyOf(buf.toString());
      if (!key) return;
      const next = applyKey(state, key);
      state = next.state;
      if (next.action === 'cancel') return finish(null);
      if (next.action === 'confirm') {
        const chosen = state.checked.flatMap((on, i) => (on ? [i] : []));
        draw();
        return finish(chosen);
      }
      draw();
    };

    output.write(`${ESC}[?25l`); // hide the cursor while redrawing
    input.setRawMode?.(true);
    input.resume();
    input.setEncoding('utf-8');
    input.on('data', onData);
    draw();
  });
}
