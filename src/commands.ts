import * as vscode from "vscode";
import { AuthManager } from "./auth";
import { LinearService, IssueSummary } from "./linear";
import { IssueEditor } from "./issueEditor";
import { Dashboard } from "./dashboard";
import { FavoritesProvider, IssueNode } from "./treeProviders";
import {
  pickIssue, pickTeam, pickQuick, currentGitBranch, createGitBranch,
  extractIssueIdentifier, formatBranchName, workspaceCwd,
} from "./util";

const PRIORITY_OPTIONS = [
  { label: "No priority", value: 0 },
  { label: "Urgent", value: 1 },
  { label: "High", value: 2 },
  { label: "Medium", value: 3 },
  { label: "Low", value: 4 },
];

function issueFromArg(arg: any): IssueSummary | undefined {
  if (!arg) return undefined;
  if (arg instanceof IssueNode) return arg.issue;
  if (arg.issue && typeof arg.issue === "object") return arg.issue;
  if (arg.id && arg.identifier) return arg as IssueSummary;
  return undefined;
}

export function registerCommands(
  ctx: vscode.ExtensionContext,
  auth: AuthManager,
  svc: LinearService,
  favs: FavoritesProvider,
) {
  const c = (id: string, fn: (...args: any[]) => any) => ctx.subscriptions.push(vscode.commands.registerCommand(id, fn));

  const ensureIssue = async (arg: any): Promise<IssueSummary | undefined> => {
    return issueFromArg(arg) ?? (await pickIssue(svc));
  };

  c("linear.signInOAuth", () => auth.signInWithOAuth());
  c("linear.signInApiKey", () => auth.signInWithApiKey());
  c("linear.signOut", () => auth.signOut());
  c("linear.refresh", () => svc.invalidate());
  c("linear.openDashboard", () => Dashboard.open(ctx, svc));

  c("linear.openIssue", async (arg: any) => {
    const issue = await ensureIssue(arg);
    if (issue) IssueEditor.open(ctx, svc, issue);
  });

  c("linear.openIssueInBrowser", async (arg: any) => {
    const issue = await ensureIssue(arg);
    if (issue) vscode.env.openExternal(vscode.Uri.parse(issue.url));
  });

  c("linear.openCurrentBranchIssue", async () => {
    const cwd = workspaceCwd();
    if (!cwd) return;
    const id = extractIssueIdentifier(await currentGitBranch(cwd));
    if (!id) { vscode.window.showInformationMessage("Current branch has no Linear ID."); return; }
    const issue = await svc.issueByIdentifier(id);
    if (issue) IssueEditor.open(ctx, svc, issue);
    else vscode.window.showWarningMessage(`Issue ${id} not found.`);
  });

  c("linear.searchIssues", async () => {
    const issue = await pickIssue(svc, "Search all Linear issues");
    if (issue) IssueEditor.open(ctx, svc, issue);
  });

  c("linear.createIssue", async (seed?: { title?: string; description?: string }) => {
    const teamId = await pickTeam(svc);
    if (!teamId) return;
    const title = await vscode.window.showInputBox({ title: "Issue title", value: seed?.title, ignoreFocusOut: true });
    if (!title) return;
    const description = await vscode.window.showInputBox({ title: "Description (optional)", value: seed?.description, ignoreFocusOut: true });
    const priority = await pickQuick(PRIORITY_OPTIONS.map((p) => ({ label: p.label, value: p.value })), { title: "Priority (optional)" });
    const created = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Creating Linear issue…" },
      () => svc.createIssue({ teamId, title, description: description || undefined, priority: priority ?? undefined }),
    );
    if (created) {
      const pick = await vscode.window.showInformationMessage(`Created ${created.identifier}`, "Open", "Copy branch");
      if (pick === "Open") IssueEditor.open(ctx, svc, created);
      else if (pick === "Copy branch") { vscode.env.clipboard.writeText(created.branchName); }
    }
  });

  c("linear.updateStatus", async (arg: any) => {
    const issue = await ensureIssue(arg); if (!issue) return;
    const team = (await svc.teams()).find((t) => t.key === issue.teamKey);
    if (!team) return;
    const states = await svc.statesForTeam(team.id);
    const pick = await pickQuick(states.map((s) => ({ label: s.name, description: s.type, value: s.id })), { title: "New status" });
    if (pick) { await svc.updateIssue(issue.id, { stateId: pick }); vscode.window.showInformationMessage(`${issue.identifier} → status updated`); }
  });

  c("linear.updatePriority", async (arg: any) => {
    const issue = await ensureIssue(arg); if (!issue) return;
    const pick = await pickQuick(PRIORITY_OPTIONS.map((p) => ({ label: p.label, value: p.value })), { title: "New priority" });
    if (pick !== undefined) { await svc.updateIssue(issue.id, { priority: pick }); vscode.window.showInformationMessage(`${issue.identifier} priority updated`); }
  });

  c("linear.updateAssignee", async (arg: any) => {
    const issue = await ensureIssue(arg); if (!issue) return;
    const team = (await svc.teams()).find((t) => t.key === issue.teamKey); if (!team) return;
    const members = await svc.membersForTeam(team.id);
    const opts = [{ label: "Unassigned", value: null as string | null }, ...members.map((u) => ({ label: u.displayName, description: u.email, value: u.id }))];
    const pick = await pickQuick(opts, { title: "Assign to" });
    if (pick !== undefined) { await svc.updateIssue(issue.id, { assigneeId: pick }); vscode.window.showInformationMessage(`${issue.identifier} assignee updated`); }
  });

  c("linear.updateLabels", async (arg: any) => {
    const issue = await ensureIssue(arg); if (!issue) return;
    const team = (await svc.teams()).find((t) => t.key === issue.teamKey); if (!team) return;
    const labels = await svc.labelsForTeam(team.id);
    const picked = await vscode.window.showQuickPick(
      labels.map((l) => ({ label: l.name, picked: issue.labelIds.includes(l.id), id: l.id })),
      { title: "Toggle labels", canPickMany: true },
    );
    if (picked) { await svc.updateIssue(issue.id, { labelIds: picked.map((p: any) => p.id) }); }
  });

  c("linear.addComment", async (arg: any) => {
    const issue = await ensureIssue(arg); if (!issue) return;
    const body = await vscode.window.showInputBox({ title: `Comment on ${issue.identifier}`, prompt: "Markdown supported", ignoreFocusOut: true });
    if (body?.trim()) { await svc.addComment(issue.id, body); vscode.window.showInformationMessage("Comment added"); }
  });

  c("linear.copyBranchName", async (arg: any) => {
    const issue = await ensureIssue(arg); if (!issue) return;
    await vscode.env.clipboard.writeText(issue.branchName);
    vscode.window.showInformationMessage(`Copied branch: ${issue.branchName}`);
  });

  c("linear.createBranch", async (arg: any) => {
    const issue = await ensureIssue(arg); if (!issue) return;
    const cwd = workspaceCwd();
    if (!cwd) { vscode.window.showErrorMessage("No workspace folder."); return; }
    const cfg = vscode.workspace.getConfiguration("linearManager");
    const template = cfg.get<string>("branchNameTemplate", "{username}/{identifier}-{slug}");
    const me = await svc.viewer();
    const name = await vscode.window.showInputBox({
      title: "Create git branch",
      value: formatBranchName(template, { identifier: issue.identifier, title: issue.title, username: me.displayName.toLowerCase().replace(/\s+/g, ""), team: issue.teamKey.toLowerCase() }),
      ignoreFocusOut: true,
    });
    if (!name) return;
    const res = await createGitBranch(cwd, name);
    if (res.ok) vscode.window.showInformationMessage(`Checked out ${name}`);
    else vscode.window.showErrorMessage(`git: ${res.err}`);
  });

  c("linear.favoriteIssue", async (arg: any) => {
    const issue = await ensureIssue(arg); if (!issue) return;
    await favs.toggle(issue.id);
  });

  c("linear.attachCodeReference", async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.selection.isEmpty) { vscode.window.showWarningMessage("Select some code first."); return; }
    const issue = await pickIssue(svc, "Attach code to which issue?");
    if (!issue) return;
    const link = codeBlockFor(editor);
    await svc.addComment(issue.id, link);
    vscode.window.showInformationMessage(`Attached code reference to ${issue.identifier}`);
  });

  c("linear.createIssueFromSelection", async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.selection.isEmpty) { vscode.window.showWarningMessage("Select some code first."); return; }
    const title = await vscode.window.showInputBox({ title: "Issue title", ignoreFocusOut: true });
    if (!title) return;
    const teamId = await pickTeam(svc); if (!teamId) return;
    const description = codeBlockFor(editor);
    const created = await svc.createIssue({ teamId, title, description });
    if (created) {
      const pick = await vscode.window.showInformationMessage(`Created ${created.identifier}`, "Open");
      if (pick === "Open") IssueEditor.open(ctx, svc, created);
    }
  });
}

function codeBlockFor(editor: vscode.TextEditor): string {
  const sel = editor.selection;
  const text = editor.document.getText(sel);
  const lang = editor.document.languageId;
  const path = vscode.workspace.asRelativePath(editor.document.uri);
  const line = sel.start.line + 1;
  const lineEnd = sel.end.line + 1;
  const range = line === lineEnd ? `L${line}` : `L${line}-L${lineEnd}`;
  return `**${path}:${range}**\n\n\`\`\`${lang}\n${text}\n\`\`\``;
}
