/**
 * The two sealed files behind the device's receipts (ADR 0162): the trail, and
 * the short list of receipts decided but not yet in it.
 *
 * They are the vault's own files, apart from the Access audit (`access-audit`,
 * ADR 0015). That file also carries the standing connector grants a person
 * revoked, so it keeps the shape and the event names every build has ever
 * written, and a receipt can neither crowd one of those out of its cap nor make
 * an older build read it as corrupt.
 */

import { redactAuditMetadata } from "@opensesame/audit/redact";
import {
  type AuditOutcome,
  type BoundaryValue,
  type JsonObject,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";
import { VaultCorruptError } from "@opensesame/vault-core";
import { kvRefresh } from "./kv.js";
import { LocalDirectoryError } from "./local-directory.js";
import { VfsError, readFile, tombFileKey, writeFile } from "./vfs.js";

export const TRAIL_PATH = "config/device-receipts";
export const PENDING_PATH = "config/device-receipts-pending";
export const MAX_BYTES = 256_000;
export const MAX_RECEIPTS = 256;

/** A receipt as it rests: ids and a closed enum, never a value. */
export type StoredReceipt = Readonly<{
  id: string;
  occurredAt: string;
  eventType: string;
  outcome: AuditOutcome;
  targetType: string;
  targetId: string;
  metadata: JsonObject;
}>;

function isOutcome(value: BoundaryValue): value is AuditOutcome {
  return value === "succeeded" || value === "failed" || value === "denied";
}

function isStored(value: BoundaryValue): value is StoredReceipt {
  if (!isJsonObject(value)) return false;
  return (
    isString(value.id) &&
    isString(value.occurredAt) &&
    isString(value.eventType) &&
    isOutcome(value.outcome) &&
    isString(value.targetType) &&
    isString(value.targetId) &&
    isJsonObject(value.metadata)
  );
}

/**
 * A file this build cannot read as receipts: damaged, sealed under a key it no
 * longer has, too large, or written by a build whose format it does not know.
 * Distinct from a failure to reach the file (a locked vault, a full disk),
 * which a retry may mend; this one it cannot, and `settle` replaces the trail.
 */
export class UnreadableReceipts extends LocalDirectoryError {}

function parse(raw: string, what: string): StoredReceipt[] {
  let parsed: BoundaryValue;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new UnreadableReceipts(`The ${what} is corrupt.`);
  }
  if (
    !isJsonObject(parsed) ||
    parsed.version !== 1 ||
    !Array.isArray(parsed.receipts) ||
    !parsed.receipts.every(isStored)
  )
    throw new UnreadableReceipts(`The ${what} is corrupt.`);
  return parsed.receipts;
}

/** The one receipt a replaced trail starts with: that it was, and nothing more. */
export const RESET_EVENT_TYPE = "access.receipts.reset";

export function resetMarker(): StoredReceipt {
  return {
    id: crypto.randomUUID(),
    occurredAt: new Date().toISOString(),
    eventType: RESET_EVENT_TYPE,
    outcome: "failed",
    targetType: "device",
    targetId: "receipts",
    metadata: {},
  };
}

/** Read one of the files; a file never written holds nothing. */
export async function readStore(
  tomb: string,
  path: string,
): Promise<StoredReceipt[]> {
  await kvRefresh(tombFileKey(tomb, path), MAX_BYTES * 2);
  try {
    const bytes = await readFile(tomb, path);
    if (bytes.length > MAX_BYTES)
      throw new UnreadableReceipts("The receipts exceed their storage.");
    return parse(
      new TextDecoder().decode(bytes),
      path === TRAIL_PATH ? "receipt trail" : "pending receipt list",
    );
  } catch (err) {
    if (err instanceof VfsError && err.code === "not-found") return [];
    // Ciphertext this vault's key cannot open is a file it cannot read.
    if (
      (err instanceof VfsError && err.code === "corrupt") ||
      err instanceof VaultCorruptError
    )
      throw new UnreadableReceipts("The receipts do not open.");
    throw err;
  }
}

export async function writeStore(
  tomb: string,
  path: string,
  receipts: readonly StoredReceipt[],
): Promise<void> {
  const bytes = new TextEncoder().encode(
    JSON.stringify({ version: 1, receipts }),
  );
  if (bytes.length > MAX_BYTES)
    throw new LocalDirectoryError("The receipts exceed their storage.");
  await writeFile(tomb, path, bytes);
}

/** Receipts with no id seen twice, the first of each kept. */
export function uniqueById(
  receipts: readonly StoredReceipt[],
): StoredReceipt[] {
  const seen = new Set<string>();
  return receipts.filter((receipt) => {
    if (seen.has(receipt.id)) return false;
    seen.add(receipt.id);
    return true;
  });
}

/**
 * Newest first by when each was decided, whichever file it came from: a
 * receipt held back through a failed write belongs where its time puts it, not
 * ahead of what was written after it. None is edited; the oldest fall away
 * past the cap. A receipt on both sides is one, the held copy kept.
 */
export function newestFirst(
  held: readonly StoredReceipt[],
  trail: readonly StoredReceipt[],
): StoredReceipt[] {
  return uniqueById([...held, ...trail])
    .sort((a, b) =>
      a.occurredAt < b.occurredAt ? 1 : a.occurredAt > b.occurredAt ? -1 : 0,
    )
    .slice(0, MAX_RECEIPTS);
}

/** Build the receipt for a decision, its metadata through the audit allowlist. */
export function buildReceipt(
  input: Pick<
    StoredReceipt,
    "eventType" | "outcome" | "targetType" | "targetId"
  >,
  metadata: JsonObject,
): StoredReceipt {
  return {
    id: crypto.randomUUID(),
    occurredAt: new Date().toISOString(),
    ...input,
    metadata: redactAuditMetadata(metadata),
  };
}
