/**
 * Operator withdrawal of always-on capabilities (ADR 0138): the one place
 * the resolver lets a policy take core out of a plan.
 */
import type { ResolveInput } from "./resolve-input.js";
import type { CapabilityDescriptor, CapabilityId } from "./types.js";

/**
 * The always-on capabilities an operator withdrew: those a verified instance
 * policy names in `prohibited`, then every always-on one depending on them.
 * Always on is the default, not a mandate — an operator may still say no.
 */
export function withdrawnCore(
  input: ResolveInput,
  index: ReadonlyMap<CapabilityId, CapabilityDescriptor>,
): Set<CapabilityId> {
  const policy = input.instancePolicy;
  if (policy === null || !input.policyValid) return new Set();
  const modular = (id: CapabilityId): boolean => {
    const d = index.get(id);
    return d?.tier === "core" && d.moduleIds.length > 0;
  };
  const out = new Set(policy.capabilities.prohibited.filter(modular));
  let grew = out.size > 0;
  while (grew) {
    grew = false;
    for (const d of index.values()) {
      if (!modular(d.id) || out.has(d.id)) continue;
      if (d.dependencies.some((dep) => out.has(dep))) {
        out.add(d.id);
        grew = true;
      }
    }
  }
  return out;
}
