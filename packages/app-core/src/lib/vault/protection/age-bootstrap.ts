/**
 * Age recovery bootstrap helpers (KP-26).
 *
 * A vault-sealed identity is reachable only after the root unlocks, so it
 * cannot be an independent recovery path. Integrates with bootstrap-graph.
 */

import type { AgeIdentityCustody, AgeIdentityEntry } from "../../age-keys.js";
import {
  type BootstrapAvailability,
  type BootstrapDependencyNode,
  assertBootstrapFeasible,
} from "./bootstrap-graph.js";
import { ProtectionError } from "./errors.js";

export type AgeBootstrapClassification =
  | { independent: true; source: "external" | "hardware" }
  | {
      independent: false;
      reason: "vault_held" | "public_only" | "missing_identity";
    };

/** Map custody onto bootstrap-graph availability. */
export function ageCustodyToBootstrapAvailability(
  custody: AgeIdentityCustody,
): BootstrapAvailability {
  if (custody === "external" || custody === "hardware") return "independent";
  if (custody === "public-only") return "external-unproven";
  return "vault-sealed";
}

/** Local classifier aligned with bootstrap-graph semantics. */
export function classifyAgeIdentityCustodyLocal(
  custody: AgeIdentityCustody,
): AgeBootstrapClassification {
  if (custody === "external" || custody === "hardware") {
    return { independent: true, source: custody };
  }
  if (custody === "public-only") {
    return { independent: false, reason: "public_only" };
  }
  return { independent: false, reason: "vault_held" };
}

export function classifyAgeIdentityCustody(
  custody: AgeIdentityCustody,
): AgeBootstrapClassification {
  return classifyAgeIdentityCustodyLocal(custody);
}

export function ageIdentityToBootstrapNode(
  entry: AgeIdentityEntry,
): BootstrapDependencyNode {
  return {
    id: entry.id,
    kind: entry.custody === "hardware" ? "hardware" : "age-identity",
    availability: ageCustodyToBootstrapAvailability(entry.custody),
    dependsOn: [],
  };
}

export function ageIdentityIsIndependentRecovery(
  entry: AgeIdentityEntry,
): boolean {
  if (entry.custody === "vault-sealed" || entry.custody === "public-only") {
    return false;
  }
  if (!entry.identity && entry.custody === "hardware") {
    return true;
  }
  if (!entry.identity) {
    return false;
  }
  return classifyAgeIdentityCustody(entry.custody).independent;
}

export function assertAgeRecoveryIndependent(entry: AgeIdentityEntry): void {
  if (ageIdentityIsIndependentRecovery(entry)) return;
  // Also fail through the shared graph so AUTH/LIFECYCLE see one error shape.
  const node = ageIdentityToBootstrapNode(entry);
  try {
    assertBootstrapFeasible([node], [node.id]);
  } catch (caught) {
    if (caught instanceof ProtectionError) throw caught;
  }
  throw new ProtectionError(
    "bootstrap_cycle",
    "Vault-held or public-only age identity is not independent root recovery.",
  );
}
