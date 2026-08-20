import { z } from "zod";
import { type JsonObject, overlapCast, type BoundaryValue, isTypeofObject } from "@opensesame/os-domain";

/**
 * Host sync-blob wire contract — opaque ciphertext only.
 *
 * Host never decrypts. Clients must not send plaintext fields, vault keys, or
 * deployment-seal material. Backup wrap keys stay on the device (VRK /
 * DeviceKey), never `OPENSESAME_CONNECTION_KEY`.
 */

const FORBIDDEN_KEYS = new Set([
  "plaintext",
  "secret",
  "password",
  "token",
  "vrk",
  "vault_key",
  "master_password",
  "connection_key",
  "deployment_seal",
]);

function rejectForbiddenKeys(
  value: BoundaryValue,
  ctx: z.RefinementCtx,
  path: (string | number)[] = [],
): void {
  if (value === null || !isTypeofObject(value)) return;
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      rejectForbiddenKeys(item, ctx, [...path, index]),
    );
    return;
  }
  for (const [key, child] of Object.entries(overlapCast(value))) {
    const lower = key.toLowerCase();
    if (
      FORBIDDEN_KEYS.has(lower) ||
      [...FORBIDDEN_KEYS].some((forbidden) => lower.includes(forbidden))
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `forbidden field: ${key}`,
        path: [...path, key],
      });
    }
    rejectForbiddenKeys(child, ctx, [...path, key]);
  }
}

export const OpaqueSyncBlobSchema = z
  .object({
    id: z.string().min(1).max(256),
    epoch: z.number().int().nonnegative(),
    /** Opaque sealed bytes — never plaintext. */
    ciphertext: z.array(z.number().int().min(0).max(255)).min(1),
  })
  .strict();
export type OpaqueSyncBlob = z.infer<typeof OpaqueSyncBlobSchema>;

export const SyncBlobsPushRequestSchema = z
  .object({
    blobs: z.array(OpaqueSyncBlobSchema).max(512),
  })
  .strict()
  .superRefine((value, ctx) => rejectForbiddenKeys(value, ctx));
export type SyncBlobsPushRequest = z.infer<typeof SyncBlobsPushRequestSchema>;

export const SyncBlobsSnapshotRequestSchema = z
  .object({
    since_epoch: z.number().int().nonnegative().optional().default(0),
    project_id: z.string().min(1).max(256).nullable().optional(),
  })
  .strict();
export type SyncBlobsSnapshotRequest = z.infer<
  typeof SyncBlobsSnapshotRequestSchema
>;

export const SyncBlobsSnapshotResponseSchema = z
  .object({
    format: z.literal("opensesame-sync-blobs-snapshot"),
    version: z.literal(1),
    project_id: z.string().nullable().optional(),
    blobs: z.array(OpaqueSyncBlobSchema),
    plaintext: z.null(),
    note: z.string(),
    wrap_key: z.null(),
    deployment_seal_used: z.literal(false),
  })
  .strict();
export type SyncBlobsSnapshotResponse = z.infer<
  typeof SyncBlobsSnapshotResponseSchema
>;

/** True when a JSON document looks like a ciphertext-only sync blob list. */
export function isCiphertextOnlySyncPayload(value: BoundaryValue): boolean {
  const parsed = SyncBlobsPushRequestSchema.safeParse(value);
  return parsed.success;
}
