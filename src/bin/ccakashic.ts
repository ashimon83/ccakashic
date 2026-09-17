#!/usr/bin/env node
import * as http from 'http';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as readline from 'readline';
import { exec } from 'child_process';
import { getOrCreateToken } from '../util';
import { listProjects, listSessions, listRecentSessions, findRecentSessionsByIds, findSessionForCwd, readCwdFromSession } from '../discover';
import { toSessionRow, orderSessionRows, parseSessionLimit } from '../api';
import { parseSession, parseSessionCached } from '../parser';
import { generate } from '../html-generator';
import { generateIndex, generateSessionList } from '../pages';
import { generateDashboard, renderPaneBody, paneStatus, timeAgo, PANE_COUNTS, DEFAULT_PANE_COUNT, type WaitState, type RestoreBanner } from '../dashboard';
import type { WaitReason } from '../cmux';
import { loadSnapshot, saveSnapshot, snapshotNow } from '../snapshot';
import { describeStopped, restoreAll, detectLastStop } from '../restore';
import { installAgent, uninstallAgent, refreshInstalledAgent } from '../agent';
import type { ResumeContext } from '../resume-ui';
import {
  isCmuxAvailable,
  listWorkspaceIdsCached,
  listWaitingWorkspacesCached,
  loadWorkspaceToSession,
  liveWorkspaceToSessionCached,
  loadResumeMap,
  saveResumeMapEntry,
  findLiveWorkspaceForSession,
  selectWorkspace,
  resumeInNewWorkspace,
  buildResumeCommand,
  openInCmuxBrowser,
} from '../cmux';
// Published at dist/bin/ccakashic.js, so ../../package.json resolves from dist/
import * as pkg from '../../package.json';

function openInBrowser(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'start'
    : 'xdg-open';
  exec(`${cmd} "${url}"`);
}

async function openUrl(url: string): Promise<void> {
  if (NO_OPEN) {
    console.log(`Not opening a browser (--no-open). URL: ${url}`);
    return;
  }
  if (!NO_CMUX && await isCmuxAvailable()) {
    try {
      await openInCmuxBrowser(url);
      console.log('Opened in cmux browser pane (use --no-cmux for a regular browser)');
      return;
    } catch {
      // cmux is up but the browser pane failed; use the regular browser
    }
  }
  openInBrowser(url);
}

const PORT = parseInt(process.env.CCAKASHIC_PORT || '') || 3333;
const MAX_PORT_TRIES = 20;
const LOCK_FILE = path.join(os.tmpdir(), `ccakashic-${os.userInfo().username || 'user'}.json`);
const NO_CMUX = process.argv.includes('--no-cmux') || !!process.env.CCAKASHIC_NO_CMUX;
const NO_OPEN = process.argv.includes('--no-open') || !!process.env.CCAKASHIC_NO_OPEN;

// CSRF guard for /api/resume: any webpage can POST to localhost, but only
// pages we served know this token. Persisted across restarts so open tabs keep
// working without a reload.
const RESUME_TOKEN = getOrCreateToken();

async function buildResumeContext(): Promise<ResumeContext | undefined> {
  if (NO_CMUX) return undefined;
  const cmuxAvailable = await isCmuxAvailable();
  const openSessionIds = new Set<string>();
  if (cmuxAvailable) {
    try {
      const live = await listWorkspaceIdsCached();
      const map = loadResumeMap();
      for (const [sessionId, wsId] of Object.entries(map)) {
        if (live.has(wsId.toUpperCase())) openSessionIds.add(sessionId);
      }
    } catch {
      // liveness markers are cosmetic; resume still works without them
    }
  }
  return { token: RESUME_TOKEN, cmuxAvailable, openSessionIds };
}

// sessionId → wait reason, from cmux's unread notifications resolved through
// two independent workspace→session sources. Empty when cmux is
// unavailable/disabled.
async function buildCmuxWaitMap(): Promise<Map<string, WaitReason>> {
  const result = new Map<string, WaitReason>();
  if (NO_CMUX || !(await isCmuxAvailable())) return result;
  try {
    const waiting = await listWaitingWorkspacesCached();
    // The resume map only covers sessions ccakashic resumed, which left every
    // hand-started session permanently unbadged. The live map reads
    // CMUX_WORKSPACE_ID from each running session's own process and covers
    // those. They complement each other — the resume map still resolves
    // sessions that have since exited — so the live one is layered on top,
    // winning conflicts because it reflects the process attached right now.
    const wsToSession = loadWorkspaceToSession();
    for (const [wsId, sessionId] of await liveWorkspaceToSessionCached()) {
      wsToSession.set(wsId, sessionId);
    }
    for (const [wsId, reason] of waiting) {
      const sessionId = wsToSession.get(wsId);
      if (sessionId) result.set(sessionId, reason);
    }
  } catch {
    // notifications are an enrichment; jsonl activity still drives the badge
  }
  return result;
}

