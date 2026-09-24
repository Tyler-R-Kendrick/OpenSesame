/**
 * Disposable compiler catalog for settings preview / tests.
 * Never use production vault refs in CI fixtures.
 */

import type { CompilerCatalog } from "@opensesame/contracts/duress";

export const SETTINGS_FIXTURE_CATALOG: CompilerCatalog = {
  ownerPrincipalRefs: ["owner-1"],
  organizationRefs: ["org-1"],
  vaultRefs: ["vault-1"],
  deviceBindingRefs: ["device-1"],
  compartmentRefs: [
    "comp-normal",
    "comp-decoy",
    "comp-restricted",
    "comp-sensitive",
  ],
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
