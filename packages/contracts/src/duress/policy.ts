import { z } from "zod";
import { DURESS_BOUNDS as B } from "./bounds.js";

/** Opaque reference string used across duress wire documents. */
export const DuressRefSchema = z
  .string()
  .min(B.refMin)
  .max(B.refMax)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/, "invalid duress ref");

export const DuressRevisionSchema = z
  .number()
  .int()
  .positive()
  .max(B.revisionMax);

export const ScopeBindingSchema = z
  .object({
    ownerPrincipalRef: DuressRefSchema,
    organizationRef: DuressRefSchema.nullable(),
    vaultRef: DuressRefSchema,
    deviceBindingRef: DuressRefSchema,
    compartmentRefs: z
      .array(DuressRefSchema)
      .max(B.compartmentRefsMax)
      .readonly(),
  })
  .strict();

export const PresentationClassSchema = z.enum([
  "normal",
  "restricted",
  "decoy",
  "locked",
  "unchanged",
]);

export const TriggerKindSchema = z.enum([
  "application_code",
  "verified_uv_then_code",
  "prf_and_code",
  "canary_activation",
  "delegated_peer_request",
  "approval_ceremony_code",
]);

const DurationMsSchema = z.union([
  z.literal("indefinite"),
  z.number().int().positive().max(B.durationMsMax),
]);

export const HoldSpecSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }).strict(),
  z
    .object({
      kind: z.literal("local_application"),
      durationMs: DurationMsSchema,
      disclosureAck: z.literal(true),
    })
    .strict(),
  z
    .object({
      kind: z.literal("independent_authority"),
      authorityRef: DuressRefSchema,
      durationMs: DurationMsSchema,
      disclosureAck: z.literal(true),
    })
    .strict(),
  z
    .object({
      kind: z.literal("custodial_reenrollment"),
      recoveryPolicyRef: DuressRefSchema,
      disclosureAck: z.literal(true),
    })
    .strict(),
]);

export const AlertSpecSchema = z
  .object({
    routeRef: DuressRefSchema,
    templateRef: DuressRefSchema,
    retainOutboxAcrossRemoval: z.boolean(),
    maxRetries: z.number().int().nonnegative().max(B.maxRetriesMax),
    expiryMs: z.number().int().positive().max(B.expiryMsMax),
  })
  .strict();

export const RemovalSpecSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }).strict(),
  z
    .object({
      kind: z.literal("local_enumerated"),
      resourceRefs: z.array(DuressRefSchema).min(1).max(B.resourceRefsMax),
      preserveSealedOutbox: z.boolean(),
      acceptUnrecoverability: z.boolean(),
    })
    .strict(),
]);

export const ProfileEffectSpecSchema = z
  .object({
    presentation: PresentationClassSchema,
    presentationCompartmentRef: DuressRefSchema.nullable(),
    hold: HoldSpecSchema,
    alert: AlertSpecSchema.nullable(),
    quarantinePeerRefs: z
      .array(DuressRefSchema)
      .max(B.quarantinePeersMax)
      .readonly(),
    providerRevocationRefs: z
      .array(DuressRefSchema)
      .max(B.providerRevocationsMax)
      .readonly(),
    removal: RemovalSpecSchema,
    recoveryPolicyRef: DuressRefSchema.nullable(),
    operationCeilingRef: DuressRefSchema.nullable(),
  })
  .strict();

export const PolicyProfileSchema = z
  .object({
    profileId: DuressRefSchema,
    label: z.string().min(1).max(B.labelMax),
    scope: ScopeBindingSchema,
    triggerKind: TriggerKindSchema,
    effects: ProfileEffectSpecSchema,
  })
  .strict();

/**
 * Versioned duress policy document.
 *
 * `enabled` is import-preview / settings state only. Compilers and importers
 * must never treat a document parse as silently arming or clearing profiles.
 */
export const PolicyDocumentSchema = z
  .object({
    schemaVersion: z.literal(1),
    policyId: DuressRefSchema,
    revision: DuressRevisionSchema,
    enabled: z.boolean(),
    profiles: z.array(PolicyProfileSchema).max(B.profilesMax),
  })
  .strict();

export type ScopeBinding = z.infer<typeof ScopeBindingSchema>;
export type PresentationClass = z.infer<typeof PresentationClassSchema>;
export type TriggerKind = z.infer<typeof TriggerKindSchema>;
export type HoldSpec = z.infer<typeof HoldSpecSchema>;
export type AlertSpec = z.infer<typeof AlertSpecSchema>;
export type RemovalSpec = z.infer<typeof RemovalSpecSchema>;
export type ProfileEffectSpec = z.infer<typeof ProfileEffectSpecSchema>;
export type PolicyProfile = z.infer<typeof PolicyProfileSchema>;
export type PolicyDocument = z.infer<typeof PolicyDocumentSchema>;
