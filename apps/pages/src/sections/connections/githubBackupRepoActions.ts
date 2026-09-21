import {
  ownerRepoFromRemote,
  putBackupTarget,
  type BackupTargetView,
} from "../../lib/backup.js";
import type { Connection } from "../../lib/connections.js";
import {
  type AppInstallAccount,
  createGithubAppRepo,
} from "../../lib/github-app-repos.js";
import { createGithubPasswordRepo } from "../../lib/github-history.js";
import type { Flash } from "./shared.js";
import {
  type RepoChoice,
  mergeChoiceRows,
  resolveBackupSlug,
  sanitizeRepoSlug,
} from "./GithubBackupRepoResolve.js";

export async function createUnder(
  connection: Connection,
  account: AppInstallAccount,
  name: string,
): Promise<RepoChoice> {
  if (account.installationId) {
    const created = await createGithubAppRepo({
      installationId: account.installationId,
      owner: account.accountLogin,
      name,
      accountType: account.accountType,
    });
    return {
      fullName: created.fullName,
      installationId: created.installationId,
      accountLogin: created.accountLogin,
      accountType: created.accountType,
    };
  }
  if (connection.connectionId === "local-github-app") {
    throw new Error("That account has no GitHub App installation.");
  }
  const created = await createGithubPasswordRepo(connection.connectionId, {
    name,
    private: true,
  });
  const owner = created.fullName.split("/")[0] ?? account.accountLogin;
  return {
    fullName: created.fullName,
    installationId: "",
    accountLogin: owner,
    accountType: account.accountType,
  };
}

function bindPayload(
  connection: Connection,
  choice: RepoChoice,
  parsed: { owner: string; repo: string },
) {
  const base = {
    installationId: choice.installationId,
    owner: parsed.owner,
    repo: parsed.repo,
    branch: "main",
    enabled: true,
  };
  if (connection.connectionId === "local-github-app") return base;
  if (connection.integrationId) {
    return {
      ...base,
      connectionId: connection.connectionId,
      integrationId: connection.integrationId,
    };
  }
  return { ...base, connectionId: connection.connectionId };
}

function plain(message: string): string {
  if (/host/i.test(message)) return "Could not save the repository.";
  return message;
}

export type BindHandlers = {
  connection: Connection;
  online: boolean;
  onFlash: (flash: Flash) => void;
  onBound: (saved: BackupTargetView) => void;
  onIssue: (message: string | null) => void;
  onBusy: (busy: boolean) => void;
  onReady?: (ready: boolean) => void;
};

export async function bindRepoChoice(
  handlers: BindHandlers,
  choice: RepoChoice,
): Promise<void> {
  if (!handlers.online) {
    handlers.onIssue("Connect online to save the repository.");
    return;
  }
  handlers.onBusy(true);
  handlers.onIssue(null);
  try {
    const parsed = ownerRepoFromRemote(choice.fullName);
    if (!parsed) throw new Error("Repository name is not valid.");
    const saved = await putBackupTarget(
      bindPayload(handlers.connection, choice, parsed),
    );
    handlers.onBound(saved);
    handlers.onReady?.(true);
    handlers.onFlash({ tone: "ok", text: `${saved.owner}/${saved.repo}` });
  } catch (caught) {
    handlers.onIssue(
      caught instanceof Error
        ? plain(caught.message)
        : "Could not save the repository.",
    );
  } finally {
    handlers.onBusy(false);
  }
}

export type CommitContext = {
  handlers: BindHandlers;
  selected: string;
  repos: RepoChoice[];
  accounts: AppInstallAccount[];
  setRepos: (update: (rows: RepoChoice[]) => RepoChoice[]) => void;
  setEditing: (value: boolean) => void;
};

export async function commitRepoSlug(
  context: CommitContext,
  raw: string,
  flight: { current: boolean },
): Promise<void> {
  if (!context.handlers.online || flight.current) return;
  const slug = sanitizeRepoSlug(raw);
  if (
    !slug ||
    slug.endsWith("/") ||
    slug.toLowerCase() === context.selected.toLowerCase()
  ) {
    context.setEditing(false);
    context.handlers.onIssue(null);
    return;
  }
  const decision = resolveBackupSlug(slug, context.repos, context.accounts);
  if (decision.kind === "invalid") {
    context.handlers.onIssue(decision.message);
    return;
  }
  flight.current = true;
  context.handlers.onIssue(null);
  try {
    if (decision.kind === "existing") {
      await bindRepoChoice(context.handlers, decision.choice);
      return;
    }
    const created = await createUnder(
      context.handlers.connection,
      decision.account,
      decision.name,
    );
    context.setRepos((rows) => mergeChoiceRows([created, ...rows]));
    await bindRepoChoice(context.handlers, created);
  } catch (caught) {
    context.handlers.onIssue(
      caught instanceof Error
        ? plain(caught.message)
        : "Could not create the repository.",
    );
  } finally {
    flight.current = false;
  }
}
