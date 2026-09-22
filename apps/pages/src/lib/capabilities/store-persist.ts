/**
 * Reading and writing the composition documents (ownership.md §4.5).
 *
 * Every read parses through the package's validators; a document that does
 * not parse is a diagnostic and *absent*, never a permissive default. Every
 * write that authority later depends on goes through `kvSetDurable`, so a
 * failure is reported to the caller instead of believed.
 */

import {
  type ConsentReceipt,
  type InstallationCapabilitySelection,
  type InstanceCapabilityPolicy,
  type ParseResult,
  type VaultCapabilitySelection,
  parseConsentReceipt,
  parseInstallationSelection,
  parseInstancePolicy,
  parseVaultSelection,
} from "@opensesame/capability-composition";
import { type BoundaryValue, isJsonObject } from "@opensesame/os-domain";
import { kvGet, kvRefresh, kvSetDurable } from "../kv.js";
import {
  GENERATION_KEY,
  LOCAL_POLICY_KEY,
  MAX_RECORD_BYTES,
  RECEIPT_KEY,
  SELECTION_KEY,
  vaultSelectionKey,
} from "./keys.js";

export type LocalPolicyRecord = Readonly<{
  /** Something was stored under the key, valid or not. */
  present: boolean;
  policy: InstanceCapabilityPolicy | null;
}>;

export type PersistedDocs = Readonly<{
  selection: InstallationCapabilitySelection | null;
  receipt: ConsentReceipt | null;
  localPolicy: LocalPolicyRecord;
  vaultSelection: VaultCapabilitySelection | null;
  committedGeneration: number;
  diagnostics: readonly string[];
}>;

function readJson(key: string): BoundaryValue | undefined {
  const raw = kvGet(key);
  if (raw === null) return undefined;
  try {
    return JSON.parse(raw) as BoundaryValue;
  } catch {
    return null;
  }
}

function readParsed<T>(
  key: string,
  parse: (value: BoundaryValue) => ParseResult<T>,
  diagnostics: string[],
): { present: boolean; value: T | null } {
  const body = readJson(key);
  if (body === undefined) return { present: false, value: null };
  if (body === null) {
    diagnostics.push(`${key}: not JSON; treated as absent`);
    return { present: true, value: null };
  }
  const result = parse(body);
  if (!result.ok) {
    const first = result.diagnostics[0];
    diagnostics.push(
      `${key}: invalid${first ? ` (${first.code}${first.path ? ` at ${first.path}` : ""})` : ""}; treated as absent`,
    );
    return { present: true, value: null };
  }
  return { present: true, value: result.value };
}

/** `{ generation, committedAt }`; anything else reads as 0. */
export function readCommittedGeneration(): number {
  const body = readJson(GENERATION_KEY);
  if (!isJsonObject(body)) return 0;
  const generation = body.generation;
  return typeof generation === "number" &&
    Number.isSafeInteger(generation) &&
    generation >= 0
    ? generation
    : 0;
}

export function readPersistedDocs(vaultId: string | null): PersistedDocs {
  const diagnostics: string[] = [];
  const selection = readParsed(
    SELECTION_KEY,
    parseInstallationSelection,
    diagnostics,
  ).value;
  const receipt = readParsed(RECEIPT_KEY, parseConsentReceipt, diagnostics)
    .value;
  const local = readParsed(LOCAL_POLICY_KEY, parseInstancePolicy, diagnostics);
  const vaultSelection =
    vaultId === null
      ? null
      : readParsed(vaultSelectionKey(vaultId), parseVaultSelection, diagnostics)
          .value;
  return {
    selection,
    receipt,
    localPolicy: { present: local.present, policy: local.value },
    vaultSelection,
    committedGeneration: readCommittedGeneration(),
    diagnostics,
  };
}

/**
 * Re-read the authority records from durable storage, so a compare sees
 * what another tab committed rather than this tab's memory. Throws when the
 * storage read itself fails — the caller fails closed.
 */
export async function refreshAuthorityRecords(): Promise<void> {
  await kvRefresh(GENERATION_KEY, MAX_RECORD_BYTES);
  await kvRefresh(SELECTION_KEY, MAX_RECORD_BYTES);
  await kvRefresh(RECEIPT_KEY, MAX_RECORD_BYTES);
}

/** Durable, in order: selection, receipt, then the generation counter. */
export async function writeCommit(
  selection: InstallationCapabilitySelection,
  receipt: ConsentReceipt,
  generation: number,
  committedAt: string,
): Promise<void> {
  await kvSetDurable(SELECTION_KEY, JSON.stringify(selection));
  await kvSetDurable(RECEIPT_KEY, JSON.stringify(receipt));
  await kvSetDurable(
    GENERATION_KEY,
    JSON.stringify({ generation, committedAt }),
  );
}

/** Durable per-vault disables plus the generation counter. */
export async function writeVaultSelection(
  selection: VaultCapabilitySelection,
  generation: number,
  committedAt: string,
): Promise<void> {
  await kvSetDurable(
    vaultSelectionKey(selection.vaultId),
    JSON.stringify(selection),
  );
  await kvSetDurable(
    GENERATION_KEY,
    JSON.stringify({ generation, committedAt }),
  );
}
