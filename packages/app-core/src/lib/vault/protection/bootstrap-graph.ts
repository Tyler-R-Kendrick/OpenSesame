/**
 * Bootstrap dependency graph for vault key protection (C07 / KP-26 / KP-37).
 *
 * Root unlock must not depend exclusively on a secret that is only reachable
 * after that same root unlocks (age identity sealed in the vault, cloud token
 * only stored as a vault item, etc.). This module detects those cycles; it
 * does not perform crypto.
 */

import { ProtectionError } from "./errors.js";

/** How a node relates to the locked vault it claims to unlock. */
export type BootstrapAvailability =
  /** Usable before this vault's root is open (password entry, HW, OS session). */
  | "independent"
  /** Only reachable after this vault unlocks (sealed age identity, in-vault token). */
  | "vault-sealed"
  /** External but not yet proven independent (untested recovery recipient). */
  | "external-unproven";

export type BootstrapNodeKind =
  | "protector"
  | "vault-secret"
  | "age-identity"
  | "cloud-credential"
  | "native-session"
  | "hardware"
  | "user-supplied";

export type BootstrapDependencyNode = {
  id: string;
  kind: BootstrapNodeKind;
  availability: BootstrapAvailability;
  /** Node ids that must be satisfied before this node can open the root. */
  dependsOn: readonly string[];
};

export type BootstrapCycle = {
  path: string[];
};

/**
 * Walk directed edges `dependsOn` and return every simple cycle that keeps the
 * unlock path inside vault-sealed material.
 */
export function findBootstrapCycles(
  nodes: readonly BootstrapDependencyNode[],
): BootstrapCycle[] {
  const byId = new Map<string, BootstrapDependencyNode>();
  for (const node of nodes) {
    byId.set(node.id, node);
  }

  const cycles: BootstrapCycle[] = [];
  const visiting = new Set<string>();
  const stack: string[] = [];
  const done = new Set<string>();

  function visit(id: string): void {
    if (done.has(id) || visiting.has(id)) {
      if (visiting.has(id)) {
        const start = stack.indexOf(id);
        if (start >= 0) {
          cycles.push({ path: [...stack.slice(start), id] });
        }
      }
      return;
    }
    const node = byId.get(id);
    if (!node) return;
    visiting.add(id);
    stack.push(id);
    for (const dep of node.dependsOn) {
      visit(dep);
    }
    stack.pop();
    visiting.delete(id);
    done.add(id);
  }

  for (const node of nodes) {
    visit(node.id);
  }
  return cycles;
}

/**
 * True when at least one listed protector can open the root without depending
 * solely on vault-sealed secrets of this vault.
 */
export function hasIndependentBootstrapPath(
  nodes: readonly BootstrapDependencyNode[],
  protectorIds: readonly string[],
): boolean {
  const byId = new Map(nodes.map((node) => [node.id, node]));

  function independent(id: string, seen: Set<string>): boolean {
    if (seen.has(id)) return false;
    const node = byId.get(id);
    if (!node) return false;
    if (node.availability === "independent") {
      if (node.dependsOn.length === 0) return true;
      const next = new Set(seen);
      next.add(id);
      return node.dependsOn.every((dep) => independent(dep, next));
    }
    if (node.availability === "vault-sealed") return false;
    // external-unproven: does not satisfy last-verified independence alone.
    return false;
  }

  return protectorIds.some((id) => independent(id, new Set()));
}

/**
 * Fail closed when unlock would cycle through vault-sealed secrets only
 * (KP-26 age inventory, KP-37 in-vault cloud token).
 */
export function assertBootstrapFeasible(
  nodes: readonly BootstrapDependencyNode[],
  protectorIds: readonly string[],
): void {
  const cycles = findBootstrapCycles(nodes);
  if (cycles.length > 0) {
    throw new ProtectionError(
      "bootstrap_cycle",
      `Root unlock depends on a cycle through vault-sealed material (${cycles[0]?.path.join(" → ") ?? "unknown"}).`,
    );
  }
  if (!hasIndependentBootstrapPath(nodes, protectorIds)) {
    throw new ProtectionError(
      "bootstrap_cycle",
      "Root unlock depends only on secrets inside the locked vault.",
    );
  }
}
