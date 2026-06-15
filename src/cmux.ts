import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const CONFIG_DIR = path.join(os.homedir(), '.config', 'ccakashic');
const RESUME_MAP_FILE = path.join(CONFIG_DIR, 'resume-map.json');

// Resolve the cmux binary. PATH alone is unreliable: `npx ccakashic` is often
// launched from a GUI terminal / login shell whose PATH omits Homebrew, so a
// bare execFile('cmux') fails with ENOENT and the whole integration silently
// disables (only the Copy button survives). Honor CCAKASHIC_CMUX, then fall
// back to PATH, then to the common install locations.
function resolveCmuxBin(): string {
  const candidates = [
    process.env.CCAKASHIC_CMUX,
    '/opt/homebrew/bin/cmux', // Apple Silicon Homebrew
    '/usr/local/bin/cmux',    // Intel Homebrew / manual installs
  ].filter(Boolean) as string[];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch {
      // ignore and try the next candidate
    }
  }
  return 'cmux'; // last resort: rely on PATH
}

const CMUX_BIN = resolveCmuxBin();

function run(args: string[], timeoutMs = 5000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(CMUX_BIN, args, { timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) {
        if (process.env.CCAKASHIC_DEBUG) console.error('[cmux]', args.join(' '), '->', err.message, stderr);
        reject(new Error((stderr || err.message).trim()));
      } else {
        resolve(stdout.trim());
      }
    });
  });
}

let everAvailable = false;
let cachedUnavailableAt = 0;

export async function isCmuxAvailable(): Promise<boolean> {
  // Sticky-positive: once cmux has answered, keep reporting available for the
  // life of the process. A long-running server can transiently lose contact
  // with cmux (Mac sleep/wake, cmux app restart) and `ping` then fails — but we
  // must NOT hide the Resume UI on such a blip. The buttons stay; if cmux is
  // genuinely unreachable at click time, /api/resume degrades to the copy
  // command. Negative results are cached only ~5s so first contact is quick.
  if (everAvailable) return true;
  if (cachedUnavailableAt && Date.now() - cachedUnavailableAt < 5_000) return false;
  let value = false;
  try {
    value = (await run(['ping'], 2500)) === 'PONG';
  } catch {
    value = false;
  }
  if (value) everAvailable = true;
  else cachedUnavailableAt = Date.now();
  return value;
}

