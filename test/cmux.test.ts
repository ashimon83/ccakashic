import { describe, it, expect } from 'vitest';
import { shellQuote, buildResumeCommand, parseOkId, parseWaitingNotifications } from '../src/cmux';

describe('shellQuote', () => {
  it('wraps plain strings in single quotes', () => {
    expect(shellQuote('/Users/foo/bar')).toBe(`'/Users/foo/bar'`);
  });

  it('escapes embedded single quotes', () => {
    expect(shellQuote(`it's`)).toBe(`'it'\\''s'`);
  });

  it('neutralizes shell metacharacters', () => {
    expect(shellQuote('$(rm -rf ~); echo `pwd` && x')).toBe("'$(rm -rf ~); echo `pwd` && x'");
  });
});

describe('buildResumeCommand', () => {
  it('builds a cd + claude --resume command', () => {
    expect(buildResumeCommand('/Users/foo/my proj', 'abc-123')).toBe(
      `cd '/Users/foo/my proj' && claude --resume 'abc-123'`
    );
  });
});

describe('parseOkId', () => {
  it('extracts the workspace UUID from OK output', () => {
    expect(parseOkId('OK D914C317-8E7D-41C9-B9C7-A91345A99361')).toBe(
      'D914C317-8E7D-41C9-B9C7-A91345A99361'
    );
  });

  it('uppercases lowercase ids', () => {
    expect(parseOkId('OK abc-def')).toBe('ABC-DEF');
  });

  it('throws on unexpected output', () => {
    expect(() => parseOkId('ERROR something')).toThrow(/Unexpected cmux output/);
  });
});

describe('parseWaitingNotifications', () => {
  it('ignores read notifications', () => {
    const m = parseWaitingNotifications([
      { workspace_id: 'A', body: 'Claude is waiting for your input', is_read: true },
    ]);
    expect(m.size).toBe(0);
  });

  it('classifies unread notifications by body', () => {
    const m = parseWaitingNotifications([
      { workspace_id: 'a', body: 'Claude is waiting for your input', is_read: false },
      { workspace_id: 'b', body: 'Claude needs your permission', is_read: false },
    ]);
    expect(m.get('A')).toBe('input');
    expect(m.get('B')).toBe('permission');
  });

  it('lets permission outrank a plain input wait for the same workspace', () => {
    const m = parseWaitingNotifications([
      { workspace_id: 'x', body: 'Claude is waiting for your input', is_read: false },
      { workspace_id: 'x', body: 'Claude needs your permission', is_read: false },
    ]);
    expect(m.get('X')).toBe('permission');
  });

  it('returns an empty map for non-array input', () => {
    expect(parseWaitingNotifications(null).size).toBe(0);
  });
});
