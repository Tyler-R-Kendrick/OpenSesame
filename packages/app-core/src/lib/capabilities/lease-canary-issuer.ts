import type { ActivationLease } from "@opensesame/capability-composition";
import {
  decodePresentedId,
  encodePresentedId,
} from "../credential-canaries/identifier.js";
/** Issuer provenance is private to actual lease mint/abort, never owner input. */
import type { CredentialCanaryIssuerResponse } from "../credential-canaries/issuer-response.js";
import type { ArtifactContext } from "../credential-canaries/protocol.js";
import {
  assertNotDecoySession,
  currentRealmGeneration,
} from "../decoy-session.js";

type Scope = { tomb: string; vaultIdentity: string };
type Issued = {
  issuerRecordRef: string;
  presentedId: string;
  tomb: string;
  context: ArtifactContext;
  revoked: boolean;
  lease: ActivationLease;
  realm: number;
};
let scope: () => Scope | null = () => null;
const issued = new Map<string, Issued>();
const aliases = new Map<string, Issued>();
const leaseAliases = new WeakMap<ActivationLease, string>();
function leaseRevoked(record: Issued): boolean {
  return (
    record.revoked ||
    record.lease.signal.aborted ||
    record.realm !== currentRealmGeneration()
  );
}
/** Trusted runtime installation; model/agent tools never receive this port. */
export function configureLeaseIssuerScope(
  read: () => Scope | null,
): () => void {
  scope = read;
  return () => {
    if (scope === read) scope = () => null;
  };
}
export function recordIssuedLease(lease: ActivationLease): void {
  const binding = scope();
  if (
    !binding ||
    binding.tomb !== lease.identity.vaultId ||
    lease.generation < 1 ||
    lease.generation > 4294967295
  )
    return;
  // Instrumentation must not change the capacity or authority of real leases.
  if (issued.size >= 16) return;
  const presentedId = encodePresentedId(
    crypto.getRandomValues(new Uint8Array(32)),
  );
  const issuerRecordRef = `oslease:v1:${crypto.randomUUID()}`;
  const record: Issued = {
    issuerRecordRef,
    presentedId,
    tomb: binding.tomb,
    context: {
      vaultIdentity: binding.vaultIdentity,
      kind: "agent_lease",
      generation: lease.generation,
    },
    revoked: false,
    lease,
    realm: currentRealmGeneration(),
  };
  issued.set(issuerRecordRef, record);
  const alias = `oslease:v1:${presentedId}`;
  aliases.set(alias, record);
  leaseAliases.set(lease, alias);
  lease.signal.addEventListener(
    "abort",
    () => {
      record.revoked = true;
    },
    { once: true },
  );
}
export function listRetiredLeaseIdentifiers(
  tomb: string,
): Array<{ issuerRecordRef: string; context: ArtifactContext }> {
  assertNotDecoySession();
  const binding = scope();
  if (!binding || binding.tomb !== tomb) return [];
  return [...issued.values()]
    .filter(
      (r) =>
        leaseRevoked(r) &&
        r.tomb === tomb &&
        r.context.vaultIdentity === binding.vaultIdentity,
    )
    .map((r) => ({
      issuerRecordRef: r.issuerRecordRef,
      context: { ...r.context },
    }));
}
/** Core calls this only inside the fresh original-owner management ceremony. */
export async function resolveRetiredLeaseIdentifier(ref: string, tomb: string) {
  assertNotDecoySession();
  const binding = scope();
  const record = issued.get(ref);
  if (
    !binding ||
    binding.tomb !== tomb ||
    !record ||
    !leaseRevoked(record) ||
    record.tomb !== tomb ||
    record.context.vaultIdentity !== binding.vaultIdentity
  )
    throw new Error("Retired issuer record unavailable.");
  return {
    kind: "presented_identifier",
    presentedId: record.presentedId,
    context: { ...record.context },
  } satisfies CredentialCanaryIssuerResponse;
}

/** Opaque delegation of exactly the same bounded activation lease, never a root. */
export function issuedLeaseReference(lease: ActivationLease): string {
  assertNotDecoySession();
  const alias = leaseAliases.get(lease);
  const record = alias ? aliases.get(alias) : undefined;
  if (!alias || !record || leaseRevoked(record))
    throw new Error("Issued lease unavailable.");
  return alias;
}
/** Actual loader admission. A revoked alias can produce evidence, never a lease. */
export async function resolveIssuedLeaseReference(
  reference: string,
  generation: number,
) {
  assertNotDecoySession();
  const binding = scope();
  const record = aliases.get(reference);
  if (binding && !record && reference.startsWith("oslease:v1:")) {
    const presentedId = reference.slice("oslease:v1:".length);
    decodePresentedId(presentedId);
    // The live lease table dies on restart. Previously enrolled detection
    // records stay durable, and can recognize old aliases without reviving one.
    const { observeControlledReference } = await import(
      "../credential-canaries/observe.js"
    );
    await observeControlledReference({
      tomb: binding.tomb,
      reference: `oscanary:v1:${presentedId}`,
      phase: "retired_generation_observed",
    });
    throw new Error("Issued lease unavailable.");
  }
  if (
    !binding ||
    !record ||
    record.tomb !== binding.tomb ||
    record.context.vaultIdentity !== binding.vaultIdentity
  )
    throw new Error("Issued lease unavailable.");
  if (leaseRevoked(record)) {
    const { observeControlledIdentifier } = await import(
      "../credential-canaries/observe.js"
    );
    await observeControlledIdentifier({
      tomb: record.tomb,
      presentedId: record.presentedId,
      context: record.context,
      phase: "retired_generation_observed",
    });
    throw new Error("Issued lease retired.");
  }
  if (record.lease.signal.aborted || generation !== record.context.generation)
    throw new Error("Issued lease stale.");
  return record.lease;
}

export function isIssuedLeaseReference(
  admission: ActivationLease | string,
): admission is string {
  return Object(admission) !== admission;
}
