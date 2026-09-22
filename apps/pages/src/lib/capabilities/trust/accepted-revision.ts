/**
 * The highest managed policy this installation accepted (S03), at
 * `capabilities.policy.accepted.v1` (ownership §4.5).
 *
 * A candidate whose revision is older than the record is a rollback
 * (TRUST-05); a candidate with the same revision but a different digest is
 * a conflict — two documents claiming one revision, and the device keeps the
 * one it already accepted (TRUST-06). Browser storage can be cleared or
 * restored from a copy, so this record is a witness, not proof: see
 * `LIMITATIONS` in `expiry.ts` (TRUST-10).
 */
import type { PolicyProvenance } from "@opensesame/capability-composition";
import {
  type BoundaryValue,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";
import { kvGet, kvSetDurable } from "../../kv.js";
import { isDigest, parseIsoTime } from "./digest.js";

export const ACCEPTED_POLICY_KEY = "capabilities.policy.accepted.v1";
const PROVENANCES: readonly PolicyProvenance[] = [
  "personal-local",
  "same-origin-deployment",
  "signed-import",
  "invitation-unverified",
];

export type AcceptedPolicyRecord = Readonly<{
  instanceId: string;
  revision: string;
  digest: string;
  provenance: PolicyProvenance;
  acceptedAt: string;
}>;

export type PolicyCandidate = Readonly<{
  instanceId: string;
  revision: string;
  digest: string;
}>;

export type RevisionCheck =
  | "ok"
  | "rollback"
  | "conflict-same-revision"
  | "wrong-instance";

function isProvenance(value: BoundaryValue): value is PolicyProvenance {
  return isString(value) && PROVENANCES.some((p) => p === value);
}

export function readAcceptedRecord(
  value: BoundaryValue,
): AcceptedPolicyRecord | null {
  if (
    !isJsonObject(value) ||
    !isString(value.instanceId) ||
    !isString(value.revision) ||
    !isDigest(value.digest) ||
    !isProvenance(value.provenance) ||
    parseIsoTime(value.acceptedAt) === null ||
    !isString(value.acceptedAt)
  )
    return null;
  return {
    instanceId: value.instanceId,
    revision: value.revision,
    digest: value.digest,
    provenance: value.provenance,
    acceptedAt: value.acceptedAt,
  };
}

/** `null` when nothing was accepted or the record is unreadable. */
export function readAcceptedPolicy(): AcceptedPolicyRecord | null {
  const raw = kvGet(ACCEPTED_POLICY_KEY);
  if (raw === null) return null;
  try {
    const parsed: BoundaryValue = JSON.parse(raw);
    return readAcceptedRecord(parsed);
  } catch {
    return null;
  }
}

/** Durable write; rejects when storage refuses so the caller never claims acceptance it cannot keep. */
export async function recordAcceptedPolicy(
  record: AcceptedPolicyRecord,
): Promise<void> {
  if (readAcceptedRecord(record) === null)
    throw new Error("invalid accepted-policy record");
  await kvSetDurable(ACCEPTED_POLICY_KEY, JSON.stringify(record));
}

/**
 * Compare two revision strings. Numeric runs compare numerically, other runs
 * lexically, so `2026.09.22-3` orders after `2026.09.22-2` and `10` after
 * `9`. Operators should issue monotonic revisions (a counter or a date);
 * arbitrary labels compare as text and the result is documented here, not
 * guessed elsewhere.
 */
export function compareRevisions(a: string, b: string): -1 | 0 | 1 {
  const runsA = a.match(/\d+|\D+/g) ?? [];
  const runsB = b.match(/\d+|\D+/g) ?? [];
  const length = Math.max(runsA.length, runsB.length);
  for (let i = 0; i < length; i += 1) {
    const ra = runsA[i];
    const rb = runsB[i];
    if (ra === undefined) return -1;
    if (rb === undefined) return 1;
    const numeric = /^\d+$/.test(ra) && /^\d+$/.test(rb);
    if (numeric) {
      const diff = BigInt(ra) - BigInt(rb);
      if (diff !== 0n) return diff < 0n ? -1 : 1;
    } else if (ra !== rb) {
      return ra < rb ? -1 : 1;
    }
  }
  return 0;
}

/**
 * Whether `candidate` may replace what was accepted. `null` accepted means a
 * first acceptance and is always `ok`.
 */
export function checkRevision(
  candidate: PolicyCandidate,
  accepted: AcceptedPolicyRecord | null,
): RevisionCheck {
  if (accepted === null) return "ok";
  if (candidate.instanceId !== accepted.instanceId) return "wrong-instance";
  const order = compareRevisions(candidate.revision, accepted.revision);
  if (order < 0) return "rollback";
  if (order === 0) {
    return candidate.digest === accepted.digest
      ? "ok"
      : "conflict-same-revision";
  }
  return "ok";
}
