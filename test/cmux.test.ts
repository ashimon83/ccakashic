import { describe, it, expect } from 'vitest';
import { shellQuote, buildResumeCommand, parseOkId, parseWaitingNotifications, parseWorkspaceEnv } from '../src/cmux';

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

describe('parseWorkspaceEnv', () => {
  // `ps eww` output: pid, command, then the process's whole environment.
  const line = (pid: number, env: string) => `${String(pid).padStart(5)} s011  S+    23:11.51 claude --resume abc ${env}`;

  it('pulls the workspace id out of a process environment', () => {
    const out = parseWorkspaceEnv(
      '  PID   TT  STAT      TIME COMMAND\n' +
      line(58133, 'MANPATH=:/usr/share/man CMUX_WORKSPACE_ID=D1D50A2C-6BF3-4ECB-9E71-03D594E843F5 SHELL=/bin/bash'),
    );
    expect(out.get(58133)).toBe('D1D50A2C-6BF3-4ECB-9E71-03D594E843F5');
  });

  it('reads every pid from one batched ps call', () => {
    const out = parseWorkspaceEnv([
      line(1, 'CMUX_WORKSPACE_ID=aaaa-1'),
      line(2, 'PATH=/bin'),
      line(3, 'CMUX_WORKSPACE_ID=cccc-3'),
    ].join('\n'));
    expect(out.get(1)).toBe('AAAA-1');
    expect(out.has(2)).toBe(false); // not launched inside cmux
    expect(out.get(3)).toBe('CCCC-3');
  });

  it('upper-cases ids so they match cmux notification workspace ids', () => {
    expect(parseWorkspaceEnv(line(7, 'CMUX_WORKSPACE_ID=abcdef-99')).get(7)).toBe('ABCDEF-99');
  });

  it('ignores headers and junk without throwing', () => {
    expect(parseWorkspaceEnv('').size).toBe(0);
    expect(parseWorkspaceEnv('  PID TT  STAT TIME COMMAND\nnot a process line').size).toBe(0);
  });

  it('does not confuse a similarly named variable', () => {
    const out = parseWorkspaceEnv(line(9, 'NOT_CMUX_WORKSPACE_IDX=nope'));
    expect(out.has(9)).toBe(false);
  });
});
