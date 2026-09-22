import { defined } from "./defined.js";
import type {
  CompilerCatalog,
  CompilerDiagnostic,
  EffectAssurance,
  ExposureSummary,
} from "./evidence.js";
import type { PolicyProfile } from "./policy.js";

export function has(list: readonly string[], ref: string): boolean {
  return list.includes(ref);
}

export function scopesOverlap(
  a: PolicyProfile["scope"],
  b: PolicyProfile["scope"],
): boolean {
  if (a.vaultRef !== b.vaultRef) return false;
  if (a.deviceBindingRef !== b.deviceBindingRef) return false;
  if (a.ownerPrincipalRef !== b.ownerPrincipalRef) return false;
  const setB = new Set(b.compartmentRefs);
  return a.compartmentRefs.some((c) => setB.has(c));
}

export function recoveryCycle(
  start: string,
  edges: ReadonlyArray<{ fromPolicyRef: string; dependsOnPolicyRef: string }>,
): boolean {
  const adj = new Map<string, string[]>();
  for (const e of edges) {
    const list = adj.get(e.fromPolicyRef) ?? [];
    list.push(e.dependsOnPolicyRef);
    adj.set(e.fromPolicyRef, list);
  }
  const seen = new Set<string>();
  const stack = [start];
  while (stack.length > 0) {
    const cur = defined(stack.pop(), "stack frame");
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const next of adj.get(cur) ?? []) {
      if (next === start) return true;
      stack.push(next);
    }
  }
  return false;
}

export function elevateAssurance(
  level: EffectAssurance["level"],
  effect: EffectAssurance["effect"],
  verified: ReadonlyArray<EffectAssurance["effect"]>,
): EffectAssurance["level"] {
  if (level === "configured" && verified.includes(effect))
    return "verified_ready";
  return level;
}

export function diag(
  code: CompilerDiagnostic["code"],
  path: string,
  message: string,
): CompilerDiagnostic {
  return { code, path, message };
}
