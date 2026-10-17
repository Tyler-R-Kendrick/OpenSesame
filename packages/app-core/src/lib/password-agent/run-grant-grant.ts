import { durationSeconds } from "./lease.js";
import {
  type RunGrantBinding,
  type RunGrantRecord,
  type RunGrantStorePort,
  createRunGrant,
  sameRunGrantBinding,
  validateRunGrantBinding,
} from "./run-grant.js";

export interface RunGrantPolicy {
  expiresIn: string;
  uses: number;
}
export interface RunGrantPorts {
  /** Only the human ceremony may implement approval; a missing or declined ceremony grants nothing. */
  approve(binding: RunGrantBinding, policy: RunGrantPolicy): Promise<boolean>;
  store: RunGrantStorePort;
  now(): number;
  newId(): string;
}

/** Issue a run grant through the same human approval ceremony as `lease approve`. */
export async function grantRunGrant(
  binding: RunGrantBinding,
  options: { expiresIn?: string; uses?: number },
  ports: RunGrantPorts,
): Promise<RunGrantRecord> {
  const policy: RunGrantPolicy = {
    expiresIn: options.expiresIn ?? "10m",
    uses: options.uses ?? 1,
  };
  durationSeconds(policy.expiresIn);
  validateRunGrantBinding(binding);
  if (!Number.isInteger(policy.uses) || policy.uses < 1 || policy.uses > 10)
    throw new Error("Run grant uses must be between 1 and 10");
  let approved: boolean;
  try {
    approved = await ports.approve(binding, policy);
  } catch {
    throw new Error(
      "Human run-grant approval unavailable (details suppressed)",
    );
  }
  if (!approved)
    throw new Error(
      "Human run-grant approval is required; nothing was granted",
    );
  try {
    const principal = await ports.store.principal();
    const grant = createRunGrant({
      id: ports.newId(),
      principal,
      binding,
      now: ports.now(),
      expiresIn: policy.expiresIn,
      uses: policy.uses,
    });
    await ports.store.insert(grant);
    const stored = await ports.store.get(grant.id);
    if (!grantMatches(grant, stored)) throw new Error("unverified");
    return grant;
  } catch {
    throw new Error(
      "Run grant is unverified; inspect run-grant status before retrying (details suppressed)",
    );
  }
}

function grantMatches(
  expected: RunGrantRecord,
  actual: RunGrantRecord,
): boolean {
  return (
    sameRunGrantBinding(expected, actual) &&
    expected.id === actual.id &&
    expected.principal === actual.principal &&
    expected.createdAt === actual.createdAt &&
    expected.expiresAt === actual.expiresAt &&
    expected.useBudget === actual.useBudget &&
    expected.usesRemaining === actual.usesRemaining &&
    expected.revoked === actual.revoked
  );
}
