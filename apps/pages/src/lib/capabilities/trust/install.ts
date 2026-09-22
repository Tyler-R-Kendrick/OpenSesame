/**
 * Installing S03's checks into the composition store's seams (ownership.md
 * §4.1). The store declares two hooks and defaults them to "no opinion";
 * this module fills them in with the trust layer's own verification and is
 * the only place that does. The store is not edited to reach them — the core
 * boot calls `installTrustSeams` once, before `compositionStore.boot`.
 *
 * `reviewManagedPolicy` answers one question: may the managed policy this
 * deployment is serving replace the one this device already accepted? That is
 * the revision ladder — an older revision is a rollback (TRUST-05) and the
 * same revision carrying a different document is a conflict (TRUST-06) — and
 * it only works if the digest of the accepted document is on record, so this
 * module also advances that witness when a review passes. The store's seam is
 * synchronous and WebCrypto is not, so the candidate is digested here, before
 * boot; a policy that was never digested is refused rather than waved through.
 *
 * `workspaceRestriction` reads the per-vault narrowing. A restriction only
 * ever narrows, so a document that is present but unreadable is treated as
 * the narrowest one it could be — never as absent, which would silently
 * restore everything the operator meant to take away.
 */

import {
  type InstanceCapabilityPolicy,
  type WorkspaceCapabilityRestriction,
  parseWorkspaceRestriction,
} from "@opensesame/capability-composition";
import {
  type BoundaryValue,
  type JsonValue,
  overlapCast,
} from "@opensesame/os-domain";
import { kvGet, kvHydrate } from "../../kv.js";
import type { ParsedRuntimeConfig } from "../../runtime-config.js";
import { canonicalizeToBytes } from "../../vault/protection/canonicalize.js";
import type { ManagedPolicyReview } from "../store-docs.js";
import { storeSeams } from "../store-seams.js";
import {
  type AcceptedPolicyRecord,
  checkRevision,
  readAcceptedPolicy,
  recordAcceptedPolicy,
} from "./accepted-revision.js";
import { policyPayloadDigest } from "./envelope.js";

/** Per-vault `WorkspaceCapabilityRestriction`, beside the vault's selection. */
export function workspaceRestrictionKey(vaultId: string): string {
  return `tomb/${vaultId}/capabilities.restriction.v1`;
}

/** The one managed policy this boot may review, digested before the store asks. */
let primed: Readonly<{ canonical: string; digest: string }> | null = null;
/** A durable write that failed; reported on the next review, never swallowed. */
let writeFailure: string | null = null;
let writes: Promise<void> = Promise.resolve();

/** Tests await the witness write the review schedules. */
export function pendingTrustWrites(): Promise<void> {
  return writes;
}

function canonicalOf(policy: InstanceCapabilityPolicy): string {
  // SAFETY: an InstanceCapabilityPolicy is a JSON document by definition (§7).
  const body: JsonValue = overlapCast(policy);
  return new TextDecoder().decode(canonicalizeToBytes(body));
}

/**
 * Whether the candidate may govern. `digest` is `null` when this document was
 * not digested before boot: unknown, and therefore refused.
 */
export function reviewManagedPolicy(
  policy: InstanceCapabilityPolicy,
  accepted: AcceptedPolicyRecord | null,
  digest: string | null,
): ManagedPolicyReview {
  if (digest === null) {
    return {
      ok: false,
      diagnostics: [
        "managed policy: not verified before boot; core-only until it is reviewed",
      ],
    };
  }
  const candidate = {
    instanceId: policy.instanceId,
    revision: policy.revision,
    digest,
  };
  switch (checkRevision(candidate, accepted)) {
    case "ok":
      return { ok: true, diagnostics: [] };
    case "wrong-instance":
      return {
        ok: false,
        diagnostics: [
          `managed policy: names instance ${policy.instanceId}; this device accepted ${accepted?.instanceId ?? "none"}`,
        ],
      };
    case "rollback":
      return {
        ok: false,
        diagnostics: [
          `managed policy: revision ${policy.revision} is older than the accepted ${accepted?.revision ?? "none"}; rollback refused`,
        ],
      };
    case "conflict-same-revision":
      return {
        ok: false,
        diagnostics: [
          `managed policy: revision ${policy.revision} carries a different document than the one accepted under it; conflict refused`,
        ],
      };
  }
}

