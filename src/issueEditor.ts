import * as vscode from "vscode";
import * as crypto from "crypto";
import { LinearService, IssueSummary } from "./linear";

interface EditorPayload {
  identifier: string;
  title: string;
  description: string;
  url: string;
  branchName: string;
  priority: number;
  priorityLabel: string;
  stateId?: string;
  stateName: string;
  stateColor: string;
  assigneeId: string | null;
  assigneeName: string;
  teamKey: string;
  teamName: string;
  projectName: string | null;
  cycleNumber: number | null;
  labels: { id: string; name: string; color: string }[];
  comments: { id: string; body: string; user: string; createdAt: string }[];
  states: any[];
  members: any[];
  allLabels: any[];
  updatedAt: string;
}

export class IssueEditor {
  private static readonly panels = new Map<string, IssueEditor>();
  private disposables: vscode.Disposable[] = [];
  private reloadTimer: NodeJS.Timeout | undefined;
  private reloadInFlight: Promise<void> | undefined;

  static async open(ctx: vscode.ExtensionContext, svc: LinearService, issue: IssueSummary) {
    const existing = IssueEditor.panels.get(issue.id);
    if (existing) { existing.panel.reveal(); existing.scheduleReload(); return existing; }
    const panel = vscode.window.createWebviewPanel(
      "linearIssue",
      `${issue.identifier} · ${issue.title}`,
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    panel.iconPath = vscode.Uri.joinPath(ctx.extensionUri, "resources", "linear.svg");
    const editor = new IssueEditor(ctx, svc, issue.id, panel);
    IssueEditor.panels.set(issue.id, editor);
    panel.onDidDispose(() => {
      editor.disposables.forEach((d) => d.dispose());
      if (editor.reloadTimer) clearTimeout(editor.reloadTimer);
      IssueEditor.panels.delete(issue.id);
    });
    panel.webview.html = editor.shell();
    return editor;
  }

  private constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly svc: LinearService,
    private readonly issueId: string,
    private readonly panel: vscode.WebviewPanel,
  ) {
    panel.webview.onDidReceiveMessage((msg) => this.onMessage(msg), null, this.disposables);
    this.disposables.push(svc.onDidChange(() => this.scheduleReload()));
  }

  private post(msg: any) { this.panel.webview.postMessage(msg); }

  /** Coalesce refreshes — rapid onDidChange bursts collapse into a single fetch. */
  private scheduleReload() {
    if (this.reloadTimer) return;
    this.reloadTimer = setTimeout(() => {
      this.reloadTimer = undefined;
      this.reload();
    }, 250);
  }

  private async reload() {
    if (this.reloadInFlight) return this.reloadInFlight;
    this.reloadInFlight = this.doReload().finally(() => { this.reloadInFlight = undefined; });
    return this.reloadInFlight;
  }

  private async doReload() {
    this.post({ type: "loading", value: true });
    try {
      const full = await this.svc.issueFull(this.issueId);
      const s = full.summary;
      this.panel.title = `${s.identifier} · ${s.title}`;

      const payload: EditorPayload = {
        identifier: s.identifier,
        title: s.title,
        description: s.description ?? "",
        url: s.url,
        branchName: s.branchName,
        priority: s.priority,
        priorityLabel: s.priorityLabel,
        stateId: full.states.find((x) => x.name === s.stateName)?.id,
        stateName: s.stateName,
        stateColor: s.stateColor,
        assigneeId: s.assigneeId,
        assigneeName: s.assigneeName ?? "unassigned",
        teamKey: s.teamKey,
        teamName: s.teamName,
        projectName: s.projectName,
        cycleNumber: s.cycleNumber,
        labels: s.labelIds.map((id, i) => ({
          id,
          name: s.labelNames[i] ?? "",
          color: full.labels.find((l) => l.id === id)?.color ?? "#888",
        })),
        comments: full.comments,
        states: full.states,
        members: full.members,
        allLabels: full.labels,
        updatedAt: s.updatedAt,
      };
      this.post({ type: "data", payload });
    } catch (e: any) {
      this.post({ type: "error", message: e?.message ?? String(e) });
    } finally {
      this.post({ type: "loading", value: false });
    }
  }

