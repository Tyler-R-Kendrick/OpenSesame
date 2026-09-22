import { type JsonObject, digestManifest } from "@opensesame/os-domain";
import type { PolicyDocument } from "./policy.js";

/**
 * Deterministic policy digest. `enabled` is excluded so arming state cannot
 * change cryptographic identity of the policy body.
 */
export function policyDigest(doc: PolicyDocument): string {
  const body: JsonObject = {
    schemaVersion: doc.schemaVersion,
    policyId: doc.policyId,
    revision: doc.revision,
    profiles: doc.profiles.map((profile) => ({
      profileId: profile.profileId,
      label: profile.label,
      scope: {
        ownerPrincipalRef: profile.scope.ownerPrincipalRef,
        organizationRef: profile.scope.organizationRef,
        vaultRef: profile.scope.vaultRef,
        deviceBindingRef: profile.scope.deviceBindingRef,
        compartmentRefs: [...profile.scope.compartmentRefs],
      },
      triggerKind: profile.triggerKind,
      effects: {
        presentation: profile.effects.presentation,
        presentationCompartmentRef: profile.effects.presentationCompartmentRef,
        hold: { ...profile.effects.hold },
        alert: profile.effects.alert ? { ...profile.effects.alert } : null,
        quarantinePeerRefs: [...profile.effects.quarantinePeerRefs],
        providerRevocationRefs: [...profile.effects.providerRevocationRefs],
        removal: { ...profile.effects.removal },
        recoveryPolicyRef: profile.effects.recoveryPolicyRef,
        operationCeilingRef: profile.effects.operationCeilingRef,
      },
    })),
  };
  return digestManifest(body);
}
