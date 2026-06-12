import { describe, it, expect } from 'vitest';
import { deriveActivity } from '../src/parser';

describe('deriveActivity', () => {
  it('returns waiting when the assistant ended its turn last', () => {
    const lines = [
      { type: 'user', message: { role: 'user', content: 'hi' } },
      { type: 'assistant', message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] } },
    ];
    expect(deriveActivity(lines)).toBe('waiting');
  });

  it('returns working when the last assistant message requested a tool', () => {
    const lines = [
      { type: 'assistant', message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'Bash' }] } },
    ];
    expect(deriveActivity(lines)).toBe('working');
  });

  it('returns working when a tool_result was just fed back', () => {
    const lines = [
      { type: 'assistant', message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use' }] } },
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } },
    ];
    expect(deriveActivity(lines)).toBe('working');
  });

  it('skips non-conversational trailing records (permission-mode, bridge-session)', () => {
    const lines = [
      { type: 'assistant', message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] } },
      { type: 'permission-mode' },
      { type: 'bridge-session' },
    ];
    expect(deriveActivity(lines)).toBe('waiting');
  });

  it('returns unknown when there is no conversational record', () => {
    expect(deriveActivity([{ type: 'summary' }, { type: 'custom-title' }])).toBe('unknown');
  });
});
