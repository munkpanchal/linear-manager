import * as vscode from "vscode";
import * as crypto from "crypto";
import { LinearService, IssueSummary } from "./linear";
import { IssueEditor } from "./issueEditor";

const STATE_ORDER = ["started", "unstarted", "backlog", "triage", "completed", "canceled"];
const STATE_LABEL: Record<string, string> = {
  started: "In Progress",
  unstarted: "Todo",
  backlog: "Backlog",
  triage: "Triage",
  completed: "Done",
  canceled: "Canceled",
};

export class Dashboard {
  private static current: Dashboard | undefined;
  private disposables: vscode.Disposable[] = [];

  static open(ctx: vscode.ExtensionContext, svc: LinearService) {
    if (Dashboard.current) {
      Dashboard.current.panel.reveal();
      Dashboard.current.refresh();
      return Dashboard.current;
    }
    const panel = vscode.window.createWebviewPanel(
      "linearDashboard",
      "Linear · Dashboard",
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    Dashboard.current = new Dashboard(ctx, svc, panel);
    return Dashboard.current;
  }

  private constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly svc: LinearService,
    private readonly panel: vscode.WebviewPanel,
  ) {
    panel.iconPath = vscode.Uri.joinPath(ctx.extensionUri, "resources", "linear.svg");
    panel.webview.html = this.shell();
    panel.webview.onDidReceiveMessage((msg) => this.onMessage(msg), null, this.disposables);
    this.disposables.push(svc.onDidChange(() => this.refresh()));
    panel.onDidDispose(() => {
      this.disposables.forEach((d) => d.dispose());
      Dashboard.current = undefined;
    });
    this.refresh();
  }

  private post(message: any) {
    this.panel.webview.postMessage(message);
  }

  async refresh() {
    this.post({ type: "loading", value: true });
    try {
      const data = await this.svc.dashboard();
      const issues = data.issues ?? [];
      const created = data.createdByMe ?? [];
      const grouped = groupIssues(issues);
      const count = (k: string) => grouped[k]?.length ?? 0;
      this.post({
        type: "data",
        me: data.me,
        counts: {
          total: issues.length,
          inProgress: count("started"),
          todo: count("unstarted"),
          backlog: count("backlog") + count("triage"),
          createdByMe: created.length,
        },
        groups: STATE_ORDER
          .filter((k) => grouped[k]?.length)
          .map((k) => ({ key: k, label: STATE_LABEL[k], items: grouped[k].map(serialise) })),
        createdByMe: created.map(serialise),
        cycles: data.activeCycles ?? [],
      });
    } catch (e: any) {
      this.post({ type: "error", message: e?.message ?? String(e) });
    } finally {
      this.post({ type: "loading", value: false });
    }
  }

  private async onMessage(msg: any) {
    switch (msg.type) {
      case "ready":
        return this.refresh();
      case "open": {
        if (msg.issue) {
          IssueEditor.open(this.ctx, this.svc, msg.issue);
        } else if (msg.id) {
          const issue = await this.svc.issueById(msg.id).catch(() => undefined);
          if (issue) IssueEditor.open(this.ctx, this.svc, issue);
        }
        return;
      }
      case "openInBrowser":
        vscode.env.openExternal(vscode.Uri.parse(msg.url));
        return;
      case "copyBranch":
        await vscode.env.clipboard.writeText(msg.branch);
        vscode.window.showInformationMessage(`Copied branch: ${msg.branch}`);
        return;
      case "refresh":
        this.svc.invalidate("issues:");
        return;
      case "createIssue":
        vscode.commands.executeCommand("linear.createIssue");
        return;
      case "search":
        vscode.commands.executeCommand("linear.searchIssues");
        return;
      case "signOut":
        vscode.commands.executeCommand("linear.signOut");
        return;
    }
  }

