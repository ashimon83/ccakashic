// Shared helpers used across the HTML generators and the server.

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
