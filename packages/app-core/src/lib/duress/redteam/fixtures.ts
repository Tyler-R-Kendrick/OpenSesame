/**
 * Disposable REDTEAM fixtures only — never real vaults/recipients/tokens.
 */

import type { CompilerCatalog } from "@opensesame/contracts";
import type { JsonObject } from "../json-boundary.js";
import type { EnrollmentState } from "../trigger/enrollment.js";

export const RT_VAULT = "rt-vault-1";
export const RT_DEVICE = "rt-device-1";
export const RT_CODE = "48291037";
export const RT_CODE_ALT = "01928374";

export function emptyEnrollment(
  overrides: Partial<EnrollmentState> = {},
): EnrollmentState {
  return {
    vaultRef: RT_VAULT,
    deviceBindingRef: RT_DEVICE,
    policyRevision: 1,
    keyEpoch: 1,
    triggers: [],
    ordinaryCodeFingerprints: [],
    rehearsalPassed: true,
    ownerConsent: true,
    armed: false,
    capabilities: {
      durableLocalStorage: true,
      prfAvailable: true,
      userVerificationAvailable: true,
      offlineReady: true,
    },
    ...overrides,
  };
}

export const RT_CATALOG: CompilerCatalog = {
  ownerPrincipalRefs: ["rt-owner"],
  organizationRefs: ["rt-org"],
  vaultRefs: [RT_VAULT],
  deviceBindingRefs: [RT_DEVICE],
  compartmentRefs: ["comp-normal", "comp-decoy", "comp-restricted"],
  independentCompartmentRefs: ["comp-decoy", "comp-restricted"],
  routeRefs: ["route-alert-1"],
  peerRefs: ["peer-1"],
  providerActionRefs: [],
  recoveryPolicyRefs: ["recovery-1"],
  operationCeilingRefs: ["ceiling-restricted"],
  authorityRefs: ["host-authority-1"],
  durableStorage: true,
  alternateUnlockPaths: [],
};

export function alertOnlyPolicy(extra: JsonObject = {}) {
  return {
    schemaVersion: 1,
    policyId: "rt-pol",
    revision: 1,
    enabled: true,
    profiles: [
      {
        profileId: "profile-alert",
        label: "Alert only",
        scope: {
          ownerPrincipalRef: "rt-owner",
          organizationRef: null,
          vaultRef: RT_VAULT,
          deviceBindingRef: RT_DEVICE,
          compartmentRefs: ["comp-normal"],
        },
        triggerKind: "application_code",
        effects: {
          presentation: "normal",
          presentationCompartmentRef: null,
          hold: { kind: "none" },
          alert: {
            routeRef: "route-alert-1",
            templateRef: "tpl-1",
            retainOutboxAcrossRemoval: false,
            maxRetries: 3,
            expiryMs: 3_600_000,
          },
          quarantinePeerRefs: [],
          providerRevocationRefs: [],
          removal: { kind: "none" },
          recoveryPolicyRef: null,
          operationCeilingRef: null,
        },
      },
    ],
    ...extra,
  };
}
