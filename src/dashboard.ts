import { getCSS, getAppJS } from './template-assets';
import { renderMessage } from './html-generator';
import type { ParsedSession } from './parser';
import type { RecentSession } from './discover';
import { resumeButtonsHtml, resumeCSS, resumeJS, type ResumeContext } from './resume-ui';
import { escapeHtml, ACTIVE_THRESHOLD_MS } from './util';

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

function paneTitle(s: RecentSession): string {
  return s.customTitle || s.aiTitle || s.slug || s.id.slice(0, 8);
}

export interface DashboardPane {
  session: RecentSession;
  bodyHtml: string;
}

export function generateDashboard(
  panes: DashboardPane[],
  paneCount: number,
  resume: ResumeContext | undefined,
): string {
  const cols = paneCount <= 4 ? Math.max(panes.length, 1) : Math.ceil(paneCount / 2);
  const rows = paneCount <= 4 ? 1 : 2;

  const panesHtml = panes.map(({ session: s, bodyHtml }) => {
    const status = paneStatus(s.lastModified);
    const detailUrl = `/project/${encodeURIComponent(s.projectRawName)}/session/${encodeURIComponent(s.id)}`;
    const projectLabel = s.projectName.split('/').pop() || s.projectName;
    const branch = s.gitBranch && s.gitBranch !== 'HEAD' ? `<span class="dash-meta-item">${escapeHtml(s.gitBranch)}</span>` : '';
    return `<div class="dash-pane" data-project="${escapeHtml(s.projectRawName)}" data-session="${escapeHtml(s.id)}" data-mtime="${s.lastModified}">
  <div class="dash-pane-header">
    <div class="dash-pane-titles">
      <div class="dash-pane-title"><span class="dash-dot dash-dot-${status}" title="${status}"></span><a href="${detailUrl}">${escapeHtml(paneTitle(s))}</a></div>
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
      if (!data.changed) return;
      pane.dataset.mtime = data.mtime;
      var nearBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 60;
      body.innerHTML = data.html;
      if (window.ccakashicApplyMarkdown) window.ccakashicApplyMarkdown(body);
      if (nearBottom) scrollToBottom(body);
    }).catch(function() { /* server briefly unavailable; retry next tick */ });
  }

  setInterval(function() {
    document.querySelectorAll('.dash-pane').forEach(refreshPane);
  }, POLL_MS);
})();
`;
}
