/** Detection-only metadata and independently paired fixed-route wire contract. */
import { b64ToBytes, bytesToB64 } from "@opensesame/vault-core/bytes.js";
import { z } from "zod";
import { artifactKindSchema } from "../credential-canaries/protocol.js";
import {
  eventSchema as canaryEventSchema,
  phaseSchema,
} from "../credential-canaries/records.js";

export const OBSERVATION_PURPOSE = "opensesame/credential-observation/v1";
export const ACK_PURPOSE = "opensesame/credential-observation/ack/v1";
export const OBSERVATION_ROUTE = "/v1/credential-observations";
export const MAX_PACKAGE_BYTES = 8192;
export const PACKAGE_TTL_MS = 86400000;
export const CLOCK_SKEW_MS = 300000;
export const isoSchema = z
  .string()
  .datetime()
  .refine((s) => {
    const date = new Date(s);
    return Number.isFinite(date.getTime()) && date.toISOString() === s;
  });
const id = z.string().min(1).max(128);
const epoch = z.number().int().min(0).max(4294967295);
export function canonicalBase64(raw: string, length: number): Uint8Array {
  const bytes = b64ToBytes(raw);
  if (bytes.length !== length || bytesToB64(bytes) !== raw) {
    bytes.fill(0);
    throw new Error("Invalid observation key or wire encoding.");
  }
  return bytes;
}
function fixedOrigin(origin: string, allowLoopback: boolean): boolean {
  try {
    const url = new URL(origin);
    if (
      url.origin !== origin ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      return false;
    return (
      url.protocol === "https:" ||
      (allowLoopback &&
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
    );
  } catch {
    return false;
  }
}
export const provisionSchema = z
  .object({
    v: z.literal(1),
    receiverId: id,
    bindingId: id,
    origin: z.string().max(2048),
    independentKeyMaterialB64: z.string().length(88),
    keyEpoch: epoch,
    expiresAt: isoSchema,
    allowLoopback: z.boolean(),
  })
  .strict()
  .superRefine((value, context) => {
    if (!fixedOrigin(value.origin, value.allowLoopback))
      context.addIssue({
        code: "custom",
        message:
          "Choose a fixed HTTPS origin or explicitly approved strict loopback origin.",
      });
    try {
      canonicalBase64(value.independentKeyMaterialB64, 64).fill(0);
    } catch {
      context.addIssue({
        code: "custom",
        message: "Independent observation material requires exactly 64 bytes.",
      });
    }
  });
export type ObservationReceiverProvision = z.infer<typeof provisionSchema>;
export function parseObservationReceiverProvision(
  raw: string,
): ObservationReceiverProvision {
  if (new TextEncoder().encode(raw).length > MAX_PACKAGE_BYTES)
    throw new Error("Observation receiver provision is too large.");
  try {
    return provisionSchema.parse(JSON.parse(raw));
  } catch {
    throw new Error("Invalid observation receiver provision.");
  }
}
const observed = z
  .object({
    type: z.literal("retired_credential_observed"),
    trapId: id,
    response: z.enum(["reject", "synthetic_decoy"]),
  })
  .strict();
const interaction = z
  .object({
    type: z.literal("synthetic_decoy_interaction"),
    trapId: id,
    response: z.literal("synthetic_decoy"),
    action: z.enum(["vault_write", "authority_denied"]),
  })
  .strict();
export const closedEventSchema = z.discriminatedUnion("type", [
  observed,
  interaction,
  z
    .object({
      type: z.literal("controlled_canary_observed"),
      artifactId: id,
      kind: artifactKindSchema,
      generation: z.number().int().min(1).max(4294967295),
      phase: phaseSchema,
    })
    .strict(),
  z.object({ type: z.literal("receiver_test") }).strict(),
]);
export const metadataSchema = z
  .object({
    v: z.literal(1),
    eventId: z.string().uuid(),
    vaultIdentity: z.string().min(1).max(256),
    event: closedEventSchema,
    at: isoSchema,
  })
  .strict();
export type ObservationMetadata = z.infer<typeof metadataSchema>;
export const passwordEventSchema = z.discriminatedUnion("type", [
  observed
    .extend({
      v: z.literal(1),
      eventId: z.string().uuid(),
      vaultIdentity: z.string().min(1).max(256),
      at: isoSchema,
    })
    .strict(),
  interaction
    .extend({
      v: z.literal(1),
      eventId: z.string().uuid(),
      vaultIdentity: z.string().min(1).max(256),
      at: isoSchema,
    })
    .strict(),
]);
export type ObservedPasswordEvent = z.infer<typeof passwordEventSchema>;
export function normalizeObservation(
  input: z.input<typeof canaryEventSchema> | ObservedPasswordEvent,
): ObservationMetadata {
  const password = passwordEventSchema.safeParse(input);
  if (password.success) {
    const { v, eventId, vaultIdentity, at, ...event } = password.data;
    return { v, eventId, vaultIdentity, event, at };
  }
  const e = canaryEventSchema.parse(input);
  return {
    v: 1,
    eventId: e.eventId,
    vaultIdentity: e.vaultIdentity,
    event: {
      type: "controlled_canary_observed",
      artifactId: e.artifactId,
      kind: e.kind,
      generation: e.generation,
      phase: e.phase,
    },
    at: e.at,
  };
}
export const packageSchema = z
  .object({
    v: z.literal(1),
    packageId: z.string().uuid(),
    receiverId: id,
    bindingId: id,
    keyEpoch: epoch,
    issuedAt: isoSchema,
    expiresAt: isoSchema,
    nonceB64: z.string().length(24),
    ciphertextB64: z.string().max(6000),
    macB64: z.string().length(44),
  })
  .strict();
export type SealedObservationPackage = z.infer<typeof packageSchema>;
export const ackSchema = z
  .object({
    v: z.literal(1),
    packageId: z.string().uuid(),
    bindingId: id,
    keyEpoch: epoch,
    acceptedAt: isoSchema,
    macB64: z.string().length(44),
  })
  .strict();
export type ObservationAcknowledgement = z.infer<typeof ackSchema>;
export function packageBody(
  p: SealedObservationPackage | Omit<SealedObservationPackage, "macB64">,
): string {
  return JSON.stringify({
    v: p.v,
    packageId: p.packageId,
    receiverId: p.receiverId,
    bindingId: p.bindingId,
    keyEpoch: p.keyEpoch,
    issuedAt: p.issuedAt,
    expiresAt: p.expiresAt,
    nonceB64: p.nonceB64,
    ciphertextB64: p.ciphertextB64,
  });
}
export function ackBody(
  p: ObservationAcknowledgement | Omit<ObservationAcknowledgement, "macB64">,
): string {
  return JSON.stringify({
    v: p.v,
    packageId: p.packageId,
    bindingId: p.bindingId,
    keyEpoch: p.keyEpoch,
    acceptedAt: p.acceptedAt,
  });
}
