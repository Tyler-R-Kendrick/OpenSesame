import type { BoundaryValue } from "@opensesame/os-domain";
import type { CompilerErrorCode } from "../evidence.js";

export const INVALID_FIXTURES_PART_2 = {
  stale_policy: {
    schemaVersion: 1,
    policyId: "bad-policy",
    revision: 1,
    enabled: false,
    profiles: [
      {
        profileId: "p1",
        label: "bad",
        scope: {
          ownerPrincipalRef: "owner-1",
          organizationRef: null,
          vaultRef: "vault-1",
          deviceBindingRef: "device-1",
          compartmentRefs: ["comp-normal"],
        },
        triggerKind: "application_code",
        effects: {
          presentation: "normal",
          presentationCompartmentRef: null,
          hold: {
            kind: "none",
          },
          alert: null,
          quarantinePeerRefs: [],
          providerRevocationRefs: [],
          removal: {
            kind: "none",
          },
          recoveryPolicyRef: null,
          operationCeilingRef: null,
        },
      },
    ],
  },

  stale_session: {
    schemaVersion: 1,
    policyId: "bad-policy",
    revision: 1,
    enabled: false,
    profiles: [
      {
        profileId: "p1",
        label: "bad",
        scope: {
          ownerPrincipalRef: "owner-1",
          organizationRef: null,
          vaultRef: "vault-1",
          deviceBindingRef: "device-1",
          compartmentRefs: ["comp-normal"],
        },
        triggerKind: "application_code",
        effects: {
          presentation: "normal",
          presentationCompartmentRef: null,
          hold: {
            kind: "none",
          },
          alert: null,
          quarantinePeerRefs: [],
          providerRevocationRefs: [],
          removal: {
            kind: "none",
          },
          recoveryPolicyRef: null,
          operationCeilingRef: null,
        },
      },
    ],
  },

  unapproved_route: {
    schemaVersion: 1,
    policyId: "bad-policy",
    revision: 1,
    enabled: false,
    profiles: [
      {
        profileId: "p1",
        label: "bad",
        scope: {
          ownerPrincipalRef: "owner-1",
          organizationRef: null,
          vaultRef: "vault-1",
          deviceBindingRef: "device-1",
          compartmentRefs: ["comp-normal"],
        },
        triggerKind: "application_code",
        effects: {
          presentation: "normal",
          presentationCompartmentRef: null,
          hold: {
            kind: "none",
          },
          alert: {
            routeRef: "route-unknown",
            templateRef: "tpl",
            retainOutboxAcrossRemoval: false,
            maxRetries: 1,
            expiryMs: 60000,
          },
          quarantinePeerRefs: [],
          providerRevocationRefs: [],
          removal: {
            kind: "none",
          },
          recoveryPolicyRef: null,
          operationCeilingRef: null,
        },
      },
    ],
  },

  unavailable_authority: {
    schemaVersion: 1,
    policyId: "bad-policy",
    revision: 1,
    enabled: false,
    profiles: [
      {
        profileId: "p1",
        label: "bad",
        scope: {
          ownerPrincipalRef: "owner-1",
          organizationRef: null,
          vaultRef: "vault-1",
          deviceBindingRef: "device-1",
          compartmentRefs: ["comp-normal"],
        },
        triggerKind: "application_code",
        effects: {
          presentation: "normal",
          presentationCompartmentRef: null,
          hold: {
            kind: "independent_authority",
            authorityRef: "missing-authority",
            durationMs: 60000,
            disclosureAck: true,
          },
          alert: null,
          quarantinePeerRefs: [],
          providerRevocationRefs: [],
          removal: {
            kind: "none",
          },
          recoveryPolicyRef: null,
          operationCeilingRef: null,
        },
      },
    ],
  },

  undurable_storage: {
    schemaVersion: 1,
    policyId: "bad-policy",
    revision: 1,
    enabled: false,
    profiles: [
      {
        profileId: "p1",
        label: "bad",
        scope: {
          ownerPrincipalRef: "owner-1",
          organizationRef: null,
          vaultRef: "vault-1",
          deviceBindingRef: "device-1",
          compartmentRefs: ["comp-normal"],
        },
        triggerKind: "application_code",
        effects: {
          presentation: "normal",
          presentationCompartmentRef: null,
          hold: {
            kind: "none",
          },
          alert: {
            routeRef: "route-alert-1",
            templateRef: "tpl",
            retainOutboxAcrossRemoval: true,
            maxRetries: 1,
            expiryMs: 60000,
          },
          quarantinePeerRefs: [],
          providerRevocationRefs: [],
          removal: {
            kind: "local_enumerated",
            resourceRefs: ["comp-normal"],
            preserveSealedOutbox: true,
            acceptUnrecoverability: true,
          },
          recoveryPolicyRef: null,
          operationCeilingRef: null,
        },
      },
    ],
  },

  unsupported_factor: {
    schemaVersion: 1,
    policyId: "bad-policy",
    revision: 1,
    enabled: false,
    profiles: [
      {
        profileId: "p1",
        label: "bad",
        scope: {
          ownerPrincipalRef: "owner-1",
          organizationRef: null,
          vaultRef: "vault-1",
          deviceBindingRef: "device-1",
          compartmentRefs: ["comp-normal"],
        },
        triggerKind: "application_code",
        effects: {
          presentation: "normal",
          presentationCompartmentRef: null,
          hold: {
            kind: "none",
          },
          alert: null,
          quarantinePeerRefs: [],
          providerRevocationRefs: ["prov-unknown"],
          removal: {
            kind: "none",
          },
          recoveryPolicyRef: null,
          operationCeilingRef: null,
        },
      },
    ],
  },

  unsupported_profile_version: {
    schemaVersion: 99,
    policyId: "bad",
    revision: 1,
    enabled: false,
    profiles: [],
  },
} satisfies Partial<Record<CompilerErrorCode, BoundaryValue>>;
