/** Controlled receiver DATA only. Registration requires a paired signature from the actual fresh private management actor. */
import { z } from "zod";
export const CONTROLLED_CANARY_REQUEST_BYTES = 16 << 10;
export const ControlledCanaryHex = z.string().regex(/^[0-9a-f]{64}$/);
export const CONTROLLED_CANARY_MAX_DATE_MS = 8_640_000_000_000_000;
const timestamp = z
  .number()
  .int()
  .nonnegative()
  .max(CONTROLLED_CANARY_MAX_DATE_MS);
const context = { contextId: ControlledCanaryHex };
export const ControlledCanaryCommandSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("inspect"), ...context }).strict(),
  z
    .object({
      kind: z.literal("enroll"),
      ...context,
      label: z.string().min(1).max(80),
      artifactKind: z.enum(["mcp-config", "connection-reference"]),
      retentionDays: z.number().int().min(1).max(90),
    })
    .strict(),
  z
    .object({ kind: z.literal("remove"), ...context, id: ControlledCanaryHex })
    .strict(),
  z
    .object({ kind: z.literal("export"), ...context, id: ControlledCanaryHex })
    .strict(),
]);
export type ControlledCanaryCommand = z.infer<
  typeof ControlledCanaryCommandSchema
>;
export const ControlledCanaryRecordSchema = z
  .object({
    id: ControlledCanaryHex,
    connectionRef: ControlledCanaryHex,
    generation: ControlledCanaryHex,
    contextId: ControlledCanaryHex,
    label: z.string().min(1).max(80),
    artifactKind: z.enum(["mcp-config", "connection-reference"]),
    createdAt: timestamp,
    expiresAt: timestamp,
  })
  .strict();
export type ControlledCanaryRecord = z.infer<
  typeof ControlledCanaryRecordSchema
>;
export const ControlledCanaryEventSchema = z
  .object({
    id: ControlledCanaryHex,
    event: z.enum(["canary_connected", "canary_tool_invoked"]),
    sequence: z.number().int().positive().safe(),
    occurredAt: timestamp,
  })
  .strict();
export type ControlledCanaryEvent = z.infer<typeof ControlledCanaryEventSchema>;
export const ControlledCanaryResultSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("enrolled"),
      record: ControlledCanaryRecordSchema,
      token: ControlledCanaryHex,
    })
    .strict(),
  z
    .object({
      kind: z.literal("inspection"),
      records: z.array(ControlledCanaryRecordSchema).max(128),
      events: z.array(ControlledCanaryEventSchema).max(1024),
    })
    .strict(),
  z.object({ kind: z.literal("removed"), id: ControlledCanaryHex }).strict(),
  z
    .object({ kind: z.literal("export"), record: ControlledCanaryRecordSchema })
    .strict(),
]);
export type ControlledCanaryResult = z.infer<
  typeof ControlledCanaryResultSchema
>;
export const ControlledCanaryChallengeSchema = z
  .object({
    nonce: ControlledCanaryHex,
    serviceId: ControlledCanaryHex,
    audience: z.string().min(1).max(512),
    commandHash: ControlledCanaryHex,
    expiresAt: timestamp,
  })
  .strict();
export type ControlledCanaryChallenge = z.infer<
  typeof ControlledCanaryChallengeSchema
>;
/** Fixed field order avoids relying on attacker-chosen JSON order in the paired action hash. */
export function encodeControlledCanaryCommand(
  command: ControlledCanaryCommand,
): string {
  const held = ControlledCanaryCommandSchema.parse(command);
  switch (held.kind) {
    case "enroll":
      return JSON.stringify([
        held.kind,
        held.contextId,
        held.label,
        held.artifactKind,
        held.retentionDays,
      ]);
    case "remove":
    case "export":
      return JSON.stringify([held.kind, held.contextId, held.id]);
    case "inspect":
      return JSON.stringify([held.kind, held.contextId]);
  }
}
