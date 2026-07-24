import * as vscode from "vscode";
import { LinearService, IssueSummary, ProjectRef, CycleRef, TeamRef } from "./linear";

const STATE_ICON: Record<string, string> = {
  backlog: "circle-large-outline",
  unstarted: "circle-outline",
  started: "sync",
  completed: "check",
  canceled: "circle-slash",
  triage: "question",
};

const PRIORITY_COLOR: Record<number, string> = {
  1: "charts.red",
  2: "charts.orange",
  3: "charts.yellow",
  4: "charts.blue",
  0: "descriptionForeground",
};

export class IssueNode extends vscode.TreeItem {
  constructor(public readonly issue: IssueSummary) {
    super(`${issue.identifier}  ${issue.title}`, vscode.TreeItemCollapsibleState.None);
    this.contextValue = "linearIssue";
    const tt = new vscode.MarkdownString(undefined, true);
    tt.isTrusted = true;
    tt.appendMarkdown(`**${issue.identifier}** · ${escapeMd(issue.title)}\n\n`);
    tt.appendMarkdown(`$(circle-filled) _${issue.stateName}_ · ${issue.priorityLabel}`);
    if (issue.assigneeName) tt.appendMarkdown(` · @${issue.assigneeName}`);
    tt.appendMarkdown(`\n\n`);
    if (issue.projectName) tt.appendMarkdown(`📁 ${issue.projectName}\n\n`);
    if (issue.cycleNumber != null) tt.appendMarkdown(`🗓 Cycle ${issue.cycleNumber}\n\n`);
    if (issue.labelNames.length) tt.appendMarkdown(`🏷 ${issue.labelNames.join(", ")}\n\n`);
    if (issue.description) tt.appendMarkdown(`\n${issue.description.slice(0, 280)}${issue.description.length > 280 ? "…" : ""}`);
    this.tooltip = tt;
    this.description = `${issue.stateName}${issue.projectName ? " · " + issue.projectName : ""}`;
    this.iconPath = new vscode.ThemeIcon(
      STATE_ICON[issue.stateType] ?? "circle-outline",
      new vscode.ThemeColor(PRIORITY_COLOR[issue.priority] ?? "charts.blue"),
    );
    this.command = { command: "linear.openIssue", title: "Open Issue", arguments: [issue] };
  }
}

class GroupNode extends vscode.TreeItem {
  constructor(label: string, public readonly children: vscode.TreeItem[], icon?: string, expanded = true) {
    super(label, expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
    this.iconPath = icon ? new vscode.ThemeIcon(icon) : undefined;
    this.description = `${children.length}`;
    this.contextValue = "linearGroup";
  }
}

class MessageNode extends vscode.TreeItem {
  constructor(msg: string, icon = "info") {
    super(msg, vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon(icon);
    this.contextValue = "linearMessage";
  }
}

function groupByState(issues: IssueSummary[]): GroupNode[] {
  const order = ["started", "unstarted", "backlog", "triage", "completed", "canceled"];
  const buckets = new Map<string, IssueSummary[]>();
  for (const i of issues) {
    const k = i.stateType;
    (buckets.get(k) ?? buckets.set(k, []).get(k)!).push(i);
  }
  return order
    .filter((k) => buckets.has(k))
    .map((k) => new GroupNode(
      labelForState(k),
      buckets.get(k)!.map((i) => new IssueNode(i)),
      STATE_ICON[k],
      k === "started" || k === "unstarted",
    ));
}

function labelForState(k: string): string {
  return { started: "In Progress", unstarted: "Todo", backlog: "Backlog", triage: "Triage", completed: "Done", canceled: "Canceled" }[k] ?? k;
}

abstract class BaseProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  protected readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  constructor(protected readonly svc: LinearService) {
    svc.onDidChange(() => this._onDidChange.fire());
  }

  getTreeItem(el: vscode.TreeItem) { return el; }

  abstract getChildren(el?: vscode.TreeItem): Promise<vscode.TreeItem[]>;

