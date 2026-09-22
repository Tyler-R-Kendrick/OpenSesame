import { z } from "zod";
import { DuressRefSchema, DuressRevisionSchema } from "./policy.js";

export const CompilerErrorCodeSchema = z.enum([
  "scope_mismatch",
  "ambiguous_trigger",
  "independent_keys_required",
  "unsupported_factor",
  "alternate_unlock_bypass",
  "circular_recovery",
  "unavailable_authority",
  "undurable_storage",
  "contradictory_actions",
  "unapproved_route",
  "stale_policy",
  "stale_session",
  "retired_device",
  "unsupported_profile_version",
  "recovery_required",
]);

export type CompilerErrorCode = z.infer<typeof CompilerErrorCodeSchema>;

export const CompilerDiagnosticSchema = z
  .object({
    code: CompilerErrorCodeSchema,
    path: z.string().max(512),
    message: z.string().max(1024),
  })
  .strict();

export type CompilerDiagnostic = z.infer<typeof CompilerDiagnosticSchema>;

export const DuressAssuranceLevelSchema = z.enum([
  "unavailable",
  "unsupported",
  "configured",
  "verified_ready",
]);

export type DuressAssuranceLevel = z.infer<typeof DuressAssuranceLevelSchema>;

export const EffectAssuranceSchema = z
  .object({
    effect: z.enum([
      "presentation",
      "hold",
      "alert",
      "quarantine",
      "provider_revocation",
      "removal",
      "recovery",
    ]),
    level: DuressAssuranceLevelSchema,
    detail: z.string().max(512).optional(),
  })
  .strict();

export type EffectAssurance = z.infer<typeof EffectAssuranceSchema>;

export const ExposureSummarySchema = z
  .object({
    profileId: DuressRefSchema,
    admittedCompartmentRefs: z.array(DuressRefSchema).max(64),
    deniedCompartmentRefs: z.array(DuressRefSchema).max(64),
    unlockPathLabels: z.array(z.string().max(256)).max(64),
    alternateWrapperWarnings: z.array(z.string().max(512)).max(64),
    historicalCopyDisclosure: z.boolean(),
  })
  .strict();

export type ExposureSummary = z.infer<typeof ExposureSummarySchema>;

export const IncidentStateSchema = z.enum([
  "active",
  "recovery_requested",
  "resolved",
  "superseded",
]);

export type IncidentState = z.infer<typeof IncidentStateSchema>;

export const EffectStatusSchema = z.enum([
  "not_requested",
  "pending",
  "applied_local",
  "accepted_remote",
  "confirmed_remote",
  "failed",
  "expired",
  "completion_unknown",
]);

export const IncidentRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    incidentId: DuressRefSchema,
    profileId: DuressRefSchema,
    policyRevision: DuressRevisionSchema,
    keyEpoch: DuressRevisionSchema,
    incidentEpoch: DuressRevisionSchema,
    localRevision: DuressRevisionSchema,
    state: IncidentStateSchema,
    scopeSnapshot: z
      .object({
        vaultRef: DuressRefSchema,
        deviceBindingRef: DuressRefSchema,
        compartmentRefs: z.array(DuressRefSchema).min(1).max(64),
      })
      .strict(),
    activationEvidenceDigest: z.string().min(16).max(128),
    effects: z
      .object({
        presentation: EffectStatusSchema,
        hold: EffectStatusSchema,
        alert: EffectStatusSchema,
        quarantine: EffectStatusSchema,
        providerRevocation: EffectStatusSchema,
        removal: EffectStatusSchema,
      })
      .strict(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();

export type IncidentRecord = z.infer<typeof IncidentRecordSchema>;

export const EnrollmentManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    vaultRef: DuressRefSchema,
    deviceBindingRef: DuressRefSchema,
    policyId: DuressRefSchema,
    policyRevision: DuressRevisionSchema,
    keyEpoch: DuressRevisionSchema,
    slotCount: z.number().int().min(0).max(8),
    armed: z.boolean(),
    readiness: z
      .object({
        durableStorage: DuressAssuranceLevelSchema,
        offlineAssets: DuressAssuranceLevelSchema,
        rehearsalPassed: z.boolean(),
        ownerConsent: z.boolean(),
      })
      .strict(),
  })
  .strict();

export type EnrollmentManifest = z.infer<typeof EnrollmentManifestSchema>;

/** Authorized catalog used by the pure compiler (no I/O). */
export const CompilerCatalogSchema = z
  .object({
    ownerPrincipalRefs: z.array(DuressRefSchema).max(256),
    organizationRefs: z.array(DuressRefSchema).max(256),
    vaultRefs: z.array(DuressRefSchema).max(64),
    deviceBindingRefs: z.array(DuressRefSchema).max(256),
    compartmentRefs: z.array(DuressRefSchema).max(256),
    /** Compartments with independently generated roots (not shared-root projects). */
    independentCompartmentRefs: z.array(DuressRefSchema).max(256),
    routeRefs: z.array(DuressRefSchema).max(128),
    peerRefs: z.array(DuressRefSchema).max(128),
    providerActionRefs: z.array(DuressRefSchema).max(128),
    recoveryPolicyRefs: z.array(DuressRefSchema).max(64),
    operationCeilingRefs: z.array(DuressRefSchema).max(64),
    authorityRefs: z.array(DuressRefSchema).max(64),
    durableStorage: z.boolean(),
    /** Admitted alternate unlock wrappers that would bypass a claimed hold/two-input. */
    alternateUnlockPaths: z
      .array(
        z
          .object({
            profileId: DuressRefSchema.optional(),
            label: z.string().max(256),
            bypassesClaim: z.boolean(),
          })
          .strict(),
      )
      .max(64),
    /** Device bindings known retired — compile must fail closed. */
    retiredDeviceBindingRefs: z.array(DuressRefSchema).max(256).optional(),
    /** Minimum accepted policy revision; older documents are stale. */
    minPolicyRevision: DuressRevisionSchema.optional(),
    /** Session digest expected at compile boundary, if any. */
    expectedSessionDigest: z.string().min(16).max(128).nullable().optional(),
    /** Session digest presented by caller; null when no session. */
    presentedSessionDigest: z.string().min(16).max(128).nullable().optional(),
    /** Recovery edges for cycle detection: fromPolicy -> dependsOnPolicy. */
    recoveryEdges: z
      .array(
        z
          .object({
            fromPolicyRef: DuressRefSchema,
            dependsOnPolicyRef: DuressRefSchema,
          })
          .strict(),
      )
      .max(128)
      .optional(),
    /** Effects whose readiness was independently verified (rehearsal). */
    verifiedReadyEffects: z
      .array(
        z.enum([
          "presentation",
          "hold",
          "alert",
          "quarantine",
          "provider_revocation",
          "removal",
          "recovery",
        ]),
      )
      .max(16)
      .optional(),
  })
  .strict();

export type CompilerCatalog = z.infer<typeof CompilerCatalogSchema>;
