import { LinearClient } from "@linear/sdk";
import * as vscode from "vscode";
import { AuthManager, AuthState } from "./auth";

export interface IssueSummary {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  url: string;
  branchName: string;
  priority: number;
  priorityLabel: string;
  stateName: string;
  stateType: string;
  stateColor: string;
  teamKey: string;
  teamName: string;
  assigneeName: string | null;
  assigneeId: string | null;
  projectId: string | null;
  projectName: string | null;
  cycleId: string | null;
  cycleNumber: number | null;
  labelIds: string[];
  labelNames: string[];
  updatedAt: string;
}

export interface TeamRef { id: string; key: string; name: string; }
export interface StateRef { id: string; name: string; type: string; color: string; teamId: string; }
export interface LabelRef { id: string; name: string; color: string; teamId: string | null; }
export interface UserRef { id: string; name: string; displayName: string; email: string; }
export interface ProjectRef { id: string; name: string; state: string; url: string; }
export interface CycleRef { id: string; number: number; name: string | null; startsAt: string; endsAt: string; teamId: string; }

type Cache<T> = { at: number; ttl: number; value: T };

/**
 * GraphQL fragments that pull EVERY relationship we need in a single request.
 * Without these the SDK's lazy relations trigger one extra HTTP call each —
 * a 100-issue list would burn 600 requests, hitting Linear's 2500/hour cap fast.
 */
const ISSUE_FIELDS = `
  id identifier title description url branchName priority priorityLabel updatedAt
  state { id name type color }
  assignee { id name displayName email }
  team { id key name }
  project { id name state url }
  cycle { id number name startsAt endsAt }
  labels(first: 20) { nodes { id name color } }
`;

const Q_ISSUES = `query ManagerIssues($filter: IssueFilter, $first: Int!) {
  issues(filter: $filter, first: $first, orderBy: updatedAt) {
    nodes { ${ISSUE_FIELDS} }
  }
}`;

const Q_ISSUE = `query ManagerIssue($id: String!) {
  issue(id: $id) {
    ${ISSUE_FIELDS}
    comments(first: 50, orderBy: createdAt) {
      nodes { id body createdAt user { id displayName name } }
    }
  }
}`;

const Q_VIEWER = `query ManagerViewer { viewer { id name displayName email } }`;

const Q_TEAMS = `query ManagerTeams { teams(first: 100) { nodes { id key name } } }`;

const Q_STATES = `query ManagerStates($teamId: String!) {
  team(id: $teamId) { states(first: 50) { nodes { id name type color } } }
}`;

const Q_MEMBERS = `query ManagerMembers($teamId: String!) {
  team(id: $teamId) { members(first: 100) { nodes { id name displayName email } } }
}`;

const Q_LABELS = `query ManagerLabels($teamId: ID!) {
  issueLabels(first: 200, filter: { team: { id: { eq: $teamId } } }) {
    nodes { id name color }
  }
}`;

const Q_PROJECTS = `query ManagerProjects { projects(first: 100) { nodes { id name state url } } }`;

const Q_TEAMS_CYCLES = `query ManagerTeamsCycles {
  teams(first: 100) {
    nodes {
      id key name
      activeCycle { id number name startsAt endsAt }
    }
  }
}`;

const Q_UPDATE_ISSUE = `mutation ManagerUpdate($id: String!, $input: IssueUpdateInput!) {
  issueUpdate(id: $id, input: $input) { success }
}`;

const Q_CREATE_ISSUE = `mutation ManagerCreate($input: IssueCreateInput!) {
  issueCreate(input: $input) { success issue { ${ISSUE_FIELDS} } }
}`;

const Q_ADD_COMMENT = `mutation ManagerComment($issueId: String!, $body: String!) {
  commentCreate(input: { issueId: $issueId, body: $body }) { success }
}`;

export class LinearService {
  private client: LinearClient | undefined;
  private boundToken: string | undefined;
  private me: UserRef | undefined;
  private readonly caches = new Map<string, Cache<any>>();
  private readonly inflight = new Map<string, Promise<any>>();

  /** Coalesces rapid onDidChange bursts (edits fire many events in a row). */
  private changeTimer: NodeJS.Timeout | undefined;

  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  constructor(private readonly auth: AuthManager) {
    auth.onDidChange((s) => this.applyAuth(s));
  }

  async init() {
    const state = await this.auth.ensureValidState();
    this.applyAuth(state);
  }

  isSignedIn(): boolean { return !!this.client; }

  invalidate(prefix?: string) {
    if (!prefix) this.caches.clear();
    else for (const k of [...this.caches.keys()]) if (k.startsWith(prefix)) this.caches.delete(k);
    this.emitChange();
  }

