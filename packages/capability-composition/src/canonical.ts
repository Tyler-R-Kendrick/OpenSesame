/**
 * Canonical serialization and the three digests the fabric binds to.
 *
 * `canonicalize` is recursively key-sorted JSON: two values that are equal
 * as JSON produce the same string regardless of key or construction order.
 * Every digest is `sha256:<hex>` over a canonical body built from *sorted*
 * copies of the relevant fields, so input ordering can never leak into it.
 */
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils";
import {
  type BoundaryValue,
  isBoolean,
  isNumber,
  isString,
} from "@opensesame/os-domain";
import { compareIds, sortIds } from "./ids.js";
import type {
  CapabilityDescriptor,
  ConsentReceipt,
  DependencyAlternatives,
  EffectivePlan,
  EgressClass,
  EgressDeclaration,
  NetworkPolicy,
  PlanConflict,
  PlanIdentity,
} from "./types.js";

export const DIGEST_PREFIX = "sha256:";
export const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

function isPlainObject(
  value: BoundaryValue,
): value is Readonly<Record<string, BoundaryValue>> {
  return (
    value !== null &&
    Object(value) === value &&
    Object.prototype.toString.call(value) === "[object Object]"
  );
}

function canonicalizeInto(value: BoundaryValue, out: string[]): void {
  if (value === null || value === undefined) {
    out.push("null");
    return;
  }
  if (isString(value)) {
    out.push(JSON.stringify(value));
    return;
  }
  if (isBoolean(value)) {
    out.push(value ? "true" : "false");
    return;
  }
  if (isNumber(value)) {
    if (!Number.isFinite(value)) {
      throw new TypeError("canonicalize: non-finite number");
    }
    out.push(JSON.stringify(value));
    return;
  }
  if (Array.isArray(value)) {
    out.push("[");
    value.forEach((entry, index) => {
      if (index > 0) out.push(",");
      canonicalizeInto(entry, out);
    });
    out.push("]");
    return;
  }
  if (isPlainObject(value)) {
    canonicalizeObject(value, out);
    return;
  }
  throw new TypeError("canonicalize: value is not JSON");
}

function canonicalizeObject(
  value: Readonly<Record<string, BoundaryValue>>,
  out: string[],
): void {
  out.push("{");
  let first = true;
  for (const key of Object.keys(value).sort(compareIds)) {
    const entry = value[key];
    if (entry === undefined) continue;
    if (!first) out.push(",");
    first = false;
    out.push(JSON.stringify(key), ":");
    canonicalizeInto(entry, out);
  }
  out.push("}");
}

/** Recursively key-sorted JSON. Throws on values JSON cannot express. */
export function canonicalize(v: BoundaryValue): string {
  const out: string[] = [];
  canonicalizeInto(v, out);
  return out.join("");
}

export function sha256Hex(v: string | Uint8Array): string {
  const bytes = isString(v) ? utf8ToBytes(v) : v;
  return bytesToHex(sha256(bytes));
}

/** `sha256:<hex>` over the canonical form of a JSON body. */
export function digestOf(v: BoundaryValue): string {
  return `${DIGEST_PREFIX}${sha256Hex(canonicalize(v))}`;
}

function egressKey(e: EgressDeclaration): string {
  return canonicalize({
    automatic: e.automatic,
    class: e.class,
    purpose: e.purpose,
  });
}

/** Sorted, de-duplicated plain copies of egress declarations. */
export function normalizeEgress(
  egress: readonly EgressDeclaration[],
): Array<{ automatic: boolean; class: EgressClass; purpose: string }> {
  const byKey = new Map<string, EgressDeclaration>();
  for (const e of egress) byKey.set(egressKey(e), e);
  return [...byKey.keys()].sort(compareIds).map((key) => {
    const e = byKey.get(key);
    if (e === undefined) throw new Error("unreachable: egress key");
    return { automatic: e.automatic, class: e.class, purpose: e.purpose };
  });
}

function normalizeAlternatives(
  alternatives: readonly DependencyAlternatives[],
): Array<{ oneOf: string[]; slot: string }> {
  return [...alternatives]
    .sort((a, b) => compareIds(a.slot, b.slot))
    .map((a) => ({ oneOf: sortIds(a.oneOf), slot: a.slot }));
}

