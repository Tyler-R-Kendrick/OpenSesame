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

export const SHARE_KINDS = ["vault", "connection", "item"] as const;
export type ShareKind = (typeof SHARE_KINDS)[number];

export const SHARE_POLICIES = {
  vault: [
    { id: "open", label: "Open" },
    { id: "items", label: "Use items" },
  ],
  connection: [
    { id: "use", label: "Use" },
    { id: "invoke", label: "Invoke" },
  ],
  item: [
    { id: "read", label: "Read" },
    { id: "use", label: "Use" },
  ],
} as const satisfies Record<
  ShareKind,
  readonly { readonly id: string; readonly label: string }[]
>;

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
  /** Set when this share was issued by a vault session run. */
  sessionId?: string;
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
  return value === "vault" || value === "connection" || value === "item";
}

function allowedPolicy(kind: ShareKind, policy: string): boolean {
  return SHARE_POLICIES[kind].some((entry) => entry.id === policy);
}

function isShare(value: BoundaryValue): value is LocalShare {
  return (
    isJsonObject(value) &&
    text(value.id, 36) &&
    text(value.principalId, 64) &&
    isKind(value.resourceKind) &&
    text(value.resourceId, 128) &&
    text(value.resourceLabel, 128) &&
    text(value.policy, 32) &&
    allowedPolicy(value.resourceKind, value.policy) &&
    (value.sessionId === undefined || text(value.sessionId, 36)) &&
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
  const bytes = new TextEncoder().encode(
    JSON.stringify({ version: 1, shares }),
  );
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

export type CreateLocalShareInput = {
  principalId: string;
  resourceKind: ShareKind;
  resourceId: string;
  resourceLabel: string;
  policy: string;
  durationSeconds: number;
  sessionId?: string;
};

type ShareWriteOptions = {
  readonly bypassAccessCheck?: boolean;
  /** Host session mirrors may use any TTL inside the 1 minute…7 day envelope. */
  readonly freeDuration?: boolean;
};

const SYSTEM_SHARE_WRITE = {
  bypassAccessCheck: true,
} as const satisfies ShareWriteOptions;

function durationAllowed(
  seconds: number,
  freeDuration: boolean | undefined,
): boolean {
  if (SHARE_DURATIONS.some((entry) => entry.seconds === seconds)) return true;
  return (
    freeDuration === true &&
    Number.isInteger(seconds) &&
    seconds >= 60 &&
    seconds <= 7 * 86400
  );
}

export async function createLocalShare(
  tomb: string,
  input: CreateLocalShareInput,
  options?: ShareWriteOptions,
): Promise<LocalShare[]> {
  if (!options?.bypassAccessCheck) {
    const { assertAccessCapability } = await import("./local-rbac.js");
    await assertAccessCapability(tomb, "manage_grants");
  }
  if (!text(input.principalId, 64))
    throw new LocalDirectoryError("Choose an identity.");
  if (
    !isKind(input.resourceKind) ||
    !allowedPolicy(input.resourceKind, input.policy)
  )
    throw new LocalDirectoryError("Choose a policy this resource allows.");
  if (!text(input.resourceId, 128) || !text(input.resourceLabel, 128))
    throw new LocalDirectoryError("Choose a vault or connector.");
  if (!durationAllowed(input.durationSeconds, options?.freeDuration))
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
  if (input.sessionId) share.sessionId = input.sessionId;
  const next = [
    ...(await readAll(tomb)).filter((row) => row.expiresAt > issuedAt),
    share,
  ];
  if (next.length > MAX_SHARES)
    throw new LocalDirectoryError("Share capacity is full.");
  await writeAll(tomb, next);
  return next.filter((row) => row.expiresAt > Date.now());
}

export async function revokeSharesForSession(
  tomb: string,
  sessionId: string,
  options?: ShareWriteOptions,
): Promise<LocalShare[]> {
  if (!options?.bypassAccessCheck) {
    const { assertAccessCapability } = await import("./local-rbac.js");
    await assertAccessCapability(tomb, "manage_grants");
  }
  if (!text(sessionId, 36))
    throw new LocalDirectoryError("This session is unavailable.");
  const current = await readAll(tomb);
  const next = current.filter((row) => row.sessionId !== sessionId);
  if (next.length !== current.length) await writeAll(tomb, next);
  return next.filter((row) => row.expiresAt > Date.now());
}

export async function revokeLocalShare(
  tomb: string,
  id: string,
  options?: ShareWriteOptions,
): Promise<LocalShare[]> {
  if (!options?.bypassAccessCheck) {
    const { assertAccessCapability } = await import("./local-rbac.js");
    await assertAccessCapability(tomb, "manage_grants");
  }
  if (!text(id, 36))
    throw new LocalDirectoryError("This share is unavailable.");
  const current = await readAll(tomb);
  if (!current.some((row) => row.id === id))
    throw new LocalDirectoryError("This share is unavailable.");
  await writeAll(
    tomb,
    current.filter((row) => row.id !== id),
  );
  return listLocalShares(tomb);
}

/** Standing dogfood duration — renewed by ensureLocalShare before it runs out. */
export const STANDING_SHARE_SECONDS =
  SHARE_DURATIONS[SHARE_DURATIONS.length - 1].seconds;

const RENEW_WITHIN_MS = 2 * 86400 * 1000;

/**
 * Ensure one share exists for this principal/resource/policy. Idempotent: a
 * still-fresh share is left alone; one nearing expiry is replaced.
 */
export async function ensureLocalShare(
  tomb: string,
  input: Omit<CreateLocalShareInput, "durationSeconds"> & {
    durationSeconds?: number;
    sessionId?: string;
  },
): Promise<LocalShare[]> {
  const durationSeconds = input.durationSeconds ?? STANDING_SHARE_SECONDS;
  const now = Date.now();
  const current = await listLocalShares(tomb);
  const existing = current.find(
    (row) =>
      row.principalId === input.principalId &&
      row.resourceKind === input.resourceKind &&
      row.resourceId === input.resourceId &&
      row.policy === input.policy,
  );
  if (existing && existing.expiresAt - now > RENEW_WITHIN_MS) {
    return current;
  }
  if (existing) await revokeLocalShare(tomb, existing.id, SYSTEM_SHARE_WRITE);
  const share: CreateLocalShareInput = {
    principalId: input.principalId,
    resourceKind: input.resourceKind,
    resourceId: input.resourceId,
    resourceLabel: input.resourceLabel,
    policy: input.policy,
    durationSeconds,
  };
  if (input.sessionId) share.sessionId = input.sessionId;
  return createLocalShare(tomb, share, SYSTEM_SHARE_WRITE);
}

export function listShareTargets(): ShareTarget[] {
  const vaults = listDeviceVaults().map((vault) => ({
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
  return (
    SHARE_POLICIES[kind].find((entry) => entry.id === policy)?.label ?? policy
  );
}