  private emitChange() {
    if (this.changeTimer) return;
    this.changeTimer = setTimeout(() => {
      this.changeTimer = undefined;
      this._onDidChange.fire();
    }, 120);
  }

  private applyAuth(state: AuthState | undefined) {
    this.client = state
      ? new LinearClient({ [state.kind === "oauth" ? "accessToken" : "apiKey"]: state.token } as any)
      : undefined;
    this.boundToken = state?.token;
    this.me = undefined;
    this.caches.clear();
    this.inflight.clear();
    this.emitChange();
  }

  private async c(): Promise<LinearClient> {
    const state = await this.auth.ensureValidState();
    if (!state) { this.applyAuth(undefined); throw new Error("Not signed in to Linear"); }
    if (!this.client || this.boundToken !== state.token) this.applyAuth(state);
    if (!this.client) throw new Error("Not signed in to Linear");
    return this.client;
  }

  private isAuthError(err: any): boolean {
    const msg = String(err?.message ?? err ?? "");
    const status = err?.status ?? err?.statusCode ?? err?.response?.status;
    return status === 401 || status === 403 || /unauthoriz|authenticat|forbidden|invalid.?token|not signed in/i.test(msg);
  }

  private isRateLimit(err: any): boolean {
    const msg = String(err?.message ?? err ?? "");
    const status = err?.status ?? err?.statusCode ?? err?.response?.status;
    return status === 429 || /rate.?limit|too many requests/i.test(msg);
  }

  private async gql<T>(query: string, variables?: any, attempt = 0): Promise<T> {
    const client = await this.c();
    try {
      const anyClient = client as any;
      const raw = anyClient?.client;
      if (!raw?.rawRequest) throw new Error("Linear SDK missing rawRequest — cannot batch queries");
      const res = await raw.rawRequest(query, variables ?? {});
      return res.data as T;
    } catch (err: any) {
      if (this.isAuthError(err) && attempt === 0) {
        const refreshed = await this.auth.handleUnauthorized();
        if (!refreshed) { this.applyAuth(undefined); throw new Error("Not signed in to Linear"); }
        this.applyAuth(refreshed);
        return this.gql<T>(query, variables, attempt + 1);
      }
      if (this.isRateLimit(err) && attempt < 2) {
        const backoff = 1500 * Math.pow(2, attempt) + Math.floor(Math.random() * 500);
        await new Promise((r) => setTimeout(r, backoff));
        return this.gql<T>(query, variables, attempt + 1);
      }
      throw err;
    }
  }

