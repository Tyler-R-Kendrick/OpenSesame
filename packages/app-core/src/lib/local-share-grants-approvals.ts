/**
 * Standing renewals and agent-grant approvals for local shares.
 *
 * The share ledger itself stays in local-share-grants. This file renews a
 * standing share before it expires, and it holds an agent grant as pending
 * until a person approves it. Approving writes the share through that ledger.
 */

import { name } from "@gdp-ts/core";
import {
  type BoundaryValue,
  isJsonObject,
  isNumber,
} from "@opensesame/os-domain";
import { getBundledProviders } from "./embedded-catalog.js";
import { kvRefresh } from "./kv.js";
import { LocalDirectoryError, readLocalDirectory } from "./local-directory.js";
import { notifyLocalIamChange } from "./local-iam-events.js";
import {
  type CreateLocalShareInput,
  type LocalShare,
  MAX_BYTES,
  MAX_SHARES,
  SHARE_DURATIONS,
  SHARE_POLICIES,
  type ShareKind,
  type ShareScopeLists,
  type ShareTarget,
  allowedPolicy,
  createLocalShare,
  createLocalShareAs,
  isKind,
  listLocalShares,
  readAll,
  text,
  validateShareInput,
  writeAll,
} from "./local-share-grants.js";
import {
  type ShareWriteAuthority,
  requireManageGrants,
  systemShareWrite,
} from "./proofs/share-write.js";
import {
  noteShareApproved,
  noteShareDenied,
  noteShareRequested,
} from "./sharing-receipts.js";
import { listDeviceVaults } from "./vaults.js";
import { VfsError, readFile, tombFileKey, writeFile } from "./vfs.js";

/** The share, if it is there — a renewal replacing it, not a revocation. */
async function dropShare(tomb: string, id: string): Promise<void> {
  const current = await readAll(tomb);
  const next = current.filter((row) => row.id !== id);
  if (next.length !== current.length) await writeAll(tomb, next);
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
  // A renewal replaces the share; it is not a revocation.
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
  // The standing share is the vault's own: system code, no person's grant.
  return name(tomb, (named) =>
    createLocalShareAs(named, share, systemShareWrite(named)),
  );
}

function scopedTargets(
  kind: "folder" | "item",
  rows: readonly { id: string; label: string }[] | undefined,
): ShareTarget[] {
  const targets: ShareTarget[] = [];
  const seen = new Set<string>();
  for (const row of rows ?? []) {
    const id = row.id.trim();
    const label = row.label.trim();
    if (!id || !label || id.length > 128 || seen.has(id)) continue;
    seen.add(id);
    targets.push({ kind, id, label: label.slice(0, 128) });
  }
  return targets;
}

export function listShareTargets(scope?: ShareScopeLists): ShareTarget[] {
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
  return [
    ...vaults,
    ...connectors,
    ...scopedTargets("folder", scope?.folders),
    ...scopedTargets("item", scope?.items),
  ];
}

export function policyLabel(kind: ShareKind, policy: string): string {
  return (
    SHARE_POLICIES[kind].find((entry) => entry.id === policy)?.label ?? policy
  );
}

const PENDING_PATH = "config/identity-share-approvals";

/** An agent grant that is not active until a person approves it. */
export type PendingShare = {
  id: string;
  principalId: string;
  resourceKind: ShareKind;
  resourceId: string;
  resourceLabel: string;
  policy: string;
  durationSeconds: number;
  requestedAt: number;
};

export type SubmittedShare =
  | { outcome: "granted"; shares: LocalShare[] }
  | { outcome: "pending"; pending: PendingShare };

function isPending(value: BoundaryValue): value is PendingShare {
  return (
    isJsonObject(value) &&
    text(value.id, 36) &&
    text(value.principalId, 64) &&
    isKind(value.resourceKind) &&
    text(value.resourceId, 128) &&
    text(value.resourceLabel, 128) &&
    text(value.policy, 32) &&
    allowedPolicy(value.resourceKind, value.policy) &&
    isNumber(value.durationSeconds) &&
    SHARE_DURATIONS.some((entry) => entry.seconds === value.durationSeconds) &&
    isNumber(value.requestedAt) &&
    Number.isSafeInteger(value.requestedAt)
  );
}

async function readPending(tomb: string): Promise<PendingShare[]> {
  await kvRefresh(tombFileKey(tomb, PENDING_PATH), MAX_BYTES * 2);
  try {
    const bytes = await readFile(tomb, PENDING_PATH);
    if (bytes.length > MAX_BYTES)
      throw new LocalDirectoryError("Share storage exceeds its limit.");
    const value: BoundaryValue = JSON.parse(new TextDecoder().decode(bytes));
    if (
      !isJsonObject(value) ||
      value.version !== 1 ||
      !Array.isArray(value.pending) ||
      value.pending.length > MAX_SHARES ||
      !value.pending.every(isPending)
    )
      throw new LocalDirectoryError("Share storage is invalid.");
    return value.pending;
  } catch (error) {
    if (error instanceof VfsError && error.code === "not-found") return [];
    throw error;
  }
}

