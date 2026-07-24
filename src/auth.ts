import * as vscode from "vscode";
import * as http from "http";
import * as crypto from "crypto";
import { URL } from "url";

const SECRET_TOKEN = "linear.accessToken";
const SECRET_TOKEN_KIND = "linear.tokenKind";
const SECRET_CLIENT_SECRET = "linear.clientSecret";
const SECRET_REFRESH = "linear.refreshToken";
const SECRET_EXPIRES_AT = "linear.expiresAt";

/** Refresh a few minutes before expiry so API calls never hit a dead token. */
const REFRESH_SKEW_MS = 5 * 60_000;

export type TokenKind = "oauth" | "apiKey";

export interface AuthState {
  token: string;
  kind: TokenKind;
}

interface OAuthTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

export class AuthManager {
  private readonly _onDidChange = new vscode.EventEmitter<AuthState | undefined>();
  readonly onDidChange = this._onDidChange.event;

  /** Single-flight refresh so concurrent API calls don't rotate the refresh token twice. */
  private refreshInFlight: Promise<AuthState | undefined> | undefined;

  constructor(private readonly ctx: vscode.ExtensionContext) {}

  async getState(): Promise<AuthState | undefined> {
    const token = await this.ctx.secrets.get(SECRET_TOKEN);
    if (!token) return undefined;
    const kind = ((await this.ctx.secrets.get(SECRET_TOKEN_KIND)) as TokenKind) || "apiKey";
    return { token, kind };
  }

  /**
   * Returns a usable auth state. For OAuth, refreshes the access token when
   * it is missing expiry metadata or within REFRESH_SKEW_MS of expiring.
   * API keys never expire and are returned as-is.
   */
  async ensureValidState(): Promise<AuthState | undefined> {
    const state = await this.getState();
    if (!state) {
      await this.setSignedInContext(false);
      return undefined;
    }
    if (state.kind === "apiKey") {
      await this.setSignedInContext(true);
      return state;
    }

    const expiresAtRaw = await this.ctx.secrets.get(SECRET_EXPIRES_AT);
    const expiresAt = expiresAtRaw ? Number(expiresAtRaw) : 0;
    const refreshToken = await this.ctx.secrets.get(SECRET_REFRESH);
    const needsRefresh = !expiresAt || Date.now() >= expiresAt - REFRESH_SKEW_MS;

    if (needsRefresh) {
      if (!refreshToken) {
        // Legacy OAuth session without a refresh token — force re-auth once.
        await this.clearTokens(false);
        await this.setSignedInContext(false);
        vscode.window.showWarningMessage(
          "Linear session expired. Sign in again — new sessions stay signed in automatically.",
          "Sign in with API key",
          "Sign in with OAuth",
        ).then((pick) => {
          if (pick === "Sign in with API key") vscode.commands.executeCommand("linear.signInApiKey");
          else if (pick === "Sign in with OAuth") vscode.commands.executeCommand("linear.signInOAuth");
        });
        return undefined;
      }
      const refreshed = await this.refreshOAuthToken(refreshToken);
      await this.setSignedInContext(!!refreshed);
      return refreshed;
    }

    await this.setSignedInContext(true);
    return state;
  }

  async signInWithApiKey(): Promise<AuthState | undefined> {
    const choice = await vscode.window.showInformationMessage(
      "Sign in to Linear with a personal API key (recommended — does not expire).",
      { modal: false },
      "Open Linear API settings",
      "I already have a key",
      "Cancel",
    );
    if (!choice || choice === "Cancel") return undefined;
    if (choice === "Open Linear API settings") {
      await vscode.env.openExternal(vscode.Uri.parse("https://linear.app/settings/api"));
    }
    const key = await vscode.window.showInputBox({
      title: "Paste your Linear personal API key",
      prompt: "It starts with lin_api_. Stored securely in VS Code SecretStorage and persists across reloads.",
      password: true,
      ignoreFocusOut: true,
      placeHolder: "lin_api_...",
      validateInput: (v) => {
        if (!v) return "Required";
        const t = v.trim();
        if (!t.startsWith("lin_api_")) return "Expected a key starting with lin_api_";
        return undefined;
      },
    });
    if (!key) return undefined;
    const trimmed = key.trim();
    await this.clearTokens(true);
    await this.ctx.secrets.store(SECRET_TOKEN, trimmed);
    await this.ctx.secrets.store(SECRET_TOKEN_KIND, "apiKey");
    const state: AuthState = { token: trimmed, kind: "apiKey" };
    await this.setSignedInContext(true);
    this._onDidChange.fire(state);
    vscode.window.showInformationMessage("Signed in to Linear. You won't need to sign in again.");
    return state;
  }

