/**
 * Keep the manifest's projection of the vault's own wraps in step with the
 * header. Password, PIN and passkey are enrolled and removed under Unlock
 * methods, which writes `header.unlocks` and nothing else; the manifest was
 * projected once, at first unlock, so a PIN added afterwards never appeared
 * as a protector and one removed afterwards stayed listed.
 *
 * Only records marked `legacy` are the header's to correct. A protector the
 * manifest enrolled itself (recovery key, age, cloud KMS) has no wrap in the
 * header and is never touched here.
 */

import { type JsonValue, overlapCast } from "@opensesame/os-domain";
import type {
  ProtectionRecord,
  RootProtectionManifest,
  VaultHeader,
} from "@opensesame/vault-core";
import { canonicalizeToString } from "./canonicalize.js";
import { migrateLegacyHeaderToManifest } from "./migrate-legacy.js";

function legacyKey(record: ProtectionRecord): string | null {
  switch (record.kind) {
    case "password":
      return "password";
    case "pin":
      return "pin";
    case "webauthn-prf":
      return record.legacy ? `prf:${record.credentialIdB64}` : null;
    default:
      return null;
  }
}

/**
 * The manifest's records with the header's wraps reconciled in, or null when
 * they already agree. A record that stays keeps its id and what was proved
 * about it; only its wrap follows the header (a changed password rewraps).
 */
export function reconcileLegacyRecords(
  header: VaultHeader,
  manifest: RootProtectionManifest,
): ProtectionRecord[] | null {
  const fresh = new Map<string, ProtectionRecord>();
  for (const record of migrateLegacyHeaderToManifest({
    header,
    vaultId: manifest.vaultId,
    rootKeyId: manifest.rootKeyId,
    rootEpoch: manifest.rootEpoch,
  }).manifest.records) {
    const key = legacyKey(record);
    if (key) fresh.set(key, record);
  }

  const seen = new Set<string>();
  const next: ProtectionRecord[] = [];
  for (const record of manifest.records) {
    const key = legacyKey(record);
    if (key === null) {
      next.push(record);
      continue;
    }
    const current = fresh.get(key);
    if (!current) continue;
    seen.add(key);
    const kept: ProtectionRecord = {
      ...current,
      protectorId: record.protectorId,
      proofStatus: record.proofStatus,
    };
    if (record.lastEvidence) kept.lastEvidence = record.lastEvidence;
    next.push(kept);
  }
  for (const [key, record] of fresh) {
    if (!seen.has(key)) next.push(record);
  }
  // Key order is not a difference: a parsed manifest orders keys as it likes.
  // SAFETY: records are JSON-shaped metadata with no undefined members.
  const canonical = (records: ProtectionRecord[]) =>
    canonicalizeToString(overlapCast<JsonValue>(records));
  return canonical(next) === canonical(manifest.records) ? null : next;
}
