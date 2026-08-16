<p align="center">
  <img src="https://raw.githubusercontent.com/ashimon83/ccakashic/main/assets/logo.png" alt="ccakashic logo" width="160" />
</p>

# ccakashic

An Akashic Record of your Claude Code sessions — a cross-project **dashboard** for your `~/.claude/projects/` logs, rendered as beautiful HTML in your browser. See every recent session side by side, spot at a glance which ones are waiting for your input, and **resume any of them in one click** straight into a [cmux](https://github.com/manaflow-ai/cmux) workspace.

![Cross-project dashboard: recent sessions side by side with live status dots, a waiting-for-you badge, and one-click Resume / Jump](https://raw.githubusercontent.com/ashimon83/ccakashic/main/docs/dashboard.png)

![Session detail with stats, cost badges, and a chat-style layout](https://raw.githubusercontent.com/ashimon83/ccakashic/main/docs/screenshot1.png)

![Expanded tool calls with red/green diffs and per-message cost](https://raw.githubusercontent.com/ashimon83/ccakashic/main/docs/screenshot2.png)

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

- **Dashboard** — The top page shows your 4/6/8 most recently active sessions across all projects side by side, each pane an independently scrollable thread of the last 24h, with live status dots (🟢 active / 🟡 recent / ⚪ idle) refreshed by polling
- **Waiting-for-you indicator** — Sessions cmux is notifying you about (an **unread** "Claude is waiting for your input" / "needs your permission") get an orange frame and a `⏳ Your turn` / `🔐 Permission` badge. cmux marks the notification read the moment you focus that workspace, so the highlight **self-clears** on the next poll once you open the tab — it mirrors cmux's own badge exactly. The browser tab title shows the count (`(2) ccakashic`) and the favicon turns orange, so a glance at the tab tells you how many sessions need you. (Requires cmux; covers sessions resumed through ccakashic, which are tracked in the resume map.)
- **Fully browser-based** — Dashboard → Project list → Session list → Conversation detail
- **Chat-style layout** — User / assistant messages in chat bubbles
- **Show only the conversation** — A `Show` row in the session header toggles each kind of noise off: `Tools`, `Injected`, `Thinking`, `Shell`, `System`, `Cost`. `Chat only` strips a session down to what was asked and answered; the choice is remembered across sessions
- **Real prompts vs. injected text** — A `user` record in the log is not necessarily something you typed: hook feedback, skill bodies, task notifications and compaction summaries are all fed to the model in the user role. Those are labelled (`HOOK FEEDBACK`, `SKILL`, `TASK NOTIFICATION`, …) and collapsed into their own row instead of sharing your chat bubble
- **Jump between your own prompts** — A pager in the corner (`▲ 11 / 31 ▼`, or `p` / `n`) moves through the prompts you actually typed and tracks where you are as you scroll
- **Sticky session header** — Title, branch, model, Resume buttons and the filters stay on screen, condensing to a thin strip as you scroll
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
- **Keyboard navigation** — `j` / `k` to move between messages, `p` / `n` to move between your own prompts
- **One-click resume in cmux** — `▶ Resume` spawns a [cmux](https://github.com/manaflow-ai/cmux) workspace that runs `cd <session cwd> && claude --resume <id>`; `📋 Copy` copies the same command for any terminal
- **Read-only JSON feed** — `GET /api/sessions?limit=40&waiting=1` returns what the dashboard shows (title, project, branch, model, `status`, `waiting`, `detailUrl`, `resumeCommand`) so other local tools can reuse the waiting signal. `waiting=1` returns only the sessions asking for you, and is the cheap path — it looks those up by id instead of parsing a whole window of session files
- **Zero dependencies** — Node.js built-in modules only

## cmux integration

When the [cmux](https://github.com/manaflow-ai/cmux) terminal is detected (`cmux ping` succeeds), ccakashic becomes a session dashboard:

- The UI opens in a cmux browser pane instead of your default browser
- Every session with a recorded `cwd` gets a `▶ Resume` button: one click creates a new cmux workspace, `cd`s into the session's directory, and runs `claude --resume <session-id>` — the workspace is renamed to the session title
- Resuming the same session again jumps to the already-open workspace instead of forking the conversation (the button turns into `↪ Jump`)
- Alt-click `▶ Resume` to open the workspace in the background and stay on the list
- Sessions that look active (modified in the last 2 minutes) ask for a second click before resuming, since resuming a live session forks it
- Without cmux, the `📋 Copy` button still gives you a ready-to-paste `cd … && claude --resume …` command

Notes:

- The resume CSRF token is persisted to `~/.config/ccakashic/token` (mode 600), so restarting the server doesn't break the buttons on already-open tabs
- cmux's socket only accepts callers inside the cmux process tree, so run `npx ccakashic` from a terminal **inside cmux** (or configure a socket password in cmux settings and export `CMUX_SOCKET_PASSWORD`)
- The `cmux` binary is found via `$PATH`, then the common Homebrew locations. If it lives elsewhere, point `CCAKASHIC_CMUX` at it (e.g. `CCAKASHIC_CMUX=/path/to/cmux npx ccakashic`)
- Disable the integration with `--no-cmux` or `CCAKASHIC_NO_CMUX=1`

## Options

```bash
# Custom port (default: 3333)
CCAKASHIC_PORT=3000 npx ccakashic

# Skip cmux detection (regular browser, no resume buttons)
npx ccakashic --no-cmux

# Start the server without opening a browser
npx ccakashic --no-open
```

## Requirements

- Node.js >= 18

## License

MIT