  async signInWithOAuth(): Promise<AuthState | undefined> {
    const cfg = vscode.workspace.getConfiguration("linearManager");
    const clientId = cfg.get<string>("oauth.clientId", "").trim();
    const port = cfg.get<number>("oauth.redirectPort", 51823);
    const scopes = cfg.get<string>("oauth.scopes", "read,write,issues:create,comments:create");

    if (!clientId) {
      const pick = await vscode.window.showErrorMessage(
        "OAuth client ID is not configured. Register a Linear OAuth app first — or use a personal API key instead.",
        "Use API key",
        "Open Linear apps page",
        "Open settings",
      );
      if (pick === "Use API key") return this.signInWithApiKey();
      if (pick === "Open Linear apps page") {
        vscode.env.openExternal(vscode.Uri.parse("https://linear.app/settings/api/applications"));
      } else if (pick === "Open settings") {
        vscode.commands.executeCommand("workbench.action.openSettings", "linearManager.oauth");
      }
      return undefined;
    }

    let clientSecret = await this.ctx.secrets.get(SECRET_CLIENT_SECRET);
    if (!clientSecret) {
      clientSecret = await vscode.window.showInputBox({
        title: "Linear OAuth client secret",
        prompt: "From your Linear OAuth application. Stored securely — you'll only enter this once.",
        password: true,
        ignoreFocusOut: true,
      });
      if (!clientSecret) return undefined;
      await this.ctx.secrets.store(SECRET_CLIENT_SECRET, clientSecret);
    }

    const redirectUri = `http://localhost:${port}/callback`;
    const state = crypto.randomBytes(16).toString("hex");

    const codePromise = this.awaitCallback(port, state);

    const authUrl = new URL("https://linear.app/oauth/authorize");
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("client_id", clientId);
    authUrl.searchParams.set("redirect_uri", redirectUri);
    authUrl.searchParams.set("scope", scopes);
    authUrl.searchParams.set("state", state);
    // Do NOT set prompt=consent — that forces a consent screen every sign-in.

    await vscode.env.openExternal(vscode.Uri.parse(authUrl.toString()));

    let code: string;
    try {
      code = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "Waiting for Linear authorization…", cancellable: true },
        (_p, tok) => Promise.race([
          codePromise,
          new Promise<string>((_res, rej) => tok.onCancellationRequested(() => rej(new Error("Cancelled")))),
        ]),
      );
    } catch (err: any) {
      vscode.window.showErrorMessage(`Linear OAuth failed: ${err?.message ?? err}`);
      return undefined;
    }

    const tokenRes = await fetch("https://api.linear.app/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        redirect_uri: redirectUri,
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: "authorization_code",
      }).toString(),
    });

    if (!tokenRes.ok) {
      const body = await tokenRes.text();
      vscode.window.showErrorMessage(`Token exchange failed: ${tokenRes.status} ${body}`);
      return undefined;
    }
    const json = (await tokenRes.json()) as OAuthTokenResponse;
    if (!json.access_token) {
      vscode.window.showErrorMessage(`Token exchange returned no token: ${JSON.stringify(json)}`);
      return undefined;
    }

    const auth = await this.persistOAuthTokens(json);
    vscode.window.showInformationMessage(
      json.refresh_token
        ? "Signed in to Linear. Session will renew automatically."
        : "Signed in to Linear. Tip: enable refresh tokens on your OAuth app, or use an API key for a permanent session.",
    );
    return auth;
  }

  async signOut(): Promise<void> {
    await this.clearTokens(false);
    // Keep client secret so re-auth doesn't ask for it again.
    await this.setSignedInContext(false);
    this._onDidChange.fire(undefined);
    vscode.window.showInformationMessage("Signed out of Linear.");
  }

  /**
   * Called when an API request fails with auth errors. Tries one refresh;
   * if that fails, clears the session and prompts to sign in.
   */
  async handleUnauthorized(): Promise<AuthState | undefined> {
    const kind = ((await this.ctx.secrets.get(SECRET_TOKEN_KIND)) as TokenKind) || "apiKey";
    if (kind !== "oauth") {
      await this.clearTokens(false);
      await this.setSignedInContext(false);
      this._onDidChange.fire(undefined);
      return undefined;
    }
    const refreshToken = await this.ctx.secrets.get(SECRET_REFRESH);
    if (!refreshToken) {
      await this.clearTokens(false);
      await this.setSignedInContext(false);
      this._onDidChange.fire(undefined);
      return undefined;
    }
    return this.refreshOAuthToken(refreshToken);
  }

  private async refreshOAuthToken(refreshToken: string): Promise<AuthState | undefined> {
    if (this.refreshInFlight) return this.refreshInFlight;
    this.refreshInFlight = this.doRefresh(refreshToken).finally(() => {
      this.refreshInFlight = undefined;
    });
    return this.refreshInFlight;
  }

  private async doRefresh(refreshToken: string): Promise<AuthState | undefined> {
    const cfg = vscode.workspace.getConfiguration("linearManager");
    const clientId = cfg.get<string>("oauth.clientId", "").trim();
    const clientSecret = await this.ctx.secrets.get(SECRET_CLIENT_SECRET);
    if (!clientId || !clientSecret) {
      await this.clearTokens(false);
      await this.setSignedInContext(false);
      this._onDidChange.fire(undefined);
      return undefined;
    }

    try {
      const tokenRes = await fetch("https://api.linear.app/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          client_id: clientId,
          client_secret: clientSecret,
        }).toString(),
      });

      if (!tokenRes.ok) {
        const body = await tokenRes.text();
        console.error("[linear-manager] refresh failed:", tokenRes.status, body);
        await this.clearTokens(false);
        await this.setSignedInContext(false);
        this._onDidChange.fire(undefined);
        vscode.window.showWarningMessage(
          "Linear session expired and could not be renewed. Please sign in again.",
          "Sign in with API key",
        ).then((pick) => {
          if (pick === "Sign in with API key") vscode.commands.executeCommand("linear.signInApiKey");
        });
        return undefined;
      }

      const json = (await tokenRes.json()) as OAuthTokenResponse;
      if (!json.access_token) {
        await this.clearTokens(false);
        await this.setSignedInContext(false);
        this._onDidChange.fire(undefined);
        return undefined;
      }
      // Linear rotates refresh tokens — always persist the new one immediately.
      return this.persistOAuthTokens(json);
    } catch (err: any) {
      console.error("[linear-manager] refresh error:", err);
      return undefined;
    }
  }

  private async persistOAuthTokens(json: OAuthTokenResponse): Promise<AuthState> {
    const access = json.access_token!;
    await this.ctx.secrets.store(SECRET_TOKEN, access);
    await this.ctx.secrets.store(SECRET_TOKEN_KIND, "oauth");
    if (json.refresh_token) {
      await this.ctx.secrets.store(SECRET_REFRESH, json.refresh_token);
    }
    const expiresIn = typeof json.expires_in === "number" ? json.expires_in : 86_400;
    await this.ctx.secrets.store(SECRET_EXPIRES_AT, String(Date.now() + expiresIn * 1000));
    const auth: AuthState = { token: access, kind: "oauth" };
    await this.setSignedInContext(true);
    this._onDidChange.fire(auth);
    return auth;
  }

  private async clearTokens(_keepClientSecret: boolean): Promise<void> {
    await this.ctx.secrets.delete(SECRET_TOKEN);
    await this.ctx.secrets.delete(SECRET_TOKEN_KIND);
    await this.ctx.secrets.delete(SECRET_REFRESH);
    await this.ctx.secrets.delete(SECRET_EXPIRES_AT);
    // Client secret is intentionally kept so re-auth doesn't ask for it again.
  }

  private async setSignedInContext(signedIn: boolean): Promise<void> {
    await vscode.commands.executeCommand("setContext", "linearManager.signedIn", signedIn);
  }

  private awaitCallback(port: number, expectedState: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        if (!req.url) return;
        const url = new URL(req.url, `http://localhost:${port}`);
        if (url.pathname !== "/callback") {
          res.statusCode = 404;
          res.end("Not found");
          return;
        }
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        const error = url.searchParams.get("error");
        if (error) {
          res.end(renderPage(`Linear authorization failed: ${error}`, false));
          server.close();
          reject(new Error(error));
          return;
        }
        if (!code || state !== expectedState) {
          res.end(renderPage("Missing or invalid authorization state.", false));
          server.close();
          reject(new Error("Invalid state"));
          return;
        }
        res.end(renderPage("Authorized! You can close this tab and return to Cursor.", true));
        server.close();
        resolve(code);
      });
      server.on("error", (err) => reject(err));
      server.listen(port, "127.0.0.1");
      setTimeout(() => {
        server.close();
        reject(new Error("Timed out waiting for authorization"));
      }, 5 * 60_000).unref();
    });
  }
}

function renderPage(msg: string, ok: boolean): string {
  const color = ok ? "#5e6ad2" : "#b23838";
  return `<!doctype html><html><head><meta charset="utf-8"><title>Linear</title>
<style>body{font-family:-apple-system,system-ui,sans-serif;background:#0e0e11;color:#e5e5e5;
display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
.card{background:#17171b;padding:32px 40px;border-radius:12px;border:1px solid #26262c;text-align:center;max-width:420px}
h1{margin:0 0 8px 0;color:${color};font-size:18px}
p{margin:0;color:#b0b0b8;font-size:14px}</style></head>
<body><div class="card"><h1>${ok ? "Linear Manager" : "Sign-in failed"}</h1><p>${msg}</p></div></body></html>`;
}