  private async onMessage(msg: any) {
    try {
      switch (msg.type) {
        case "ready": return this.reload();
        case "saveTitle": await this.svc.updateIssue(this.issueId, { title: msg.title }); break;
        case "saveDescription": await this.svc.updateIssue(this.issueId, { description: msg.description }); break;
        case "changeState": await this.svc.updateIssue(this.issueId, { stateId: msg.stateId }); break;
        case "changePriority": await this.svc.updateIssue(this.issueId, { priority: msg.priority }); break;
        case "changeAssignee": await this.svc.updateIssue(this.issueId, { assigneeId: msg.assigneeId || null }); break;
        case "changeLabels": await this.svc.updateIssue(this.issueId, { labelIds: msg.labelIds }); break;
        case "addComment":
          if (msg.body?.trim()) await this.svc.addComment(this.issueId, msg.body);
          break;
        case "openInBrowser":
          vscode.env.openExternal(vscode.Uri.parse(msg.url));
          return;
        case "copyBranch":
          await vscode.env.clipboard.writeText(msg.branch);
          vscode.window.showInformationMessage(`Copied branch: ${msg.branch}`);
          return;
        case "reload":
          return this.reload();
      }
    } catch (e: any) {
      this.post({ type: "error", message: e?.message ?? String(e) });
      vscode.window.showErrorMessage(`Linear: ${e.message ?? e}`);
    }
  }

  private shell(): string {
    const nonce = crypto.randomBytes(16).toString("hex");
    const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';`;
    return /* html */ `<!doctype html>
<html><head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>${STYLES}</style>
</head><body>
<div id="app">
  <header class="topbar">
    <div class="crumbs">
      <span class="brand-dot"></span>
      <span id="team">—</span>
      <span class="sep">/</span>
      <span id="id" class="mono">—</span>
    </div>
    <div class="actions">
      <button class="btn btn-ghost" data-act="branch"><svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="4" cy="4" r="2"/><circle cx="4" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><path d="M4 6v4M6 12h4"/><path d="M12 10V6a2 2 0 0 0-2-2H8"/></svg> Branch</button>
      <button class="btn btn-ghost" data-act="browser"><svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M6 3H4a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h7a2 2 0 0 0 2-2v-2"/><path d="M10 2h4v4M14 2 8 8"/></svg> Open</button>
      <button class="btn btn-ghost" data-act="reload" title="Refresh">↻</button>
    </div>
  </header>

  <div class="body">
    <main class="main">
      <input class="title" id="title" placeholder="Issue title…" spellcheck="false" />

      <div class="chips" id="chips"></div>

      <div class="section">
        <div class="section-head"><h3>Description</h3><span class="hint" id="descHint">Markdown supported · auto-saves on blur</span></div>
        <textarea id="description" placeholder="Add a description…"></textarea>
      </div>

      <div class="section">
        <div class="section-head"><h3>Comments</h3><span class="hint" id="commentCount">0</span></div>
        <div id="comments"></div>
        <div class="composer">
          <textarea id="newComment" placeholder="Write a comment…"></textarea>
          <div class="composer-actions">
            <span class="hint">⌘/Ctrl+Enter to send</span>
            <button class="btn btn-primary" id="btnComment">Send</button>
          </div>
        </div>
      </div>
    </main>

    <aside class="sidebar">
      <div class="side-section">
        <label class="field-label">Status</label>
        <select id="state"></select>
      </div>
      <div class="side-section">
        <label class="field-label">Priority</label>
        <select id="priority">
          <option value="0">No priority</option>
          <option value="1">Urgent</option>
          <option value="2">High</option>
          <option value="3">Medium</option>
          <option value="4">Low</option>
        </select>
      </div>
      <div class="side-section">
        <label class="field-label">Assignee</label>
        <select id="assignee"><option value="">Unassigned</option></select>
      </div>
      <div class="side-section">
        <label class="field-label">Labels</label>
        <div id="labels" class="labels"></div>
      </div>
      <div class="side-section side-meta">
        <div><span class="k">Team</span><span class="v" id="teamName">—</span></div>
        <div><span class="k">Project</span><span class="v" id="projectName">—</span></div>
        <div><span class="k">Cycle</span><span class="v" id="cycleNumber">—</span></div>
        <div><span class="k">Updated</span><span class="v" id="updatedAt">—</span></div>
      </div>
    </aside>
  </div>

  <div id="loader" class="loader" hidden><div class="loader-bar"></div></div>
  <div id="error" class="error-banner" hidden></div>
</div>

<script nonce="${nonce}">${CLIENT}</script>
</body></html>`;
  }
}

