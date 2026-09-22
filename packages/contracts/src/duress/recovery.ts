import { z } from "zod";
import { DURESS_BOUNDS as B } from "./bounds.js";
import { DuressRefSchema } from "./policy.js";

const IsoDateTime = z.string().datetime({ offset: true });

export const RecoveryCeremonyKindSchema = z.enum([
  "owner_reauth",
  "custodial_threshold",
  "independent_authority_release",
  "shamir_reassembly",
]);

/**
 * Recovery policy lives outside the removed compartment.
 * Ceremony kinds are exhaustive — no arbitrary webhooks.
 */
export const RecoveryPolicySchema = z
  .object({
    schemaVersion: z.literal(1),
    recoveryPolicyId: DuressRefSchema,
    label: z.string().min(1).max(B.labelMax),
    ceremony: RecoveryCeremonyKindSchema,
    outsideCompartmentRefs: z
      .array(DuressRefSchema)
      .min(1)
      .max(B.compartmentRefsMax),
    authorityRef: DuressRefSchema.nullable(),
    thresholdN: z.number().int().positive().max(16).nullable(),
    thresholdK: z.number().int().positive().max(16).nullable(),
    createdAt: IsoDateTime,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.thresholdK !== null &&
      value.thresholdN !== null &&
      value.thresholdK > value.thresholdN
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "thresholdK must be <= thresholdN",
        path: ["thresholdK"],
      });
    }
    if (
      value.ceremony === "independent_authority_release" &&
      value.authorityRef === null
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "authorityRef required for independent_authority_release",
        path: ["authorityRef"],
      });
    }
  });

export type RecoveryCeremonyKind = z.infer<typeof RecoveryCeremonyKindSchema>;
export type RecoveryPolicy = z.infer<typeof RecoveryPolicySchema>;