  private shell(): string {
    const nonce = crypto.randomBytes(16).toString("hex");
    const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';`;
    return /* html */ `<!doctype html>
<html><head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<style>${STYLES}</style>
</head><body>
<div id="app">
  <header class="topbar">
    <div class="brand">
      <span class="brand-dot"></span>
      <span>Linear</span>
      <span class="brand-sep">·</span>
      <span class="brand-sub">Dashboard</span>
    </div>
    <div class="topbar-actions">
      <button data-act="search" class="btn btn-ghost" title="Search issues">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="7" cy="7" r="5"/><path d="m11 11 3 3"/></svg>
        Search
      </button>
      <button data-act="createIssue" class="btn btn-primary" title="Create issue">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 3v10M3 8h10"/></svg>
        New Issue
      </button>
      <button data-act="refresh" class="btn btn-ghost" title="Refresh">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M13 3v4h-4M3 13V9h4"/><path d="M13 7a5 5 0 0 0-9-2M3 9a5 5 0 0 0 9 2"/></svg>
      </button>
    </div>
  </header>

  <section class="hero">
    <div class="hero-inner">
      <div id="greeting" class="greeting">Loading your workspace…</div>
      <div class="stat-grid">
        <div class="stat"><div class="stat-label">Total open</div><div class="stat-value" id="stat-total">—</div></div>
        <div class="stat stat-accent"><div class="stat-label">In Progress</div><div class="stat-value" id="stat-progress">—</div></div>
        <div class="stat"><div class="stat-label">Todo</div><div class="stat-value" id="stat-todo">—</div></div>
        <div class="stat"><div class="stat-label">Backlog</div><div class="stat-value" id="stat-backlog">—</div></div>
        <div class="stat"><div class="stat-label">Created by me</div><div class="stat-value" id="stat-created">—</div></div>
      </div>
    </div>
  </section>

  <main class="grid">
    <div class="col main-col">
      <div class="section">
        <div class="section-head">
          <h2>My Issues</h2>
          <span class="hint">Only issues assigned to you</span>
        </div>
        <div id="groups" class="groups">
          ${skeletonGroup(3)}
          ${skeletonGroup(2)}
        </div>
      </div>
    </div>

    <aside class="col side-col">
      <div class="section">
        <div class="section-head"><h2>Active Cycles</h2></div>
        <div id="cycles" class="cycles"><div class="skel skel-line"></div><div class="skel skel-line"></div></div>
      </div>

      <div class="section">
        <div class="section-head"><h2>Created by me</h2><span class="hint">assigned elsewhere</span></div>
        <div id="created" class="created"><div class="skel skel-row"></div></div>
      </div>
    </aside>
  </main>

  <div id="loader" class="loader" hidden><div class="loader-bar"></div></div>
  <div id="error" class="error-banner" hidden></div>
</div>

<script nonce="${nonce}">${CLIENT}</script>
</body></html>`;
  }
}

function skeletonGroup(rows: number): string {
  let out = `<div class="group"><div class="group-head"><div class="skel skel-chip"></div></div>`;
  for (let i = 0; i < rows; i++) out += `<div class="issue skel-issue"><div class="skel skel-dot"></div><div class="skel skel-line" style="flex:1"></div></div>`;
  return out + `</div>`;
}

function groupIssues(issues: IssueSummary[]): Record<string, IssueSummary[]> {
  const out: Record<string, IssueSummary[]> = {};
  for (const i of issues) (out[i.stateType] ??= []).push(i);
  for (const k of Object.keys(out)) {
    out[k].sort((a, b) => a.priority - b.priority || a.identifier.localeCompare(b.identifier));
  }
  return out;
}

function serialise(i: IssueSummary) {
  return {
    id: i.id,
    identifier: i.identifier,
    title: i.title,
    url: i.url,
    branchName: i.branchName,
    priority: i.priority,
    priorityLabel: i.priorityLabel,
    stateName: i.stateName,
    stateColor: i.stateColor,
    stateType: i.stateType,
    projectName: i.projectName,
    labels: i.labelNames,
    updatedAt: i.updatedAt,
  };
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
  --success: #4ade80;
  --radius: 8px;
  --radius-lg: 12px;
  --gap: 8px;
  --gap-2: 16px;
  --gap-3: 24px;
  --font: -apple-system, BlinkMacSystemFont, "Inter", "SF Pro Text", "Segoe UI", system-ui, sans-serif;
  --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: var(--bg); color: var(--fg); font-family: var(--font); font-size: 13px; line-height: 1.45; }
#app { max-width: 1280px; margin: 0 auto; padding: 0 24px 48px; }

.topbar { display: flex; align-items: center; justify-content: space-between; padding: 16px 0; border-bottom: 1px solid var(--border); position: sticky; top: 0; background: var(--bg); z-index: 10; }
.brand { display: flex; align-items: center; gap: 8px; font-weight: 600; font-size: 14px; letter-spacing: -.01em; }
.brand-dot { width: 10px; height: 10px; border-radius: 3px; background: linear-gradient(135deg, var(--accent), var(--accent-2)); box-shadow: 0 0 0 3px rgba(94,106,210,.15); }
.brand-sep { opacity: .35; }
.brand-sub { color: var(--muted); font-weight: 500; }
.topbar-actions { display: flex; gap: 8px; }