// Waiting is driven solely by cmux's unread notifications: cmux clears them the
// moment you focus a workspace, so the dashboard badge self-clears when you open
// the tab — mirroring cmux exactly. (A jsonl "assistant ended its turn" signal
// was tried but flags nearly every finished session and never self-clears.)
function resolveWaiting(sessionId: string, cmuxWait: Map<string, WaitReason>): WaitState {
  return cmuxWait.get(sessionId) ?? null;
}

function readJsonBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 64 * 1024) {
        reject(new Error('Body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try { resolve(JSON.parse(data)); } catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

async function handleResume(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const respond = (status: number, body: object) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  if (req.method !== 'POST') return respond(405, { action: 'error', message: 'POST only' });
  if (req.headers['x-ccakashic-token'] !== RESUME_TOKEN) {
    return respond(403, { action: 'error', message: 'Invalid token' });
  }

  let body: any;
  try {
    body = await readJsonBody(req);
  } catch (err: any) {
    return respond(400, { action: 'error', message: err?.message || 'Bad request' });
  }
  const { project: rawName, session: sessionId, mode } = body || {};
  if (typeof rawName !== 'string' || typeof sessionId !== 'string') {
    return respond(400, { action: 'error', message: 'project and session are required' });
  }

  const projects = await listProjects();
  const project = projects.find((p) => p.rawName === rawName);
  const sessionPath = project ? path.join(project.dir, `${sessionId}.jsonl`) : null;
  if (!project || !sessionPath || !fs.existsSync(sessionPath)) {
    return respond(404, { action: 'error', message: 'Session not found' });
  }

  const cwd = await readCwdFromSession(sessionPath);
  if (!cwd) return respond(200, { action: 'error', message: 'No cwd recorded in this session' });
  if (!fs.existsSync(cwd)) {
    return respond(200, { action: 'error', message: `Directory no longer exists: ${cwd}` });
  }

  const command = buildResumeCommand(cwd, sessionId);
  if (NO_CMUX) {
    return respond(200, { action: 'unavailable', command });
  }

  // Any cmux call can fail if the long-running server has lost contact with the
  // current cmux instance (Mac sleep/wake, cmux restart). Rather than surface a
  // hard error or hide the button, fall back to handing back the copy command
  // with a hint to restart ccakashic if it persists.
  try {
    // Already open via a previous resume → jump instead of forking.
    const liveWorkspace = await findLiveWorkspaceForSession(sessionId);
    if (liveWorkspace) {
      await selectWorkspace(liveWorkspace);
      return respond(200, { action: 'jumped', workspace: liveWorkspace });
    }

    const sessions = await listSessions(project.dir);
    const preview = sessions.find((s) => s.id === sessionId);
    const title = preview?.customTitle || preview?.aiTitle || preview?.slug || sessionId.slice(0, 8);

    const result = await resumeInNewWorkspace(cwd, sessionId, title, mode === 'background');
    saveResumeMapEntry(sessionId, result.workspaceId);
    return respond(200, { action: 'resumed', workspace: result.workspaceId });
  } catch (err: any) {
    if (process.env.CCAKASHIC_DEBUG) console.error('[resume] cmux failed:', err?.message || err);
    return respond(200, {
      action: 'unavailable',
      command,
      message: 'cmux unreachable — copied the command instead. If this persists, restart ccakashic.',
    });
  }
}

// The stopped group the dashboard offers to bring back, unless dismissed.
async function buildRestoreBanner(): Promise<RestoreBanner | undefined> {
  try {
    const { state, stop } = detectLastStop();
    if (!stop || !stop.sessions.length || stop.stoppedAt === state.dismissedStopAt) return undefined;
    const cmuxAvailable = !NO_CMUX && await isCmuxAvailable();
    return {
      token: RESUME_TOKEN,
      stoppedAt: stop.stoppedAt,
      estimated: !!stop.estimated,
      cmuxAvailable,
      items: await describeStopped(stop.sessions),
    };
  } catch {
    return undefined; // the banner is an extra; never break the dashboard over it
  }
}

async function handleRestore(req: http.IncomingMessage, res: http.ServerResponse, action: 'run' | 'dismiss'): Promise<void> {
  const respond = (status: number, body: object) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (req.method !== 'POST') return respond(405, { error: 'POST only' });
  if (req.headers['x-ccakashic-token'] !== RESUME_TOKEN) return respond(403, { error: 'Invalid token' });
  let body: any;
  try {
    body = await readJsonBody(req);
  } catch (err: any) {
    return respond(400, { error: err?.message || 'Bad request' });
  }

  // Recompute rather than trust the page: sessions may have been resumed in the
  // meantime, and resuming a live one again would fork it.
  const { state, stop } = detectLastStop();
  if (!stop || stop.stoppedAt !== body?.stoppedAt) {
    return respond(409, { error: 'The list is out of date — reload the dashboard' });
  }

  if (action === 'dismiss') {
    saveSnapshot({ ...state, dismissedStopAt: stop.stoppedAt });
    return respond(200, { ok: true });
  }

  if (NO_CMUX || !(await isCmuxAvailable())) return respond(503, { error: 'cmux is not reachable' });
  const wanted = Array.isArray(body.sessions) ? new Set(body.sessions) : null;
  const chosen = stop.sessions.filter((s) => !wanted || wanted.has(s.sessionId));
  const outcomes = await restoreAll(await describeStopped(chosen));
  return respond(200, { outcomes });
}

// Only accept loopback Host headers. The server binds 127.0.0.1, but without
// this check a malicious site could DNS-rebind its hostname to 127.0.0.1 and
// become same-origin, defeating the resume token and reading session content.
function isAllowedHost(host: string | undefined): boolean {
  if (!host) return false;
  const hostname = host.replace(/:\d+$/, '').toLowerCase();
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]' || hostname === '::1';
}

const server = http.createServer(async (req, res) => {
  try {
    if (!isAllowedHost(req.headers.host)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Forbidden: invalid Host header');
      return;
    }

    const url = new URL(req.url || '/', `http://localhost`);
    const pathname = url.pathname;

    if (pathname === '/__ccakashic') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ name: 'ccakashic', version: pkg.version }));
      return;
    }

    if (pathname === '/api/resume') {
      await handleResume(req, res);
      return;
    }

    if (pathname === '/api/restore' || pathname === '/api/restore/dismiss') {
      await handleRestore(req, res, pathname === '/api/restore' ? 'run' : 'dismiss');
      return;
    }

    if (pathname === '/' || pathname === '') {
      const requested = parseInt(url.searchParams.get('n') || '') || DEFAULT_PANE_COUNT;
      const paneCount = PANE_COUNTS.includes(requested) ? requested : DEFAULT_PANE_COUNT;
      const recent = await listRecentSessions(paneCount);
      const cmuxWait = await buildCmuxWaitMap();
      const panes = await Promise.all(recent.map(async (session) => ({
        session,
        bodyHtml: renderPaneBody(await parseSessionCached(session.path, session.lastModified)),
        waiting: resolveWaiting(session.id, cmuxWait),
      })));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(generateDashboard(panes, paneCount, await buildResumeContext(), await buildRestoreBanner()));
      return;
    }

    if (pathname === '/projects') {
      const projects = await listProjects();
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(generateIndex(projects));
      return;
    }

    if (pathname === '/api/pane') {
      const rawName = url.searchParams.get('project') || '';
      const sessionId = url.searchParams.get('session') || '';
      const since = parseFloat(url.searchParams.get('since') || '0');
      const projects = await listProjects();
      const project = projects.find((p) => p.rawName === rawName);
      const sessionPath = project ? path.join(project.dir, `${sessionId}.jsonl`) : null;
      if (!project || !sessionPath || !fs.existsSync(sessionPath)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Session not found' }));
        return;
      }
      const mtime = fs.statSync(sessionPath).mtimeMs;
      const status = paneStatus(mtime);
      const ago = timeAgo(mtime);
      const cmuxWait = await buildCmuxWaitMap();
      const waiting = resolveWaiting(sessionId, cmuxWait);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      // mtimeMs is sub-millisecond (nanosecond FS resolution) so distinct
      // appends get distinct values; `<=` means "nothing newer since last poll".
      // Waiting still re-evaluates here (cmux notifications change without the
      // jsonl growing) so the badge clears on the next poll after you open a tab.
      if (mtime <= since) {
        res.end(JSON.stringify({ changed: false, status, ago, waiting }));
        return;
      }
      const parsed = await parseSessionCached(sessionPath, mtime);
      res.end(JSON.stringify({ changed: true, mtime, status, ago, waiting, html: renderPaneBody(parsed) }));
      return;
    }

    // Read-only feed of the dashboard's own view, for other local tools.
    if (pathname === '/api/sessions') {
      const limit = parseSessionLimit(url.searchParams.get('limit'));
      const waitingOnly = url.searchParams.get('waiting') === '1';
      const cmuxWait = await buildCmuxWaitMap();
      // Waiting sessions are fetched by id rather than filtered out of the
      // recent window: a session can sit waiting while other projects churn
      // past it, and reading a wide window means parsing every file in it.
      const sessions = waitingOnly
        ? await findRecentSessionsByIds([...cmuxWait.keys()])
        : await listRecentSessions(limit);
      const rows = orderSessionRows(
        sessions
          .map((s) => toSessionRow(s, resolveWaiting(s.id, cmuxWait)))
          .filter((r) => !waitingOnly || r.waiting !== null),
        limit,
      );
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(rows));
      return;
    }

    const projectMatch = pathname.match(/^\/project\/(.+)$/);
    if (projectMatch && !pathname.includes('/session/')) {
      const rawName = decodeURIComponent(projectMatch[1]);
      const projects = await listProjects();
      const project = projects.find((p) => p.rawName === rawName);
      if (!project) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Project not found');
        return;
      }
      const sessions = await listSessions(project.dir);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(generateSessionList(project, sessions, await buildResumeContext()));
      return;
    }

    const sessionMatch = pathname.match(/^\/project\/(.+)\/session\/(.+)$/);
    if (sessionMatch) {
      const rawName = decodeURIComponent(sessionMatch[1]);
      const sessionId = decodeURIComponent(sessionMatch[2]);
      const projects = await listProjects();
      const project = projects.find((p) => p.rawName === rawName);
      if (!project) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Project not found');
        return;
      }
      const sessionPath = path.join(project.dir, `${sessionId}.jsonl`);
      if (!fs.existsSync(sessionPath)) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Session not found');
        return;
      }
      const sessions = await listSessions(project.dir);
      const session = sessions.find((s) => s.id === sessionId) || { id: sessionId, path: sessionPath };
      const parsed = await parseSession(sessionPath);
      const html = generate(parsed, {
        projectName: project.name,
        projectRawName: rawName,
        session,
        backUrl: `/project/${encodeURIComponent(rawName)}`,
        resume: await buildResumeContext(),
      });
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  } catch (err) {
    console.error(err);
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Internal server error');
  }
});