const STYLES = `
:root {
  color-scheme: dark light;
  --bg: var(--vscode-editor-background);
  --fg: var(--vscode-editor-foreground);
  --muted: var(--vscode-descriptionForeground);
  --border: var(--vscode-panel-border, rgba(255,255,255,.08));
  --surface: var(--vscode-sideBar-background, rgba(255,255,255,.02));
  --surface-2: var(--vscode-editorWidget-background, rgba(255,255,255,.04));
  --hover: var(--vscode-list-hoverBackground, rgba(255,255,255,.06));
  --accent: #5e6ad2;
  --accent-2: #7a86e0;
  --danger: #f2777a;
  --radius: 8px;
  --font: -apple-system, BlinkMacSystemFont, "Inter", "SF Pro Text", "Segoe UI", system-ui, sans-serif;
  --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: var(--bg); color: var(--fg); font-family: var(--font); font-size: 13px; line-height: 1.5; }
#app { display: flex; flex-direction: column; min-height: 100vh; }

.topbar { display: flex; align-items: center; justify-content: space-between; padding: 12px 24px; border-bottom: 1px solid var(--border); background: var(--bg); position: sticky; top: 0; z-index: 10; }
.crumbs { display: flex; align-items: center; gap: 10px; color: var(--muted); font-size: 12px; }
.brand-dot { width: 8px; height: 8px; border-radius: 2px; background: linear-gradient(135deg, var(--accent), var(--accent-2)); }
.mono { font-family: var(--mono); }
.sep { opacity: .4; }
.actions { display: flex; gap: 8px; }

.btn { display: inline-flex; align-items: center; gap: 6px; padding: 5px 12px; border-radius: 6px; border: 1px solid transparent; background: transparent; color: inherit; font: inherit; font-size: 12px; font-weight: 500; cursor: pointer; transition: background .12s, border-color .12s; }
.btn-ghost { border-color: var(--border); }
.btn-ghost:hover { background: var(--hover); }
.btn-primary { background: var(--accent); color: white; }
.btn-primary:hover { background: var(--accent-2); }

.body { display: grid; grid-template-columns: minmax(0, 1fr) 280px; gap: 32px; padding: 32px 24px 48px; max-width: 1200px; margin: 0 auto; width: 100%; }
@media (max-width: 820px) { .body { grid-template-columns: 1fr; } }

.title { width: 100%; font-size: 26px; font-weight: 600; letter-spacing: -.02em; background: transparent; color: inherit; border: none; outline: none; padding: 0 0 12px; margin: 0 0 12px; border-bottom: 1px solid transparent; transition: border-color .12s; }
.title:hover { border-bottom-color: var(--border); }
.title:focus { border-bottom-color: var(--accent); }

.chips { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 24px; }
.chip { display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border-radius: 999px; background: var(--surface); border: 1px solid var(--border); font-size: 11.5px; color: var(--fg); }
.chip .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); }

.section { margin-bottom: 32px; }
.section-head { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 10px; }
.section-head h3 { margin: 0; font-size: 11.5px; font-weight: 600; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); }
.hint { color: var(--muted); font-size: 11px; }

textarea, select { font-family: inherit; font-size: 13px; background: var(--surface); color: var(--fg); border: 1px solid var(--border); border-radius: var(--radius); padding: 8px 10px; transition: border-color .12s, background .12s; }
textarea { width: 100%; min-height: 160px; resize: vertical; font-family: var(--mono); font-size: 12.5px; line-height: 1.55; }
select { width: 100%; cursor: pointer; }
textarea:focus, select:focus { outline: none; border-color: var(--accent); background: var(--bg); }

.composer { margin-top: 12px; border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; background: var(--surface); }
.composer textarea { border: none; background: transparent; min-height: 90px; border-radius: 0; }
.composer textarea:focus { background: transparent; }
.composer-actions { display: flex; justify-content: space-between; align-items: center; padding: 8px 10px; border-top: 1px solid var(--border); }

.comment { padding: 12px 14px; border: 1px solid var(--border); border-radius: var(--radius); margin-bottom: 10px; background: var(--surface); }
.comment .head { display: flex; align-items: center; gap: 10px; margin-bottom: 6px; font-size: 12px; color: var(--muted); }
.comment .avatar { width: 22px; height: 22px; border-radius: 50%; background: linear-gradient(135deg, var(--accent), var(--accent-2)); display: inline-flex; align-items: center; justify-content: center; color: white; font-size: 11px; font-weight: 600; }
.comment .body { white-space: pre-wrap; font-size: 13px; line-height: 1.55; }

.sidebar { display: flex; flex-direction: column; gap: 18px; padding-top: 4px; }
.side-section { display: flex; flex-direction: column; gap: 6px; }
.field-label { font-size: 11px; font-weight: 500; color: var(--muted); text-transform: uppercase; letter-spacing: .05em; }
.labels { display: flex; flex-wrap: wrap; gap: 6px; }
.label-chip { display: inline-flex; align-items: center; gap: 6px; padding: 3px 10px; border-radius: 999px; font-size: 11.5px; background: var(--surface); border: 1px solid var(--border); cursor: pointer; user-select: none; transition: background .12s, border-color .12s; }
.label-chip:hover { background: var(--hover); }
.label-chip.selected { border-color: var(--accent); background: rgba(94,106,210,.12); }
.label-chip .dot { width: 8px; height: 8px; border-radius: 50%; }

.side-meta { border-top: 1px solid var(--border); padding-top: 16px; gap: 8px; }
.side-meta > div { display: flex; justify-content: space-between; font-size: 12px; }
.side-meta .k { color: var(--muted); }
.side-meta .v { color: var(--fg); }

.loader { position: fixed; top: 0; left: 0; right: 0; height: 2px; overflow: hidden; z-index: 20; }
.loader-bar { width: 30%; height: 100%; background: var(--accent); animation: slide 1.1s ease-in-out infinite; }
@keyframes slide { 0% { transform: translateX(-100%); } 100% { transform: translateX(400%); } }

.error-banner { position: fixed; bottom: 16px; left: 50%; transform: translateX(-50%); background: rgba(242,119,122,.12); border: 1px solid rgba(242,119,122,.4); color: var(--danger); padding: 8px 14px; border-radius: var(--radius); font-size: 12px; z-index: 30; }
`;

