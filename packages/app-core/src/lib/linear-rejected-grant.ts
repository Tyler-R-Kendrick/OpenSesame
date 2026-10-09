/** Rejected consent grants remain sealed until provider compensation completes. */
import type { LinearGrant } from "./linear-api.js";
import {
  cleanupGrantId,
  forgetCleanedGrants,
  retainCleanupGrant,
  withLinearCleanup,
} from "./linear-cleanup-queue.js";
import {
  revokeLinearGrant,
  revokeLinearGrantWithoutRotation,
} from "./linear-grant-cleanup.js";
import type { LinearActor } from "./linear-store.js";

export async function cleanupRejectedLinearGrant(
  id: string,
  actor: LinearActor,
  grant: LinearGrant,
  clientId: string,
): Promise<void> {
  await withLinearCleanup(id, actor, async () => {
    const original = { kind: "oauth" as const, ...grant };
    try {
      await retainCleanupGrant(id, actor, original);
    } catch {
      await revokeLinearGrantWithoutRotation(grant);
      return;
    }
    const cleaned = new Set([cleanupGrantId(original)]);
    await revokeLinearGrant(grant, clientId, async (rotated) => {
      const next = { kind: "oauth" as const, ...rotated };
      await retainCleanupGrant(id, actor, next);
      cleaned.add(cleanupGrantId(next));
    });
    await forgetCleanedGrants(id, actor, cleaned);
  });
}
