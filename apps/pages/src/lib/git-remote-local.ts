/**
 * Browser-held forge-agnostic git remotes (ADR 0090).
 * Public metadata stays in localStorage; credentials seal in the vault.
 */
import {
  type BoundaryValue,
  isString,
  overlapCast,
} from "@opensesame/os-domain";
import type { GitAuthMode, GitRemoteConfiguration } from "./git-auth-modes.js";
import { isGitAuthMode } from "./git-auth-modes.js";
import { createItem } from "./vault/model.js";
import { vaultStore } from "./vault/store.js";

const PUBLIC_KEY = "opensesame.git-remotes.v1";
const ID_PREFIX = "git_local_";

const listeners = new Set<() => void>();

export type LocalGitRemote = {
  id: string;
  displayName: string;
  remoteUrl: string;
  authMode: GitAuthMode;
  username: string | null;
  /** Vault secret item that holds sealed credential fields, if any. */
  secretItemId: string | null;
  createdAt: string;
  updatedAt: string;
};

/** Tests / private mode when localStorage is missing. */
let memoryRemotes: LocalGitRemote[] = [];

export function subscribeLocalGitRemotes(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function notify(): void {
  for (const listener of listeners) listener();
}

function randomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${ID_PREFIX}${hex}`;
}

export function isLocalGitRemoteId(id: string): boolean {
  return id.startsWith(ID_PREFIX);
}

function optionalTrim(value: BoundaryValue): string | null {
  return isString(value) && value.trim() !== "" ? value.trim() : null;
}

function parseOneRemote(item: BoundaryValue): LocalGitRemote | null {
  const row = overlapCast(item);
  if (!isString(row.id) || !isLocalGitRemoteId(row.id)) return null;
  if (!isString(row.displayName) || row.displayName.trim() === "") return null;
  if (!isString(row.remoteUrl) || row.remoteUrl.trim() === "") return null;
  if (!isString(row.authMode) || !isGitAuthMode(row.authMode)) return null;
  if (!isString(row.createdAt) || !isString(row.updatedAt)) return null;
  return {
    id: row.id,
    displayName: row.displayName.trim(),
    remoteUrl: row.remoteUrl.trim(),
    authMode: row.authMode,
    username: optionalTrim(row.username),
    secretItemId: optionalTrim(row.secretItemId),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function parseRows(parsed: BoundaryValue): LocalGitRemote[] {
  if (!Array.isArray(parsed)) return [];
  const rows: LocalGitRemote[] = [];
  for (const item of parsed) {
    const remote = parseOneRemote(item);
    if (remote) rows.push(remote);
  }
  return rows;
}

function readRaw(): LocalGitRemote[] {
  const store = globalThis.localStorage;
  if (!store) return memoryRemotes.map((row) => ({ ...row }));
  const raw = store.getItem(PUBLIC_KEY);
  if (!raw) return [];
  try {
    const parsed: BoundaryValue = JSON.parse(raw);
    return parseRows(parsed);
  } catch {
    return [];
  }
}

function writeRaw(rows: LocalGitRemote[]): void {
  memoryRemotes = rows.map((row) => ({ ...row }));
  const store = globalThis.localStorage;
  if (store) {
    if (rows.length === 0) {
      store.removeItem(PUBLIC_KEY);
    } else {
      store.setItem(PUBLIC_KEY, JSON.stringify(rows));
    }
  }
  notify();
}

export function listLocalGitRemotes(): LocalGitRemote[] {
  return readRaw();
}

export function hasLocalGitRemotes(): boolean {
  return readRaw().length > 0;
}

export function getLocalGitRemote(id: string): LocalGitRemote | null {
  return readRaw().find((row) => row.id === id) ?? null;
}

type GitSecretFields = {
  token?: string;
  password?: string;
  ssh_private_key?: string;
  ssh_passphrase?: string;
};

function secretPayload(configuration: GitRemoteConfiguration): GitSecretFields {
  const secrets: GitSecretFields = {};
  if (configuration.token !== undefined) secrets.token = configuration.token;
  if (configuration.password !== undefined) {
    secrets.password = configuration.password;
  }
  if (configuration.ssh_private_key !== undefined) {
    secrets.ssh_private_key = configuration.ssh_private_key;
  }
  if (configuration.ssh_passphrase !== undefined) {
    secrets.ssh_passphrase = configuration.ssh_passphrase;
  }
  return secrets;
}

function needsSecrets(configuration: GitRemoteConfiguration): boolean {
  return Object.keys(secretPayload(configuration)).length > 0;
}

async function sealSecrets(
  displayName: string,
  configuration: GitRemoteConfiguration,
): Promise<string | null> {
  const secrets = secretPayload(configuration);
  if (Object.keys(secrets).length === 0) return null;
  if (!vaultStore.isUnlocked()) {
    throw new Error("Unlock the vault to seal git credentials.");
  }
  const item = createItem("secret", `Git · ${displayName}`);
  item.value = JSON.stringify(secrets);
  await vaultStore.addItems([item]);
  return item.id;
}

export async function rememberLocalGitRemote(input: {
  displayName: string;
  configuration: GitRemoteConfiguration;
}): Promise<LocalGitRemote> {
  const displayName = input.displayName.trim() || "Git remote";
  const now = new Date().toISOString();
  const secretItemId = needsSecrets(input.configuration)
    ? await sealSecrets(displayName, input.configuration)
    : null;
  const username =
    input.configuration.username !== undefined &&
    input.configuration.username.trim() !== ""
      ? input.configuration.username.trim()
      : null;
  const remote: LocalGitRemote = {
    id: randomId(),
    displayName,
    remoteUrl: input.configuration.remote_url,
    authMode: input.configuration.auth_mode,
    username,
    secretItemId,
    createdAt: now,
    updatedAt: now,
  };
  writeRaw([...readRaw(), remote]);
  return remote;
}

async function trashSecret(secretItemId: string | null): Promise<void> {
  if (!secretItemId || !vaultStore.isUnlocked()) return;
  try {
    await vaultStore.trashItem(secretItemId);
  } catch {
    /* vault may already lack the item */
  }
}

export async function forgetLocalGitRemote(id: string): Promise<boolean> {
  const rows = readRaw();
  const target = rows.find((row) => row.id === id);
  if (!target) return false;
  await trashSecret(target.secretItemId);
  writeRaw(rows.filter((row) => row.id !== id));
  return true;
}

export async function forgetAllLocalGitRemotes(): Promise<void> {
  const rows = readRaw();
  for (const row of rows) {
    await trashSecret(row.secretItemId);
  }
  writeRaw([]);
}
