import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as readline from 'readline';

export const CLAUDE_DIR = path.join(os.homedir(), '.claude', 'projects');

export interface Project {
  name: string;
  rawName: string;
  dir: string;
  sessionCount: number;
  lastModified: Date;
}

export interface SessionPreview {
  id: string;
  path: string;
  cwd: string | null;
  timestamp: string | null;
  lastModified: number;
  preview: string;
  gitBranch: string | null;
  slug: string | null;
  customTitle: string | null;
  aiTitle: string | null;
  model: string | null;
  hasSubagents: boolean;
  totalTokens: number;
  outputTokens: number;
}

export interface CwdMatch {
  projectRawName: string;
  sessionId: string;
}

export interface RecentSession extends SessionPreview {
  projectRawName: string;
  projectName: string;
}

export function decodeDirName(dirName: string): string {
  // Directory names encode paths: /Users/foo/bar → -Users-foo-bar
  // This is lossy (dots become dashes too), but good enough for display
  if (dirName.startsWith('-')) {
    return '/' + dirName.slice(1).replace(/-/g, '/');
  }
  return dirName;
}

interface ProjectScan {
  rawName: string;
  dir: string;
  name: string;
  files: { file: string; mtimeMs: number }[];
}

// Stat every .jsonl in a project dir once. Tolerant of files/dirs disappearing
// mid-scan (a live `claude` process may be rotating them).
function statSessionFiles(projectDir: string): { file: string; mtimeMs: number }[] {
  let names: string[];
  try {
    names = fs.readdirSync(projectDir);
  } catch {
    return [];
  }
  const out: { file: string; mtimeMs: number }[] = [];
  for (const f of names) {
    if (!f.endsWith('.jsonl')) continue;
    try {
      out.push({ file: f, mtimeMs: fs.statSync(path.join(projectDir, f)).mtimeMs });
    } catch {
      // removed between readdir and stat
    }
  }
  return out;
}

// Single source of truth for walking ~/.claude/projects. Both listProjects and
// listRecentSessions build on this so the filesystem is walked/statted once.
async function scanProjects(): Promise<ProjectScan[]> {
  if (!fs.existsSync(CLAUDE_DIR)) return [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(CLAUDE_DIR, { withFileTypes: true });
  } catch {
    return [];
  }

  const scans: ProjectScan[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(CLAUDE_DIR, entry.name);
    const files = statSessionFiles(dir);
    if (files.length === 0) continue;

    // Prefer the real cwd recorded in the latest session over the lossy
    // directory-name decoding (dots and slashes both collapse to dashes).
    let name = decodeDirName(entry.name);
    const latest = files.reduce((a, b) => (b.mtimeMs > a.mtimeMs ? b : a));
    const cwd = await readCwdFromSession(path.join(dir, latest.file));
    if (cwd) name = cwd;

    scans.push({ rawName: entry.name, dir, name, files });
  }
  return scans;
}

export async function listProjects(): Promise<Project[]> {
  const scans = await scanProjects();
  const projects = scans.map((s) => ({
    name: s.name,
    rawName: s.rawName,
    dir: s.dir,
    sessionCount: s.files.length,
    lastModified: new Date(Math.max(...s.files.map((f) => f.mtimeMs))),
  }));
  projects.sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());
  return projects;
}

async function getSessionPreview(filePath: string): Promise<SessionPreview> {
  return new Promise((resolve) => {
    const result: SessionPreview = {
      id: path.basename(filePath, '.jsonl'),
      path: filePath,
      cwd: null,
      timestamp: null,
      lastModified: fs.statSync(filePath).mtimeMs,
      preview: '',
      gitBranch: null,
      slug: null,
      customTitle: null,
      aiTitle: null,
      model: null,
      hasSubagents: false,
      totalTokens: 0,
      outputTokens: 0,
    };

    const sessionDir = path.join(path.dirname(filePath), result.id);
    if (fs.existsSync(path.join(sessionDir, 'subagents'))) {
      result.hasSubagents = true;
    }

    const rl = readline.createInterface({
      input: fs.createReadStream(filePath, { encoding: 'utf-8' }),
      crlfDelay: Infinity,
    });

    let foundPreview = false;

    rl.on('line', (line) => {
      try {
        const obj = JSON.parse(line);

        if (!result.timestamp && obj.timestamp) {
          result.timestamp = obj.timestamp;
        }
        if (!result.cwd && obj.cwd) {
          result.cwd = obj.cwd;
        }
        if (!result.gitBranch && obj.gitBranch) {
          result.gitBranch = obj.gitBranch;
        }
        if (!result.slug && obj.slug) {
          result.slug = obj.slug;
        }

        // Title records can appear anywhere and be updated multiple times
        // (e.g. renaming repeatedly), so keep the last non-empty value.
        if (obj.type === 'custom-title' && obj.customTitle) {
          result.customTitle = obj.customTitle;
        }
        if (obj.type === 'ai-title' && obj.aiTitle) {
          result.aiTitle = obj.aiTitle;
        }

        if (!result.model && obj.type === 'assistant' && obj.message?.model) {
          result.model = obj.message.model;
        }

        if (obj.type === 'assistant' && obj.message?.usage) {
          const u = obj.message.usage;
          result.totalTokens += (u.input_tokens || 0) + (u.output_tokens || 0)
            + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
          result.outputTokens += u.output_tokens || 0;
        }

        if (!foundPreview && obj.type === 'user' && obj.message) {
          const content = obj.message.content;
          let text = '';
          if (typeof content === 'string') {
            text = content;
          } else if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === 'text' && block.text) {
                text = block.text;
                break;
              }
            }
          }
          if (text) {
            result.preview = text.replace(/\n/g, ' ').slice(0, 100);
            foundPreview = true;
          }
        }
      } catch {
        // skip malformed lines
      }
    });

    rl.on('close', () => resolve(result));
    rl.on('error', () => resolve(result));
  });
}

