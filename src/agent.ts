import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { SNAPSHOT_FILE } from './snapshot';

// launchd agent that records live sessions every minute. It has to live
// outside both cmux and the ccakashic server: a hung cmux takes the server
// (usually started inside it) down with it, and the whole point is to have
// recorded what was running before that happened.
//
// ccakashic is mostly run through npx, whose cache directory npm may clear or
// replace on any version bump. Pointing launchd at it would make the agent stop
// silently — noticed only after the next crash. So the agent runs its own copy
// of the compiled snapshot module (Node built-ins only) under ~/.config.

export const AGENT_LABEL = 'com.ccakashic.snapshot';
export const AGENT_PLIST = path.join(os.homedir(), 'Library', 'LaunchAgents', `${AGENT_LABEL}.plist`);
const CONFIG_DIR = path.join(os.homedir(), '.config', 'ccakashic');
const LOG_FILE = path.join(CONFIG_DIR, 'snapshot.log');
export const AGENT_DIR = path.join(CONFIG_DIR, 'agent');
const AGENT_MODULE = path.join(AGENT_DIR, 'snapshot.js');
const AGENT_RUNNER = path.join(AGENT_DIR, 'run.js');
const RUNNER_SOURCE = `// Written by \`ccakashic install-agent\`; run by launchd every minute.
require('./snapshot.js').snapshotNow();
`;
const INTERVAL_SEC = 60;

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function buildPlist(nodePath: string, runnerPath: string): string {
  const args = [nodePath, runnerPath].map((a) => `    <string>${xmlEscape(a)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>StartInterval</key>
  <integer>${INTERVAL_SEC}</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(LOG_FILE)}</string>
</dict>
</plist>
`;
}

function launchctl(args: string[]): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    execFile('launchctl', args, { timeout: 10_000 }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: `${stdout}${stderr}`.trim() });
    });
  });
}

// process.execPath is often version-pinned (e.g. ~/.volta/tools/image/node/24.x
// or an nvm version dir) and vanishes on the next upgrade, silently stopping the
// agent. A `node` elsewhere on PATH is usually a stable shim or symlink
// (~/.volta/bin, /opt/homebrew/bin). Version managers put the pinned dir itself
// first on PATH while running node, so that one is skipped.
function stableNodePath(): string {
  const pinnedDir = path.dirname(process.execPath);
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir || path.resolve(dir) === pinnedDir) continue;
    const candidate = path.join(dir, 'node');
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // not here
    }
  }
  return process.execPath;
}

const domain = () => `gui/${process.getuid ? process.getuid() : 501}`;

// The compiled snapshot module that shipped with this ccakashic.
const bundledModule = () => path.join(__dirname, 'snapshot.js');

// Write the agent's copy; returns true when anything changed. Atomic per file
// so a tick firing mid-update never loads a truncated module.
function writeAgentFiles(): boolean {
  let changed = false;
  fs.mkdirSync(AGENT_DIR, { recursive: true });
  for (const [dest, content] of [
    [AGENT_MODULE, fs.readFileSync(bundledModule(), 'utf-8')],
    [AGENT_RUNNER, RUNNER_SOURCE],
  ] as const) {
    try {
      if (fs.readFileSync(dest, 'utf-8') === content) continue;
    } catch {
      // not written yet
    }
    const tmp = `${dest}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, content);
    fs.renameSync(tmp, dest);
    changed = true;
  }
  return changed;
}

// Keep an installed agent's copy in step with the ccakashic being run, so a
// newer version's snapshot format reaches the agent without a reinstall. The
// plist points at a fixed path, so launchd needs no reload.
export function refreshInstalledAgent(): void {
  if (!fs.existsSync(AGENT_PLIST)) return;
  try {
    writeAgentFiles();
  } catch {
    // the previous copy keeps running
  }
}

export async function installAgent(): Promise<void> {
  if (process.platform !== 'darwin') {
    throw new Error('The snapshot agent uses launchd and is macOS-only. Run `ccakashic snapshot` from cron instead.');
  }
  writeAgentFiles();
  fs.mkdirSync(path.dirname(AGENT_PLIST), { recursive: true });
  const nodePath = stableNodePath();
  fs.writeFileSync(AGENT_PLIST, buildPlist(nodePath, AGENT_RUNNER));

  // Re-install cleanly: bootout fails harmlessly when not loaded yet.
  await launchctl(['bootout', `${domain()}/${AGENT_LABEL}`]);
  const res = await launchctl(['bootstrap', domain(), AGENT_PLIST]);
  if (!res.ok) throw new Error(`launchctl bootstrap failed: ${res.out}`);

  console.log(`Installed ${AGENT_PLIST} (node: ${nodePath})`);
  console.log(`Recording live sessions every ${INTERVAL_SEC}s → ${SNAPSHOT_FILE}`);
  console.log(`(runs its own copy in ${AGENT_DIR}, so clearing the npx cache won't stop it)`);
}

export async function uninstallAgent(): Promise<void> {
  await launchctl(['bootout', `${domain()}/${AGENT_LABEL}`]);
  fs.rmSync(AGENT_DIR, { recursive: true, force: true });
  try {
    fs.unlinkSync(AGENT_PLIST);
    console.log(`Removed ${AGENT_PLIST}`);
  } catch {
    console.log('Agent was not installed');
  }
}
