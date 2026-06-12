import { describe, it, expect } from 'vitest';
import { shellQuote, buildResumeCommand, parseOkId } from '../src/cmux';

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
