import type { ClaimItem, ClaimSession, Clock, JsonObject } from "@opensesame/os-domain";

/**
 * Persistence seam for claim sessions. Implementations must provide
 * atomic compare-and-swap on `version` (DB row lock / UPDATE ... WHERE version = ?).
 */
export interface ClaimStore {
  get(id: string): Promise<ClaimSession | undefined>;
  getItems(claimId: string): Promise<ClaimItem[]>;
  putItems(claimId: string, items: ClaimItem[]): Promise<void>;
  /**
   * Insert a new claim. Fails if id already exists.
   */
  create(session: ClaimSession, items: ClaimItem[]): Promise<ClaimSession>;
  /**
   * CAS: persist `next` only when current version === expectedVersion.
   * Returns the stored session (winner) and whether this caller won.
   */
  compareAndSwap(
    id: string,
    expectedVersion: number,
    next: ClaimSession,
  ): Promise<{ session: ClaimSession; won: boolean }>;
}

export interface ClaimEngineOptions {
  pepper: string | Uint8Array;
  store: ClaimStore;
  clock?: Clock;
}

export type CompleteDecision = {
  acceptedItemIds: string[];
  destination?: JsonObject;
  idempotencyKey?: string;
};