.btn { display: inline-flex; align-items: center; gap: 6px; padding: 6px 12px; border-radius: 6px; border: 1px solid transparent; background: transparent; color: inherit; font-family: inherit; font-size: 12px; font-weight: 500; cursor: pointer; transition: background .12s, border-color .12s, transform .06s; }
.btn:active { transform: translateY(1px); }
.btn-ghost { border-color: var(--border); }
.btn-ghost:hover { background: var(--hover); }
.btn-primary { background: var(--accent); color: white; }
.btn-primary:hover { background: var(--accent-2); }

.hero { padding: 32px 0 24px; }
.hero-inner { display: flex; flex-direction: column; gap: 20px; }
.greeting { font-size: 22px; font-weight: 600; letter-spacing: -.02em; }
.greeting .name { color: var(--accent-2); }
.stat-grid { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 12px; }
.stat { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-lg); padding: 14px 16px; }
.stat-accent { border-color: rgba(94,106,210,.4); background: linear-gradient(180deg, rgba(94,106,210,.08), rgba(94,106,210,0)); }
.stat-label { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .06em; margin-bottom: 6px; }
.stat-value { font-size: 22px; font-weight: 600; font-variant-numeric: tabular-nums; }

.grid { display: grid; grid-template-columns: minmax(0, 2fr) minmax(280px, 1fr); gap: 24px; margin-top: 8px; }
@media (max-width: 900px) { .grid { grid-template-columns: 1fr; } .stat-grid { grid-template-columns: repeat(2, 1fr); } }

.section { margin-bottom: 28px; }
.section-head { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 12px; }
.section-head h2 { font-size: 13px; margin: 0; font-weight: 600; letter-spacing: -.005em; text-transform: uppercase; opacity: .75; letter-spacing: .05em; }
.section-head .hint { color: var(--muted); font-size: 11px; }

.groups { display: flex; flex-direction: column; gap: 20px; }
.group { border: 1px solid var(--border); border-radius: var(--radius-lg); overflow: hidden; background: var(--surface); }
.group-head { display: flex; align-items: center; justify-content: space-between; padding: 10px 14px; background: var(--surface-2); border-bottom: 1px solid var(--border); }
.group-title { display: flex; align-items: center; gap: 8px; font-size: 12px; font-weight: 600; color: var(--fg); }
.group-title .state-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); }
.group-count { color: var(--muted); font-size: 11px; font-variant-numeric: tabular-nums; }

.issue { display: grid; grid-template-columns: 22px minmax(60px, auto) 1fr auto; align-items: center; gap: 10px; padding: 8px 14px; cursor: pointer; border-bottom: 1px solid var(--border); transition: background .1s; }
.issue:last-child { border-bottom: none; }
.issue:hover { background: var(--hover); }
.issue-prio { display: inline-flex; width: 18px; justify-content: center; color: var(--muted); }
.issue-id { font-family: var(--mono); font-size: 11.5px; color: var(--muted); }
.issue-title { color: var(--fg); font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.issue-meta { display: flex; align-items: center; gap: 8px; color: var(--muted); font-size: 11px; }
.issue .chip { display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; border-radius: 999px; background: var(--surface-2); border: 1px solid var(--border); font-size: 10.5px; }
.issue .chip .dot { width: 6px; height: 6px; border-radius: 50%; }
.issue-actions { display: none; gap: 6px; }
.issue:hover .issue-actions { display: inline-flex; }
.icon-btn { width: 24px; height: 24px; display: inline-flex; align-items: center; justify-content: center; background: transparent; border: 1px solid var(--border); border-radius: 6px; cursor: pointer; color: var(--muted); }
.icon-btn:hover { background: var(--surface-2); color: var(--fg); }

.cycles { display: flex; flex-direction: column; gap: 8px; }
.cycle { padding: 12px 14px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); }
.cycle-name { font-size: 13px; font-weight: 500; }
.cycle-sub { font-size: 11px; color: var(--muted); margin-top: 4px; }