/**
 * Digest over the declared exposure: dependencies, alternatives, egress,
 * permissions, key access, environments, modules, and the worker constraint.
 * Title, summary, operations, item kinds and versions are not exposure.
 */
export function exposureDigest(
  d: Omit<CapabilityDescriptor, "exposureDigest">,
): string {
  return digestOf({
    alternatives: normalizeAlternatives(d.alternatives),
    browserPermissions: sortIds(d.browserPermissions),
    dependencies: sortIds(d.dependencies),
    egress: normalizeEgress(d.egress),
    environments: sortIds(d.environments),
    id: d.id,
    keyAccess: d.keyAccess,
    moduleIds: sortIds(d.moduleIds),
    requiresService: d.requiresService,
    workerGraphConstraint: d.workerGraphConstraint,
  });
}

export function normalizeNetwork(n: NetworkPolicy): {
  allowedServiceOrigins: string[];
  externalServices: string;
} {
  return {
    allowedServiceOrigins: sortIds(n.allowedServiceOrigins),
    externalServices: n.externalServices,
  };
}

function conflictKey(c: PlanConflict): string {
  return `${c.capability}\u0000${c.code}\u0000${c.subject}\u0000${c.message}`;
}

/** Conflicts in a stable order: capability, code, subject, message. */
export function sortConflicts(
  conflicts: readonly PlanConflict[],
): PlanConflict[] {
  const byKey = new Map<string, PlanConflict>();
  for (const c of conflicts) byKey.set(conflictKey(c), c);
  return [...byKey.keys()].sort(compareIds).map((key) => {
    const c = byKey.get(key);
    if (c === undefined) throw new Error("unreachable: conflict key");
    return c;
  });
}

/** Everything of a plan that the digest commits to (identity sans digest). */
export type PlanDigestBody = Readonly<
  Omit<EffectivePlan, "identity"> & {
    identity: Omit<PlanIdentity, "planDigest">;
  }
>;

/** Deterministic digest over normalized identity, approved sets, conflicts and consent. */
export function planDigest(body: PlanDigestBody): string {
  return digestOf({
    approvedCapabilities: sortIds(body.approvedCapabilities),
    approvedItemKinds: sortIds(body.approvedItemKinds),
    approvedModules: sortIds(body.approvedModules),
    approvedOperations: sortIds(body.approvedOperations),
    conflicts: sortConflicts(body.conflicts).map((c) => ({
      capability: c.capability,
      code: c.code,
      message: c.message,
      subject: c.subject,
    })),
    consent: {
      addedDependencies: sortIds(body.consent.addedDependencies),
      addedRoots: sortIds(body.consent.addedRoots),
      changedExposure: sortIds(body.consent.changedExposure),
      removedRoots: sortIds(body.consent.removedRoots),
      requiredNotAccepted: sortIds(body.consent.requiredNotAccepted),
    },
    identity: {
      distributionId: body.identity.distributionId,
      installationId: body.identity.installationId,
      instanceId: body.identity.instanceId,
      policyRevision: body.identity.policyRevision,
      selectionRevision: body.identity.selectionRevision,
      vaultId: body.identity.vaultId,
    },
    network: normalizeNetwork(body.network),
    policyValid: body.policyValid,
    provenance: body.provenance,
    requiredWorkerVariant: body.requiredWorkerVariant,
  });
}

/** Digest over the normalized receipt body (everything but `receiptDigest`). */
export function receiptDigest(
  receipt: Omit<ConsentReceipt, "receiptDigest">,
): string {
  const exposure: Record<string, string> = {};
  for (const id of sortIds(Object.keys(receipt.exposure))) {
    const digest = receipt.exposure[id];
    if (digest !== undefined) exposure[id] = digest;
  }
  return digestOf({
    acceptedAt: receipt.acceptedAt,
    exposure,
    installationId: receipt.installationId,
    instanceId: receipt.instanceId,
    policyRevision: receipt.policyRevision,
    roots: sortIds(receipt.roots),
    schemaVersion: receipt.schemaVersion,
    selectionRevision: receipt.selectionRevision,
  });
}
