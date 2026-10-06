import {
  type LeaseRecord,
  type LeaseStorePort,
  type ResourceVersion,
  createLease,
  durationSeconds,
  sameBinding,
  validateLeaseBinding,
} from "./lease.js";
import type { Binding } from "./request.js";
export interface GrantPolicy {
  expiresIn: string;
  uses: number;
}
export interface GrantPorts {
  /** Only the human UI may implement approval; a missing or declined ceremony grants nothing. */
  approve(binding: Binding, policy: GrantPolicy): Promise<boolean>;
  /** The host must use desktop authentication, never a saved service token, for this metadata read. */
  inspect(reference: string): Promise<ResourceVersion>;
  store: LeaseStorePort;
  now(): number;
  newId(): string;
}
export async function grantLease(
  binding: Binding,
  options: { expiresIn?: string; uses?: number },
  ports: GrantPorts,
): Promise<LeaseRecord> {
  const policy: GrantPolicy = {
    expiresIn: options.expiresIn ?? "10m",
    uses: options.uses ?? 1,
  };
  durationSeconds(policy.expiresIn);
  validateLeaseBinding(binding);
  if (!Number.isInteger(policy.uses) || policy.uses < 1 || policy.uses > 10)
    throw new Error("Lease uses must be between 1 and 10");
  let approved: boolean;
  try {
    approved = await ports.approve(binding, policy);
  } catch {
    throw new Error("Human lease approval unavailable (details suppressed)");
  }
  if (!approved)
    throw new Error("Human lease approval is required; nothing was granted");
  const resource = await inspectApproved(ports, binding.reference);
  try {
    const principal = await ports.store.principal();
    const lease = createLease({
      id: ports.newId(),
      principal,
      binding,
      resource,
      now: ports.now(),
      expiresIn: policy.expiresIn,
      uses: policy.uses,
    });
    await ports.store.insert(lease);
    const stored = await ports.store.get(lease.id);
    if (!grantMatches(lease, stored)) throw new Error("unverified");
    return lease;
  } catch {
    throw new Error(
      "Lease grant is unverified; inspect lease status before retrying (details suppressed)",
    );
  }
}
async function inspectApproved(
  ports: GrantPorts,
  reference: string,
): Promise<ResourceVersion> {
  try {
    return await ports.inspect(reference);
  } catch {
    throw new Error(
      "Could not inspect approved credential version; nothing was granted (details suppressed)",
    );
  }
}
function grantMatches(expected: LeaseRecord, actual: LeaseRecord): boolean {
  return (
    sameBinding(expected, actual) &&
    identityMatches(expected, actual) &&
    policyMatches(expected, actual)
  );
}
function identityMatches(expected: LeaseRecord, actual: LeaseRecord): boolean {
  return (
    expected.id === actual.id &&
    expected.principal === actual.principal &&
    expected.itemId === actual.itemId &&
    expected.itemVersion === actual.itemVersion
  );
}
function policyMatches(expected: LeaseRecord, actual: LeaseRecord): boolean {
  return (
    expected.createdAt === actual.createdAt &&
    expected.expiresAt === actual.expiresAt &&
    expected.useBudget === actual.useBudget &&
    expected.usesRemaining === actual.usesRemaining &&
    expected.revoked === actual.revoked
  );
}
