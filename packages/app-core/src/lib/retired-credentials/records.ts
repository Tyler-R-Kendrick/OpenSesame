/** Bounded pre-unlock record parser. Storage content establishes no authority. */
import { z } from "zod";
import { assertUnambiguousJson } from "./json-preflight.js";
export const MAX_RETIRED_CREDENTIAL_TRAPS = 3;
export const MAX_RETIRED_CREDENTIAL_EVENTS = 32;
export const MAX_RETIRED_CREDENTIAL_RECORD_BYTES = 32768;
export const responseSchema = z.enum(["reject", "synthetic_decoy"]);
const boundedText = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((text) => new TextEncoder().encode(text).length <= max);
const timestamp = z.string().max(64).datetime();
const trapSchema = z
  .object({
    id: boundedText(128),
    createdAt: timestamp,
    response: responseSchema,
  })
  .strict();
const observedEventSchema = z
  .object({
    type: z.literal("retired_credential_observed"),
    trapId: boundedText(128),
    at: timestamp,
    response: responseSchema,
  })
  .strict();
export const retiredDecoyActionSchema = z.enum([
  "vault_write",
  "authority_denied",
]);
const interactionEventSchema = z
  .object({
    type: z.literal("synthetic_decoy_interaction"),
    trapId: boundedText(128),
    at: timestamp,
    response: z.literal("synthetic_decoy"),
    action: retiredDecoyActionSchema,
  })
  .strict();
const eventSchema = z.discriminatedUnion("type", [
  observedEventSchema,
  interactionEventSchema,
]);
export type RetiredDecoyAction = z.infer<typeof retiredDecoyActionSchema>;
const recordSchema = z
  .object({
    v: z.literal(1),
    tomb: boundedText(256),
    traps: z
      .array(
        trapSchema.extend({
          salt: z.string().regex(/^[A-Za-z0-9+/]{21}[AQgw]==$/),
          verifier: z.string().regex(/^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$/),
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
  try {
    assertUnambiguousJson(raw, MAX_RETIRED_CREDENTIAL_RECORD_BYTES);
    const parsed = recordSchema.parse(JSON.parse(raw));
    if (parsed.tomb !== tomb) throw new Error("Wrong credential context");
    return parsed;
  } catch {
    throw new Error("Retired credential records are unavailable.");
  }
}
