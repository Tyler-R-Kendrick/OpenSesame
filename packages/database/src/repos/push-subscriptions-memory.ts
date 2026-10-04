import {
  ConflictError,
  type PushSubscription,
  type PushSubscriptionRepository,
  type UnitOfWork,
} from "./interfaces.js";

/** Flat row — a copy is a full clone. */
function clonePushSubscription(sub: PushSubscription): PushSubscription {
  return { ...sub };
}

/** In-memory rows behind the `PushSubscriptionRepository` interface. */
export function createMemoryPushSubscriptions(
  rows: Map<string, PushSubscription>,
  applyNowOrDefer: (uow: UnitOfWork | undefined, apply: () => void) => void,
): PushSubscriptionRepository {
  return {
    create: async (sub, uow) => {
      // The same endpoint is the same browser. Postgres holds
      // `endpoint_digest` unique and upserts onto it; here the existing row is
      // found and rewritten in place, keeping its id and `createdAt` and
      // reviving it if it had been disabled — a second row would push the same
      // person twice and leave the operator unable to say which is live.
      let existingId: string | undefined;
      let existingCreatedAt: Date | undefined;
      for (const row of rows.values()) {
        if (row.endpointDigest === sub.endpointDigest) {
          // A live row belongs to its owner, and a registration from anyone
          // else must not move it (the endpoint is a capability URL). A row
          // its owner already retired is up for the taking.
          if (row.principalId !== sub.principalId && !row.disabledAt) {
            throw new ConflictError(
              "push endpoint is registered to another principal",
            );
          }
          existingId = row.id;
          existingCreatedAt = row.createdAt;
          break;
        }
      }
      const row: PushSubscription = {
        ...sub,
        ...(existingId ? { id: existingId } : undefined),
        ...(existingCreatedAt ? { createdAt: existingCreatedAt } : undefined),
      };
      if (!sub.disabledAt) Reflect.deleteProperty(row, "disabledAt");
      applyNowOrDefer(uow, () => {
        rows.set(row.id, clonePushSubscription(row));
      });
      return clonePushSubscription(row);
    },

    listForPrincipal: async (principalId) => {
      return [...rows.values()]
        .filter(
          (row) =>
            row.principalId === principalId && row.disabledAt === undefined,
        )
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        .map(clonePushSubscription);
    },

    getById: async (id) => {
      const row = rows.get(id);
      return row ? clonePushSubscription(row) : null;
    },

    findByEndpointDigest: async (digest) => {
      for (const row of rows.values()) {
        if (row.endpointDigest === digest) return clonePushSubscription(row);
      }
      return null;
    },

    disable: async (id, at, principalId) => {
      const current = rows.get(id);
      // Compare-and-set on "not already disabled" (and, given a principal, on
      // the owner), so only the caller that actually retired the subscription
      // is told it did.
      if (!current || current.disabledAt) return false;
      if (principalId !== undefined && current.principalId !== principalId) {
        return false;
      }
      rows.set(id, { ...current, disabledAt: at });
      return true;
    },
  };
}
