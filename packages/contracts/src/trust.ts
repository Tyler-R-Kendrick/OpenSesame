import { z } from "zod";
export const AssuranceRequirementSchema = z
  .object({
    subjectKind: z.enum(["human", "agent", "workload"]),
    minimumIdentityProofing: z
      .array(
        z.enum([
          "none",
          "self_attested",
          "verified_account",
          "remote_unattended",
          "remote_attended",
          "in_person",
          "enterprise_asserted",
        ]),
      )
      .max(8)
      .optional(),
    requireUserVerification: z.boolean().optional(),
    requirePhishingResistance: z.boolean().optional(),
    requireVerifierNameBinding: z.boolean().optional(),
    minimumDeviceBinding: z
      .array(z.enum(["none", "software", "hardware"]))
      .max(3)
      .optional(),
    minimumKeyProtection: z
      .array(
        z.enum([
          "unknown",
          "software_exportable",
          "software_non_exportable",
          "tee_backed",
          "strongbox_backed",
          "external_hardware",
        ]),
      )
      .max(6)
      .optional(),
    maximumAuthenticationAgeSeconds: z
      .number()
      .int()
      .positive()
      .max(31_536_000)
      .optional(),
    maximumEvidenceAgeSeconds: z
      .number()
      .int()
      .positive()
      .max(31_536_000)
      .optional(),
    acceptableIssuers: z.array(z.string().url()).max(32).optional(),
    acceptableAcrValues: z.array(z.string().min(1).max(256)).max(32).optional(),
  })
  .strict();
export const PresentationIntentSchema = z
  .object({
    id: z.string().min(1).max(128),
    principalId: z.string().min(1).max(256),
    requesterAgentId: z.string().min(1).max(256),
    verifierId: z.string().min(1).max(256),
    verifierOrigin: z.string().url().optional(),
    requestedClaims: z.array(z.string().min(1).max(128)).max(32),
    purpose: z.string().min(1).max(512),
    assuranceRequirement: AssuranceRequirementSchema,
    requestDigest: z.string().regex(/^[a-f0-9]{64}$/),
    createdAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
  })
  .strict();
export type AssuranceRequirementWire = z.infer<
  typeof AssuranceRequirementSchema
>;
export type PresentationIntentWire = z.infer<typeof PresentationIntentSchema>;
