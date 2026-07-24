# Linear Manager for Cursor / VS Code

A complete Linear client inside Cursor. Browse issues, projects and cycles, edit them with a full webview editor, and glue Linear to your git workflow.

## Features

- **Activity bar sidebar** with six live views:
  - My Issues (grouped by workflow state)
  - Assigned to me
  - Teams → issues per team
  - Projects → issues per project
  - Current Cycle (per team)
  - Favorites (right-click any issue to pin)
- **Rich webview editor** — inline title, description (markdown), status, priority, assignee, labels, and threaded comments. Autosaves on blur.
- **Quick actions** on every issue (right-click or from the palette): change status / priority / assignee / labels, add a comment, copy branch name, create & checkout a git branch, open in browser, toggle favorite.
- **Fuzzy search** across all issues (`Cmd+Alt+L`).
- **Fast create** (`Cmd+Alt+Shift+L`) — pick team, type title, done.
- **Editor integration**:
  - Right-click a selection → **Create issue from selection** (auto-attaches file path, line range, and a code block).
  - Right-click a selection → **Attach code to issue** (posts as a comment on any issue you pick).
- **Status bar** shows the Linear issue linked to the current git branch (extracts `ABC-123` from the branch name). Click it to open the issue.
- **Auth**: OAuth 2.0 (recommended) or personal API key. Tokens live in VS Code SecretStorage.

## Install (development)

```bash
cd linear-manager
npm install
npm run compile
```

Open the folder in Cursor / VS Code and press `F5` to launch a new Extension Development Host with Linear Manager loaded.

To build a shareable `.vsix`:

```bash
npm i -g @vscode/vsce
vsce package
```

## Sign in

### OAuth (recommended)

1. Go to <https://linear.app/settings/api/applications> and create a new OAuth application.
2. Set the redirect URL to exactly: `http://localhost:51823/callback` (or any port; then set `linearManager.oauth.redirectPort` to match).
3. Copy the **Client ID** into `linearManager.oauth.clientId` (Settings → Extensions → Linear Manager).
4. Run **Linear: Sign in with OAuth** from the palette. When prompted, paste the **Client Secret** — it is stored in SecretStorage, not in settings.
5. Your browser opens Linear; approve access. The redirect returns to the local port and you're signed in.

### Personal API key (fastest)

1. Get a key at <https://linear.app/settings/api>.
2. Run **Linear: Sign in with Personal API Key** and paste it.

## Settings

| Setting | Default | Notes |
|---|---|---|
| `linearManager.oauth.clientId` | *(empty)* | Required for OAuth |
| `linearManager.oauth.redirectPort` | `51823` | Must match your Linear app's redirect URL |
| `linearManager.oauth.scopes` | `read,write,issues:create,comments:create` | Comma-separated |
| `linearManager.defaultTeam` | *(empty)* | Team key (e.g. `ENG`) used when creating issues |
| `linearManager.branchNameTemplate` | `{username}/{identifier}-{slug}` | Placeholders: `{identifier}`, `{slug}`, `{title}`, `{username}`, `{team}` |
| `linearManager.showStatusBar` | `true` | Show current-branch issue in the status bar |
| `linearManager.pollIntervalSeconds` | `120` | Background refresh cadence. `0` disables. |

## Keybindings

| Command | Mac | Win/Linux |
|---|---|---|
| Search issues | `Cmd+Alt+L` | `Ctrl+Alt+L` |
| Create issue | `Cmd+Alt+Shift+L` | `Ctrl+Alt+Shift+L` |

## MCP note

You already have Linear connected as an MCP server in Cursor — that gives the chat agent tool-calls against Linear. This extension is complementary: it provides the *UI* (tree views, rich editors, status bar, code-linking commands) that MCP alone doesn't offer. The extension talks to Linear directly via `@linear/sdk`; it does not proxy through MCP.

## Project layout

```
linear-manager/
├── package.json          extension manifest (views, commands, menus, config)
├── tsconfig.json
├── resources/linear.svg  activity bar icon
└── src/
    ├── extension.ts      activation & wiring
    ├── auth.ts           OAuth (local HTTP callback) + API key + SecretStorage
    ├── linear.ts         @linear/sdk wrapper, typed helpers, in-memory cache
    ├── treeProviders.ts  all six sidebar views
    ├── issueEditor.ts    full webview editor with CSP + nonce
    ├── commands.ts       every registered command
    ├── statusBar.ts      current-branch issue indicator
    └── util.ts           quick-picks, git helpers, branch formatting
```

## From the developer

Built by **Mayank Panchal**.

I use Linear every day and got tired of hopping between the browser and my editor just to check status, create an issue, or open the ticket tied to my branch. Cursor already talks to Linear through MCP for the agent — this extension is the missing UI: a real sidebar, a proper issue editor, and git-aware shortcuts that stay out of your way.

Sessions are meant to stick. Prefer a personal API key if you want sign-in-once forever; OAuth renews itself with refresh tokens so you aren’t kicked out every day.

If something breaks, feels slow, or you’d like a feature — open an issue on this repo. PRs are welcome.

— Mayank
