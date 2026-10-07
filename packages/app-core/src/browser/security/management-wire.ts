import { z } from "zod";
export const managementOperation = z.discriminatedUnion("verb", [
  z
    .object({
      verb: z.enum([
        "canary-status",
        "canary-issued-status",
        "canary-clear",
        "receiver-status",
        "receiver-test",
        "receiver-remove",
        "legacy-status",
      ]),
    })
    .strict(),
  z
    .object({
      verb: z.literal("legacy-discard-corrupt"),
      acknowledgeIrrecoverableLegacyDiscard: z.literal(true),
    })
    .strict(),
  z
    .object({
      verb: z.literal("legacy-resolve"),
      connectionIds: z
        .array(z.string().min(1).max(256))
        .min(1)
        .max(16)
        .refine((ids) => new Set(ids).size === ids.length),
      decision: z.enum(["import", "discard"]),
      acknowledgeOwnershipAmbiguity: z.literal(true),
    })
    .strict(),
  z
    .object({
      verb: z.literal("canary-create"),
      kind: z.enum([
        "connection_ref",
        "mcp_configuration",
        "token_generation",
        "agent_lease",
      ]),
    })
    .strict(),
  z
    .object({
      verb: z.literal("canary-retire"),
      issuerRecordRef: z.string().min(1).max(128),
    })
    .strict(),
  z
    .object({
      verb: z.literal("canary-remove"),
      artifactId: z.string().min(1).max(128),
    })
    .strict(),
  z
    .object({
      verb: z.literal("receiver-configure"),
      pairingJson: z.string().max(8192),
    })
    .strict(),
  z
    .object({ verb: z.literal("receiver-enabled"), enabled: z.boolean() })
    .strict(),
]);
export type ManagementOperation = z.infer<typeof managementOperation>;
export const managementRequest = z
  .object({
    id: z.number().int().nonnegative(),
    op: z.literal("manage"),
    permit: z.string().max(64),
    password: z.string().min(1).max(1024),
    operation: managementOperation,
  })
  .strict();
