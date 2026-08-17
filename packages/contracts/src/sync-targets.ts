import { z } from "zod";

/**
 * Sync target wire contract (ADR 0041 / WP-C).
 * Snake_case Host wire names. `.strict()` rejects credential material.
 */

export const SyncTargetStatusSchema = z.enum([
  "idle",
  "syncing",
  "ready",
  "error",
]);
export type SyncTargetStatus = z.infer<typeof SyncTargetStatusSchema>;

export const SyncTargetSchema = z
  .object({
    id: z.string().min(1),
    project_id: z.string().min(1),
    config_id: z.string().min(1),
    connection_id: z.string().min(1),
    provider_id: z.string().min(1),
    operation: z.string().min(1),
    status: SyncTargetStatusSchema,
    status_detail: z.string().nullable(),
    content_version: z.string().nullable().optional(),
    last_synced_at: z.string().datetime({ offset: true }).nullable().optional(),
    organization_id: z.string().min(1),
    created_at: z.string().datetime({ offset: true }),
    updated_at: z.string().datetime({ offset: true }),
  })
  .strict();
export type SyncTarget = z.infer<typeof SyncTargetSchema>;

export const CreateSyncTargetRequestSchema = z
  .object({
    project_id: z.string().min(1),
    config_id: z.string().min(1),
    connection_id: z.string().min(1),
    operation: z.string().min(1).optional(),
  })
  .strict();
export type CreateSyncTargetRequest = z.infer<
  typeof CreateSyncTargetRequestSchema
>;

export const SyncTargetOutcomeSchema = z
  .object({
    target: SyncTargetSchema,
    ok: z.boolean(),
    keys_synced: z.number().int().nonnegative(),
    content_version: z.string().nullable().optional(),
    error: z.string().nullable().optional(),
  })
  .strict();
export type SyncTargetOutcome = z.infer<typeof SyncTargetOutcomeSchema>;

export const ListSyncTargetsResponseSchema = z
  .object({
    sync_targets: z.array(SyncTargetSchema),
  })
  .strict();
export type ListSyncTargetsResponse = z.infer<
  typeof ListSyncTargetsResponseSchema
>;

export const SyncAllResponseSchema = z
  .object({
    outcomes: z.array(SyncTargetOutcomeSchema),
  })
  .strict();
export type SyncAllResponse = z.infer<typeof SyncAllResponseSchema>;

export const SyncTargetRequestSchema = z
  .object({
    /** Key names only — values are never accepted on the wire. */
    key_names: z.array(z.string().min(1).max(256)).max(256).optional(),
  })
  .strict();
export type SyncTargetRequest = z.infer<typeof SyncTargetRequestSchema>;