export function shellQuote(s: string): string {
  return `'` + s.replace(/'/g, `'\\''`) + `'`;
}

export function buildResumeCommand(cwd: string, sessionId: string): string {
  return `cd ${shellQuote(cwd)} && claude --resume ${shellQuote(sessionId)}`;
}

export async function listWorkspaceIds(): Promise<Set<string>> {
  const out = await run(['--json', '--id-format', 'both', 'list-workspaces']);
  const data = JSON.parse(out);
  const ids = new Set<string>();
  for (const ws of data.workspaces || []) {
    if (ws.id) ids.add(String(ws.id).toUpperCase());
  }
  return ids;
}

let cachedWorkspaceIds: { value: Set<string>; at: number } | null = null;

// Cached variant for page renders: buildResumeContext runs on every request
// and only needs workspace liveness to pick the Resume vs Jump button label,
// which tolerates a few seconds of staleness. Avoids spawning a cmux
// subprocess on each navigation.
export async function listWorkspaceIdsCached(): Promise<Set<string>> {
  if (cachedWorkspaceIds && Date.now() - cachedWorkspaceIds.at < 5_000) {
    return cachedWorkspaceIds.value;
  }
  const value = await listWorkspaceIds();
  cachedWorkspaceIds = { value, at: Date.now() };
  return value;
}

export type WaitReason = 'permission' | 'input';

// Map of workspaceId → wait reason, derived from cmux's UNREAD notifications.
// cmux marks a notification read once you focus its workspace, so an unread
// "Claude is waiting" / "needs your permission" is a live "needs attention"
// signal that matches the desktop notification ring.
export function parseWaitingNotifications(data: any): Map<string, WaitReason> {
  const result = new Map<string, WaitReason>();
  if (!Array.isArray(data)) return result;
  for (const n of data) {
    if (!n || n.is_read || !n.workspace_id) continue;
    const body = String(n.body || '').toLowerCase();
    const reason: WaitReason = body.includes('permission') ? 'permission' : 'input';
    // permission outranks a plain input wait if both exist for one workspace
    const ws = String(n.workspace_id).toUpperCase();
    if (reason === 'permission' || !result.has(ws)) result.set(ws, reason);
  }
  return result;
}

export async function listWaitingWorkspaces(): Promise<Map<string, WaitReason>> {
  const out = await run(['--json', 'list-notifications']);
  return parseWaitingNotifications(JSON.parse(out));
}

let cachedWaiting: { value: Map<string, WaitReason>; at: number } | null = null;

export async function listWaitingWorkspacesCached(): Promise<Map<string, WaitReason>> {
  if (cachedWaiting && Date.now() - cachedWaiting.at < 5_000) return cachedWaiting.value;
  const value = await listWaitingWorkspaces();
  cachedWaiting = { value, at: Date.now() };
  return value;
}

export async function currentWorkspaceId(): Promise<string | null> {
  try {
    const out = await run(['--json', '--id-format', 'both', 'current-workspace']);
    const data = JSON.parse(out);
    return data.workspace_id ? String(data.workspace_id).toUpperCase() : null;
  } catch {
    return null;
  }
}

export async function selectWorkspace(id: string): Promise<void> {
  await run(['select-workspace', '--workspace', id]);
}

export interface ResumeResult {
  workspaceId: string;
}

export async function resumeInNewWorkspace(
  cwd: string,
  sessionId: string,
  title: string | null,
  background: boolean,
): Promise<ResumeResult> {
  const prev = background ? await currentWorkspaceId() : null;
  const out = await run(['new-workspace', '--command', buildResumeCommand(cwd, sessionId)]);
  const workspaceId = parseOkId(out);
  if (title) {
    try {
      await run(['rename-workspace', '--workspace', workspaceId, title]);
    } catch {
      // title is cosmetic; the workspace is already running
    }
  }
  // Foreground: jump to the new workspace (new-workspace doesn't reliably
  // focus it). Background: restore the workspace we were on.
  try {
    await selectWorkspace(prev || workspaceId);
  } catch {
    // focus is best-effort; the workspace is already running either way
  }
  return { workspaceId };
}

export function parseOkId(output: string): string {
  const match = output.match(/^OK\s+(\S+)/);
  if (!match) throw new Error(`Unexpected cmux output: ${output}`);
  return match[1].toUpperCase();
}

export async function openInCmuxBrowser(url: string): Promise<void> {
  await run(['browser', 'open', url]);
}

// --- sessionId → workspaceId mapping, so a second Resume click jumps to the
// --- already-open workspace instead of forking the session.

export function loadResumeMap(): Record<string, string> {
  try {
    const data = JSON.parse(fs.readFileSync(RESUME_MAP_FILE, 'utf-8'));
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

export function saveResumeMapEntry(sessionId: string, workspaceId: string): void {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    const map = loadResumeMap();
    map[sessionId] = workspaceId;
    // Atomic write: a crash mid-write would otherwise truncate the file, and
    // loadResumeMap swallows the parse error and returns {} — wiping every
    // mapping. Write to a temp file and rename (atomic on the same fs).
    const tmp = `${RESUME_MAP_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(map, null, 2));
    fs.renameSync(tmp, RESUME_MAP_FILE);
  } catch {
    // best-effort: losing the map only means a duplicate workspace later
  }
}

// Inverse of the resume map: workspaceId(upper) → sessionId. Only covers
// sessions ccakashic itself resumed (manually-opened ones aren't tracked).
export function loadWorkspaceToSession(): Map<string, string> {
  const inv = new Map<string, string>();
  for (const [sessionId, wsId] of Object.entries(loadResumeMap())) {
    inv.set(wsId.toUpperCase(), sessionId);
  }
  return inv;
}

export async function findLiveWorkspaceForSession(sessionId: string): Promise<string | null> {
  const mapped = loadResumeMap()[sessionId];
  if (!mapped) return null;
  try {
    const live = await listWorkspaceIds();
    return live.has(mapped.toUpperCase()) ? mapped.toUpperCase() : null;
  } catch {
    return null;
  }
}
