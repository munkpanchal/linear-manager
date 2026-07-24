import * as vscode from "vscode";
import { LinearService } from "./linear";
import { currentGitBranch, extractIssueIdentifier, workspaceCwd } from "./util";

export class StatusBar {
  private readonly item: vscode.StatusBarItem;
  private timer?: NodeJS.Timeout;

  constructor(private readonly svc: LinearService) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.item.command = "linear.openCurrentBranchIssue";
    svc.onDidChange(() => this.refresh());
  }

  start(ctx: vscode.ExtensionContext) {
    ctx.subscriptions.push(this.item, {
      dispose: () => this.timer && clearInterval(this.timer),
    });
    this.timer = setInterval(() => this.refresh(), 30_000);
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("linearManager.showStatusBar")) this.refresh();
    }, undefined, ctx.subscriptions);
    this.refresh();
  }

  async refresh() {
    const cfg = vscode.workspace.getConfiguration("linearManager");
    if (!cfg.get<boolean>("showStatusBar", true) || !this.svc.isSignedIn()) {
      this.item.hide();
      return;
    }
    const cwd = workspaceCwd();
    if (!cwd) { this.item.hide(); return; }
    const branch = await currentGitBranch(cwd);
    const id = extractIssueIdentifier(branch);
    if (!id) { this.item.hide(); return; }
    try {
      const issue = await this.svc.issueByIdentifier(id);
      if (!issue) { this.item.text = `$(git-branch) ${id} (not found)`; this.item.show(); return; }
      this.item.text = `$(git-branch) ${issue.identifier} · ${issue.stateName}`;
      this.item.tooltip = new vscode.MarkdownString(`**${issue.identifier}** ${issue.title}\n\n_${issue.stateName}_ · ${issue.priorityLabel}\n\nClick to open.`);
      this.item.show();
    } catch {
      this.item.hide();
    }
  }
}
