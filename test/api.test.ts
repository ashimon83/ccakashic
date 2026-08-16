import { describe, it, expect } from 'vitest';
import {
  toSessionRow,
  orderSessionRows,
  parseSessionLimit,
  DEFAULT_SESSION_LIMIT,
  MAX_SESSION_LIMIT,
} from '../src/api';

const MIN = 60_000;

function session(over: Partial<any> = {}): any {
  return {
    id: 'abcdef12-0000',
    path: '/tmp/proj/abcdef12-0000.jsonl',
    cwd: '/Users/me/repo',
    timestamp: null,
    lastModified: Date.now() - 30_000,
    preview: 'do the thing',
    gitBranch: 'main',
    slug: null,
    customTitle: null,
    aiTitle: null,
    model: 'claude-opus-5',
    hasSubagents: false,
    totalTokens: 0,
    outputTokens: 0,
    projectRawName: '-Users-me-repo',
    projectName: '/Users/me/repo',
    ...over,
  };
}

describe('toSessionRow', () => {
  it('exposes the dashboard status and waiting state', () => {
    const row = toSessionRow(session(), 'permission');
    expect(row.status).toBe('active');
    expect(row.waiting).toBe('permission');
    expect(toSessionRow(session({ lastModified: Date.now() - 10 * MIN }), null).status).toBe('recent');
    expect(toSessionRow(session({ lastModified: Date.now() - 5 * 60 * MIN }), null).status).toBe('idle');
  });

  it('uses the same display name as the dashboard pane', () => {
    expect(toSessionRow(session({ customTitle: 'My Session' }), null).title).toBe('My Session');
    expect(toSessionRow(session({ aiTitle: 'AI named' }), null).title).toBe('AI named');
    expect(toSessionRow(session({ id: 'abcdef1234-xyz' }), null).title).toBe('abcdef12');
  });

  it('links to the real session route, url-encoded', () => {
    const row = toSessionRow(session({ projectRawName: '-a b', id: 'x/y' }), null);
    expect(row.detailUrl).toBe('/project/-a%20b/session/x%2Fy');
  });

  it('offers a resume command instead of a resume URL', () => {
    // /api/resume is POST + CSRF token; handing that token out here would
    // defeat it, so callers get the shell command the Copy button gives.
    const row = toSessionRow(session(), null);
    expect(row.resumeUrl).toBeNull();
    expect(row.resumeCommand).toContain('claude --resume');
    expect(row.resumeCommand).toContain('/Users/me/repo');
  });

  it('has no resume command for a session with no recorded cwd', () => {
    const row = toSessionRow(session({ cwd: null }), null);
    expect(row.resumeCommand).toBeNull();
  });

  it('caps the preview', () => {
    const row = toSessionRow(session({ preview: 'x'.repeat(500) }), null);
    expect(row.preview.length).toBe(200);
  });
});

describe('parseSessionLimit', () => {
  it('defaults when absent or unusable', () => {
    expect(parseSessionLimit(null)).toBe(DEFAULT_SESSION_LIMIT);
    expect(parseSessionLimit('')).toBe(DEFAULT_SESSION_LIMIT);
    expect(parseSessionLimit('abc')).toBe(DEFAULT_SESSION_LIMIT);
    expect(parseSessionLimit('0')).toBe(DEFAULT_SESSION_LIMIT);
    expect(parseSessionLimit('-5')).toBe(DEFAULT_SESSION_LIMIT);
  });

  it('caps the limit, because every row costs a full session-file read', () => {
    expect(parseSessionLimit('3')).toBe(3);
    expect(parseSessionLimit('9999')).toBe(MAX_SESSION_LIMIT);
  });
});

describe('orderSessionRows', () => {
  it('returns the newest first, capped at the limit', () => {
    const rows = [
      toSessionRow(session({ id: 'old', lastModified: 1000 }), null),
      toSessionRow(session({ id: 'new', lastModified: 3000 }), null),
      toSessionRow(session({ id: 'mid', lastModified: 2000 }), null),
    ];
    expect(orderSessionRows(rows, 10).map((r) => r.id)).toEqual(['new', 'mid', 'old']);
    expect(orderSessionRows(rows, 2).map((r) => r.id)).toEqual(['new', 'mid']);
  });

  it('does not mutate the input', () => {
    const rows = [
      toSessionRow(session({ id: 'a', lastModified: 1000 }), null),
      toSessionRow(session({ id: 'b', lastModified: 3000 }), null),
    ];
    orderSessionRows(rows, 10);
    expect(rows.map((r) => r.id)).toEqual(['a', 'b']);
  });
});