async function buildOpenUrl(baseUrl: string): Promise<string> {
  try {
    const match = await findSessionForCwd(process.cwd());
    if (match) {
      console.log(`Detected session for ${process.cwd()} → opening at bottom`);
      return `${baseUrl}/project/${encodeURIComponent(match.projectRawName)}/session/${encodeURIComponent(match.sessionId)}#session-bottom`;
    }
  } catch (err: any) {
    console.error('Failed to auto-detect session:', err?.message);
  }
  return baseUrl;
}

function probeCcakashic(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: '/__ccakashic',
      method: 'GET',
      timeout: 500,
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve(parsed && parsed.name === 'ccakashic');
        } catch {
          resolve(false);
        }
      });
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
}

function readLockPort(): number | null {
  try {
    const data = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf-8'));
    return typeof data.port === 'number' ? data.port : null;
  } catch {
    return null;
  }
}

function writeLockFile(port: number): void {
  try {
    fs.writeFileSync(LOCK_FILE, JSON.stringify({ port, pid: process.pid, startedAt: Date.now() }));
  } catch {
    // best-effort
  }
}

function cleanupLockFile(): void {
  try { fs.unlinkSync(LOCK_FILE); } catch {}
}

function listenOnPort(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => { server.off('listening', onListening); reject(err); };
    const onListening = () => { server.off('error', onError); resolve(); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });
}

