# ccakashic

An Akashic Record of your Claude Code sessions — browse Claude Code session logs (`~/.claude/projects/`) as beautiful HTML in your browser.

## Usage

### npx

```bash
npx ccakashic
```

### Run from source

```bash
git clone git@github.com:ashimon83/ccakashic.git
cd ccakashic
npm start
```

A local HTTP server starts and your browser opens automatically.

## Features

- **Fully browser-based** — Project list → Session list → Conversation detail
- **Chat-style layout** — User / assistant messages in chat bubbles
- **Collapsible tool calls** — Bash, Read, Edit, and other tool invocations collapsed by default
- **Diff view** — File edits shown with red/green line highlights
- **Date navigation** — Side nav and sticky headers to jump between dates
- **Cost estimation** — Per-turn and per-message USD cost based on Claude Opus 4 pricing (input / output / cache read / cache write breakdown)
- **Elapsed time** — Per-turn duration and per-tool execution time derived from timestamps
- **Local command display** — `!` shell commands rendered with prompt and output
- **Inline subagent conversations** — Subagent dialogues nested inside the Agent tool_use that spawned them
- **Permalinks** — Click any message timestamp to get a shareable URL (`#t20260416103045`)
- **Session-level stats** — Estimated cost, turns, token breakdown, cache hit rate, and duration in the header
- **Dark mode** — Follows `prefers-color-scheme` automatically
- **Filter search** — Incremental filtering on list pages
- **Keyboard navigation** — `j` / `k` to move between messages
- **Zero dependencies** — Node.js built-in modules only

## Options

```bash
# Custom port (default: 3333)
CCAKASHIC_PORT=3000 npx ccakashic
```

## Requirements

- Node.js >= 18

## License

MIT
