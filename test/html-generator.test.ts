import { describe, it, expect } from 'vitest';
import { generate, renderMessage } from '../src/html-generator';

const TS = '2026-08-11T01:02:03.000Z';

function parsed(messages: any[] = []): any {
  return {
    messages,
    subagents: {},
    sessionPath: '/tmp/x.jsonl',
    stats: { turns: 1, inputTokens: 10, outputTokens: 20, cacheCreation: 0, cacheRead: 0, totalTokens: 30, cacheHitRate: 0, durationMs: 1000 },
  };
}

describe('message filters', () => {
  it('renders a chip per filter, all enabled by default', () => {
    const html = generate(parsed());
    for (const key of ['tools', 'injected', 'thinking', 'shell', 'system', 'cost']) {
      expect(html).toContain(`data-filter="${key}" checked`);
    }
    expect(html).toContain('data-preset="chat"');
    expect(html).toContain('data-preset="all"');
  });

  it('hides each filtered type through a body class', () => {
    const html = generate(parsed());
    expect(html).toContain('body.hide-tools .msg-tool');
    expect(html).toContain('body.hide-injected .msg-injected');
    expect(html).toContain('body.hide-thinking .msg-thinking');
    expect(html).toContain('body.hide-shell .msg-local-cmd');
    expect(html).toContain('body.hide-system .msg-system');
    expect(html).toContain('body.hide-cost .turn-usage');
  });

  it('never hides the conversation itself', () => {
    const html = generate(parsed());
    expect(html).not.toContain('.msg-user {\n  display: none');
    expect(html).not.toMatch(/body\.hide-\w+ \.msg-(user|assistant)\b/);
  });

  it('marks up each message type with the class its filter targets', () => {
    expect(renderMessage({ type: 'tool_use', toolName: 'Read', input: { file_path: '/a' }, timestamp: TS }))
      .toContain('msg-tool');
    expect(renderMessage({ type: 'thinking', timestamp: TS })).toContain('msg-thinking');
    expect(renderMessage({ type: 'local_command', command: 'ls', timestamp: TS })).toContain('msg-local-cmd');
    expect(renderMessage({ type: 'system', subtype: 'info', content: 'hi', timestamp: TS })).toContain('msg-system');
    expect(renderMessage({ type: 'user', text: 'hello', timestamp: TS })).toContain('msg-user');
    expect(renderMessage({ type: 'assistant', text: 'hi', timestamp: TS })).toContain('msg-assistant');
  });

  it('separates harness-injected user-role text from the user bubble', () => {
    const injected = renderMessage({
      type: 'user', text: 'Stop hook feedback: keep going', timestamp: TS,
      injected: true, injectedKind: 'Hook feedback',
    });
    expect(injected).toContain('msg-injected');
    expect(injected).not.toContain('msg-user');
    expect(injected).toContain('Hook feedback');
    // collapsed, with the opening of the text as the summary
    expect(injected).toContain('<details>');
    expect(injected).toContain('injected-peek');

    const real = renderMessage({ type: 'user', text: 'hello', timestamp: TS, injected: false, injectedKind: null });
    expect(real).toContain('msg-user');
    expect(real).not.toContain('msg-injected');
  });

  it('puts cost badges in filterable wrappers', () => {
    const turn = renderMessage({
      type: 'user', text: 'hi', timestamp: TS,
      turnUsage: { input: 1, output: 2, cacheRead: 3, cacheCreate: 4, total: 10, durationMs: 0 },
    });
    expect(turn).toContain('turn-usage');

    const tool = renderMessage({
      type: 'tool_use', toolName: 'Read', input: { file_path: '/a' }, timestamp: TS,
      usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    });
    expect(tool).toContain('tool-usage-row');
  });
});

describe('sticky session header', () => {
  it('wraps the header in a sticky bar the scripts can condense', () => {
    const html = generate(parsed());
    expect(html).toContain('class="session-header-bar" id="sessionHeaderBar"');
    expect(html).toContain('position: sticky');
    expect(html).toContain('is-condensed');
  });

  it('offsets sticky date headings and the side nav against the header height', () => {
    const html = generate(parsed([{ type: 'user', text: 'hi', timestamp: TS }]));
    expect(html).toContain('top: var(--header-h, 60px)');
    expect(html).toContain('top: calc(var(--header-h, 60px) + 8px)');
    expect(html).toContain('scroll-margin-top: calc(var(--header-h, 60px) + 44px)');
  });

  it('drops the old free-floating date bar', () => {
    const html = generate(parsed());
    expect(html).not.toContain('detailStickyBar');
  });
});

describe('prompt pager', () => {
  const html = () => generate(parsed([{ type: 'user', text: 'hi', timestamp: TS }]));

  it('renders an always-visible prev/next control with a counter', () => {
    const h = html();
    expect(h).toContain('id="msgPager"');
    expect(h).toContain('id="msgPagerCount"');
    expect(h).toContain('data-dir="-1"');
    expect(h).toContain('data-dir="1"');
    expect(h).toContain('position: fixed');
  });

  it('targets only top-level prompts, not the ones inside subagent transcripts', () => {
    // Subagent conversations are inlined in collapsed tool rows and carry their
    // own .msg-user nodes; scrolling to those does nothing.
    expect(html()).toContain(".detail-date-group > .msg-user'");
  });

  it('re-aligns jumps against the condensing header', () => {
    const h = html();
    expect(h).toContain('ccakashicAlign');
    expect(h).toContain('scrollMarginTop');
    expect(h).toContain("addEventListener('hashchange'");
  });
});
