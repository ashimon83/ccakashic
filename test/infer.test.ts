import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { inferLastStop, readLogFacts, type LogFacts } from '../src/infer';
import { chooseStop } from '../src/restore';
import { emptyState } from '../src/snapshot';

const MIN = 60_000;
const NOW = 1_800_000_000_000;

// Lays out <root>/<project>/<id>.jsonl with the given mtimes; facts are injected.
function setup(files: { id: string; ago: number; facts: Partial<LogFacts> }[]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccakashic-infer-'));
  fs.mkdirSync(path.join(root, 'proj'));
  const facts = new Map<string, LogFacts>();
  for (const f of files) {
    const file = path.join(root, 'proj', `${f.id}.jsonl`);
    fs.writeFileSync(file, '');
    const t = (NOW - f.ago) / 1000;
    fs.utimesSync(file, t, t);
    facts.set(file, { interactive: true, cwd: `/repo/${f.id}`, exited: false, ...f.facts });
  }
  return { root, readFacts: (file: string) => facts.get(file)! };
}

const ids = (stop: ReturnType<typeof inferLastStop>) => stop?.sessions.map((s) => s.sessionId).sort();

describe('inferLastStop', () => {
  it('takes the burst of exits from a shutdown, skipping headless runs and earlier exits', () => {
    const { root, readFacts } = setup([
      { id: 'a', ago: 30 * MIN, facts: { exited: true } },
      { id: 'b', ago: 30 * MIN + 20_000, facts: { exited: true } },
      { id: 'headless', ago: 30 * MIN, facts: { exited: true, interactive: false } },
      { id: 'no-exit', ago: 31 * MIN }, // active at the time but did not exit then
      { id: 'yesterday', ago: 20 * 60 * MIN, facts: { exited: true } },
    ]);
    const stop = inferLastStop([], NOW, root, readFacts);
    expect(stop?.estimated).toBe(true);
    expect(ids(stop)).toEqual(['a', 'b']);
  });

  it('falls back to recent activity when nothing exited (force-quit)', () => {
    const { root, readFacts } = setup([
      { id: 'a', ago: 30 * MIN },
      { id: 'b', ago: 40 * MIN },
      { id: 'idle-long', ago: 120 * MIN },
    ]);
    expect(ids(inferLastStop([], NOW, root, readFacts))).toEqual(['a', 'b']);
  });

  it('offers nothing when a session from before the stop is still running', () => {
    const { root, readFacts } = setup([{ id: 'closed', ago: 5 * MIN, facts: { exited: true } }]);
    const survivor = { sessionId: 'x', cwd: '/x', name: null, proc: '1:', startedAt: NOW - 60 * MIN };
    expect(inferLastStop([survivor], NOW, root, readFacts)).toBeNull();
  });

  it('ignores running sessions and ones already resumed', () => {
    const { root, readFacts } = setup([
      { id: 'resumed', ago: 1 * MIN },
      { id: 'a', ago: 30 * MIN, facts: { exited: true } },
      { id: 'b', ago: 30 * MIN, facts: { exited: true } },
    ]);
    const resumed = { sessionId: 'resumed', cwd: '/r', name: null, proc: '2:', startedAt: NOW - 2 * MIN };
    expect(ids(inferLastStop([resumed], NOW, root, readFacts))).toEqual(['a', 'b']);
  });
});

describe('readLogFacts', () => {
  it('finds cost-state even when bookkeeping follows it', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ccakashic-facts-')), 's.jsonl');
    const lines = [
      { type: 'user', entrypoint: 'cli', cwd: '/w' },
      { type: 'last-prompt' },
      { type: 'cost-state' },
      { type: 'artifact-comment-monitor' },
    ];
    fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    expect(readLogFacts(file)).toEqual({ interactive: true, cwd: '/w', exited: true });
  });

  it('treats sdk-cli sessions as headless', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ccakashic-facts-')), 's.jsonl');
    fs.writeFileSync(file, JSON.stringify({ type: 'user', entrypoint: 'sdk-cli', cwd: '/w' }) + '\n');
    expect(readLogFacts(file).interactive).toBe(false);
  });
});

describe('chooseStop', () => {
  // Stands in for inferLastStop, which itself declines anything older than the floor.
  const stopAt = (t: number) => (notOlderThan: number) =>
    (t < notOlderThan ? null : { stoppedAt: t, sessions: [], estimated: true });

  it('does not walk back to older groups once the offered stop is resolved', () => {
    const first = chooseStop(emptyState(), [], false, stopAt(100));
    expect(first.stop?.stoppedAt).toBe(100);
    expect(first.state.lastOfferedStopAt).toBe(100);
    // everything from 100 reopened; the logs now point at an older group
    expect(chooseStop(first.state, [], false, stopAt(50)).stop).toBeNull();
    // still offered while some of the same stop remain
    expect(chooseStop(first.state, [], false, stopAt(100)).stop?.stoppedAt).toBe(100);
    // a newer stop is offered again
    expect(chooseStop(first.state, [], false, stopAt(200)).stop?.stoppedAt).toBe(200);
  });

  it('with the agent, uses logs only for stops before recording began', () => {
    const state = { ...emptyState(), recordingSince: 1000 };
    expect(chooseStop(state, [], true, stopAt(900)).stop?.stoppedAt).toBe(900);
    expect(chooseStop(state, [], true, stopAt(1100)).stop).toBeNull();
  });
});
