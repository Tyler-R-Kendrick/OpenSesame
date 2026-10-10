/**
 * The documents the desk keeps in the pending store. Each is read back through
 * a strict schema: a stored value is as untrusted as a pasted one, because a
 * restored backup or another tab can put anything there.
 */

import { z } from "zod";
import { fromB64url } from "../bytes.js";
import type { Json } from "../canonical.js";
import { RecoveryBundleSchema } from "../circle.js";
import { InviteSchema } from "../enroll.js";
import type { LedgerSnapshot } from "../ledger-types.js";
import {
  ApprovalSchema,
  CancellationSchema,
  GuardianSchema,
  QuorumRequestSchema,
  ReleaseSchema,
} from "../types.js";
import { DeskError, type PendingStore } from "./ports.js";

const B64URL = z.string().regex(/^[A-Za-z0-9_-]*$/);

export const OwnerDraftSchema = z
  .object({
    v: z.literal(1),
    circleId: z.string(),
    label: z.string(),
    collection: z.string(),
    /** `true` when the circle will hold shares of a recovery key. */
    recovers: z.boolean(),
    invite: InviteSchema,
    /** Present only until the circle exists; then the key lives in the record. */
    ownerSecretKey: B64URL.nullable(),
    /** Guardians whose enrollment verified and who are not in a policy yet. */
    guardians: z.array(GuardianSchema),
  })
  .strict();
export type OwnerDraft = z.infer<typeof OwnerDraftSchema>;

export const ReceiptsSchema = z
  .object({ epoch: z.number().int(), guardianIds: z.array(z.string()) })
  .strict();

export const LedgerSnapshotSchema = z
  .object({
    approvals: z.array(ApprovalSchema),
    releases: z.array(ReleaseSchema),
    counters: z.record(z.string(), z.number().int()),
    spent: z.array(z.string()),
    cancellation: CancellationSchema.nullable(),
    executed: z.boolean(),
  })
  .strict();

export const AskSchema = z
  .object({
    v: z.literal(1),
    circleId: z.string(),
    request: QuorumRequestSchema,
    snapshot: LedgerSnapshotSchema,
  })
  .strict();
export type Ask = z.infer<typeof AskSchema>;

export const GuardianPendingSchema = z
  .object({
    v: z.literal(1),
    invite: InviteSchema,
    guardianId: z.string(),
    name: z.string(),
    hpkeSecretKey: B64URL,
  })
  .strict();
export type GuardianPending = z.infer<typeof GuardianPendingSchema>;

export const CancelledSchema = z.array(z.string());

export const RecoverySchema = z
  .object({
    v: z.literal(1),
    bundle: RecoveryBundleSchema,
    request: QuorumRequestSchema,
    recipientSecretKey: B64URL,
    snapshot: LedgerSnapshotSchema,
  })
  .strict();
export type Recovery = z.infer<typeof RecoverySchema>;

export const KEYS = {
  draft: (circleId: string) => `owner-draft:${circleId}`,
  receipts: (circleId: string) => `receipts:${circleId}`,
  ask: (digest: string) => `ask:${digest}`,
  guardian: (inviteId: string) => `guardian-pending:${inviteId}`,
  cancelled: (circleId: string) => `cancelled:${circleId}`,
  recovery: (requestId: string) => `recovery:${requestId}`,
} as const;

/** Read one document through its schema; `null` when it is not there. */
export async function load<S extends z.ZodType>(
  store: PendingStore,
  key: string,
  schema: S,
): Promise<z.infer<S> | null> {
  const found = await store.read(key);
  if (found === undefined) return null;
  const parsed = schema.safeParse(found);
  if (!parsed.success) {
    throw new DeskError(
      "stored",
      `a saved ceremony could not be read (${key})`,
    );
  }
  return parsed.data;
}

export async function save<S extends z.ZodType>(
  store: PendingStore,
  key: string,
  schema: S,
  value: z.infer<S>,
): Promise<void> {
  // `JSON.parse(JSON.stringify())` yields the plain JSON the store takes.
  const plain: Json = JSON.parse(JSON.stringify(schema.parse(value)));
  await store.write(key, plain);
}

export const keyBytes = (b64: string): Uint8Array => fromB64url(b64);

/** A ledger's snapshot as the plain, mutable copy the store takes. */
export function plainSnapshot(snapshot: LedgerSnapshot) {
  return {
    approvals: [...snapshot.approvals],
    releases: [...snapshot.releases],
    counters: { ...snapshot.counters },
    spent: [...snapshot.spent],
    cancellation: snapshot.cancellation,
    executed: snapshot.executed,
  };
}