export async function listSessions(projectDir: string): Promise<SessionPreview[]> {
  const jsonlFiles = fs
    .readdirSync(projectDir)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => path.join(projectDir, f));

  const sessions = await Promise.all(jsonlFiles.map(getSessionPreview));
  sessions.sort((a, b) => b.lastModified - a.lastModified);
  return sessions;
}

export async function listRecentSessions(limit: number): Promise<RecentSession[]> {
  const scans = await scanProjects();
  const entries: { file: string; mtime: number; scan: ProjectScan }[] = [];
  for (const scan of scans) {
    for (const f of scan.files) {
      entries.push({ file: path.join(scan.dir, f.file), mtime: f.mtimeMs, scan });
    }
  }
  entries.sort((a, b) => b.mtime - a.mtime);
  const top = entries.slice(0, limit);
  const previews = await Promise.all(top.map((e) => getSessionPreview(e.file)));
  return previews.map((s, i) => ({
    ...s,
    projectRawName: top[i].scan.rawName,
    projectName: top[i].scan.name,
  }));
}

// Locate specific sessions by id. scanProjects only stats filenames, so this
// parses just the matched files — unlike listRecentSessions, which parses every
// file in its window (getSessionPreview reads a session end to end to total its
// tokens). Callers that know which ids they want should use this: a session can
// sit waiting for you while other projects churn past it, so it is not
// necessarily inside any "most recent N" window.
export async function findRecentSessionsByIds(ids: string[]): Promise<RecentSession[]> {
  const wanted = new Set(ids);
  if (!wanted.size) return [];
  const scans = await scanProjects();
  const hits: { file: string; scan: ProjectScan }[] = [];
  for (const scan of scans) {
    for (const f of scan.files) {
      if (wanted.has(f.file.replace(/\.jsonl$/, ''))) {
        hits.push({ file: path.join(scan.dir, f.file), scan });
      }
    }
  }
  const previews = await Promise.all(hits.map((h) => getSessionPreview(h.file)));
  return previews.map((s, i) => ({
    ...s,
    projectRawName: hits[i].scan.rawName,
    projectName: hits[i].scan.name,
  }));
}

export function readCwdFromSession(filePath: string): Promise<string | null> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: fs.createReadStream(filePath, { encoding: 'utf-8' }),
      crlfDelay: Infinity,
    });

    let found: string | null = null;
    rl.on('line', (line) => {
      if (found) return;
      try {
        const obj = JSON.parse(line);
        if (obj.cwd) {
          found = obj.cwd;
          rl.close();
        }
      } catch {
        // skip
      }
    });

    rl.on('close', () => resolve(found));
    rl.on('error', () => resolve(found));
  });
}

function latestSessionFile(projectDir: string): { file: string; mtimeMs: number } | null {
  const files = fs.readdirSync(projectDir).filter((f) => f.endsWith('.jsonl'));
  if (!files.length) return null;
  let best: string | null = null;
  let bestMtime = 0;
  for (const f of files) {
    const mtime = fs.statSync(path.join(projectDir, f)).mtimeMs;
    if (mtime > bestMtime) {
      bestMtime = mtime;
      best = f;
    }
  }
  return best ? { file: best, mtimeMs: bestMtime } : null;
}

export async function findSessionForCwd(cwd: string): Promise<CwdMatch | null> {
  // Pick the project whose cwd is the most specific (longest) match for the
  // given cwd. A brand-new session in a specific subdir should win over an
  // older, more-active ancestor project.
  const projects = await listProjects();
  let bestMatch: CwdMatch | null = null;
  let bestLen = -1;

  for (const project of projects) {
    const latest = latestSessionFile(project.dir);
    if (!latest) continue;
    const projectCwd = await readCwdFromSession(path.join(project.dir, latest.file));
    if (!projectCwd) continue;

    const isMatch = cwd === projectCwd || cwd.startsWith(projectCwd + path.sep);
    if (isMatch && projectCwd.length > bestLen) {
      bestMatch = {
        projectRawName: project.rawName,
        sessionId: path.basename(latest.file, '.jsonl'),
      };
      bestLen = projectCwd.length;
    }
  }

  return bestMatch;
}
