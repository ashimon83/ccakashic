import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// "What was running before the crash?" — a record of live Claude Code sessions
// that outlives the processes, so they can be brought back in one go after a
// reboot or a hung cmux.
//
// Claude Code keeps ~/.claude/sessions/<pid>.json only while a session runs and
// removes it on exit (stale ones are swept at the next launch), so the registry
// itself is gone by the time you need it. `ccakashic snapshot` copies it into
// our own file on a timer (a launchd agent, see agent.ts) and keeps, per
// session, when it was last seen alive.

const CONFIG_DIR = path.join(os.homedir(), '.config', 'ccakashic');
export const SNAPSHOT_FILE = path.join(CONFIG_DIR, 'live-sessions.json');
const SESSION_REGISTRY_DIR = path.join(os.homedir(), '.claude', 'sessions');

// Sessions killed by the same event share their last sighting, give or take a
// run that was in progress while they went down.
const GROUP_WINDOW_MS = 150_000;
const RETENTION_MS = 14 * 24 * 60 * 60_000;

export interface SnapshotEntry {
  cwd: string;
  name: string | null;
  // pid + process start time. A resumed session runs in a new process, which is
  // what tells "resumed after dying" apart from "alive all along" — timing gaps
  // can't, since launchd doesn't fire while the Mac sleeps.
  proc: string;
  aliveSince: number;
  lastSeenAlive: number;
}

export interface SnapshotState {
  version: 1;
  lastRunAt: number;
  // First run of the recorder. Stops before this are not in the records.
  recordingSince: number | null;
  // Newest stop ever estimated from logs. Once its sessions are all resumed, the
  // next-older group of closed sessions would otherwise surface as a "stop",
  // and so on back through history; anything older than this is ignored.
  lastEstimatedStopAt: number | null;
  // lastSeenAlive of the stop the user dismissed from the dashboard
  dismissedStopAt: number | null;
  sessions: Record<string, SnapshotEntry>;
}

export interface LiveSession {
  sessionId: string;
  cwd: string;
  name: string | null;
  proc: string;
  startedAt?: number;
}

export function emptyState(): SnapshotState {
  return { version: 1, lastRunAt: 0, recordingSince: null, lastEstimatedStopAt: null, dismissedStopAt: null, sessions: {} };
}

export function loadSnapshot(file = SNAPSHOT_FILE): SnapshotState {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (data && data.version === 1 && data.sessions && typeof data.sessions === 'object') {
      return { ...emptyState(), ...data };
    }
  } catch {
    // not recorded yet
  }
  return emptyState();
}

export function saveSnapshot(state: SnapshotState, file = SNAPSHOT_FILE): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Atomic: this file is exactly what a crash must not leave half-written.
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, file);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err?.code === 'EPERM'; // exists, just not ours
  }
}

// Interactive sessions whose process is running right now. Headless `claude -p`
// runs (git hooks, scripts) register too but are not something to resume.
export function readLiveSessions(dir = SESSION_REGISTRY_DIR): LiveSession[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out = new Map<string, LiveSession>();
  for (const f of names) {
    if (!f.endsWith('.json')) continue;
    try {
      const o = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
      if (typeof o?.pid !== 'number' || typeof o?.sessionId !== 'string' || typeof o?.cwd !== 'string') continue;
      if (o.kind && o.kind !== 'interactive') continue;
      if (!isProcessAlive(o.pid)) continue;
      out.set(o.sessionId, {
        sessionId: o.sessionId,
        cwd: o.cwd,
        name: typeof o.name === 'string' ? o.name : null,
        proc: `${o.pid}:${o.procStart ?? ''}`,
        ...(typeof o.startedAt === 'number' ? { startedAt: o.startedAt } : {}),
      });
    } catch {
      // half-written record
    }
  }
  return [...out.values()];
}

export function recordLive(state: SnapshotState, live: LiveSession[], now: number): SnapshotState {
  const sessions: Record<string, SnapshotEntry> = {};
  for (const [id, e] of Object.entries(state.sessions)) {
    if (now - e.lastSeenAlive < RETENTION_MS) sessions[id] = e;
  }
  for (const s of live) {
    const prev = sessions[s.sessionId];
    const sameProcess = prev && prev.proc === s.proc;
    sessions[s.sessionId] = {
      cwd: s.cwd,
      name: s.name ?? prev?.name ?? null,
      proc: s.proc,
      aliveSince: sameProcess ? prev.aliveSince : now,
      lastSeenAlive: now,
    };
  }
  return { ...state, lastRunAt: now, recordingSince: state.recordingSince ?? now, sessions };
}

export interface StoppedSession extends SnapshotEntry {
  sessionId: string;
}

export interface LastStop {
  stoppedAt: number; // last time any of them was seen alive
  sessions: StoppedSession[];
  // true when guessed from conversation logs rather than the agent's records
  estimated?: boolean;
}

// The most recent group of sessions that went down together and has not been
// brought back. A group only counts as a stop when nothing survived it: if some
// session was alive both before and after, the others were closed one by one on
// purpose (/exit, closing a tab), not killed by a reboot or a hung cmux.
export function findLastStop(state: SnapshotState, liveIds: Set<string>): LastStop | null {
  const dead: StoppedSession[] = [];
  for (const [sessionId, e] of Object.entries(state.sessions)) {
    if (!liveIds.has(sessionId)) dead.push({ sessionId, ...e });
  }
  if (!dead.length) return null;
  const stoppedAt = Math.max(...dead.map((d) => d.lastSeenAlive));

  for (const id of liveIds) {
    const e = state.sessions[id];
    if (e && e.aliveSince <= stoppedAt) return null;
  }

  const sessions = dead
    .filter((d) => d.lastSeenAlive >= stoppedAt - GROUP_WINDOW_MS)
    .sort((a, b) => b.lastSeenAlive - a.lastSeenAlive || a.cwd.localeCompare(b.cwd));
  return { stoppedAt, sessions };
}

// One launchd tick. Kept free of any import beyond Node built-ins: the agent
// runs a copy of this compiled file, not the installed package (see agent.ts).
export function snapshotNow(now = Date.now()): void {
  saveSnapshot(recordLive(loadSnapshot(), readLiveSessions(), now));
}