async function writePending(
  tomb: string,
  pending: PendingShare[],
): Promise<void> {
  const bytes = new TextEncoder().encode(
    JSON.stringify({ version: 1, pending }),
  );
  if (bytes.length > MAX_BYTES)
    throw new LocalDirectoryError("Share storage exceeds its limit.");
  try {
    await writeFile(tomb, PENDING_PATH, bytes);
  } finally {
    notifyLocalIamChange();
  }
}

export async function listPendingShares(tomb: string): Promise<PendingShare[]> {
  return readPending(tomb);
}

function sameRequest(row: PendingShare, input: CreateLocalShareInput): boolean {
  return (
    row.principalId === input.principalId &&
    row.resourceKind === input.resourceKind &&
    row.resourceId === input.resourceId &&
    row.policy === input.policy
  );
}

async function savePendingShare<T>(
  tomb: string,
  input: CreateLocalShareInput,
  authority: ShareWriteAuthority<T>,
): Promise<PendingShare> {
  if (authority.kind !== "ManageGrants")
    throw new LocalDirectoryError(
      "Approve the agent grant before it takes effect.",
    );
  validateShareInput(input, false);
  const current = await readPending(tomb);
  const existing = current.find((row) => sameRequest(row, input));
  if (existing) return existing;
  const pending: PendingShare = {
    id: crypto.randomUUID(),
    principalId: input.principalId,
    resourceKind: input.resourceKind,
    resourceId: input.resourceId,
    resourceLabel: input.resourceLabel,
    policy: input.policy,
    durationSeconds: input.durationSeconds,
    requestedAt: Date.now(),
  };
  const next = [...current, pending];
  if (next.length > MAX_SHARES)
    throw new LocalDirectoryError("Share capacity is full.");
  await writePending(tomb, next);
  noteShareRequested(tomb, {
    id: pending.id,
    principalId: pending.principalId,
    resourceId: pending.resourceId,
  });
  return pending;
}

/** Agents and applications need a person to approve before the share is active. */
function shareNeedsApproval(kind: string | undefined): boolean {
  return kind === "agent" || kind === "application";
}

/**
 * Grant immediately to a person. An agent or application grant is stored
 * pending and does not appear in `listLocalShares` until it is approved.
 */
export async function submitLocalShare(
  tomb: string,
  input: CreateLocalShareInput,
): Promise<SubmittedShare> {
  const directory = await readLocalDirectory(tomb);
  const entry = directory.entries.find((row) => row.id === input.principalId);
  if (shareNeedsApproval(entry?.kind)) {
    if (entry?.kind === "agent" && !entry.enabled)
      throw new LocalDirectoryError("This agent is disabled.");
    const pending = await name(tomb, async (named) =>
      savePendingShare(named.value, input, await requireManageGrants(named)),
    );
    return { outcome: "pending", pending };
  }
  return { outcome: "granted", shares: await createLocalShare(tomb, input) };
}

/** Turn a pending agent grant into an active share. The clock starts here. */
export function approvePendingShare(
  tomb: string,
  id: string,
): Promise<LocalShare[]> {
  return name(tomb, async (named) => {
    const authority = await requireManageGrants(named);
    const pending = (await readPending(tomb)).find((row) => row.id === id);
    if (!pending)
      throw new LocalDirectoryError("This approval is unavailable.");
    const entry = (await readLocalDirectory(tomb)).entries.find(
      (row) => row.id === pending.principalId,
    );
    if (
      !entry ||
      !shareNeedsApproval(entry.kind) ||
      (entry.kind === "agent" && !entry.enabled)
    )
      throw new LocalDirectoryError("This grant request is unavailable.");
    const shares = await createLocalShareAs(
      named,
      {
        principalId: pending.principalId,
        resourceKind: pending.resourceKind,
        resourceId: pending.resourceId,
        resourceLabel: pending.resourceLabel,
        policy: pending.policy,
        durationSeconds: pending.durationSeconds,
      },
      authority,
    );
    await writePending(
      tomb,
      (await readPending(tomb)).filter((row) => row.id !== id),
    );
    noteShareApproved(tomb, {
      id: pending.id,
      principalId: pending.principalId,
      resourceId: pending.resourceId,
    });
    return shares;
  });
}

/** Drop a pending agent grant. Nothing was active. */
export async function denyPendingShare(
  tomb: string,
  id: string,
): Promise<PendingShare[]> {
  await name(tomb, async (named) => {
    await requireManageGrants(named);
  });
  const current = await readPending(tomb);
  const pending = current.find((row) => row.id === id);
  if (!pending)
    throw new LocalDirectoryError("This approval is unavailable.");
  const next = current.filter((row) => row.id !== id);
  await writePending(tomb, next);
  noteShareDenied(tomb, {
    id: pending.id,
    principalId: pending.principalId,
    resourceId: pending.resourceId,
  });
  return next;
}