const CLIENT = String.raw`
const vscode = acquireVsCodeApi();
const $ = (id) => document.getElementById(id);
function esc(s) { return String(s ?? "").replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }
function timeAgo(iso) {
  if (!iso) return "—";
  const s = Math.max(1, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return s + "s ago";
  if (s < 3600) return Math.round(s/60) + "m ago";
  if (s < 86400) return Math.round(s/3600) + "h ago";
  return Math.round(s/86400) + "d ago";
}
function initials(name) { return (name || "?").trim().split(/\s+/).slice(0,2).map(s => s[0]).join("").toUpperCase(); }

let state = { url: "", branch: "", selectedLabels: new Set(), userEdited: {} };

document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-act]");
  if (!b) return;
  const act = b.dataset.act;
  if (act === "reload") vscode.postMessage({ type: "reload" });
  if (act === "browser") vscode.postMessage({ type: "openInBrowser", url: state.url });
  if (act === "branch") vscode.postMessage({ type: "copyBranch", branch: state.branch });
});

$("title").addEventListener("blur", (e) => { if (state.userEdited.title) { vscode.postMessage({ type: "saveTitle", title: e.target.value }); state.userEdited.title = false; }});
$("title").addEventListener("input", () => { state.userEdited.title = true; });
$("description").addEventListener("blur", (e) => { if (state.userEdited.description) { vscode.postMessage({ type: "saveDescription", description: e.target.value }); state.userEdited.description = false; }});
$("description").addEventListener("input", () => { state.userEdited.description = true; });
$("state").addEventListener("change", (e) => vscode.postMessage({ type: "changeState", stateId: e.target.value }));
$("priority").addEventListener("change", (e) => vscode.postMessage({ type: "changePriority", priority: Number(e.target.value) }));
$("assignee").addEventListener("change", (e) => vscode.postMessage({ type: "changeAssignee", assigneeId: e.target.value }));

function sendComment() {
  const body = $("newComment").value;
  if (!body.trim()) return;
  vscode.postMessage({ type: "addComment", body });
  $("newComment").value = "";
}
$("btnComment").addEventListener("click", sendComment);
$("newComment").addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); sendComment(); }
});

function renderChips(p) {
  const chips = [];
  chips.push('<span class="chip"><span class="dot" style="background:' + esc(p.stateColor) + '"></span>' + esc(p.stateName) + '</span>');
  chips.push('<span class="chip">' + esc(p.priorityLabel) + '</span>');
  chips.push('<span class="chip">@' + esc(p.assigneeName) + '</span>');
  if (p.projectName) chips.push('<span class="chip">📁 ' + esc(p.projectName) + '</span>');
  if (p.cycleNumber != null) chips.push('<span class="chip">🗓 Cycle ' + p.cycleNumber + '</span>');
  $("chips").innerHTML = chips.join("");
}

function renderComments(cs) {
  $("commentCount").textContent = cs.length;
  if (!cs.length) {
    $("comments").innerHTML = '';
    return;
  }
  $("comments").innerHTML = cs.map((c) =>
    '<div class="comment">'
    + '<div class="head"><div class="avatar">' + esc(initials(c.user)) + '</div><span>' + esc(c.user) + '</span><span>·</span><span>' + timeAgo(c.createdAt) + '</span></div>'
    + '<div class="body">' + esc(c.body) + '</div>'
    + '</div>'
  ).join("");
}

window.addEventListener("message", (event) => {
  const msg = event.data;
  if (msg.type === "loading") { $("loader").hidden = !msg.value; return; }
  if (msg.type === "error") {
    const b = $("error"); b.hidden = false; b.textContent = "Error: " + msg.message;
    setTimeout(() => b.hidden = true, 6000);
    return;
  }
  if (msg.type !== "data") return;
  const p = msg.payload;
  state.url = p.url; state.branch = p.branchName;

  $("team").textContent = p.teamName + (p.teamKey ? " (" + p.teamKey + ")" : "");
  $("id").textContent = p.identifier;

  if (!state.userEdited.title || document.activeElement !== $("title")) $("title").value = p.title;
  if (!state.userEdited.description || document.activeElement !== $("description")) $("description").value = p.description;

  renderChips(p);

  $("state").innerHTML = p.states.map((s) => '<option value="' + s.id + '" ' + (s.id === p.stateId ? "selected" : "") + '>' + esc(s.name) + '</option>').join("");
  $("priority").value = String(p.priority);
  $("assignee").innerHTML = '<option value="">Unassigned</option>' + p.members.map((u) => '<option value="' + u.id + '" ' + (u.id === p.assigneeId ? "selected" : "") + '>' + esc(u.displayName) + '</option>').join("");

  state.selectedLabels = new Set(p.labels.map((l) => l.id));
  $("labels").innerHTML = p.allLabels.map((l) =>
    '<span class="label-chip ' + (state.selectedLabels.has(l.id) ? "selected" : "") + '" data-id="' + l.id + '">'
    + '<span class="dot" style="background:' + esc(l.color) + '"></span>' + esc(l.name)
    + '</span>'
  ).join("");
  $("labels").querySelectorAll(".label-chip").forEach((el) => el.addEventListener("click", () => {
    const id = el.dataset.id;
    if (state.selectedLabels.has(id)) state.selectedLabels.delete(id); else state.selectedLabels.add(id);
    el.classList.toggle("selected");
    vscode.postMessage({ type: "changeLabels", labelIds: [...state.selectedLabels] });
  }));

  $("teamName").textContent = p.teamName || "—";
  $("projectName").textContent = p.projectName || "—";
  $("cycleNumber").textContent = p.cycleNumber != null ? "Cycle " + p.cycleNumber : "—";
  $("updatedAt").textContent = timeAgo(p.updatedAt);

  renderComments(p.comments);
});

vscode.postMessage({ type: "ready" });
`;
