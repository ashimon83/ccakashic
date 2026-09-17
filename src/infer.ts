import * as fs from 'fs';
import * as path from 'path';
import { CLAUDE_DIR } from './discover';
import type { LastStop, LiveSession, StoppedSession } from './snapshot';

// Best-effort "what was running before the crash" from the conversation logs
// alone, for when the snapshot agent is not installed.
//
// What the logs can and cannot tell:
// - A session that exits (including during a normal shutdown/reboot) appends a
//   `cost-state` record, usually followed by a line or two of bookkeeping. A
//   burst of those right before a gap is a reliable signature.
// - A session killed outright (cmux force-quit while hung) writes nothing. All
//   that is left is when it was last active, so a session idling for hours
//   before the hang is missed. Results are therefore marked `estimated`.

// Sessions that exit on the same shutdown finish within seconds of each other.
const EXIT_BURST_WINDOW_MS = 3 * 60_000;
// Without exit records, "recently active before the newest one" is the best proxy.
const ACTIVITY_WINDOW_MS = 15 * 60_000;
const LOOKBACK_MS = 7 * 24 * 60 * 60_000;
const CHUNK = 64 * 1024;

function readChunk(file: string, fromEnd: boolean): string {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(CHUNK, size);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, fromEnd ? size - len : 0);
    return buf.toString('utf-8');
  } catch {
    return '';
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function parseLines(text: string): any[] {
  const out: any[] = [];
  for (const line of text.split('\n')) {
    try {
      out.push(JSON.parse(line));
    } catch {
      // partial first/last line of the chunk
    }
  }
  return out;
}

export interface LogFacts {
  interactive: boolean; // false for headless `claude -p` runs (entrypoint sdk-cli)
  cwd: string | null;
  exited: boolean; // a cost-state record near the end
}

export function readLogFacts(file: string): LogFacts {
  let entrypoint: string | null = null;
  let cwd: string | null = null;
  for (const o of parseLines(readChunk(file, false))) {
    entrypoint ??= typeof o?.entrypoint === 'string' ? o.entrypoint : null;
    cwd ??= typeof o?.cwd === 'string' ? o.cwd : null;
    if (entrypoint && cwd) break;
  }
  // Only the last few records: an exit writes cost-state and then a little
  // bookkeeping (e.g. artifact-comment-monitor), so it isn't always the last line.
  const exited = parseLines(readChunk(file, true)).slice(-8).some((o) => o?.type === 'cost-state');
  return { interactive: !entrypoint || entrypoint === 'cli', cwd, exited };
}

interface LogFile {
  sessionId: string;
  file: string;
  mtime: number;
}

function listLogFiles(root: string, since: number): LogFile[] {
  const out: LogFile[] = [];
  let dirs: string[];
  try {
    dirs = fs.readdirSync(root);
  } catch {
    return out;
  }
  for (const d of dirs) {
    let names: string[];
    try {
      names = fs.readdirSync(path.join(root, d));
    } catch {
      continue;
    }
    for (const f of names) {
      if (!f.endsWith('.jsonl')) continue;
      const file = path.join(root, d, f);
      try {
        const mtime = fs.statSync(file).mtimeMs;
        if (mtime >= since) out.push({ sessionId: f.slice(0, -'.jsonl'.length), file, mtime });
      } catch {
        // vanished mid-scan
      }
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

export function inferLastStop(
  live: LiveSession[],
  now = Date.now(),
  root = CLAUDE_DIR,
  readFacts: (file: string) => LogFacts = readLogFacts,
): LastStop | null {
  const liveIds = new Set(live.map((s) => s.sessionId));
  const factsCache = new Map<string, LogFacts>();
  const facts = (f: LogFile) => {
    let v = factsCache.get(f.file);
    if (!v) factsCache.set(f.file, (v = readFacts(f.file)));
    return v;
  };

  // Newest interactive session that is no longer running marks the stop.
  const dead = listLogFiles(root, now - LOOKBACK_MS).filter((f) => !liveIds.has(f.sessionId));
  const newest = dead.find((f) => facts(f).interactive && facts(f).cwd);
  if (!newest) return null;
  const stoppedAt = Math.floor(newest.mtime); // an integer survives the round trip through the page

  // Same rule as the recorded path: a session started before the stop and still
  // running means the others were closed on purpose, not killed together.
  if (live.some((s) => s.startedAt !== undefined && s.startedAt <= stoppedAt)) return null;

  const burst = facts(newest).exited;
  const window = burst ? EXIT_BURST_WINDOW_MS : ACTIVITY_WINDOW_MS;
  const sessions: StoppedSession[] = [];
  for (const f of dead) {
    if (f.mtime < stoppedAt - window) break; // sorted newest first
    const x = facts(f);
    if (!x.interactive || !x.cwd) continue;
    // In a shutdown burst, only sessions that actually exited belong to it.
    if (burst && !x.exited) continue;
    sessions.push({ sessionId: f.sessionId, cwd: x.cwd, name: null, proc: 'log', aliveSince: f.mtime, lastSeenAlive: f.mtime });
  }
  return { stoppedAt, sessions, estimated: true };
}
