import { buildResumeCommand } from './cmux';
import { escapeHtml, ACTIVE_THRESHOLD_MS } from './util';

// Shared UI for the "resume this session in cmux" feature: button markup,
// styles, and the client-side script that talks to POST /api/resume.

export interface ResumeContext {
  token: string;
  cmuxAvailable: boolean;
  openSessionIds: Set<string>;
}

export interface ResumableSession {
  id: string;
  cwd: string | null;
  lastModified: number;
}

export function resumeButtonsHtml(
  projectRawName: string,
  session: ResumableSession,
  ctx: ResumeContext | undefined,
): string {
  if (!ctx || !session.cwd) return '';
  const isOpen = ctx.openSessionIds.has(session.id);
  const isActive = Date.now() - session.lastModified < ACTIVE_THRESHOLD_MS;
  const resumeBtn = ctx.cmuxAvailable
    ? `<button type="button" class="resume-btn${isOpen ? ' is-open' : ''}"
        data-project="${escapeHtml(projectRawName)}"
        data-session="${escapeHtml(session.id)}"
        data-open="${isOpen ? '1' : '0'}"
        data-active="${isActive ? '1' : '0'}"
        title="${isOpen ? 'Jump to the open cmux workspace' : 'Resume in a new cmux workspace (Alt-click: open in background)'}">${isOpen ? '&#8618; Jump' : '&#9654; Resume'}</button>`
    : '';
  const copyBtn = `<button type="button" class="copy-cmd-btn"
        data-cmd="${escapeHtml(buildResumeCommand(session.cwd, session.id))}"
        title="Copy the cd + claude --resume command">&#128203; Copy</button>`;
  return `<div class="resume-actions">${resumeBtn}${copyBtn}</div>`;
}

export function resumeCSS(): string {
  return `
.resume-actions {
  display: inline-flex;
  gap: 6px;
  margin-top: 6px;
  /* Sit above the stretched .list-item-link so the buttons stay clickable. */
  position: relative;
  z-index: 1;
}
.resume-btn, .copy-cmd-btn {
  font-size: 0.72rem;
  font-weight: 600;
  padding: 3px 10px;
  border-radius: 5px;
  border: 1px solid var(--border);
  background: var(--tool-bg);
  color: var(--text);
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s;
}
.resume-btn:hover, .copy-cmd-btn:hover {
  border-color: var(--link);
  background: var(--bg-secondary);
}
.resume-btn.is-open {
  color: var(--link);
  border-color: var(--link);
}
.resume-btn:disabled, .copy-cmd-btn:disabled { opacity: 0.5; cursor: wait; }
.resume-toast {
  position: fixed;
  bottom: 24px;
  left: 50%;
  transform: translateX(-50%);
  background: var(--text);
  color: var(--bg);
  padding: 8px 18px;
  border-radius: 8px;
  font-size: 0.85rem;
  z-index: 1000;
  opacity: 0;
  transition: opacity 0.2s;
  pointer-events: none;
}
.resume-toast.visible { opacity: 1; }
`;
}

export function resumeJS(ctx: ResumeContext | undefined): string {
  if (!ctx) return '';
  return `
(function() {
  var TOKEN = ${JSON.stringify(ctx.token)};
  var toastEl = null;
  function toast(msg) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.className = 'resume-toast';
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    toastEl.classList.add('visible');
    clearTimeout(toastEl._t);
    toastEl._t = setTimeout(function() { toastEl.classList.remove('visible'); }, 2500);
  }
  function copy(text) {
    navigator.clipboard.writeText(text).then(
      function() { toast('Command copied'); },
      function() { toast('Copy failed'); }
    );
  }
  document.addEventListener('click', function(e) {
    var btn = e.target.closest ? e.target.closest('.resume-btn, .copy-cmd-btn') : null;
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();

    if (btn.classList.contains('copy-cmd-btn')) {
      copy(btn.dataset.cmd);
      return;
    }

    // Resuming a session that still looks active forks the conversation;
    // require a second click to confirm.
    if (btn.dataset.active === '1' && btn.dataset.open !== '1' && !btn.dataset.confirm) {
      btn.dataset.confirm = '1';
      var orig = btn.innerHTML;
      btn.innerHTML = '&#9888; Fork? click again';
      setTimeout(function() { delete btn.dataset.confirm; btn.innerHTML = orig; }, 3000);
      return;
    }
    delete btn.dataset.confirm;

    var mode = e.altKey ? 'background' : 'jump';
    btn.disabled = true;
    fetch('/api/resume', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Ccakashic-Token': TOKEN },
      body: JSON.stringify({ project: btn.dataset.project, session: btn.dataset.session, mode: mode })
    }).then(function(res) { return res.json(); }).then(function(data) {
      btn.disabled = false;
      if (data.action === 'jumped') {
        toast('Jumped to the open cmux workspace');
      } else if (data.action === 'resumed') {
        toast(mode === 'background' ? 'Resumed in a background cmux workspace' : 'Resumed in a new cmux workspace');
        btn.dataset.open = '1';
        btn.dataset.active = '1';
        btn.classList.add('is-open');
        btn.innerHTML = '&#8618; Jump';
      } else if (data.action === 'unavailable' && data.command) {
        copy(data.command);
      } else {
        toast(data.message || 'Resume failed');
      }
    }).catch(function() {
      btn.disabled = false;
      toast('Resume failed: server unreachable');
    });
  }, true);
})();
`;
}
