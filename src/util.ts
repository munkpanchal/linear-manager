import * as vscode from "vscode";
import * as cp from "child_process";
import { LinearService, IssueSummary } from "./linear";

export function pickQuick<T>(items: (vscode.QuickPickItem & { value: T })[], opts: vscode.QuickPickOptions = {}): Thenable<T | undefined> {
  return vscode.window.showQuickPick(items, opts).then((r) => (r as any)?.value);
}

export async function pickTeam(svc: LinearService): Promise<string | undefined> {
  const cfg = vscode.workspace.getConfiguration("linearManager");
  const defaultKey = cfg.get<string>("defaultTeam", "");
  const teams = await svc.teams();
  if (defaultKey) {
    const m = teams.find((t) => t.key.toLowerCase() === defaultKey.toLowerCase());
    if (m) return m.id;
  }
  if (teams.length === 1) return teams[0].id;
  return pickQuick(
    teams.map((t) => ({ label: `${t.key} — ${t.name}`, value: t.id })),
    { title: "Select team", matchOnDetail: true },
  );
}

export async function pickIssue(svc: LinearService, prompt = "Search Linear issues"): Promise<IssueSummary | undefined> {
  const qp = vscode.window.createQuickPick<vscode.QuickPickItem & { issue?: IssueSummary }>();
  qp.title = prompt;
  qp.placeholder = "Type to search…";
  qp.matchOnDescription = true;
  qp.matchOnDetail = true;

  let seq = 0;
  const run = async (value: string) => {
    const mine = ++seq;
    qp.busy = true;
    const items = value.trim() ? await svc.searchIssues(value) : await svc.myIssues();
    if (mine !== seq) return;
    qp.items = items.map((i) => ({
      label: `${i.identifier}  ${i.title}`,
      description: `${i.stateName} · ${i.priorityLabel}${i.assigneeName ? " · " + i.assigneeName : ""}`,
      detail: i.projectName ?? undefined,
      issue: i,
    }));
    qp.busy = false;
  };

  qp.onDidChangeValue(run);
  await run("");
  qp.show();
  return new Promise((resolve) => {
    qp.onDidAccept(() => {
      const sel = qp.activeItems[0];
      qp.hide();
      resolve(sel?.issue);
    });
    qp.onDidHide(() => resolve(undefined));
  });
}

export function currentGitBranch(cwd: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    cp.exec("git rev-parse --abbrev-ref HEAD", { cwd }, (err, stdout) => {
      if (err) return resolve(undefined);
      resolve(stdout.trim() || undefined);
    });
  });
}

export function createGitBranch(cwd: string, name: string): Promise<{ ok: boolean; err?: string }> {
  return new Promise((resolve) => {
    cp.exec(`git checkout -b ${JSON.stringify(name)}`, { cwd }, (err, _o, stderr) => {
      if (err) resolve({ ok: false, err: stderr || err.message });
      else resolve({ ok: true });
    });
  });
}

export function extractIssueIdentifier(branch: string | undefined): string | undefined {
  if (!branch) return undefined;
  const m = branch.match(/([A-Z][A-Z0-9]+)-(\d+)/);
  return m ? `${m[1]}-${m[2]}` : undefined;
}

export function formatBranchName(template: string, ctx: { identifier: string; title: string; username: string; team: string }): string {
  const slug = ctx.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return template
    .replace(/\{identifier\}/g, ctx.identifier.toLowerCase())
    .replace(/\{slug\}/g, slug)
    .replace(/\{title\}/g, ctx.title)
    .replace(/\{username\}/g, ctx.username)
    .replace(/\{team\}/g, ctx.team);
}

export function workspaceCwd(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}
