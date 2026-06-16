import { describe, it, expect } from 'vitest';
import {
  timeAgo,
  paneStatus,
  waitBadgeHtml,
  renderPaneBody,
  generateDashboard,
  PANE_COUNTS,
} from '../src/dashboard';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe('timeAgo', () => {
  it('reports "just now" under a minute', () => {
    expect(timeAgo(Date.now() - 30_000)).toBe('just now');
  });
  it('reports minutes, hours, and days', () => {
    expect(timeAgo(Date.now() - 5 * MIN)).toBe('5m ago');
    expect(timeAgo(Date.now() - 3 * HOUR)).toBe('3h ago');
    expect(timeAgo(Date.now() - 2 * DAY)).toBe('2d ago');
  });
});

describe('paneStatus', () => {
  it('is active within 2 minutes', () => {
    expect(paneStatus(Date.now() - 30_000)).toBe('active');
  });
  it('is recent within 30 minutes', () => {
    expect(paneStatus(Date.now() - 10 * MIN)).toBe('recent');
  });
  it('is idle beyond 30 minutes', () => {
    expect(paneStatus(Date.now() - 2 * HOUR)).toBe('idle');
  });
});

describe('waitBadgeHtml', () => {
  it('renders nothing when not waiting', () => {
    expect(waitBadgeHtml(null)).toBe('');
  });
  it('renders an input-waiting badge', () => {
    const html = waitBadgeHtml('input');
    expect(html).toContain('dash-wait-input');
    expect(html).toContain('Your turn');
  });
  it('renders a permission badge', () => {
    const html = waitBadgeHtml('permission');
    expect(html).toContain('dash-wait-permission');
    expect(html).toContain('Permission');
  });
});

function parsed(messages: any[]): any {
  return { messages, subagents: {}, sessionPath: '/tmp/x.jsonl', stats: {} };
}
function userMsg(text: string, timestamp: string | null): any {
  return { type: 'user', text, timestamp };
}

describe('renderPaneBody', () => {
  it('keeps messages from the last 24h and drops older ones', () => {
    const recent = new Date(Date.now() - HOUR).toISOString();
    const old = new Date(Date.now() - 3 * DAY).toISOString();
    const html = renderPaneBody(parsed([userMsg('OLD_ONE', old), userMsg('RECENT_ONE', recent)]));
    expect(html).toContain('RECENT_ONE');
    expect(html).not.toContain('OLD_ONE');
  });

  it('keeps messages with a missing/unparseable timestamp', () => {
    const html = renderPaneBody(parsed([userMsg('NO_TS', null)]));
    expect(html).toContain('NO_TS');
    expect(html).not.toContain('No activity');
  });

  it('shows the latest tail with a note when nothing is in the last 24h', () => {
    const old = new Date(Date.now() - 5 * DAY).toISOString();
    const html = renderPaneBody(parsed([userMsg('STALE', old)]));
    expect(html).toContain('No activity in the last 24h');
    expect(html).toContain('STALE');
  });

  it('caps to the last 150 messages with a note', () => {
    const recent = new Date(Date.now() - HOUR).toISOString();
    const msgs = Array.from({ length: 151 }, (_, i) => userMsg('m' + i, recent));
    const html = renderPaneBody(parsed(msgs));
    expect(html).toContain('Showing last 150 of 151');
    expect(html).not.toContain('>m0<'); // first message trimmed
    expect(html).toContain('m150'); // last message kept
  });
});

function session(over: Partial<any> = {}): any {
  return {
    id: 'abcdef12-0000',
    path: '/tmp/abcdef12.jsonl',
    cwd: '/tmp/proj',
    timestamp: null,
    lastModified: Date.now() - 30_000,
    preview: '',
    gitBranch: 'main',
    slug: null,
    customTitle: 'My Session',
    aiTitle: null,
    model: null,
    hasSubagents: false,
    totalTokens: 0,
    outputTokens: 0,
    projectRawName: '-tmp-proj',
    projectName: '/tmp/proj',
    ...over,
  };
}

describe('generateDashboard', () => {
  it('renders one pane per entry and offers the pane-count switcher', () => {
    const html = generateDashboard(
      [{ session: session(), bodyHtml: '<div>body</div>', waiting: null }],
      4,
      undefined,
    );
    expect(html).toContain('class="dash-pane"');
    expect(html).toContain('My Session');
    for (const n of PANE_COUNTS) expect(html).toContain(`/?n=${n}`);
  });

  it('marks waiting panes and exposes the wait state for the client', () => {
    const html = generateDashboard(
      [{ session: session(), bodyHtml: '', waiting: 'permission' }],
      4,
      undefined,
    );
    // assert on the pane element class, not the CSS rule of the same name
    expect(html).toContain('class="dash-pane dash-pane-waiting"');
    expect(html).toContain('data-waiting="permission"');
    expect(html).toContain('Permission');
  });

  it('leaves non-waiting panes unmarked', () => {
    const html = generateDashboard(
      [{ session: session(), bodyHtml: '', waiting: null }],
      4,
      undefined,
    );
    expect(html).toContain('class="dash-pane"');
    expect(html).not.toContain('class="dash-pane dash-pane-waiting"');
    expect(html).toContain('data-waiting=""');
  });
});
