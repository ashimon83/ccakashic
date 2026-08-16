import type { RecentSession } from './discover';
import { paneStatus, paneTitle, type WaitState } from './dashboard';
import { buildResumeCommand } from './cmux';

// Read-only JSON view of what the dashboard already computes, so other local
// tools can treat ccakashic as the source of truth for "which session is
// waiting for me" instead of re-deriving it from ~/.claude. The waiting signal
// in particular cannot be rebuilt elsewhere: it maps cmux's unread
// notifications through ccakashic's own resume map.

export const DEFAULT_SESSION_LIMIT = 40;
// Each row costs a full session-file read, so cap what one request can ask for.
export const MAX_SESSION_LIMIT = 100;
const PREVIEW_MAX = 200;

export interface SessionApiRow {
  id: string;
  projectRawName: string;
  projectName: string;
  cwd: string | null;
  title: string;
  preview: string;
  gitBranch: string | null;
  model: string | null;
  lastModified: number;
  status: 'active' | 'recent' | 'idle';
  waiting: WaitState;
  detailUrl: string;
  resumeUrl: string | null;
  resumeCommand: string | null;
}

export function toSessionRow(session: RecentSession, waiting: WaitState): SessionApiRow {
  return {
    id: session.id,
    projectRawName: session.projectRawName,
    projectName: session.projectName,
    cwd: session.cwd,
    title: paneTitle(session),
    preview: (session.preview || '').slice(0, PREVIEW_MAX),
    gitBranch: session.gitBranch,
    model: session.model,
    lastModified: session.lastModified,
    status: paneStatus(session.lastModified),
    waiting,
    detailUrl: `/project/${encodeURIComponent(session.projectRawName)}/session/${encodeURIComponent(session.id)}`,
    // /api/resume is POST-only and requires the CSRF token, so there is no GET
    // URL to hand out — and publishing that token from an unauthenticated
    // endpoint would defeat it. Callers that want to act on a session either
    // open detailUrl and press Resume, or run resumeCommand themselves.
    resumeUrl: null,
    resumeCommand: session.cwd ? buildResumeCommand(session.cwd, session.id) : null,
  };
}

export function parseSessionLimit(raw: string | null): number {
  const n = parseInt(raw || '', 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_SESSION_LIMIT;
  return Math.min(n, MAX_SESSION_LIMIT);
}

export function orderSessionRows(rows: SessionApiRow[], limit: number): SessionApiRow[] {
  return rows.slice().sort((a, b) => b.lastModified - a.lastModified).slice(0, limit);
}
