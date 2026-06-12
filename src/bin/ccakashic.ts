#!/usr/bin/env node
import * as http from 'http';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { exec } from 'child_process';
import { listProjects, listSessions, listRecentSessions, findSessionForCwd, readCwdFromSession } from '../discover';
import { parseSession, parseSessionCached, type SessionActivity } from '../parser';
import { generate } from '../html-generator';
import { generateIndex, generateSessionList } from '../pages';
import { generateDashboard, renderPaneBody, paneStatus, timeAgo, PANE_COUNTS, DEFAULT_PANE_COUNT, type WaitState } from '../dashboard';
import type { WaitReason } from '../cmux';
import type { ResumeContext } from '../resume-ui';
import {
  isCmuxAvailable,
  listWorkspaceIdsCached,
  listWaitingWorkspacesCached,
  loadWorkspaceToSession,
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
// pages we served know this token.
const RESUME_TOKEN = crypto.randomBytes(16).toString('hex');

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

// sessionId → wait reason, from cmux's unread notifications mapped through the
// resume map. Only covers ccakashic-resumed sessions; others fall back to the
// jsonl-derived activity below. Empty when cmux is unavailable/disabled.
async function buildCmuxWaitMap(): Promise<Map<string, WaitReason>> {
  const result = new Map<string, WaitReason>();
  if (NO_CMUX || !(await isCmuxAvailable())) return result;
  try {
    const waiting = await listWaitingWorkspacesCached();
    const wsToSession = loadWorkspaceToSession();
    for (const [wsId, reason] of waiting) {
      const sessionId = wsToSession.get(wsId);
      if (sessionId) result.set(sessionId, reason);
    }
  } catch {
    // notifications are an enrichment; jsonl activity still drives the badge
  }
  return result;
}

// Combine the cmux signal (authoritative reason: input vs permission) with the
// jsonl tail heuristic (universal, works for sessions cmux can't map).
function resolveWaiting(
  sessionId: string,
  activity: SessionActivity,
  cmuxWait: Map<string, WaitReason>,
): WaitState {
  const reason = cmuxWait.get(sessionId);
  if (reason) return reason;
  return activity === 'waiting' ? 'input' : null;
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

  // Already open via a previous resume → jump instead of forking.
  const liveWorkspace = await findLiveWorkspaceForSession(sessionId);
  if (liveWorkspace) {
    try {
      await selectWorkspace(liveWorkspace);
      return respond(200, { action: 'jumped', workspace: liveWorkspace });
    } catch {
      // workspace died between the check and the select; fall through
    }
  }

  const cwd = await readCwdFromSession(sessionPath);
  if (!cwd) return respond(200, { action: 'error', message: 'No cwd recorded in this session' });
  if (!fs.existsSync(cwd)) {
    return respond(200, { action: 'error', message: `Directory no longer exists: ${cwd}` });
  }

  if (NO_CMUX || !(await isCmuxAvailable())) {
    return respond(200, { action: 'unavailable', command: buildResumeCommand(cwd, sessionId) });
  }

  const sessions = await listSessions(project.dir);
  const preview = sessions.find((s) => s.id === sessionId);
  const title = preview?.customTitle || preview?.aiTitle || preview?.slug || sessionId.slice(0, 8);

  try {
    const result = await resumeInNewWorkspace(cwd, sessionId, title, mode === 'background');
    saveResumeMapEntry(sessionId, result.workspaceId);
    return respond(200, { action: 'resumed', workspace: result.workspaceId });
  } catch (err: any) {
    return respond(200, { action: 'error', message: `cmux error: ${err?.message || err}` });
  }
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

    if (pathname === '/' || pathname === '') {
      const requested = parseInt(url.searchParams.get('n') || '') || DEFAULT_PANE_COUNT;
      const paneCount = PANE_COUNTS.includes(requested) ? requested : DEFAULT_PANE_COUNT;
      const recent = await listRecentSessions(paneCount);
      const cmuxWait = await buildCmuxWaitMap();
      const panes = await Promise.all(recent.map(async (session) => {
        const parsed = await parseSessionCached(session.path, session.lastModified);
        return {
          session,
          bodyHtml: renderPaneBody(parsed),
          waiting: resolveWaiting(session.id, parsed.activity, cmuxWait),
        };
      }));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(generateDashboard(panes, paneCount, await buildResumeContext()));
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
      res.writeHead(200, { 'Content-Type': 'application/json' });
      // mtimeMs is sub-millisecond (nanosecond FS resolution) so distinct
      // appends get distinct values; `<=` means "nothing newer since last poll".
      // We still re-evaluate waiting state even when the body is unchanged,
      // since a cmux permission prompt doesn't append to the jsonl.
      if (mtime <= since) {
        const parsedUnchanged = await parseSessionCached(sessionPath, mtime);
        const waiting = resolveWaiting(sessionId, parsedUnchanged.activity, cmuxWait);
        res.end(JSON.stringify({ changed: false, status, ago, waiting }));
        return;
      }
      const parsed = await parseSessionCached(sessionPath, mtime);
      const waiting = resolveWaiting(sessionId, parsed.activity, cmuxWait);
      res.end(JSON.stringify({ changed: true, mtime, status, ago, waiting, html: renderPaneBody(parsed) }));
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

async function main() {
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