async function findExistingCcakashic(startPort: number): Promise<number | null> {
  const lockPort = readLockPort();
  if (lockPort && await probeCcakashic(lockPort)) return lockPort;
  if (startPort !== lockPort && await probeCcakashic(startPort)) return startPort;
  return null;
}

async function startServer(startPort: number): Promise<number> {
  for (let i = 0; i < MAX_PORT_TRIES; i++) {
    const port = startPort + i;
    try {
      await listenOnPort(port);
      return port;
    } catch (err: any) {
      if (err?.code !== 'EADDRINUSE') throw err;
      if (await probeCcakashic(port)) return -port;
    }
  }
  throw new Error(`No available port after ${MAX_PORT_TRIES} tries starting at ${startPort}`);
}

function formatClock(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function askYesNo(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer: string) => {
      rl.close();
      resolve(/^(y|yes|)$/i.test(answer.trim()));
    });
  });
}

async function runRestoreCommand(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const yes = process.argv.includes('--yes') || process.argv.includes('-y');
  const previousRun = loadSnapshot().lastRunAt;
  const { stop, agentInstalled } = detectLastStop();

  if (stop?.estimated) {
    console.log('Note: estimated from conversation logs. Sessions left idle before cmux was force-quit may be missing.');
    console.log(agentInstalled
      ? '      (these closed before the snapshot agent started recording)\n'
      : '      Run `npx ccakashic install-agent` to record live sessions every minute for an exact list.\n');
  } else if (!agentInstalled) {
    console.log('Tip: `npx ccakashic install-agent` records open sessions every minute for an exact list.\n');
  } else if (previousRun && Date.now() - previousRun > 5 * 60_000) {
    console.log(`Note: the last snapshot before this one was at ${formatClock(previousRun)}.\n`);
  }

  if (!stop || !stop.sessions.length) {
    console.log('Nothing to reopen: no closed sessions found (or some from that time are still running).');
    return;
  }
  const items = await describeStopped(stop.sessions);
  console.log(`${items.length} session(s) you had open until ${formatClock(stop.stoppedAt)}${stop.estimated ? ' (estimated)' : ''}:\n`);
  for (const it of items) console.log(`  • ${it.title}\n    ${it.cwd}`);
  console.log('');
  if (dryRun) return;

  if (NO_CMUX || !(await isCmuxAvailable())) {
    console.log('cmux is not reachable (run this from a terminal inside cmux). Commands to resume by hand:\n');
    for (const it of items) console.log(buildResumeCommand(it.cwd, it.sessionId));
    return;
  }
  if (!yes && !(await askYesNo(`Reopen all ${items.length} in new cmux workspaces? [Y/n] `))) return;

  const outcomes = await restoreAll(items, (o) => {
    console.log(o.ok ? `  ✓ ${o.title}` : `  ✗ ${o.title} — ${o.message}`);
  });
  const failed = outcomes.filter((o) => !o.ok).length;
  console.log(`\nReopened ${outcomes.length - failed} / ${outcomes.length}.`);
}

