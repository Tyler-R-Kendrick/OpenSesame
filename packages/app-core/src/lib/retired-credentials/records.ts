/** Bounded pre-unlock record parser. Storage content establishes no authority. */
import { z } from "zod";
export const MAX_RETIRED_CREDENTIAL_TRAPS = 3;
export const MAX_RETIRED_CREDENTIAL_EVENTS = 32;
export const responseSchema = z.enum(["reject", "synthetic_decoy"]);
const trapSchema = z.object({
  id: z.string().min(1).max(128),
  createdAt: z.string().datetime(),
  response: responseSchema,
});
const observedEventSchema = z.object({
  type: z.literal("retired_credential_observed"),
  trapId: z.string().min(1).max(128),
  at: z.string().datetime(),
  response: responseSchema,
});
export const retiredDecoyActionSchema = z.enum([
  "vault_write",
  "authority_denied",
]);
const interactionEventSchema = z.object({
  type: z.literal("synthetic_decoy_interaction"),
  trapId: z.string().min(1).max(128),
  at: z.string().datetime(),
  response: z.literal("synthetic_decoy"),
  action: retiredDecoyActionSchema,
});
const eventSchema = z.discriminatedUnion("type", [
  observedEventSchema,
  interactionEventSchema,
]);
export type RetiredDecoyAction = z.infer<typeof retiredDecoyActionSchema>;
const recordSchema = z
  .object({
    v: z.literal(1),
    tomb: z.string().min(1).max(256),
    traps: z
      .array(
        trapSchema.extend({
          salt: z.string().regex(/^[A-Za-z0-9+/]{22}==$/),
          verifier: z.string().regex(/^[A-Za-z0-9+/]{43}=$/),
        }),
      )
      .max(MAX_RETIRED_CREDENTIAL_TRAPS),
    events: z.array(eventSchema).max(MAX_RETIRED_CREDENTIAL_EVENTS),
  })
  .strict()
  .refine(
    (r) => new Set(r.traps.map((t) => t.id)).size === r.traps.length,
    "Duplicate trap identifiers",
  );
export type RetiredCredentialResponse = z.infer<typeof responseSchema>;
export type RetiredCredentialTrap = z.infer<typeof trapSchema>;
export type RetiredCredentialEvent = z.infer<typeof eventSchema>;
export type Records = z.infer<typeof recordSchema>;
export type TrapRecord = Records["traps"][number];
export function parseRetiredCredentialRecords(
  raw: string,
  tomb: string,
): Records {
  if (new TextEncoder().encode(raw).length > 32768)
    throw new Error("Retired credential records are unavailable.");
  try {
    const parsed = recordSchema.parse(JSON.parse(raw));
    if (parsed.tomb !== tomb) throw new Error("Wrong credential context");
    return parsed;
  } catch {
    throw new Error("Retired credential records are unavailable.");
  }
}
