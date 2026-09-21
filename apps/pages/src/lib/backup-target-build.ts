import type { JsonObject } from "@opensesame/os-domain";
import type { LocalBackupTarget } from "./backup-target-local.js";

export type PutBackupTargetInput = {
  kind?: string;
  providerId?: string;
  connectionId?: string;
  integrationId?: string;
  installationId?: string;
  owner?: string;
  repo?: string;
  branch?: string;
  enabled?: boolean;
  config?: JsonObject;
};

export function trimInput(value: string | undefined): string {
  if (value === undefined) return "";
  return value.trim();
}

function pickTrimmed(
  primary: string | undefined,
  fallback: string | undefined,
  defaultValue = "",
): string {
  const first = trimInput(primary);
  if (first !== "") return first;
  const second = trimInput(fallback);
  if (second !== "") return second;
  return defaultValue;
}

function pickNullable(
  primary: string | undefined,
  fallback: string | null | undefined,
): string | null {
  const first = trimInput(primary);
  if (first !== "") return first;
  if (fallback === undefined || fallback === null) return null;
  const second = fallback.trim();
  return second === "" ? null : second;
}

export function resolveProviderId(
  input: PutBackupTargetInput,
  kindHint: string,
): string {
  const fromInput = trimInput(input.providerId);
  if (fromInput !== "") return fromInput;
  if (kindHint === "git_remote") return "";
  return "github";
}

function assertBackupFields(
  kind: string,
  owner: string,
  repo: string,
  installationId: string,
  connectionId: string | null,
): void {
  if (owner === "" || repo === "") {
    throw new Error("Backup needs an owner/repo.");
  }
  if (kind === "github_app" && installationId === "") {
    throw new Error("Backup needs a GitHub App installation.");
  }
  if (kind === "git_remote" && connectionId === null) {
    throw new Error("Backup needs a git remote connection.");
  }
}

function pickEnabled(
  input: boolean | undefined,
  prior: boolean | undefined,
): boolean {
  if (input !== undefined) return input;
  if (prior !== undefined) return prior;
  return true;
}

function pickPriorString(prior: string | undefined, fallback: string): string {
  if (prior !== undefined && prior !== "") return prior;
  return fallback;
}

function pickPriorNullable(prior: string | null | undefined): string | null {
  if (prior === undefined) return null;
  return prior;
}

function pickConfig(
  input: JsonObject | undefined,
  prior: JsonObject | null | undefined,
): JsonObject | null {
  if (input !== undefined) return input;
  if (prior !== undefined && prior !== null) return prior;
  return null;
}

export function buildLocalBackupTarget(
  input: PutBackupTargetInput,
  prior: LocalBackupTarget | null,
  providerId: string,
  kind: string,
): LocalBackupTarget {
  const installationId = pickTrimmed(
    input.installationId,
    prior?.installationId,
  );
  const connectionId = pickNullable(input.connectionId, prior?.connectionId);
  const owner = pickTrimmed(input.owner, prior?.owner);
  const repo = pickTrimmed(input.repo, prior?.repo);
  assertBackupFields(kind, owner, repo, installationId, connectionId);
  return {
    kind,
    providerId,
    connectionId,
    integrationId: pickTrimmed(input.integrationId, prior?.integrationId),
    installationId,
    owner,
    repo,
    branch: pickTrimmed(input.branch, prior?.branch, "main"),
    enabled: pickEnabled(input.enabled, prior?.enabled),
    status: pickPriorString(prior?.status, "pending"),
    lastCommitSha: pickPriorNullable(prior?.lastCommitSha),
    lastSyncedAt: pickPriorNullable(prior?.lastSyncedAt),
    lastError: pickPriorNullable(prior?.lastError),
    config: pickConfig(input.config, prior?.config),
    pendingEvents: prior?.pendingEvents ?? 0,
  };
}
