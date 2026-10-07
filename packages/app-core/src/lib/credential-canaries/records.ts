import { b64ToBytes, bytesToB64 } from "@opensesame/vault-core";
/** Strict bounded detection-only storage; never stores a presented identifier. */
import { z } from "zod";
import { artifactKindSchema, contextSchema } from "./protocol.js";
export const MAX_CONTROLLED_CANARIES = 16;
export const MAX_CANARY_EVENTS = 64;
export const phaseSchema = z.enum([
  "connected",
  "invoked",
  "retired_generation_observed",
  "artifact_dispatched",
]);
export const artifactRecordSchema = z
  .object({
    id: z.string().uuid(),
    context: contextSchema,
    digestB64: z.string().regex(/^[A-Za-z0-9+/]{43}=$/),
    state: z.enum(["bait", "retired"]),
    createdAt: z.string().datetime(),
    retiredAt: z.string().datetime().optional(),
  })
  .strict();
export const eventSchema = z
  .object({
    v: z.literal(1),
    eventId: z.string().uuid(),
    vaultIdentity: z.string().min(1).max(256),
    artifactId: z.string().uuid(),
    kind: artifactKindSchema,
    generation: z.number().int().min(1).max(4294967295),
    phase: phaseSchema,
    at: z.string().datetime(),
  })
  .strict();
const registrySchema = z
  .object({
    v: z.literal(1),
    tomb: z.string().min(1).max(256),
    vaultIdentity: z.string().min(1).max(256),
    artifacts: z.array(artifactRecordSchema).max(MAX_CONTROLLED_CANARIES),
    events: z.array(eventSchema).max(MAX_CANARY_EVENTS),
  })
  .strict();
export type ArtifactRecord = z.infer<typeof artifactRecordSchema>;
export type CanaryEvent = z.infer<typeof eventSchema>;
export type CanaryPhase = z.infer<typeof phaseSchema>;
export type CanaryRegistry = z.infer<typeof registrySchema>;
function validArtifact(record: ArtifactRecord, identity: string): boolean {
  return (
    record.context.vaultIdentity === identity &&
    (record.state === "retired") === Boolean(record.retiredAt) &&
    bytesToB64(b64ToBytes(record.digestB64)) === record.digestB64
  );
}
function unique(values: string[]): boolean {
  return new Set(values).size === values.length;
}
export function parseCanaryRegistry(
  raw: string,
  tomb: string,
  identity: string,
): CanaryRegistry {
  if (new TextEncoder().encode(raw).length > 32768)
    throw new Error("Controlled canary registry unavailable.");
  const records = registrySchema.parse(JSON.parse(raw));
  if (
    records.tomb !== tomb ||
    records.vaultIdentity !== identity ||
    !unique(records.artifacts.map((a) => a.id)) ||
    !unique(records.artifacts.map((a) => a.digestB64)) ||
    !unique(records.events.map((e) => e.eventId)) ||
    records.events.some((e) => e.vaultIdentity !== identity) ||
    records.artifacts.some((a) => !validArtifact(a, identity))
  )
    throw new Error("Controlled canary registry context mismatch.");
  return records;
}
