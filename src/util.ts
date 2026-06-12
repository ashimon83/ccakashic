// Shared helpers used across the HTML generators and the server.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';

const CONFIG_DIR = path.join(os.homedir(), '.config', 'ccakashic');
const TOKEN_FILE = path.join(CONFIG_DIR, 'token');

// The /api/resume CSRF token, persisted so it survives a server restart and the
// buttons on already-open tabs keep working without a reload. Falls back to an
// in-memory token if the file can't be read/written. DNS rebinding is already
// blocked by the Host-header check, so this token is defense-in-depth.
export function getOrCreateToken(): string {
  try {
    const existing = fs.readFileSync(TOKEN_FILE, 'utf-8').trim();
    if (/^[a-f0-9]{32,}$/.test(existing)) return existing;
  } catch {
    // not created yet
  }
  const token = crypto.randomBytes(16).toString('hex');
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(TOKEN_FILE, token, { mode: 0o600 });
  } catch {
    // fall back to an ephemeral token (rotates on restart)
  }
  return token;
}

export function escapeHtml(str: unknown): string {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// A session whose file was touched within this window is treated as still
// attached to a live `claude` process. Shared so the dashboard status dot and
// the resume fork-confirmation use the exact same definition of "active".
export const ACTIVE_THRESHOLD_MS = 2 * 60_000;
