import { z } from "zod";
import { DURESS_BOUNDS as B } from "./bounds.js";
import { EffectStatusSchema, IncidentStateSchema } from "./evidence.js";
import { DuressRefSchema, PresentationClassSchema } from "./policy.js";

const IsoDateTime = z.string().datetime({ offset: true });

export const EffectKindSchema = z.enum([
  "presentation",
  "hold",
  "alert",
  "quarantine",
  "provider_revocation",
  "removal",
  "recovery",
  "operation_ceiling",
]);

export const EffectOutcomeSchema = z
  .object({
    kind: EffectKindSchema,
    status: EffectStatusSchema,
    /** Honest label when capability is unsupported — never stubbed success. */
    unsupported: z.boolean(),
    detail: z.string().max(B.noteMax).optional(),
  })
  .strict();

/**
 * Result of applying a duress profile. Delivery ≠ receipt: alert outcome
 * statuses remain distinct from presentation/unlock outcomes.
 */
export const DuressResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    incidentId: DuressRefSchema,
    profileId: DuressRefSchema,
    policyDigest: z.string().min(B.digestMin).max(B.digestMax),
    incidentState: IncidentStateSchema,
    presentation: PresentationClassSchema,
    outcomes: z.array(EffectOutcomeSchema).max(B.effectsPerIncidentMax),
    appliedAt: IsoDateTime,
  })
  .strict();

export type EffectKind = z.infer<typeof EffectKindSchema>;
export type EffectOutcome = z.infer<typeof EffectOutcomeSchema>;
export type DuressResult = z.infer<typeof DuressResultSchema>;