async function runSubcommand(name: string): Promise<boolean> {
  switch (name) {
    case 'snapshot': {
      // One-off record; the launchd agent runs its own copy of the same code.
      snapshotNow();
      return true;
    }
    case 'restore':
      await runRestoreCommand();
      return true;
    case 'install-agent':
      await installAgent();
      return true;
    case 'uninstall-agent':
      await uninstallAgent();
      return true;
    default:
      return false;
  }
}

async function main() {
  refreshInstalledAgent();
  const sub = process.argv[2];
  if (sub && !sub.startsWith('-')) {
    if (await runSubcommand(sub)) return;
    console.error(`Unknown command: ${sub}\nUsage: ccakashic [restore [--dry-run] [--yes] | install-agent | uninstall-agent | snapshot]`);
    process.exit(1);
  }

  const existing = await findExistingCcakashic(PORT);
  if (existing) {
    const url = `http://127.0.0.1:${existing}`;
    console.log(`Reusing existing ccakashic at ${url}`);
    writeLockFile(existing);
    await openUrl(await buildOpenUrl(url));
    return;
  }

  const result = await startServer(PORT);
  if (result < 0) {
    const port = -result;
    const url = `http://127.0.0.1:${port}`;
    console.log(`Reusing existing ccakashic at ${url}`);
    writeLockFile(port);
    await openUrl(await buildOpenUrl(url));
    return;
  }

  const port = result;
  const url = `http://127.0.0.1:${port}`;
  console.log(`ccakashic running at ${url}`);
  console.log('Press Ctrl+C to stop');
  writeLockFile(port);

  const cleanup = () => { cleanupLockFile(); process.exit(0); };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
  process.on('exit', cleanupLockFile);

  await openUrl(await buildOpenUrl(url));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
