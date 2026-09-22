import type { BoundaryValue } from "@opensesame/os-domain";
import type { CompilerErrorCode } from "../evidence.js";

export const INVALID_FIXTURES_PART_1 = {
  alternate_unlock_bypass: {
    schemaVersion: 1,
    policyId: "bad-policy",
    revision: 1,
    enabled: false,
    profiles: [
      {
        profileId: "prf",
        label: "bad",
        scope: {
          ownerPrincipalRef: "owner-1",
          organizationRef: null,
          vaultRef: "vault-1",
          deviceBindingRef: "device-1",
          compartmentRefs: ["comp-normal"],
        },
        triggerKind: "prf_and_code",
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

  ambiguous_trigger: {
    schemaVersion: 1,
    policyId: "bad-policy",
    revision: 1,
    enabled: false,
    profiles: [
      {
        profileId: "a",
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
      {
        profileId: "b",
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

  circular_recovery: {
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
          recoveryPolicyRef: "recovery-cycle-a",
          operationCeilingRef: null,
        },
      },
    ],
  },

  contradictory_actions: {
    schemaVersion: 1,
    policyId: "bad-policy",
    revision: 1,
    enabled: false,
    profiles: [
      {
        profileId: "bad-canary",
        label: "bad",
        scope: {
          ownerPrincipalRef: "owner-1",
          organizationRef: null,
          vaultRef: "vault-1",
          deviceBindingRef: "device-1",
          compartmentRefs: ["comp-normal"],
        },
        triggerKind: "canary_activation",
        effects: {
          presentation: "unchanged",
          presentationCompartmentRef: null,
          hold: {
            kind: "none",
          },
          alert: {
            routeRef: "route-alert-1",
            templateRef: "tpl",
            retainOutboxAcrossRemoval: false,
            maxRetries: 1,
            expiryMs: 60000,
          },
          quarantinePeerRefs: [],
          providerRevocationRefs: [],
          removal: {
            kind: "local_enumerated",
            resourceRefs: ["comp-normal"],
            preserveSealedOutbox: false,
            acceptUnrecoverability: true,
          },
          recoveryPolicyRef: null,
          operationCeilingRef: null,
        },
      },
    ],
  },

  independent_keys_required: {
    schemaVersion: 1,
    policyId: "bad-policy",
    revision: 1,
    enabled: false,
    profiles: [
      {
        profileId: "decoy",
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
          presentation: "decoy",
          presentationCompartmentRef: "comp-normal",
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
          operationCeilingRef: "ceiling-restricted",
        },
      },
    ],
  },

  recovery_required: {
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
            kind: "local_application",
            durationMs: "indefinite",
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

  retired_device: {
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
          deviceBindingRef: "device-retired",
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

  scope_mismatch: {
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
          vaultRef: "vault-unknown",
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
} satisfies Partial<Record<CompilerErrorCode, BoundaryValue>>;
