import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const CONFIG_DIR = path.join(os.homedir(), '.config', 'ccakashic');
const RESUME_MAP_FILE = path.join(CONFIG_DIR, 'resume-map.json');

function run(args: string[], timeoutMs = 5000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('cmux', args, { timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) {
        if (process.env.CCAKASHIC_DEBUG) console.error('[cmux]', args.join(' '), '->', err.message, stderr);
        reject(new Error((stderr || err.message).trim()));
      } else {
        resolve(stdout.trim());
      }
    });
  });
}

let cachedAvailable: { value: boolean; at: number } | null = null;

export async function isCmuxAvailable(): Promise<boolean> {
  // ping spawns a process; cache briefly so page renders stay cheap
  if (cachedAvailable && Date.now() - cachedAvailable.at < 10_000) {
    return cachedAvailable.value;
  }
  let value = false;
  try {
    value = (await run(['ping'], 1500)) === 'PONG';
  } catch {
    value = false;
  }
  cachedAvailable = { value, at: Date.now() };
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
    fs.writeFileSync(RESUME_MAP_FILE, JSON.stringify(map, null, 2));
  } catch {
    // best-effort: losing the map only means a duplicate workspace later
  }
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
