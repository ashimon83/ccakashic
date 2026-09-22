import * as fs from 'fs';
import { findRecentSessionsByIds, listKnownSessionIds } from './discover';
import { resumeInNewWorkspace, saveResumeMapEntry } from './cmux';
import { recordLive, loadSnapshot, saveSnapshot, readLiveSessions, findLastStop, type LastStop, type LiveSession, type SnapshotState, type StoppedSession } from './snapshot';
import { inferLastStop } from './infer';
import { AGENT_PLIST } from './agent';

// Bring back a stopped group, one cmux workspace per session. Shared by
// `ccakashic restore` and the dashboard's "Restore all" button.

export interface RestoreItem {
  sessionId: string;
  cwd: string;
  title: string;
  projectRawName: string | null;
}

export interface RestoreOutcome {
  sessionId: string;
  title: string;
  ok: boolean;
  message?: string;
}

// Starting a dozen `claude` processes at once is what tends to cause the memory
// pressure this feature recovers from, so space them out a little.
const STAGGER_MS = 1500;

// The stop to offer. The agent's records are exact but only reach back to when
// it started recording; anything else (no agent, or a stop that predates it)
// is guessed from the conversation logs. Either way the current registry is
// recorded first so already-resumed sessions count as running.
export function detectLastStop(now = Date.now()): { state: SnapshotState; stop: LastStop | null; agentInstalled: boolean } {
  const live = readLiveSessions();
  const agentInstalled = fs.existsSync(AGENT_PLIST);
  const known = listKnownSessionIds();
  const { state, stop } = chooseStop(
    recordLive(loadSnapshot(), live, now),
    live,
    agentInstalled,
    (notOlderThan) => inferLastStop(live, now, undefined, undefined, notOlderThan),
    (id) => known.has(id),
  );
  try {
    saveSnapshot(state);
  } catch {
    // read-only use still works from the in-memory state
  }
  return { state, stop, agentInstalled };
}

// Pure decision between the agent's records and a log estimate; returns the
// state to persist alongside it.
export function chooseStop(
  state: SnapshotState,
  live: LiveSession[],
  agentInstalled: boolean,
  infer: (notOlderThan: number) => LastStop | null,
  resumable: (sessionId: string) => boolean = () => true,
): { state: SnapshotState; stop: LastStop | null } {
  // Never dig further back than the last group offered: once those are reopened,
  // the group before them is just history, not something that stopped on you.
  const floor = state.lastOfferedStopAt ?? 0;
  const liveIds = new Set(live.map((s) => s.sessionId));
  const stop = (agentInstalled ? findLastStop(state, liveIds, resumable, floor) : null)
    // Within the recorded period the agent's records are the truth, so the log
    // estimate is only for stops from before recording began.
    ?? inferBeforeRecording(state, agentInstalled, infer, floor);
  if (!stop) return { state, stop: null };
  return { state: { ...state, lastOfferedStopAt: Math.max(floor, stop.stoppedAt) }, stop };
}

function inferBeforeRecording(
  state: SnapshotState,
  agentInstalled: boolean,
  infer: (notOlderThan: number) => LastStop | null,
  floor: number,
): LastStop | null {
  const inferred = infer(floor);
  if (!inferred) return null;
  if (agentInstalled && state.recordingSince !== null && inferred.stoppedAt >= state.recordingSince) return null;
  return inferred;
}

export async function describeStopped(sessions: StoppedSession[]): Promise<RestoreItem[]> {
  const previews = await findRecentSessionsByIds(sessions.map((s) => s.sessionId));
  const byId = new Map(previews.map((p) => [p.id, p]));
  return sessions.map((s) => {
    const p = byId.get(s.sessionId);
    return {
      sessionId: s.sessionId,
      cwd: s.cwd,
      title: p?.customTitle || p?.aiTitle || s.name || p?.slug || s.sessionId.slice(0, 8),
      projectRawName: p?.projectRawName ?? null,
    };
  });
}

export async function restoreAll(
  items: RestoreItem[],
  onProgress?: (o: RestoreOutcome) => void,
): Promise<RestoreOutcome[]> {
  const outcomes: RestoreOutcome[] = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    let outcome: RestoreOutcome;
    if (!it.projectRawName) {
      outcome = { sessionId: it.sessionId, title: it.title, ok: false, message: 'no conversation log (nothing to resume)' };
    } else if (!fs.existsSync(it.cwd)) {
      outcome = { sessionId: it.sessionId, title: it.title, ok: false, message: `directory no longer exists: ${it.cwd}` };
    } else {
      try {
        // Background: keep focus where it is instead of flicking through every tab.
        const { workspaceId } = await resumeInNewWorkspace(it.cwd, it.sessionId, it.title, true);
        saveResumeMapEntry(it.sessionId, workspaceId);
        outcome = { sessionId: it.sessionId, title: it.title, ok: true };
      } catch (err: any) {
        outcome = { sessionId: it.sessionId, title: it.title, ok: false, message: err?.message || String(err) };
      }
      if (i < items.length - 1) await new Promise((r) => setTimeout(r, STAGGER_MS));
    }
    outcomes.push(outcome);
    onProgress?.(outcome);
  }
  return outcomes;
}
