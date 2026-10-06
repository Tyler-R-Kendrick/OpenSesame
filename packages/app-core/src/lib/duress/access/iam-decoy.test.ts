import { expect, it } from "vitest";
import type { FenceState } from "../session/fence.js";
import { issueAccessContext } from "./context.js";
import { capabilityDeniedByFence, roleUnderFence } from "./iam.js";

it("denies decoy IAM authority even without a device incident", () => {
  const ctx = issueAccessContext({
    principalRef: "synthetic",
    tenantRef: null,
    vaultRef: "guest",
    compartmentRefs: ["synthetic"],
    deviceBindingRef: "local",
    presentation: "decoy",
    authorizationCeiling: [],
    denyOperations: [],
    policyRevision: 1,
    incidentEpoch: 0,
    keyEpoch: 1,
    sessionGeneration: 1,
    profileId: null,
    evidenceDigest: "local",
  });
  const fence: FenceState = {
    incidentEpoch: 0,
    policyRevision: 0,
    keyEpoch: 0,
    activeIncidentIds: [],
    denyOperations: [],
    admittedCompartmentRefs: [],
    retiredDevice: false,
  };
  expect(capabilityDeniedByFence("manage_identity", fence, ctx)).toBe(true);
  expect(roleUnderFence("operator", fence, ctx)).toBe("guest");
});
