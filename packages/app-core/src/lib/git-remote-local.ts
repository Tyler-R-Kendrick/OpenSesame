import {
  type BoundaryValue,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";
import { createItem } from "@opensesame/vault-core";
import { lockManager, maybeLocalStore } from "../ports.js";
/**
 * Browser-held forge-agnostic git remotes (ADR 0090).
 * Public metadata stays in localStorage; credentials seal in the vault.
 */
import {
  assertNotDecoySession,
  isRealAuthorityBlocked,
} from "./decoy-session.js";
import { onDeviceConnectorPrincipalTransfer } from "./device-connector-principal-state.js";
import {
  activeDeviceConnectorPrincipal,
  assertDeviceConnectorPrincipal,
  requireDeviceConnectorPrincipal,
} from "./device-connector-principal.js";
import type { GitAuthMode, GitRemoteConfiguration } from "./git-auth-modes.js";
import { isGitAuthMode } from "./git-auth-modes.js";
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
type OwnedGitRemote = LocalGitRemote & { owner: string | null };
let memoryRemotes: BoundaryValue[] = [];

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

function parseOneRemote(item: BoundaryValue): OwnedGitRemote | null {
  if (!isJsonObject(item)) return null;
  const row = item;
  if (!isString(row.id) || !isLocalGitRemoteId(row.id)) return null;
  if (!isString(row.displayName) || row.displayName.trim() === "") return null;
  if (!isString(row.remoteUrl) || row.remoteUrl.trim() === "") return null;
  if (!isString(row.authMode) || !isGitAuthMode(row.authMode)) return null;
  if (!isString(row.createdAt) || !isString(row.updatedAt)) return null;
  return {
    owner: optionalTrim(row.owner),
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

function parseRows(parsed: BoundaryValue): OwnedGitRemote[] {
  if (!Array.isArray(parsed)) return [];
  const rows: OwnedGitRemote[] = [];
  for (const item of parsed) {
    const remote = parseOneRemote(item);
    if (remote) rows.push(remote);
  }
  return rows;
}

function storedEntries(): BoundaryValue[] {
  const store = maybeLocalStore();
  if (!store) return [...memoryRemotes];
  const raw = store.getItem(PUBLIC_KEY);
  if (!raw) return [];
  try {
    const parsed: BoundaryValue = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error("Invalid saved Git records.");
    return parsed;
  } catch {
    throw new Error("Saved Git connector records are unreadable.");
  }
}

function readRaw(): LocalGitRemote[] {
  if (isRealAuthorityBlocked()) return [];
  const principal = activeDeviceConnectorPrincipal();
  if (!principal) return [];
  return parseRows(storedEntries())
    .filter((row) => row.owner === principal.id)
    .map(({ owner: _owner, ...row }) => row);
}

function writeRaw(rows: LocalGitRemote[]): void {
  assertNotDecoySession();
  const principal = requireDeviceConnectorPrincipal();
  const next = [
    ...storedEntries().filter(
      (row) => parseOneRemote(row)?.owner !== principal.id,
    ),
    ...rows.map((row) => ({ ...row, owner: principal.id })),
  ];
  writeStored(next);
}

function writeStored(rows: BoundaryValue[]): void {
  memoryRemotes = rows;
  const store = maybeLocalStore();
  if (store) {
    if (rows.length === 0) {
      store.removeItem(PUBLIC_KEY);
    } else {
      store.setItem(PUBLIC_KEY, JSON.stringify(rows));
    }
  }
  notify();
}

function withGitMetadata<T>(work: () => Promise<T>): Promise<T> {
  const realm = assertNotDecoySession();
  const principal = requireDeviceConnectorPrincipal();
  const locks = lockManager();
  if (!locks) throw new Error("Connector storage locking is required.");
  return locks.request(
    "opensesame.git-remotes",
    { mode: "exclusive" },
    async (lock) => {
      if (!lock) throw new Error("Connector storage is busy. Try again.");
      assertNotDecoySession(realm);
      assertDeviceConnectorPrincipal(principal);
      const result = await work();
      assertNotDecoySession(realm);
      assertDeviceConnectorPrincipal(principal);
      return result;
    },
  );
}

onDeviceConnectorPrincipalTransfer(async (from, to) => {
  await withGitMetadata(async () => {
    assertDeviceConnectorPrincipal(to);
    const items = vaultStore.getSnapshot().items;
    const rows = storedEntries().map((entry) => {
      const row = parseOneRemote(entry);
      if (!row || row.owner !== from.id) return entry;
      if (
        row.secretItemId !== null &&
        !items.some(
          (item) => item.id === row.secretItemId && item.deletedAt === null,
        )
      )
        return entry;
      return isJsonObject(entry) ? { ...entry, owner: to.id } : entry;
    });
    assertDeviceConnectorPrincipal(to);
    writeStored(rows);
  });
});

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
  const realm = assertNotDecoySession();
  const principal = requireDeviceConnectorPrincipal();
  const displayName = input.displayName.trim() || "Git remote";
  const now = new Date().toISOString();
  const secretItemId = needsSecrets(input.configuration)
    ? await sealSecrets(displayName, input.configuration)
    : null;
  assertNotDecoySession(realm);
  assertDeviceConnectorPrincipal(principal);
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
  await withGitMetadata(async () => {
    assertDeviceConnectorPrincipal(principal);
    writeRaw([...readRaw(), remote]);
  });
  return remote;
}

async function trashSecret(secretItemId: string | null): Promise<void> {
  const realm = assertNotDecoySession();
  if (!secretItemId) return;
  try {
    await vaultStore.trashItem(secretItemId);
  } catch {
    /* vault may already lack the item */
  }
  assertNotDecoySession(realm);
}

function assertUnlockedForSecrets(rows: LocalGitRemote[]): void {
  if (
    rows.some((row) => row.secretItemId !== null) &&
    !vaultStore.isUnlocked()
  ) {
    throw new Error("Unlock the vault to remove git remotes with credentials.");
  }
}

export async function forgetLocalGitRemote(id: string): Promise<boolean> {
  return withGitMetadata(async () => {
    const realm = assertNotDecoySession();
    const rows = readRaw();
    const target = rows.find((row) => row.id === id);
    if (!target) return false;
    assertUnlockedForSecrets([target]);
    await trashSecret(target.secretItemId);
    assertNotDecoySession(realm);
    writeRaw(rows.filter((row) => row.id !== id));
    return true;
  });
}

export async function forgetAllLocalGitRemotes(): Promise<void> {
  await withGitMetadata(async () => {
    const realm = assertNotDecoySession();
    const rows = readRaw();
    assertUnlockedForSecrets(rows);
    for (const row of rows) {
      await trashSecret(row.secretItemId);
      assertNotDecoySession(realm);
    }
    assertNotDecoySession(realm);
    writeRaw([]);
  });
}
