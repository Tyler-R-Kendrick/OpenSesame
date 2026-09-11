/**
 * Standing shares from this vault to local identities.
 *
 * Application OIDC grants stay in identity-grants. These records answer the
 * PAM question: which person or agent may open which vault, or use which
 * connector, under which policy, until when.
 */

import {
  type BoundaryValue,
  isJsonObject,
  isNumber,
  isString,
} from "@opensesame/os-domain";
import { getBundledProviders } from "./embedded-catalog.js";
import { kvRefresh } from "./kv.js";
import { LocalDirectoryError } from "./local-directory.js";
import { notifyLocalIamChange } from "./local-iam-events.js";
import { listDeviceVaults } from "./vaults.js";
import { VfsError, readFile, tombFileKey, writeFile } from "./vfs.js";

const PATH = "config/identity-shares";
const MAX_BYTES = 256_000;
const MAX_SHARES = 256;

export const SHARE_KINDS = ["vault", "connection"] as const;
export type ShareKind = (typeof SHARE_KINDS)[number];

export const SHARE_POLICIES: Record<
  ShareKind,
  readonly { id: string; label: string }[]
> = {
  vault: [
    { id: "open", label: "Open" },
    { id: "items", label: "Use items" },
  ],
  connection: [
    { id: "use", label: "Use" },
    { id: "invoke", label: "Invoke" },
  ],
};

export const SHARE_DURATIONS = [
  { seconds: 3600, label: "1 hour" },
  { seconds: 8 * 3600, label: "8 hours" },
  { seconds: 86400, label: "1 day" },
  { seconds: 7 * 86400, label: "1 week" },
] as const;

export type LocalShare = {
  id: string;
  principalId: string;
  resourceKind: ShareKind;
  resourceId: string;
  resourceLabel: string;
  policy: string;
  issuedAt: number;
  expiresAt: number;
};

export type ShareTarget = {
  kind: ShareKind;
  id: string;
  label: string;
};

function text(value: BoundaryValue, max: number): value is string {
  return isString(value) && value.length > 0 && value.length <= max;
}

function isKind(value: BoundaryValue): value is ShareKind {
  return value === "vault" || value === "connection";
}

function allowedPolicy(kind: ShareKind, policy: string): boolean {
  return SHARE_POLICIES[kind].some((entry) => entry.id === policy);
}

function isShare(value: BoundaryValue): value is LocalShare {
  return (
    isJsonObject(value) &&
    text(value.id, 36) &&
    text(value.principalId, 42) &&
    isKind(value.resourceKind) &&
    text(value.resourceId, 128) &&
    text(value.resourceLabel, 128) &&
    text(value.policy, 32) &&
    allowedPolicy(value.resourceKind, value.policy) &&
    isNumber(value.issuedAt) &&
    isNumber(value.expiresAt) &&
    Number.isSafeInteger(value.issuedAt) &&
    Number.isSafeInteger(value.expiresAt) &&
    value.expiresAt > value.issuedAt
  );
}

async function readAll(tomb: string): Promise<LocalShare[]> {
  await kvRefresh(tombFileKey(tomb, PATH), MAX_BYTES * 2);
  try {
    const bytes = await readFile(tomb, PATH);
    if (bytes.length > MAX_BYTES)
      throw new LocalDirectoryError("Share storage exceeds its limit.");
    const value: BoundaryValue = JSON.parse(new TextDecoder().decode(bytes));
    if (
      !isJsonObject(value) ||
      value.version !== 1 ||
      !Array.isArray(value.shares) ||
      value.shares.length > MAX_SHARES ||
      !value.shares.every(isShare)
    )
      throw new LocalDirectoryError("Share storage is invalid.");
    return value.shares;
  } catch (error) {
    if (error instanceof VfsError && error.code === "not-found") return [];
    throw error;
  }
}

async function writeAll(tomb: string, shares: LocalShare[]): Promise<void> {
  const bytes = new TextEncoder().encode(JSON.stringify({ version: 1, shares }));
  if (bytes.length > MAX_BYTES)
    throw new LocalDirectoryError("Share storage exceeds its limit.");
  try {
    await writeFile(tomb, PATH, bytes);
  } finally {
    notifyLocalIamChange();
  }
}

export async function listLocalShares(tomb: string): Promise<LocalShare[]> {
  const now = Date.now();
  return (await readAll(tomb)).filter((share) => share.expiresAt > now);
}

export async function createLocalShare(
  tomb: string,
  input: {
    principalId: string;
    resourceKind: ShareKind;
    resourceId: string;
    resourceLabel: string;
    policy: string;
    durationSeconds: number;
  },
): Promise<LocalShare[]> {
  if (!text(input.principalId, 42))
    throw new LocalDirectoryError("Choose an identity.");
  if (!isKind(input.resourceKind) || !allowedPolicy(input.resourceKind, input.policy))
    throw new LocalDirectoryError("Choose a policy this resource allows.");
  if (!text(input.resourceId, 128) || !text(input.resourceLabel, 128))
    throw new LocalDirectoryError("Choose a vault or connector.");
  if (!SHARE_DURATIONS.some((entry) => entry.seconds === input.durationSeconds))
    throw new LocalDirectoryError("Choose a duration.");
  const issuedAt = Date.now();
  const share: LocalShare = {
    id: crypto.randomUUID(),
    principalId: input.principalId,
    resourceKind: input.resourceKind,
    resourceId: input.resourceId,
    resourceLabel: input.resourceLabel,
    policy: input.policy,
    issuedAt,
    expiresAt: issuedAt + input.durationSeconds * 1000,
  };
  const next = [...(await readAll(tomb)).filter((row) => row.expiresAt > issuedAt), share];
  if (next.length > MAX_SHARES)
    throw new LocalDirectoryError("Share capacity is full.");
  await writeAll(tomb, next);
  return next.filter((row) => row.expiresAt > Date.now());
}

export async function revokeLocalShare(tomb: string, id: string): Promise<LocalShare[]> {
  if (!text(id, 36)) throw new LocalDirectoryError("This share is unavailable.");
  const current = await readAll(tomb);
  if (!current.some((row) => row.id === id))
    throw new LocalDirectoryError("This share is unavailable.");
  await writeAll(
    tomb,
    current.filter((row) => row.id !== id),
  );
  return listLocalShares(tomb);
}

export function listShareTargets(): ShareTarget[] {
  const vaults = listDeviceVaults()
    .filter((vault) => vault.kind !== "guest")
    .map((vault) => ({
      kind: "vault" as const,
      id: vault.id,
      label: vault.label,
    }));
  const connectors = getBundledProviders().map((provider) => ({
    kind: "connection" as const,
    id: provider.id,
    label: provider.displayName,
  }));
  return [...vaults, ...connectors];
}

export function policyLabel(kind: ShareKind, policy: string): string {
  return SHARE_POLICIES[kind].find((entry) => entry.id === policy)?.label ?? policy;
}
