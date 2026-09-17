import { getCSS, getAppJS } from './template-assets';
import { renderMessage } from './html-generator';
import type { ParsedSession } from './parser';
import type { RecentSession } from './discover';
import { resumeButtonsHtml, resumeCSS, resumeJS, type ResumeContext } from './resume-ui';
import { escapeHtml, ACTIVE_THRESHOLD_MS } from './util';
import { buildResumeCommand } from './cmux';
import type { RestoreItem } from './restore';

// Multi-pane dashboard: the N most recently active sessions across all
// projects, each pane showing the last 24h of conversation as a scrollable
// thread, refreshed by polling /api/pane.

export const PANE_COUNTS = [4, 6, 8];
export const DEFAULT_PANE_COUNT = 4;

const DAY_MS = 24 * 60 * 60 * 1000;
// Keep panes light: a busy session can have thousands of messages in 24h.
const MAX_PANE_MESSAGES = 150;

export function timeAgo(mtime: number): string {
  const diff = Date.now() - mtime;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < DAY_MS) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / DAY_MS)}d ago`;
}

export function paneStatus(mtime: number): 'active' | 'recent' | 'idle' {
  const diff = Date.now() - mtime;
  if (diff < ACTIVE_THRESHOLD_MS) return 'active';
  if (diff < 30 * 60_000) return 'recent';
  return 'idle';
}

export function renderPaneBody(parsed: ParsedSession): string {
  const cutoff = Date.now() - DAY_MS;
  // Exclude only messages we can positively place before the cutoff. Messages
  // with a missing or unparseable timestamp (some tool/meta records) are kept
  // rather than silently dropped — they interleave with timestamped ones and
  // are usually part of the recent tail.
  let messages = parsed.messages.filter((m: any) => {
    const t = m.timestamp ? new Date(m.timestamp).getTime() : NaN;
    return isNaN(t) || t >= cutoff;
  });
  let note = '';
  if (messages.length === 0) {
    // Nothing in the last 24h: show the tail so the pane isn't empty.
    messages = parsed.messages.slice(-6);
    note = '<div class="dash-pane-note">No activity in the last 24h — showing latest messages</div>';
  } else if (messages.length > MAX_PANE_MESSAGES) {
    note = `<div class="dash-pane-note">Showing last ${MAX_PANE_MESSAGES} of ${messages.length} messages from 24h</div>`;
    messages = messages.slice(-MAX_PANE_MESSAGES);
  }
  return note + messages.map(renderMessage).join('\n');
}

export function paneTitle(s: RecentSession): string {
  return s.customTitle || s.aiTitle || s.slug || s.id.slice(0, 8);
}

export type WaitState = 'input' | 'permission' | null;

export interface DashboardPane {
  session: RecentSession;
  bodyHtml: string;
  waiting: WaitState;
}

export function waitBadgeHtml(waiting: WaitState): string {
  if (!waiting) return '';
  const label = waiting === 'permission' ? '\u{1F510} Permission' : '⏳ Your turn';
  return `<span class="dash-wait-badge dash-wait-${waiting}">${label}</span>`;
}

// The sessions you last had open, offered for reopening (see restore.ts).
export interface RestoreBanner {
  token: string;
  stoppedAt: number;
  estimated: boolean;
  cmuxAvailable: boolean;
  items: RestoreItem[];
}

export function restoreBannerHtml(banner: RestoreBanner | undefined): string {
  if (!banner || !banner.items.length) return '';
  const n = banner.items.length;
  const rows = banner.items.map((it) => {
    const title = it.projectRawName
      ? `<a href="/project/${encodeURIComponent(it.projectRawName)}/session/${encodeURIComponent(it.sessionId)}">${escapeHtml(it.title)}</a>`
      : escapeHtml(it.title);
    return `<li><label><input type="checkbox" class="dash-restore-check" value="${escapeHtml(it.sessionId)}" data-cmd="${escapeHtml(buildResumeCommand(it.cwd, it.sessionId))}" checked> ${title}</label> <span class="dash-restore-cwd">${escapeHtml(it.cwd)}</span></li>`;
  }).join('');
  const action = banner.cmuxAvailable
    ? `<button type="button" class="dash-restore-run">&#9654; Reopen selected</button>`
    : `<button type="button" class="dash-restore-copy">&#128203; Copy commands</button>`;
  return `<div class="dash-restore" data-stopped-at="${banner.stoppedAt}" data-token="${escapeHtml(banner.token)}">
  <div class="dash-restore-head">
    <span>&#8634; <b>${n} session${n === 1 ? '' : 's'}</b> you had open until <span class="dash-restore-at" data-ts="${banner.stoppedAt}"></span>${banner.estimated ? ' <span class="dash-restore-est" title="Estimated from conversation logs; sessions left idle before cmux was force-quit may be missing. Run `npx ccakashic install-agent` for an exact list.">(estimated)</span>' : ''}</span>
    ${action}
    <button type="button" class="dash-restore-dismiss">Dismiss</button>
    <span class="dash-restore-status"></span>
  </div>
  <ul class="dash-restore-list">${rows}</ul>
</div>`;
}

