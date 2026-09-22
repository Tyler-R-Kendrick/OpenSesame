import { diag, has } from "./compiler-util.js";
import type { CompilerCatalog, CompilerDiagnostic } from "./evidence.js";
import type { PolicyProfile } from "./policy.js";

export function validateRemovalAndRecoveryEffects(
  profile: PolicyProfile,
  catalog: CompilerCatalog,
  diagnostics: CompilerDiagnostic[],
  base: string,
  effects: PolicyProfile["effects"],
  presentationNeedsKey: boolean,
): void {
  for (const peer of effects.quarantinePeerRefs) {
    if (!has(catalog.peerRefs, peer)) {
      diagnostics.push(
        diag(
          "unavailable_authority",
          `${base}.effects.quarantinePeerRefs`,
          `Unknown peer ${peer}.`,
        ),
      );
    }
  }

  for (const prov of effects.providerRevocationRefs) {
    if (!has(catalog.providerActionRefs, prov)) {
      diagnostics.push(
        diag(
          "unsupported_factor",
          `${base}.effects.providerRevocationRefs`,
          `Provider revocation ${prov} not in catalog.`,
        ),
      );
    }
  }

  if (effects.recoveryPolicyRef) {
    if (!has(catalog.recoveryPolicyRefs, effects.recoveryPolicyRef)) {
      diagnostics.push(
        diag(
          "unavailable_authority",
          `${base}.effects.recoveryPolicyRef`,
          "Recovery policy not in catalog.",
        ),
      );
    }
  }

  if (
    effects.removal.kind === "local_enumerated" &&
    !effects.removal.acceptUnrecoverability &&
    !effects.recoveryPolicyRef &&
    effects.hold.kind !== "custodial_reenrollment"
  ) {
    diagnostics.push(
      diag(
        "recovery_required",
        `${base}.effects.removal`,
        "Local removal with preserved recoverability requires a recovery policy.",
      ),
    );
  }

  if (!catalog.durableStorage && effects.removal.kind !== "none") {
    diagnostics.push(
      diag(
        "undurable_storage",
        `${base}.effects.removal`,
        "Destructive local effects require durable storage readiness.",
      ),
    );
  }
}
