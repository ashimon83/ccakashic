import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { emptyState, recordLive, findLastStop, readLiveSessions, type LiveSession } from '../src/snapshot';
import { buildPlist } from '../src/agent';

const MIN = 60_000;
// Replays snapshot runs. An id may carry a process suffix ('a@2') to model the
// same session running in a new process, i.e. resumed.
function replay(runs: { at: number; ids: string[] }[]) {
  let state = emptyState();
  for (const r of runs) {
    const live: LiveSession[] = r.ids.map((raw) => {
      const [id, proc = '1'] = raw.split('@');
      return { sessionId: id, cwd: `/repo/${id}`, name: null, proc };
    });
    state = recordLive(state, live, r.at);
  }
  return state;
}

describe('findLastStop', () => {
  it('returns every session that went down together (reboot / hung cmux)', () => {
    const t0 = 1_000_000_000;
    const state = replay([
      { at: t0, ids: ['a', 'b', 'c'] },
      { at: t0 + MIN, ids: ['a', 'b', 'c'] },
      // machine off for an hour, then a fresh session is started
      { at: t0 + 61 * MIN, ids: ['new'] },
    ]);
    const stop = findLastStop(state, new Set(['new']));
    expect(stop?.stoppedAt).toBe(t0 + MIN);
    expect(stop?.sessions.map((s) => s.sessionId).sort()).toEqual(['a', 'b', 'c']);
  });

  it('ignores sessions closed one by one while others kept running', () => {
    const t0 = 1_000_000_000;
    const state = replay([
      { at: t0, ids: ['a', 'b'] },
      { at: t0 + MIN, ids: ['a', 'b'] },
      { at: t0 + 10 * MIN, ids: ['a'] }, // b was /exit-ed; a survived
    ]);
    expect(findLastStop(state, new Set(['a']))).toBeNull();
  });

  it('leaves out sessions that ended well before the crash', () => {
    const t0 = 1_000_000_000;
    const state = replay([
      { at: t0, ids: ['old', 'a'] },
      { at: t0 + 30 * MIN, ids: ['a', 'b'] },
      { at: t0 + 90 * MIN, ids: [] },
    ]);
    const stop = findLastStop(state, new Set());
    expect(stop?.sessions.map((s) => s.sessionId).sort()).toEqual(['a', 'b']);
  });

  it('keeps the rest listed after some of them are resumed', () => {
    const t0 = 1_000_000_000;
    const state = replay([
      { at: t0, ids: ['a', 'b', 'c'] },
      { at: t0 + 60 * MIN, ids: ['a@2'] }, // a resumed after the crash
      { at: t0 + 61 * MIN, ids: ['a@2'] },
    ]);
    const stop = findLastStop(state, new Set(['a']));
    expect(stop?.sessions.map((s) => s.sessionId).sort()).toEqual(['b', 'c']);
  });

  it('treats sessions that slept through a gap in snapshots as survivors', () => {
    const t0 = 1_000_000_000;
    const state = replay([
      { at: t0, ids: ['a', 'b'] },
      // Mac asleep for 8h: no runs, but both processes live on
      { at: t0 + 480 * MIN, ids: ['a', 'b'] },
      { at: t0 + 481 * MIN, ids: ['a'] }, // b /exit-ed right after wake
    ]);
    expect(findLastStop(state, new Set(['a']))).toBeNull();
  });

  it('returns null when everything recorded is still running', () => {
    const state = replay([{ at: 1_000_000_000, ids: ['a'] }]);
    expect(findLastStop(state, new Set(['a']))).toBeNull();
  });
});

describe('recordLive', () => {
  it('remembers when recording started', () => {
    const state = replay([{ at: 5, ids: [] }, { at: 9, ids: ['a'] }]);
    expect(state.recordingSince).toBe(5);
  });

  it('drops entries past retention', () => {
    const t0 = 1_000_000_000;
    const state = replay([
      { at: t0, ids: ['a'] },
      { at: t0 + 15 * 24 * 60 * MIN, ids: ['b'] },
    ]);
    expect(Object.keys(state.sessions)).toEqual(['b']);
  });
});

describe('readLiveSessions', () => {
  it('keeps live interactive sessions only', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccakashic-reg-'));
    const write = (name: string, o: object) => fs.writeFileSync(path.join(dir, name), JSON.stringify(o));
    write('1.json', { pid: process.pid, sessionId: 's-live', cwd: '/x', kind: 'interactive', name: 'n' });
    write('2.json', { pid: process.pid, sessionId: 's-headless', cwd: '/x', kind: 'print' });
    write('3.json', { pid: 99_999_999, sessionId: 's-dead', cwd: '/x' });
    fs.writeFileSync(path.join(dir, '4.json'), '{broken');
    write('5.json', { pid: process.pid, sessionId: 's-old', cwd: '/y', procStart: 'Thu' }); // no kind (older CLI)
    expect(readLiveSessions(dir)).toEqual([
      { sessionId: 's-live', cwd: '/x', name: 'n', proc: `${process.pid}:` },
      { sessionId: 's-old', cwd: '/y', name: null, proc: `${process.pid}:Thu` },
    ]);
  });
});

describe('agent copy', () => {
  it('the compiled snapshot module needs nothing but Node built-ins', () => {
    // The launchd agent runs a lone copy of this file outside the package.
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'snapshot.ts'), 'utf-8');
    const imports = [...src.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]);
    expect(imports.every((m) => ['fs', 'os', 'path'].includes(m))).toBe(true);
  });
});

describe('buildPlist', () => {
  it('runs the runner on an interval, with paths XML-escaped', () => {
    const plist = buildPlist('/usr/local/bin/node', '/a&b/run.js');
    expect(plist).toContain('<string>/usr/local/bin/node</string>\n    <string>/a&amp;b/run.js</string>\n  </array>');
    expect(plist).toContain('<key>StartInterval</key>');
  });
});