.created { display: flex; flex-direction: column; gap: 8px; }
.mini-issue { padding: 8px 12px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); cursor: pointer; }
.mini-issue:hover { background: var(--hover); }
.mini-id { font-family: var(--mono); font-size: 10.5px; color: var(--muted); }
.mini-title { font-size: 12.5px; margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.empty { padding: 24px; text-align: center; color: var(--muted); border: 1px dashed var(--border); border-radius: var(--radius); }

.loader { position: fixed; top: 0; left: 0; right: 0; height: 2px; overflow: hidden; z-index: 20; background: transparent; }
.loader-bar { width: 30%; height: 100%; background: var(--accent); animation: slide 1.1s ease-in-out infinite; }
@keyframes slide { 0% { transform: translateX(-100%); } 100% { transform: translateX(400%); } }

.error-banner { position: fixed; bottom: 16px; left: 50%; transform: translateX(-50%); background: rgba(242,119,122,.12); border: 1px solid rgba(242,119,122,.4); color: var(--danger); padding: 8px 14px; border-radius: var(--radius); font-size: 12px; }

.skel { background: linear-gradient(90deg, var(--surface-2), var(--hover), var(--surface-2)); background-size: 200% 100%; animation: shimmer 1.6s linear infinite; border-radius: 4px; }
.skel-line { height: 10px; width: 100%; }
.skel-chip { height: 14px; width: 90px; border-radius: 999px; }
.skel-dot { width: 10px; height: 10px; border-radius: 50%; }
.skel-issue { padding: 10px 14px; display: flex; gap: 10px; align-items: center; border-bottom: 1px solid var(--border); }
.skel-row { height: 46px; border-radius: var(--radius); }
@keyframes shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }
`;

const CLIENT = String.raw`
const vscode = acquireVsCodeApi();
const $ = (id) => document.getElementById(id);
const $$ = (sel, root=document) => [...root.querySelectorAll(sel)];

const PRIO_LABEL = { 0: "—", 1: "Urgent", 2: "High", 3: "Medium", 4: "Low" };
const PRIO_ICON = {
  1: '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" style="color:#f2777a"><rect x="2" y="2" width="12" height="12" rx="2"/></svg>',
  2: '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" style="color:#e0a458"><rect x="2" y="10" width="3" height="4" rx="1"/><rect x="7" y="6" width="3" height="8" rx="1"/><rect x="12" y="2" width="3" height="12" rx="1"/></svg>',
  3: '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" style="color:#e0a458"><rect x="2" y="10" width="3" height="4" rx="1"/><rect x="7" y="6" width="3" height="8" rx="1" opacity=".6"/><rect x="12" y="2" width="3" height="12" rx="1" opacity=".3"/></svg>',
  4: '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" style="color:#7a86e0"><rect x="2" y="10" width="3" height="4" rx="1"/><rect x="7" y="6" width="3" height="8" rx="1" opacity=".4"/></svg>',
  0: '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" opacity=".5"><line x1="3" y1="8" x2="13" y2="8"/></svg>',
};

function esc(s) { return String(s ?? "").replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }
function timeAgo(iso) {
  if (!iso) return "";
  const d = new Date(iso).getTime();
  const s = Math.max(1, Math.round((Date.now() - d) / 1000));
  if (s < 60) return s + "s ago";
  if (s < 3600) return Math.round(s/60) + "m ago";
  if (s < 86400) return Math.round(s/3600) + "h ago";
  return Math.round(s/86400) + "d ago";
}

const ISSUE_INDEX = new Map();

document.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-act]");
  if (btn) { vscode.postMessage({ type: btn.dataset.act }); return; }
  const issueRow = e.target.closest("[data-issue-id]");
  if (issueRow) {
    if (e.target.closest("[data-inline-act]")) return;
    const id = issueRow.dataset.issueId;
    const issue = ISSUE_INDEX.get(id);
    vscode.postMessage({ type: "open", id, issue });
  }
});

document.addEventListener("click", (e) => {
  const inline = e.target.closest("[data-inline-act]");
  if (!inline) return;
  e.stopPropagation();
  const act = inline.dataset.inlineAct;
  const row = inline.closest("[data-issue-id]");
  if (act === "browser") vscode.postMessage({ type: "openInBrowser", url: row.dataset.url });
  if (act === "branch") vscode.postMessage({ type: "copyBranch", branch: row.dataset.branch });
}, true);

function greetingFor(name) {
  const h = new Date().getHours();
  const time = h < 5 ? "Working late" : h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
  return time + ', <span class="name">' + esc(name || "there") + '</span>.';
}