export function generateDashboard(
  panes: DashboardPane[],
  paneCount: number,
  resume: ResumeContext | undefined,
  restore?: RestoreBanner,
): string {
  const cols = paneCount <= 4 ? Math.max(panes.length, 1) : Math.ceil(paneCount / 2);
  const rows = paneCount <= 4 ? 1 : 2;

  const panesHtml = panes.map(({ session: s, bodyHtml, waiting }) => {
    const status = paneStatus(s.lastModified);
    const detailUrl = `/project/${encodeURIComponent(s.projectRawName)}/session/${encodeURIComponent(s.id)}`;
    const projectLabel = s.projectName.split('/').pop() || s.projectName;
    const branch = s.gitBranch && s.gitBranch !== 'HEAD' ? `<span class="dash-meta-item">${escapeHtml(s.gitBranch)}</span>` : '';
    return `<div class="dash-pane${waiting ? ' dash-pane-waiting' : ''}" data-project="${escapeHtml(s.projectRawName)}" data-session="${escapeHtml(s.id)}" data-mtime="${s.lastModified}" data-waiting="${waiting || ''}">
  <div class="dash-pane-header">
    <div class="dash-pane-titles">
      <div class="dash-pane-title"><span class="dash-dot dash-dot-${status}" title="${status}"></span><a href="${detailUrl}">${escapeHtml(paneTitle(s))}</a><span class="dash-wait-slot">${waitBadgeHtml(waiting)}</span></div>
      <div class="dash-pane-meta">
        <span class="dash-meta-item dash-meta-project" title="${escapeHtml(s.projectName)}">${escapeHtml(projectLabel)}</span>
        ${branch}
        <span class="dash-meta-item dash-ago">${timeAgo(s.lastModified)}</span>
      </div>
    </div>
    ${resumeButtonsHtml(s.projectRawName, s, resume)}
  </div>
  <div class="dash-pane-body">${bodyHtml}</div>
</div>`;
  }).join('\n');

  const countLinks = PANE_COUNTS.map((n) =>
    `<a class="dash-count${n === paneCount ? ' active' : ''}" href="/?n=${n}">${n}</a>`
  ).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ccakashic — dashboard</title>
<link rel="icon" id="dash-favicon" href="data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" rx="3" fill="#2563eb"/></svg>')}">
<style>${getCSS()}
${resumeCSS()}
${dashboardCSS(cols, rows)}
</style>
</head>
<body class="dash-page">
<div class="dash-topbar">
  <span class="dash-brand">ccakashic</span>
  <span class="dash-sub">last 24h across projects</span>
  <span class="dash-counts">Panes: ${countLinks}</span>
  <a class="dash-nav-link" href="/projects">All projects &rarr;</a>
</div>
${restoreBannerHtml(restore)}
<div class="dash-grid">
${panesHtml || '<div class="empty">No sessions found</div>'}
</div>
<script>${getAppJS()}
${resumeJS(resume)}
${dashboardJS()}
</script>
</body>
</html>`;
}

function dashboardCSS(cols: number, rows: number): string {
  return `
.dash-page {
  height: 100vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.dash-topbar {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 8px 16px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}
.dash-brand { font-weight: 700; font-size: 1rem; }
.dash-sub { color: var(--text-muted); font-size: 0.8rem; }
.dash-counts { margin-left: auto; font-size: 0.8rem; color: var(--text-muted); }
.dash-count {
  display: inline-block;
  padding: 2px 8px;
  margin-left: 4px;
  border: 1px solid var(--border);
  border-radius: 5px;
  color: var(--text);
  text-decoration: none;
}
.dash-count.active { border-color: var(--link); color: var(--link); font-weight: 700; }
.dash-nav-link { color: var(--link); text-decoration: none; font-size: 0.85rem; }
.dash-nav-link:hover { text-decoration: underline; }

.dash-grid {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: repeat(${cols}, 1fr);
  grid-template-rows: repeat(${rows}, 1fr);
  gap: 8px;
  padding: 8px;
}
.dash-pane {
  display: flex;
  flex-direction: column;
  min-height: 0;
  min-width: 0;
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
  background: var(--bg);
}
.dash-pane-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-secondary);
  flex-shrink: 0;
}
.dash-pane-titles { min-width: 0; }
.dash-pane-title {
  font-size: 0.85rem;
  font-weight: 700;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dash-pane-title a { color: var(--text); text-decoration: none; }
.dash-pane-title a:hover { color: var(--link); }
.dash-pane-meta {
  display: flex;
  gap: 8px;
  font-size: 0.7rem;
  color: var(--text-muted);
  margin-top: 2px;
  white-space: nowrap;
  overflow: hidden;
}
.dash-pane-header .resume-actions { margin-top: 0; flex-shrink: 0; }

/* Waiting-for-user emphasis: orange frame + glow so it stands out at a glance. */
.dash-pane-waiting {
  border-color: #f97316;
  box-shadow: 0 0 0 2px rgba(249, 115, 22, 0.35);
}
.dash-pane-waiting .dash-pane-header { background: rgba(249, 115, 22, 0.12); }
.dash-wait-slot:empty { display: none; }
.dash-wait-badge {
  display: inline-block;
  margin-left: 6px;
  padding: 1px 7px;
  border-radius: 10px;
  font-size: 0.68rem;
  font-weight: 700;
  vertical-align: middle;
  white-space: nowrap;
  background: #f97316;
  color: #fff;
}
.dash-wait-permission { background: #dc2626; animation: dash-pulse 1.2s ease-in-out infinite; }

.dash-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  margin-right: 6px;
  background: var(--text-muted);
  opacity: 0.4;
}
.dash-dot-active { background: #22c55e; opacity: 1; animation: dash-pulse 1.6s ease-in-out infinite; }
.dash-dot-recent { background: #eab308; opacity: 1; }
@keyframes dash-pulse { 50% { opacity: 0.35; } }
.dash-pane-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 8px 10px;
  font-size: 0.85rem;
}
.dash-pane-body .msg { max-width: 100%; }
.dash-pane-note {
  font-size: 0.72rem;
  color: var(--text-muted);
  text-align: center;
  padding: 4px 0 8px;
}
.empty { text-align: center; color: var(--text-muted); padding: 40px; }

.dash-restore {
  flex-shrink: 0;
  max-height: 40vh;
  overflow-y: auto;
  margin: 8px 8px 0;
  padding: 8px 12px;
  border: 1px solid #f97316;
  border-radius: 8px;
  background: rgba(249, 115, 22, 0.08);
  font-size: 0.82rem;
}
.dash-restore-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.dash-restore-head button {
  font-size: 0.75rem;
  font-weight: 600;
  padding: 3px 10px;
  border-radius: 5px;
  border: 1px solid var(--border);
  background: var(--tool-bg);
  color: var(--text);
  cursor: pointer;
}
.dash-restore-head .dash-restore-run { border-color: #f97316; }
.dash-restore-head button:disabled { opacity: 0.5; cursor: wait; }
.dash-restore-status, .dash-restore-est { color: var(--text-muted); }
.dash-restore-list { list-style: none; margin: 6px 0 0; padding: 0; columns: 2 360px; }
.dash-restore-list li { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; padding: 1px 0; }
.dash-restore-list a { color: var(--text); }
.dash-restore-cwd { color: var(--text-muted); font-size: 0.72rem; margin-left: 4px; }

@media (max-width: 900px) {
  .dash-page { height: auto; overflow: auto; }
  .dash-grid { grid-template-columns: 1fr; grid-template-rows: none; grid-auto-rows: 70vh; }
}
`;
}

function dashboardJS(): string {
  return `
(function() {
  var POLL_MS = 20000;

  function scrollToBottom(body) {
    body.scrollTop = body.scrollHeight;
  }

  document.querySelectorAll('.dash-pane-body').forEach(scrollToBottom);

  var BASE_TITLE = 'ccakashic';
  var ICON_NORMAL = document.getElementById('dash-favicon').href;
  function svgIcon(fill) {
    return 'data:image/svg+xml,' + encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" rx="3" fill="' + fill + '"/></svg>'
    );
  }
  var ICON_WAIT = svgIcon('#f97316');

  function waitBadge(state) {
    if (state === 'permission') return '<span class="dash-wait-badge dash-wait-permission">\u{1F510} Permission</span>';
    if (state === 'input') return '<span class="dash-wait-badge dash-wait-input">⏳ Your turn</span>';
    return '';
  }

  // Reflect the number of sessions awaiting the user into the tab title and
  // favicon, so a glance at the browser tab is enough.
  function syncWaitingIndicator() {
    var waiting = document.querySelectorAll('.dash-pane[data-waiting="input"], .dash-pane[data-waiting="permission"]').length;
    document.title = waiting ? '(' + waiting + ') ' + BASE_TITLE + ' — dashboard' : BASE_TITLE + ' — dashboard';
    var icon = document.getElementById('dash-favicon');
    if (icon) icon.href = waiting ? ICON_WAIT : ICON_NORMAL;
  }

  function applyWaiting(pane, state) {
    var norm = (state === 'input' || state === 'permission') ? state : '';
    if ((pane.dataset.waiting || '') === norm) return;
    pane.dataset.waiting = norm;
    pane.classList.toggle('dash-pane-waiting', !!norm);
    var slot = pane.querySelector('.dash-wait-slot');
    if (slot) slot.innerHTML = waitBadge(norm);
  }

  function refreshPane(pane) {
    var body = pane.querySelector('.dash-pane-body');
    var url = '/api/pane?project=' + encodeURIComponent(pane.dataset.project)
      + '&session=' + encodeURIComponent(pane.dataset.session)
      + '&since=' + encodeURIComponent(pane.dataset.mtime);
    return fetch(url).then(function(res) { return res.json(); }).then(function(data) {
      var dot = pane.querySelector('.dash-dot');
      if (dot && data.status) dot.className = 'dash-dot dash-dot-' + data.status;
      var ago = pane.querySelector('.dash-ago');
      if (ago && data.ago) ago.textContent = data.ago;
      if ('waiting' in data) { applyWaiting(pane, data.waiting); syncWaitingIndicator(); }
      if (!data.changed) return;
      pane.dataset.mtime = data.mtime;
      var nearBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 60;
      body.innerHTML = data.html;
      if (window.ccakashicApplyMarkdown) window.ccakashicApplyMarkdown(body);
      if (nearBottom) scrollToBottom(body);
    }).catch(function() { /* server briefly unavailable; retry next tick */ });
  }

  var restore = document.querySelector('.dash-restore');
  if (restore) {
    var at = restore.querySelector('.dash-restore-at');
    if (at) at.textContent = new Date(Number(at.dataset.ts)).toLocaleString();
    var status = restore.querySelector('.dash-restore-status');
    var checked = function() {
      return Array.prototype.slice.call(restore.querySelectorAll('.dash-restore-check:checked'));
    };
    var post = function(path, body) {
      body.stoppedAt = Number(restore.dataset.stoppedAt);
      return fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Ccakashic-Token': restore.dataset.token },
        body: JSON.stringify(body)
      }).then(function(res) { return res.json(); });
    };
    restore.addEventListener('click', function(e) {
      var btn = e.target.closest ? e.target.closest('button') : null;
      if (!btn) return;
      if (btn.classList.contains('dash-restore-dismiss')) {
        post('/api/restore/dismiss', {}).then(function() { restore.remove(); });
      } else if (btn.classList.contains('dash-restore-copy')) {
        var cmds = checked().map(function(c) { return c.dataset.cmd; }).join('\n');
        navigator.clipboard.writeText(cmds).then(function() { status.textContent = 'Copied'; });
      } else if (btn.classList.contains('dash-restore-run')) {
        var ids = checked().map(function(c) { return c.value; });
        if (!ids.length) return;
        btn.disabled = true;
        status.textContent = 'Reopening ' + ids.length + '…';
        post('/api/restore', { sessions: ids }).then(function(data) {
          if (!data.outcomes) { btn.disabled = false; status.textContent = data.error || 'Reopen failed'; return; }
          var failed = data.outcomes.filter(function(o) { return !o.ok; });
          if (!failed.length) { restore.remove(); return; }
          btn.disabled = false;
          status.textContent = 'Failed: ' + failed.map(function(o) { return o.title + ' (' + o.message + ')'; }).join(', ');
        }).catch(function() { btn.disabled = false; status.textContent = 'Reopen failed: server unreachable'; });
      }
    });
  }

  syncWaitingIndicator();
  setInterval(function() {
    document.querySelectorAll('.dash-pane').forEach(refreshPane);
  }, POLL_MS);
})();
`;
}
