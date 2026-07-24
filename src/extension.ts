import * as vscode from "vscode";
import { AuthManager } from "./auth";
import { LinearService } from "./linear";
import {
  MyIssuesProvider, CreatedByMeProvider, TeamsProvider,
  ProjectsProvider, CyclesProvider, FavoritesProvider,
} from "./treeProviders";
import { registerCommands } from "./commands";
import { StatusBar } from "./statusBar";

const output = vscode.window.createOutputChannel("Linear Manager");

export async function activate(ctx: vscode.ExtensionContext) {
  ctx.subscriptions.push(output);
  try {
    await activateInner(ctx);
    output.appendLine("[activate] Linear Manager activated successfully.");
  } catch (err: any) {
    output.appendLine(`[activate] FAILED: ${err?.stack ?? err}`);
    output.show(true);
    vscode.window.showErrorMessage(
      `Linear Manager failed to activate: ${err?.message ?? err}. See "Linear Manager" output channel.`,
    );
    throw err;
  }
}

async function activateInner(ctx: vscode.ExtensionContext) {
  const auth = new AuthManager(ctx);
  const svc = new LinearService(auth);
  await svc.init();

  const myIssues = new MyIssuesProvider(svc);
  const createdByMe = new CreatedByMeProvider(svc);
  const teams = new TeamsProvider(svc);
  const projects = new ProjectsProvider(svc);
  const cycles = new CyclesProvider(svc);
  const favorites = new FavoritesProvider(svc, ctx);

  ctx.subscriptions.push(
    vscode.window.registerTreeDataProvider("linear.myIssues", myIssues),
    vscode.window.registerTreeDataProvider("linear.createdByMe", createdByMe),
    vscode.window.registerTreeDataProvider("linear.teams", teams),
    vscode.window.registerTreeDataProvider("linear.projects", projects),
    vscode.window.registerTreeDataProvider("linear.cycles", cycles),
    vscode.window.registerTreeDataProvider("linear.favorites", favorites),
  );

  registerCommands(ctx, auth, svc, favorites);

  const statusBar = new StatusBar(svc);
  statusBar.start(ctx);

  const cfg = vscode.workspace.getConfiguration("linearManager");
  const poll = cfg.get<number>("pollIntervalSeconds", 120);
  if (poll > 0) {
    const timer = setInterval(() => svc.invalidate("issues:"), poll * 1000);
    ctx.subscriptions.push({ dispose: () => clearInterval(timer) });
  }

  vscode.commands.executeCommand("setContext", "linearManager.active", true);
  vscode.commands.executeCommand("setContext", "linearManager.signedIn", svc.isSignedIn());
}

export function deactivate() {}
