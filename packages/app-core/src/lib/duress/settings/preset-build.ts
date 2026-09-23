/**
 * Preset → PolicyDocument preview builders (SETTINGS presets).
 */

import type { PolicyDocument, PolicyProfile } from "@opensesame/contracts";
import {
  PRESET_CATALOG,
  type PresetId,
  type PresetScope,
} from "./preset-catalog.js";

function baseEffects(
  presentation: PolicyProfile["effects"]["presentation"],
  scope: PresetScope,
  extras: Partial<PolicyProfile["effects"]> = {},
): PolicyProfile["effects"] {
  return {
    presentation,
    presentationCompartmentRef: extras.presentationCompartmentRef ?? null,
    hold: extras.hold ?? { kind: "none" },
    alert: extras.alert ?? null,
    quarantinePeerRefs: extras.quarantinePeerRefs ?? [],
    providerRevocationRefs: extras.providerRevocationRefs ?? [],
    removal: extras.removal ?? { kind: "none" },
    recoveryPolicyRef: extras.recoveryPolicyRef ?? null,
    operationCeilingRef: extras.operationCeilingRef ?? null,
  };
}

function alertSpec(scope: PresetScope) {
  return {
    routeRef: scope.alertRouteRef ?? "route-alert-1",
    templateRef: scope.alertTemplateRef ?? "tpl-duress",
    retainOutboxAcrossRemoval: false,
    maxRetries: 3,
    expiryMs: 3_600_000,
  };
}

function commonScope(scope: PresetScope) {
  return {
    ownerPrincipalRef: scope.ownerPrincipalRef,
    organizationRef: scope.organizationRef,
    vaultRef: scope.vaultRef,
    deviceBindingRef: scope.deviceBindingRef,
    compartmentRefs: [...scope.compartmentRefs],
  };
}

type ProfileBuilder = (scope: PresetScope, label: string) => PolicyProfile;

const PROFILE_BUILDERS = {
  "SC-ALERT-ONLY": (scope, label) => ({
    profileId: "alert-only",
    label,
    scope: commonScope(scope),
    triggerKind: "application_code",
    effects: baseEffects("normal", scope, { alert: alertSpec(scope) }),
  }),
  "SC-RESTRICTED": (scope, label) => ({
    profileId: "restricted",
    label,
    scope: commonScope(scope),
    triggerKind: "application_code",
    effects: baseEffects("restricted", scope, {
      presentationCompartmentRef:
        scope.presentationCompartmentRef ?? "comp-restricted",
      operationCeilingRef: scope.operationCeilingRef ?? "ceiling-restricted",
    }),
  }),
  "SC-DECOY": (scope, label) => ({
    profileId: "decoy",
    label,
    scope: commonScope(scope),
    triggerKind: "application_code",
    effects: baseEffects("decoy", scope, {
      presentationCompartmentRef:
        scope.presentationCompartmentRef ?? "comp-decoy",
      operationCeilingRef: scope.operationCeilingRef ?? "ceiling-restricted",
    }),
  }),
  "SC-LOCAL-HOLD": (scope, label) => ({
    profileId: "local-hold",
    label,
    scope: commonScope(scope),
    triggerKind: "application_code",
    effects: baseEffects("locked", scope, {
      hold: {
        kind: "local_application",
        durationMs: "indefinite",
        disclosureAck: true,
      },
      recoveryPolicyRef: scope.recoveryPolicyRef ?? "recovery-1",
    }),
  }),
  "SC-CUSTODIAN-HOLD": (scope, label) => ({
    profileId: "custodian-hold",
    label,
    scope: commonScope(scope),
    triggerKind: "application_code",
    effects: baseEffects("locked", scope, {
      hold: {
        kind: "custodial_reenrollment",
        recoveryPolicyRef: scope.recoveryPolicyRef ?? "recovery-1",
        disclosureAck: true,
      },
      recoveryPolicyRef: scope.recoveryPolicyRef ?? "recovery-1",
    }),
  }),
  "SC-QUARANTINE": (scope, label) => ({
    profileId: "quarantine",
    label,
    scope: commonScope(scope),
    triggerKind: "application_code",
    effects: baseEffects("restricted", scope, {
      presentationCompartmentRef:
        scope.presentationCompartmentRef ?? "comp-restricted",
      operationCeilingRef: scope.operationCeilingRef ?? "ceiling-restricted",
      quarantinePeerRefs: [scope.peerRef ?? "peer-1"],
    }),
  }),
  "SC-LOCAL-REMOVE": (scope, label) => ({
    profileId: "local-remove",
    label,
    scope: commonScope(scope),
    triggerKind: "application_code",
    effects: baseEffects("locked", scope, {
      removal: {
        kind: "local_enumerated",
        resourceRefs: [...(scope.removalResourceRefs ?? ["comp-sensitive"])],
        preserveSealedOutbox: true,
        acceptUnrecoverability: true,
      },
      alert: alertSpec(scope),
    }),
  }),
  "SC-LIMITED-CARRY": (scope, label) => ({
    profileId: "limited-carry",
    label,
    scope: commonScope(scope),
    triggerKind: "application_code",
    effects: baseEffects("restricted", scope, {
      presentationCompartmentRef:
        scope.presentationCompartmentRef ?? "comp-restricted",
      operationCeilingRef: scope.operationCeilingRef ?? "ceiling-restricted",
    }),
  }),
  "SC-APPROVAL-DURESS": (scope, label) => ({
    profileId: "approval-duress",
    label,
    scope: commonScope(scope),
    triggerKind: "approval_ceremony_code",
    effects: baseEffects("locked", scope),
  }),
  "SC-LOST-DEVICE": (scope, label) => ({
    profileId: "lost-device",
    label,
    scope: commonScope(scope),
    triggerKind: "delegated_peer_request",
    effects: baseEffects("unchanged", scope, {
      quarantinePeerRefs: [scope.peerRef ?? "peer-1"],
    }),
  }),
  "SC-SPLIT-SCOPE": (scope, label) => ({
    profileId: "split-scope",
    label,
    scope: {
      ...commonScope(scope),
      organizationRef: scope.organizationRef ?? "org-1",
    },
    triggerKind: "application_code",
    effects: baseEffects("restricted", scope, {
      presentationCompartmentRef:
        scope.presentationCompartmentRef ?? "comp-restricted",
      operationCeilingRef: scope.operationCeilingRef ?? "ceiling-restricted",
    }),
  }),
  "SC-CANARY": (scope, label) => ({
    profileId: "canary",
    label,
    scope: commonScope(scope),
    triggerKind: "canary_activation",
    effects: baseEffects("unchanged", scope, {
      alert: alertSpec(scope),
    }),
  }),
  "SC-REHEARSAL": (scope, label) => ({
    profileId: "rehearsal",
    label,
    scope: commonScope(scope),
    triggerKind: "application_code",
    effects: baseEffects("unchanged", scope),
  }),
} satisfies Record<PresetId, ProfileBuilder>;

export function buildPresetPolicy(
  presetId: PresetId,
  scope: PresetScope,
): PolicyDocument {
  const meta = PRESET_CATALOG.find((p) => p.id === presetId);
  if (!meta) {
    throw new Error(`unknown_preset:${presetId}`);
  }
  const build = PROFILE_BUILDERS[presetId];
  const profile = build(scope, meta.label);
  return {
    schemaVersion: 1,
    policyId: `preset-${presetId}`,
    revision: 1,
    enabled: false,
    profiles: [profile],
  };
}