/** Advance the witness, so the next boot can see a rollback for what it is. */
function remember(record: AcceptedPolicyRecord): void {
  writes = writes.then(() =>
    recordAcceptedPolicy(record).catch(() => {
      writeFailure =
        "managed policy: the accepted-revision record could not be written; rollback detection is not armed for this revision";
    }),
  );
}

function alreadyWitnessed(
  accepted: AcceptedPolicyRecord | null,
  record: AcceptedPolicyRecord,
): boolean {
  return (
    accepted !== null &&
    accepted.instanceId === record.instanceId &&
    accepted.revision === record.revision &&
    accepted.digest === record.digest
  );
}

function reviewSeam(policy: InstanceCapabilityPolicy): ManagedPolicyReview {
  const digest =
    primed !== null && primed.canonical === canonicalOf(policy)
      ? primed.digest
      : null;
  const accepted = readAcceptedPolicy();
  const review = reviewManagedPolicy(policy, accepted, digest);
  const diagnostics =
    writeFailure === null
      ? review.diagnostics
      : [writeFailure, ...review.diagnostics];
  writeFailure = null;
  if (review.ok && digest !== null) {
    const record: AcceptedPolicyRecord = {
      instanceId: policy.instanceId,
      revision: policy.revision,
      digest,
      provenance: "same-origin-deployment",
      acceptedAt: storeSeams.now(),
    };
    if (!alreadyWitnessed(accepted, record)) remember(record);
  }
  return { ok: review.ok, diagnostics };
}

/** The narrowest restriction there is: this workspace gets no optional capability. */
function narrowest(
  instanceId: string,
  vaultId: string,
): WorkspaceCapabilityRestriction {
  return {
    schemaVersion: 1,
    kind: "WorkspaceCapabilityRestriction",
    instanceId,
    vaultId,
    revision: "unreadable",
    allow: [],
    prohibited: [],
  };
}

/**
 * The stored narrowing for this vault. Absent when nothing is stored or when
 * the document is scoped to another instance or vault (the store's own rule
 * for a foreign document); the narrowest possible one when a document is
 * there but will not parse.
 */
export function readWorkspaceRestriction(
  instanceId: string,
  vaultId: string | null,
): WorkspaceCapabilityRestriction | null {
  if (vaultId === null) return null;
  const raw = kvGet(workspaceRestrictionKey(vaultId));
  if (raw === null) return null;
  let body: BoundaryValue;
  try {
    body = JSON.parse(raw);
  } catch {
    return narrowest(instanceId, vaultId);
  }
  const parsed = parseWorkspaceRestriction(body);
  if (!parsed.ok) return narrowest(instanceId, vaultId);
  const restriction = parsed.value;
  return restriction.instanceId === instanceId &&
    restriction.vaultId === vaultId
    ? restriction
    : null;
}

/**
 * Digest the deployment's managed policy, pull this vault's restriction into
 * the plaintext cache the seam reads synchronously, and install both hooks.
 * Called once by the core boot, before `compositionStore.boot`.
 */
export async function installTrustSeams(
  runtimeConfig: ParsedRuntimeConfig,
  vaultId: string | null,
): Promise<void> {
  const policy = runtimeConfig.capabilityComposition?.instancePolicy ?? null;
  primed =
    policy === null
      ? null
      : {
          canonical: canonicalOf(policy),
          digest: await policyPayloadDigest(policy),
        };
  if (vaultId !== null) await kvHydrate([workspaceRestrictionKey(vaultId)]);
  storeSeams.reviewManagedPolicy = reviewSeam;
  storeSeams.workspaceRestriction = readWorkspaceRestriction;
}