  /**
   * Cache with single-flight: N callers requesting the same key while a
   * request is in flight all wait on that one promise instead of each firing.
   */
  private async cached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
    const hit = this.caches.get(key);
    if (hit && Date.now() - hit.at < hit.ttl) return hit.value as T;
    const existing = this.inflight.get(key);
    if (existing) return existing as Promise<T>;
    const p = (async () => {
      try {
        const value = await load();
        this.caches.set(key, { at: Date.now(), ttl: ttlMs, value });
        return value;
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, p);
    return p;
  }

  async viewer(): Promise<UserRef> {
    if (this.me) return this.me;
    const data = await this.gql<{ viewer: UserRef }>(Q_VIEWER);
    this.me = data.viewer;
    return this.me;
  }

  async teams(): Promise<TeamRef[]> {
    return this.cached("teams", 15 * 60_000, async () => {
      const data = await this.gql<{ teams: { nodes: TeamRef[] } }>(Q_TEAMS);
      return data.teams.nodes;
    });
  }

  async statesForTeam(teamId: string): Promise<StateRef[]> {
    return this.cached(`states:${teamId}`, 15 * 60_000, async () => {
      const data = await this.gql<{ team: { states: { nodes: any[] } } }>(Q_STATES, { teamId });
      return data.team.states.nodes.map((s) => ({ id: s.id, name: s.name, type: s.type, color: s.color, teamId }));
    });
  }

  async labelsForTeam(teamId: string): Promise<LabelRef[]> {
    return this.cached(`labels:${teamId}`, 15 * 60_000, async () => {
      const data = await this.gql<{ issueLabels: { nodes: any[] } }>(Q_LABELS, { teamId });
      return data.issueLabels.nodes.map((l) => ({ id: l.id, name: l.name, color: l.color, teamId }));
    });
  }

  async membersForTeam(teamId: string): Promise<UserRef[]> {
    return this.cached(`members:${teamId}`, 15 * 60_000, async () => {
      const data = await this.gql<{ team: { members: { nodes: UserRef[] } } }>(Q_MEMBERS, { teamId });
      return data.team.members.nodes;
    });
  }

  async projects(): Promise<ProjectRef[]> {
    return this.cached("projects", 10 * 60_000, async () => {
      const data = await this.gql<{ projects: { nodes: ProjectRef[] } }>(Q_PROJECTS);
      return data.projects.nodes;
    });
  }

  async currentCycles(): Promise<CycleRef[]> {
    return this.cached("cycles:current", 5 * 60_000, async () => {
      const data = await this.gql<{ teams: { nodes: any[] } }>(Q_TEAMS_CYCLES);
      const out: CycleRef[] = [];
      for (const t of data.teams.nodes) {
        if (t.activeCycle) {
          out.push({
            id: t.activeCycle.id,
            number: t.activeCycle.number,
            name: t.activeCycle.name ?? null,
            startsAt: t.activeCycle.startsAt ?? "",
            endsAt: t.activeCycle.endsAt ?? "",
            teamId: t.id,
          });
        }
      }
      return out;
    });
  }

  private toSummaryFromRaw(n: any): IssueSummary {
    return {
      id: n.id,
      identifier: n.identifier,
      title: n.title,
      description: n.description ?? null,
      url: n.url,
      branchName: n.branchName,
      priority: n.priority ?? 0,
      priorityLabel: n.priorityLabel ?? "",
      stateName: n.state?.name ?? "—",
      stateType: n.state?.type ?? "unstarted",
      stateColor: n.state?.color ?? "#888",
      teamKey: n.team?.key ?? "",
      teamName: n.team?.name ?? "",
      assigneeName: n.assignee?.displayName ?? null,
      assigneeId: n.assignee?.id ?? null,
      projectId: n.project?.id ?? null,
      projectName: n.project?.name ?? null,
      cycleId: n.cycle?.id ?? null,
      cycleNumber: n.cycle?.number ?? null,
      labelIds: (n.labels?.nodes ?? []).map((l: any) => l.id),
      labelNames: (n.labels?.nodes ?? []).map((l: any) => l.name),
      updatedAt: n.updatedAt ?? "",
    };
  }

  private async fetchIssues(cacheKey: string, ttlMs: number, filter: any, first = 100): Promise<IssueSummary[]> {
    return this.cached(cacheKey, ttlMs, async () => {
      const data = await this.gql<{ issues: { nodes: any[] } }>(Q_ISSUES, { filter, first });
      return data.issues.nodes.map((n) => this.toSummaryFromRaw(n));
    });
  }

  async myIssues(opts: { includeDone?: boolean } = {}): Promise<IssueSummary[]> {
    const me = await this.viewer();
    const key = opts.includeDone ? "issues:mine:all" : "issues:mine";
    const filter: any = { assignee: { id: { eq: me.id } } };
    if (!opts.includeDone) filter.state = { type: { nin: ["completed", "canceled"] } };
    return this.fetchIssues(key, 90_000, filter, 200);
  }

  async myIssuesForTeam(teamId: string): Promise<IssueSummary[]> {
    const me = await this.viewer();
    return this.fetchIssues(`issues:mine:team:${teamId}`, 90_000, {
      assignee: { id: { eq: me.id } },
      team: { id: { eq: teamId } },
      state: { type: { nin: ["completed", "canceled"] } },
    });
  }

  async myIssuesForProject(projectId: string): Promise<IssueSummary[]> {
    const me = await this.viewer();
    return this.fetchIssues(`issues:mine:project:${projectId}`, 90_000, {
      assignee: { id: { eq: me.id } },
      project: { id: { eq: projectId } },
    });
  }

  async myIssuesForCycle(cycleId: string): Promise<IssueSummary[]> {
    const me = await this.viewer();
    return this.fetchIssues(`issues:mine:cycle:${cycleId}`, 90_000, {
      assignee: { id: { eq: me.id } },
      cycle: { id: { eq: cycleId } },
    });
  }

  /** Reuses cached myIssues to derive the user's active teams — zero extra network calls. */
  async myTeams(): Promise<TeamRef[]> {
    return this.cached("teams:mine", 5 * 60_000, async () => {
      const mine = await this.myIssues();
      const keys = new Set(mine.map((i) => i.teamKey).filter(Boolean));
      const all = await this.teams();
      return all.filter((t) => keys.has(t.key));
    });
  }

  async myProjects(): Promise<ProjectRef[]> {
    return this.cached("projects:mine", 5 * 60_000, async () => {
      const mine = await this.myIssues();
      const ids = new Set(mine.map((i) => i.projectId).filter((x): x is string => !!x));
      if (!ids.size) return [];
      const all = await this.projects();
      return all.filter((p) => ids.has(p.id));
    });
  }

  async createdByMe(): Promise<IssueSummary[]> {
    const me = await this.viewer();
    const issues = await this.fetchIssues("issues:created", 3 * 60_000, {
      creator: { id: { eq: me.id } },
      state: { type: { nin: ["completed", "canceled"] } },
    });
    return issues.filter((i) => i.assigneeId !== me.id);
  }

  async dashboard(): Promise<{
    me: UserRef;
    issues: IssueSummary[];
    createdByMe: IssueSummary[];
    activeCycles: (CycleRef & { teamName: string })[];
  }> {
    const [me, issues, created, cycles, teams] = await Promise.all([
      this.viewer(),
      this.myIssues().catch(() => []),
      this.createdByMe().catch(() => []),
      this.currentCycles().catch(() => []),
      this.teams().catch(() => []),
    ]);
    const tMap = new Map(teams.map((t) => [t.id, t.name]));
    return {
      me,
      issues,
      createdByMe: created,
      activeCycles: cycles.map((c) => ({ ...c, teamName: tMap.get(c.teamId) ?? "" })),
    };
  }

  async searchIssues(query: string): Promise<IssueSummary[]> {
    if (!query.trim()) return [];
    const data = await this.gql<{ searchIssues: { nodes: any[] } }>(
      `query ManagerSearch($term: String!, $first: Int!) {
        searchIssues(term: $term, first: $first) { nodes { ${ISSUE_FIELDS} } }
      }`,
      { term: query, first: 25 },
    );
    return data.searchIssues.nodes.map((n) => this.toSummaryFromRaw(n));
  }

  async issueByIdentifier(identifier: string): Promise<IssueSummary | undefined> {
    const parts = identifier.split("-");
    if (parts.length !== 2) return undefined;
    const teamKey = parts[0];
    const number = parseInt(parts[1], 10);
    if (!teamKey || isNaN(number)) return undefined;
    const data = await this.gql<{ issues: { nodes: any[] } }>(Q_ISSUES, {
      filter: { number: { eq: number }, team: { key: { eq: teamKey } } },
      first: 1,
    });
    const n = data.issues.nodes[0];
    return n ? this.toSummaryFromRaw(n) : undefined;
  }

  async issueById(id: string): Promise<IssueSummary> {
    const data = await this.gql<{ issue: any }>(Q_ISSUE, { id });
    return this.toSummaryFromRaw(data.issue);
  }

  async issueFull(id: string): Promise<{
    summary: IssueSummary;
    states: StateRef[];
    members: UserRef[];
    labels: LabelRef[];
    comments: { id: string; body: string; user: string; createdAt: string }[];
  }> {
    const data = await this.gql<{ issue: any }>(Q_ISSUE, { id });
    const n = data.issue;
    const summary = this.toSummaryFromRaw(n);
    const teamId = n.team?.id;
    const [states, members, labels] = teamId
      ? await Promise.all([this.statesForTeam(teamId), this.membersForTeam(teamId), this.labelsForTeam(teamId)])
      : [[] as StateRef[], [] as UserRef[], [] as LabelRef[]];
    const comments = (n.comments?.nodes ?? []).map((c: any) => ({
      id: c.id,
      body: c.body,
      user: c.user?.displayName ?? c.user?.name ?? "unknown",
      createdAt: c.createdAt ?? "",
    }));
    return { summary, states, members, labels, comments };
  }

  async createIssue(input: {
    teamId: string; title: string; description?: string; assigneeId?: string; stateId?: string;
    priority?: number; labelIds?: string[]; projectId?: string; cycleId?: string;
  }): Promise<IssueSummary | undefined> {
    const data = await this.gql<{ issueCreate: { success: boolean; issue: any } }>(Q_CREATE_ISSUE, { input });
    this.invalidate("issues:");
    return data.issueCreate?.issue ? this.toSummaryFromRaw(data.issueCreate.issue) : undefined;
  }

  async updateIssue(id: string, input: Partial<{
    title: string; description: string; stateId: string; priority: number; assigneeId: string | null;
    labelIds: string[]; projectId: string | null; cycleId: string | null;
  }>) {
    await this.gql(Q_UPDATE_ISSUE, { id, input });
    this.invalidate("issues:");
  }

  async addComment(issueId: string, body: string) {
    await this.gql(Q_ADD_COMMENT, { issueId, body });
    this.invalidate("issues:");
  }
}