function renderIssue(i) {
  const chips = [];
  if (i.projectName) chips.push('<span class="chip">' + esc(i.projectName) + '</span>');
  if (i.labels && i.labels.length) chips.push('<span class="chip"><span class="dot" style="background:#7a86e0"></span>' + esc(i.labels.slice(0,2).join(", ")) + (i.labels.length>2?" +"+(i.labels.length-2):"") + '</span>');
  chips.push('<span title="Updated">' + timeAgo(i.updatedAt) + '</span>');
  return '<div class="issue" data-issue-id="' + i.id + '" data-url="' + esc(i.url) + '" data-branch="' + esc(i.branchName) + '" title="' + esc(i.title) + '">'
    + '<span class="issue-prio" title="' + esc(PRIO_LABEL[i.priority]) + '">' + (PRIO_ICON[i.priority] || PRIO_ICON[0]) + '</span>'
    + '<span class="issue-id">' + esc(i.identifier) + '</span>'
    + '<span class="issue-title">' + esc(i.title) + '</span>'
    + '<span class="issue-meta">' + chips.join(" ")
    + '<span class="issue-actions">'
    +   '<button class="icon-btn" data-inline-act="branch" title="Copy branch name"><svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="4" cy="4" r="2"/><circle cx="4" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><path d="M4 6v4M6 12h4"/><path d="M12 10V6a2 2 0 0 0-2-2H8"/></svg></button>'
    +   '<button class="icon-btn" data-inline-act="browser" title="Open in Linear"><svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M6 3H4a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h7a2 2 0 0 0 2-2v-2"/><path d="M10 2h4v4M14 2 8 8"/></svg></button>'
    + '</span>'
    + '</span>'
    + '</div>';
}

function renderGroup(g) {
  return '<div class="group">'
    + '<div class="group-head"><div class="group-title"><span class="state-dot" style="background:' + (g.items[0]?.stateColor || "#888") + '"></span>' + esc(g.label) + '</div><div class="group-count">' + g.items.length + '</div></div>'
    + g.items.map(renderIssue).join("")
    + '</div>';
}

function indexIssues(msg) {
  ISSUE_INDEX.clear();
  const push = (i) => ISSUE_INDEX.set(i.id, i);
  (msg.groups || []).forEach((g) => (g.items || []).forEach(push));
  (msg.createdByMe || []).forEach(push);
}

function render(msg) {
  try {
    $("error").hidden = true;
    indexIssues(msg);
    const counts = msg.counts || {};
    $("greeting").innerHTML = greetingFor(msg.me && (msg.me.displayName || msg.me.name));
    $("stat-total").textContent = counts.total ?? 0;
    $("stat-progress").textContent = counts.inProgress ?? 0;
    $("stat-todo").textContent = counts.todo ?? 0;
    $("stat-backlog").textContent = counts.backlog ?? 0;
    $("stat-created").textContent = counts.createdByMe ?? 0;

    const groups = $("groups");
    const gs = msg.groups || [];
    if (!gs.length) {
      groups.innerHTML = '<div class="empty">You have no assigned issues right now.<br/>Create one, or search across your workspace.</div>';
    } else {
      groups.innerHTML = gs.map(renderGroup).join("");
    }

    const cyclesEl = $("cycles");
    const cs = msg.cycles || [];
    if (!cs.length) {
      cyclesEl.innerHTML = '<div class="empty">No active cycles.</div>';
    } else {
      cyclesEl.innerHTML = cs.map((c) => {
        const ends = c.endsAt ? new Date(c.endsAt) : null;
        const daysLeft = ends && !isNaN(ends.getTime()) ? Math.max(0, Math.ceil((ends.getTime() - Date.now()) / 86400000)) : null;
        return '<div class="cycle"><div class="cycle-name">' + esc(c.teamName || "") + ' · Cycle ' + (c.number ?? "?") + (c.name ? ' — ' + esc(c.name) : '') + '</div>'
          + '<div class="cycle-sub">' + (daysLeft != null ? daysLeft + ' days remaining' : '—') + '</div></div>';
      }).join("");
    }

    const createdEl = $("created");
    const created = msg.createdByMe || [];
    if (!created.length) {
      createdEl.innerHTML = '<div class="empty">Nothing assigned to others.</div>';
    } else {
      createdEl.innerHTML = created.slice(0, 8).map((i) =>
        '<div class="mini-issue" data-issue-id="' + i.id + '" data-url="' + esc(i.url) + '" data-branch="' + esc(i.branchName) + '">'
        + '<div class="mini-id">' + esc(i.identifier) + ' · ' + esc(i.stateName) + '</div>'
        + '<div class="mini-title">' + esc(i.title) + '</div>'
        + '</div>'
      ).join("");
    }
  } catch (e) {
    const b = $("error"); b.hidden = false; b.textContent = "Render error: " + (e && e.message ? e.message : e);
  }
}

window.addEventListener("message", (event) => {
  const msg = event.data;
  if (!msg) return;
  if (msg.type === "loading") { $("loader").hidden = !msg.value; return; }
  if (msg.type === "error") {
    const b = $("error"); b.hidden = false; b.textContent = "Error: " + msg.message;
    setTimeout(() => b.hidden = true, 6000);
    return;
  }
  if (msg.type === "data") render(msg);
});

vscode.postMessage({ type: "ready" });
`;