  refresh() { this._onDidChange.fire(); }
}

export class MyIssuesProvider extends BaseProvider {
  async getChildren(el?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
    if (!this.svc.isSignedIn()) return [];
    if (el instanceof GroupNode) return el.children;
    try {
      const items = await this.svc.myIssues();
      return items.length ? groupByState(items) : [new MessageNode("You're all caught up. No open issues.", "check")];
    } catch (e: any) {
      return [new MessageNode(`Error: ${e.message}`, "error")];
    }
  }
}

export class CreatedByMeProvider extends BaseProvider {
  async getChildren(el?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
    if (!this.svc.isSignedIn()) return [];
    if (el instanceof GroupNode) return el.children;
    try {
      const items = await this.svc.createdByMe();
      return items.length ? groupByState(items) : [new MessageNode("No open issues you created for others.", "check")];
    } catch (e: any) {
      return [new MessageNode(`Error: ${e.message}`, "error")];
    }
  }
}

class TeamNode extends vscode.TreeItem {
  constructor(public readonly team: TeamRef) {
    super(`${team.key} — ${team.name}`, vscode.TreeItemCollapsibleState.Collapsed);
    this.iconPath = new vscode.ThemeIcon("organization");
    this.contextValue = "linearTeam";
  }
}

export class TeamsProvider extends BaseProvider {
  async getChildren(el?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
    if (!this.svc.isSignedIn()) return [];
    if (!el) {
      const teams = await this.svc.myTeams();
      if (!teams.length) return [new MessageNode("You have no issues in any team.", "info")];
      return teams.map((t) => new TeamNode(t));
    }
    if (el instanceof TeamNode) {
      const items = await this.svc.myIssuesForTeam(el.team.id);
      return items.length ? groupByState(items) : [new MessageNode("Nothing assigned in this team.", "check")];
    }
    if (el instanceof GroupNode) return el.children;
    return [];
  }
}

class ProjectNode extends vscode.TreeItem {
  constructor(public readonly project: ProjectRef) {
    super(project.name, vscode.TreeItemCollapsibleState.Collapsed);
    this.iconPath = new vscode.ThemeIcon("project");
    this.description = project.state;
    this.contextValue = "linearProject";
  }
}

export class ProjectsProvider extends BaseProvider {
  async getChildren(el?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
    if (!this.svc.isSignedIn()) return [];
    if (!el) {
      const projects = await this.svc.myProjects();
      if (!projects.length) return [new MessageNode("None of your issues belong to a project.", "info")];
      return projects.map((p) => new ProjectNode(p));
    }
    if (el instanceof ProjectNode) {
      const items = await this.svc.myIssuesForProject(el.project.id);
      return items.length ? groupByState(items) : [new MessageNode("Nothing assigned in this project.", "check")];
    }
    if (el instanceof GroupNode) return el.children;
    return [];
  }
}

class CycleNode extends vscode.TreeItem {
  constructor(public readonly cycle: CycleRef, teamName: string) {
    super(`${teamName} · Cycle ${cycle.number}${cycle.name ? " — " + cycle.name : ""}`, vscode.TreeItemCollapsibleState.Expanded);
    this.iconPath = new vscode.ThemeIcon("calendar");
    this.contextValue = "linearCycle";
  }
}

export class CyclesProvider extends BaseProvider {
  async getChildren(el?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
    if (!this.svc.isSignedIn()) return [];
    if (!el) {
      const [cycles, teams] = await Promise.all([this.svc.currentCycles(), this.svc.teams()]);
      const tMap = new Map(teams.map((t) => [t.id, t.name]));
      if (!cycles.length) return [new MessageNode("No active cycles.", "calendar")];
      return cycles.map((c) => new CycleNode(c, tMap.get(c.teamId) ?? ""));
    }
    if (el instanceof CycleNode) {
      const items = await this.svc.myIssuesForCycle(el.cycle.id);
      return items.length ? groupByState(items) : [new MessageNode("Nothing assigned in this cycle.", "check")];
    }
    if (el instanceof GroupNode) return el.children;
    return [];
  }
}

const FAV_KEY = "linear.favorites";

export class FavoritesProvider extends BaseProvider {
  constructor(svc: LinearService, private readonly ctx: vscode.ExtensionContext) {
    super(svc);
  }

  async getChildren(el?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
    if (!this.svc.isSignedIn()) return [];
    if (el instanceof GroupNode) return el.children;
    const ids: string[] = this.ctx.globalState.get(FAV_KEY, []);
    if (!ids.length) return [new MessageNode("Right-click any issue → Toggle Favorite.", "star")];
    const items = await Promise.all(ids.map((id) => this.svc.issueById(id).catch(() => undefined)));
    return items.filter(Boolean).map((i) => new IssueNode(i as IssueSummary));
  }

  async toggle(issueId: string) {
    const ids: string[] = this.ctx.globalState.get(FAV_KEY, []);
    const idx = ids.indexOf(issueId);
    if (idx >= 0) ids.splice(idx, 1); else ids.push(issueId);
    await this.ctx.globalState.update(FAV_KEY, ids);
    this._onDidChange.fire();
  }
}

function escapeMd(s: string): string {
  return String(s ?? "").replace(/([\\`*_{}\[\]()#+\-!])/g, "\\$1");
}
