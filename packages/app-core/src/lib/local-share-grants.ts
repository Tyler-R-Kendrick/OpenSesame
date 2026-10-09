/**
 * Standing shares from this vault to local identities.
 *
 * Application OIDC grants stay in identity-grants. These records answer the
 * PAM question: which person or agent may open which vault, or use which
 * connector, under which policy, until when.
 */

import { type Named, name } from "@gdp-ts/core";
import { recordAccessAuditEvent } from "./local-access-audit.js";
import { LocalDirectoryError } from "./local-directory.js";
import {
  SHARE_CAPACITY,
  readAllShares,
  shareKindValue,
  sharePolicyAllowed,
  shareTextField,
  writeAllShares,
} from "./local-share-grants-store.js";
import {
  FOLDER_TARGET_PREFIX,
  SHARE_DURATIONS,
  SHARE_KINDS,
  SHARE_POLICIES,
  type LocalShare,
  type ShareKind,
  type ShareTarget,
  listShareTargets,
  policyLabel,
} from "./local-share-grants-types.js";
import {
  type ShareWriteAuthority,
  requireManageGrants,
  systemShareWrite,
} from "./proofs/share-write.js";

export {
  FOLDER_TARGET_PREFIX,
  SHARE_DURATIONS,
  SHARE_KINDS,
  SHARE_POLICIES,
  listShareTargets,
  policyLabel,
};
export type { LocalShare, ShareKind, ShareTarget };

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

export async function listLocalShares(tomb: string): Promise<LocalShare[]> {
  const now = Date.now();
  return (await readAllShares(tomb)).filter((share) => share.expiresAt > now);
}

/** A person writing a share: the `manage_grants` check, then the write. */
export function createLocalShare(
  tomb: string,
  input: CreateLocalShareInput,
  options?: ShareWriteOptions,
): Promise<LocalShare[]> {
  return name(tomb, async (named) =>
    createLocalShareAs(named, input, await requireManageGrants(named), options),
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
  if (!shareTextField(input.principalId, 64))
    throw new LocalDirectoryError("Choose an identity.");
  if (
    !shareKindValue(input.resourceKind) ||
    !sharePolicyAllowed(input.resourceKind, input.policy)
  )
    throw new LocalDirectoryError("Choose a policy this resource allows.");
  if (
    !shareTextField(input.resourceId, 128) ||
    !shareTextField(input.resourceLabel, 128)
  )
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
    ...(await readAllShares(tomb)).filter((row) => row.expiresAt > issuedAt),
    share,
  ];
  if (next.length > SHARE_CAPACITY)
    throw new LocalDirectoryError("Share capacity is full.");
  await writeAllShares(tomb, next);
  if (share.resourceKind === "connection" && authority.kind === "ManageGrants")
    await recordConnectionShareEvent(
      tomb,
      "access.connection.granted",
      share,
    ).catch(() => undefined);
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
  if (!shareTextField(sessionId, 36))
    throw new LocalDirectoryError("This session is unavailable.");
  const current = await readAllShares(tomb);
  const next = current.filter((row) => row.sessionId !== sessionId);
  if (next.length !== current.length) await writeAllShares(tomb, next);
  return next.filter((row) => row.expiresAt > Date.now());
}

async function dropShare(tomb: string, id: string): Promise<void> {
  const current = await readAllShares(tomb);
  const next = current.filter((row) => row.id !== id);
  if (next.length !== current.length) await writeAllShares(tomb, next);
}

export async function revokeLocalShare(
  tomb: string,
  id: string,
): Promise<LocalShare[]> {
  const { assertAccessCapability } = await import("./local-rbac.js");
  await assertAccessCapability(tomb, "manage_grants");
  if (!shareTextField(id, 36))
    throw new LocalDirectoryError("This share is unavailable.");
  const current = await readAllShares(tomb);
  const removed = current.find((row) => row.id === id);
  if (!removed) throw new LocalDirectoryError("This share is unavailable.");
  if (removed.resourceKind === "connection")
    await recordConnectionShareEvent(
      tomb,
      "access.connection.revoked",
      removed,
    );
  await writeAllShares(
    tomb,
    current.filter((row) => row.id !== id),
  );
  return listLocalShares(tomb);
}

/** Standing dogfood duration — renewed by ensureLocalShare before it runs out. */
export const STANDING_SHARE_SECONDS =
  SHARE_DURATIONS[SHARE_DURATIONS.length - 1].seconds;

const RENEW_WITHIN_MS = 2 * 86400 * 1000;

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
  if (existing) await dropShare(tomb, existing.id);
  const share: CreateLocalShareInput = {
    principalId: input.principalId,
    resourceKind: input.resourceKind,
    resourceId: input.resourceId,
    resourceLabel: input.resourceLabel,
    policy: input.policy,
    durationSeconds,
  };
  if (input.sessionId) share.sessionId = input.sessionId;
  return name(tomb, (named) =>
    createLocalShareAs(named, share, systemShareWrite(named)),
  );
}
