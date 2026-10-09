/**
 * Standing shares from this vault to local identities.
 *
 * Application OIDC grants stay in identity-grants. These records answer the
 * PAM question: which person, application, or agent may open which vault,
 * folder, or item, or use which connector, under which policy, until when.
 * A grant to an agent is pending until a person approves it.
 * Renewals and that approval inbox live in local-share-grants-approvals.
 */

import { type Named, name } from "@gdp-ts/core";
import {
  type BoundaryValue,
  isJsonObject,
  isNumber,
  isString,
} from "@opensesame/os-domain";
import { kvRefresh } from "./kv.js";
import { recordAccessAuditEvent } from "./local-access-audit.js";
import { LocalDirectoryError, readLocalDirectory } from "./local-directory.js";
import { notifyLocalIamChange } from "./local-iam-events.js";
import {
  type ShareWriteAuthority,
  requireManageGrants,
} from "./proofs/share-write.js";
import { noteLocalShare } from "./sharing-receipts.js";
import { VfsError, readFile, tombFileKey, writeFile } from "./vfs.js";

const PATH = "config/identity-shares";
export const MAX_BYTES = 256_000;
export const MAX_SHARES = 256;

export const SHARE_KINDS = ["vault", "connection", "folder", "item"] as const;
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
  folder: [
    { id: "read", label: "Read" },
    { id: "use", label: "Use" },
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

/** Items and folders the open vault can be granted one at a time. */
export type ShareScopeLists = {
  items?: readonly { id: string; label: string }[];
  folders?: readonly { id: string; label: string }[];
};

export type GrantIdentity = {
  id: string;
  name: string;
  kind: "person" | "agent" | "application";
};

/** People, agents, and applications a grant form can name. Organizations are not principals. */
export function grantIdentities(
  entries: readonly {
    id: string;
    name: string;
    kind: string;
    enabled: boolean;
  }[],
): GrantIdentity[] {
  const identities: GrantIdentity[] = [];
  for (const entry of entries) {
    if (!entry.enabled) continue;
    if (
      entry.kind !== "person" &&
      entry.kind !== "agent" &&
      entry.kind !== "application"
    )
      continue;
    identities.push({ id: entry.id, name: entry.name, kind: entry.kind });
  }
  return identities;
}

export function text(value: BoundaryValue, max: number): value is string {
  return isString(value) && value.length > 0 && value.length <= max;
}

export function isKind(value: BoundaryValue): value is ShareKind {
  return (
    value === "vault" ||
    value === "connection" ||
    value === "folder" ||
    value === "item"
  );
}

export function allowedPolicy(kind: ShareKind, policy: string): boolean {
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

export async function readAll(tomb: string): Promise<LocalShare[]> {
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

export async function writeAll(
  tomb: string,
  shares: LocalShare[],
): Promise<void> {
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
  /** Host session mirrors may use any TTL inside the 1 minute…7 day envelope. */
  readonly freeDuration?: boolean;
};

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

export function validateShareInput(
  input: CreateLocalShareInput,
  freeDuration: boolean | undefined,
): void {
  if (!text(input.principalId, 64))
    throw new LocalDirectoryError("Choose an identity.");
  if (
    !isKind(input.resourceKind) ||
    !allowedPolicy(input.resourceKind, input.policy)
  )
    throw new LocalDirectoryError("Choose a policy this resource allows.");
  if (!text(input.resourceId, 128) || !text(input.resourceLabel, 128))
    throw new LocalDirectoryError(
      "Choose a vault, folder, item, or connector.",
    );
  if (!durationAllowed(input.durationSeconds, freeDuration))
    throw new LocalDirectoryError("Choose a duration.");
}

/**
 * A person writing a share: the `manage_grants` check, then the write.
 * An agent is refused here. `submitLocalShare` records a pending approval,
 * and `approvePendingShare` is what writes that share.
 */
export function createLocalShare(
  tomb: string,
  input: CreateLocalShareInput,
  options?: ShareWriteOptions,
): Promise<LocalShare[]> {
  return name(tomb, async (named) => {
    const authority = await requireManageGrants(named);
    await refuseUnapprovedAgent(named.value, input.principalId);
    return createLocalShareAs(named, input, authority, options);
  });
}

async function refuseUnapprovedAgent(
  tomb: string,
  principalId: string,
): Promise<void> {
  const directory = await readLocalDirectory(tomb);
  const entry = directory.entries.find((row) => row.id === principalId);
  if (entry?.kind === "agent")
    throw new LocalDirectoryError(
      "Approve the agent grant before it takes effect.",
    );
}

/**
 * Write a share under an authority for this tomb: `ManageGrants` (a person's
 * write, trailed when it grants a connector) or `SystemShareWrite` (system
 * code, never trailed).
 */
export async function createLocalShareAs<T>(
  named: Named<T, string>,
  input: CreateLocalShareInput,
  authority: ShareWriteAuthority<T>,
  options?: ShareWriteOptions,
): Promise<LocalShare[]> {
  const tomb = named.value;
  validateShareInput(input, options?.freeDuration);
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
  // A person granting a connector is on the trail as a revocation is, so a
  // grant made after a revocation lets the standing grant renew again. The
  // share is already written: a trail that will not take the entry leaves an
  // earlier revocation newest, so the standing grant stays off (the safe way)
  // and the grant the person made still stands — failing here would only
  // invite a retry that grants twice.
  if (share.resourceKind === "connection" && authority.kind === "ManageGrants")
    await recordConnectionShareEvent(
      tomb,
      "access.connection.granted",
      share,
    ).catch(() => undefined);
  if (authority.kind === "ManageGrants") noteLocalShare(tomb, "granted", share);
  return next.filter((row) => row.expiresAt > Date.now());
}

/** The sealed Access trail entry for a connector share granted or revoked. */
async function recordConnectionShareEvent(
  tomb: string,
  eventType: "access.connection.granted" | "access.connection.revoked",
  share: LocalShare,
): Promise<void> {
  await recordAccessAuditEvent(tomb, {
    eventType,
    outcome: "succeeded",
    targetType: "connection",
    targetId: share.resourceId,
    metadata: {
      providerId: share.resourceId,
      resourceType: "connection",
      resourceId: share.resourceId,
      // Whose grant, under which policy — a standing grant a person took
      // away is not re-issued for that principal and policy.
      subject: share.principalId,
      policy: share.policy,
      action: eventType === "access.connection.granted" ? "grant" : "revoke",
      kind: "share",
    },
  });
}

export async function revokeSharesForSession<T>(
  named: Named<T, string>,
  sessionId: string,
  _authority: ShareWriteAuthority<T>,
): Promise<LocalShare[]> {
  const tomb = named.value;
  if (!text(sessionId, 36))
    throw new LocalDirectoryError("This session is unavailable.");
  const current = await readAll(tomb);
  const next = current.filter((row) => row.sessionId !== sessionId);
  if (next.length !== current.length) await writeAll(tomb, next);
  return next.filter((row) => row.expiresAt > Date.now());
}

/**
 * A person revokes a share. Revoking a connector share is audited on the
 * sealed Access trail (ADR 0015), which is also how a connector page knows
 * not to re-issue a standing grant somebody took away — so the revocation is
 * recorded before the share goes. A trail that will not take it fails the
 * revoke with the share still in place, for the person to retry; the other
 * order could drop the share with nothing to keep it from being re-issued.
 */
export async function revokeLocalShare(
  tomb: string,
  id: string,
): Promise<LocalShare[]> {
  const { assertAccessCapability } = await import("./local-rbac.js");
  await assertAccessCapability(tomb, "manage_grants");
  if (!text(id, 36))
    throw new LocalDirectoryError("This share is unavailable.");
  const current = await readAll(tomb);
  const removed = current.find((row) => row.id === id);
  if (!removed) throw new LocalDirectoryError("This share is unavailable.");
  if (removed.resourceKind === "connection")
    await recordConnectionShareEvent(
      tomb,
      "access.connection.revoked",
      removed,
    );
  await writeAll(
    tomb,
    current.filter((row) => row.id !== id),
  );
  noteLocalShare(tomb, "revoked", removed);
  return listLocalShares(tomb);
}
