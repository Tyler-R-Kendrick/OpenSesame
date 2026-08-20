import {
  type ClaimItem,
  type ClaimSession,
  type ClaimTargetType,
  type Clock,
  DomainError,
  assertDependencyClosure,
  canonicalize,
  digestManifest,
  digestUserCode,
  generateClaimToken,
  generateUserCode,
  maybeExpireClaim,
  authenticateClaim as transitionAuthenticate,
  completeClaim as transitionComplete,
  denyClaim as transitionDeny,
  expireClaim as transitionExpire,
  presentClaim as transitionPresent,
  reviewClaim as transitionReview,
  revokeClaim as transitionRevoke,
  verifyClaimToken,
} from "@opensesame/os-domain";
import type {
  ClaimEngineOptions,
  ClaimStore,
  CompleteDecision,
} from "./store.js";

export interface CreateClaimInput {
  type: ClaimTargetType;
  targetManifest: Record<string, unknown>;
  items?: ClaimItem[];
  creatorPrincipalId?: string;
  creatorAgentId?: string;
  creatorInstanceId?: string;
  proofKeyJkt?: string;
  ttlMs?: number;
  publicId?: string;
  requestedDestination?: Record<string, unknown>;
  requestedGrant?: Record<string, unknown>;
}

export interface CreateClaimResult {
  session: ClaimSession;
  token: string;
  userCode: string;
}

export class ClaimEngine {
  private readonly store: ClaimStore;
  private readonly pepper: string | Uint8Array;
  private readonly clock: Clock;

  constructor(options: ClaimEngineOptions) {
    this.store = options.store;
    this.pepper = options.pepper;
    this.clock = options.clock ?? (() => new Date());
  }

  async createClaim(input: CreateClaimInput): Promise<CreateClaimResult> {
    const now = this.clock();
    const ttlMs = input.ttlMs ?? 600_000;
    const generated = generateClaimToken(this.pepper, input.publicId);
    const userCode = generateUserCode();
    const digest = digestManifest(input.targetManifest);

    const session: ClaimSession = {
      id: generated.publicId,
      type: input.type,
      state: "pending",
      tokenDigest: generated.digest,
      userCodeDigest: digestUserCode(this.pepper, generated.publicId, userCode),
      targetManifest: structuredClone(input.targetManifest),
      targetManifestDigest: digest,
      createdAt: now,
      expiresAt: new Date(now.getTime() + ttlMs),
      version: 1,
    };
    if (input.creatorPrincipalId !== undefined) {
      session.creatorPrincipalId = input.creatorPrincipalId;
    }
    if (input.creatorAgentId !== undefined) {
      session.creatorAgentId = input.creatorAgentId;
    }
    if (input.creatorInstanceId !== undefined) {
      session.creatorInstanceId = input.creatorInstanceId;
    }
    if (input.proofKeyJkt !== undefined) {
      session.proofKeyJkt = input.proofKeyJkt;
    }
    if (input.requestedDestination !== undefined) {
      session.requestedDestination = input.requestedDestination;
    }
    if (input.requestedGrant !== undefined) {
      session.requestedGrant = input.requestedGrant;
    }

    const items = (input.items ?? []).map((item) => ({
      ...item,
      claimId: session.id,
    }));

    const created = await this.store.create(session, items);
    return { session: created, token: generated.token, userCode };
  }

  private async loadFresh(id: string): Promise<ClaimSession> {
    const existing = await this.store.get(id);
    if (!existing) {
      throw new DomainError("NOT_FOUND", "Claim not found", { id });
    }
    const maybe = maybeExpireClaim(existing, this.clock);
    if (maybe.state === "expired" && existing.state !== "expired") {
      // Whether or not this writer won, the store's version is authoritative.
      const { session } = await this.store.compareAndSwap(
        id,
        existing.version,
        maybe,
      );
      return session;
    }
    return maybe;
  }

  private async applyTransition(
    id: string,
    transform: (s: ClaimSession) => ClaimSession,
  ): Promise<ClaimSession> {
    for (let attempt = 0; attempt < 8; attempt++) {
      const current = await this.loadFresh(id);
      if (current.state === "expired") {
        throw new DomainError("EXPIRED", "Claim expired", { id });
      }
      const next = transform(current);
      const { session, won } = await this.store.compareAndSwap(
        id,
        current.version,
        next,
      );
      if (won) {
        return session;
      }
      // CAS lost — retry if still transitionable
    }
    throw new DomainError("CONFLICT", "Claim CAS retries exhausted", { id });
  }

  async presentClaim(id: string, token: string): Promise<ClaimSession> {
    const current = await this.loadFresh(id);
    if (!verifyClaimToken(this.pepper, token, current.tokenDigest)) {
      throw new DomainError("INVALID_TOKEN", "Invalid claim token", { id });
    }
    return this.applyTransition(id, (s) => transitionPresent(s, this.clock()));
  }

  async authenticateClaim(id: string): Promise<ClaimSession> {
    return this.applyTransition(id, (s) =>
      transitionAuthenticate(s, this.clock()),
    );
  }

  async reviewClaim(
    id: string,
    decision: Record<string, unknown>,
  ): Promise<ClaimSession> {
    return this.applyTransition(id, (s) =>
      transitionReview(s, decision, this.clock()),
    );
  }

  /** Bound on `completeClaim` retries, matching `applyTransition`. */
  private static readonly MAX_COMPLETE_ATTEMPTS = 8;

  async completeClaim(
    id: string,
    completedByPrincipalId: string,
    decision: CompleteDecision,
    attempt = 0,
  ): Promise<{ session: ClaimSession; won: boolean }> {
    // Losing the review CAS re-enters this method. Without a bound, concurrent
    // completers could recurse until the stack gave out.
    if (attempt >= ClaimEngine.MAX_COMPLETE_ATTEMPTS) {
      throw new DomainError("CONFLICT", "Claim CAS retries exhausted", { id });
    }
    const current = await this.loadFresh(id);
    if (current.state === "expired") {
      throw new DomainError("EXPIRED", "Claim expired", { id });
    }

    // Idempotent replay: same completer + matching decision on completed claim
    if (current.state === "completed") {
      if (
        current.completedByPrincipalId === completedByPrincipalId &&
        decisionsMatch(current.reviewDecision, decision)
      ) {
        // The decision on record is this one, so finish the item rows in case a
        // previous attempt stopped between the swap and writing them.
        await this.settleItems(id, new Set(decision.acceptedItemIds));
        return { session: current, won: true };
      }
      throw new DomainError("CONFLICT", "Claim already completed differently", {
        id,
      });
    }

    const items = await this.store.getItems(id);
    const accepted = new Set(decision.acceptedItemIds);
    assertDependencyClosure(items, accepted);

    const reviewed =
      current.state === "reviewed"
        ? current
        : current.state === "authenticated"
          ? transitionReview(
              current,
              // SAFETY: ClaimDecision is a JSON object; transitionReview only
              // reads acceptedItemIds/destination keys from this record.
              decision as Record<string, unknown>,
              this.clock(),
            )
          : (() => {
              throw new DomainError(
                "INVALID_TRANSITION",
                `Cannot complete from ${current.state}`,
                { state: current.state },
              );
            })();

    // Ensure reviewed is persisted if we just transitioned
    let base = reviewed;
    if (reviewed.version !== current.version) {
      const cas = await this.store.compareAndSwap(
        id,
        current.version,
        reviewed,
      );
      if (!cas.won) {
        // Concurrent writer — reload and handle
        return this.completeClaim(
          id,
          completedByPrincipalId,
          decision,
          attempt + 1,
        );
      }
      base = cas.session;
    }

    const completed = transitionComplete(
      base,
      completedByPrincipalId,
      this.clock(),
    );
    completed.reviewDecision = {
      acceptedItemIds: decision.acceptedItemIds,
      ...(decision.destination !== undefined
        ? { destination: decision.destination }
        : {}),
      ...(decision.idempotencyKey !== undefined
        ? { idempotencyKey: decision.idempotencyKey }
        : {}),
    };

    const result = await this.store.compareAndSwap(id, base.version, completed);
    if (!result.won) {
      // Concurrent completion — only one winner
      if (
        result.session.state === "completed" &&
        result.session.completedByPrincipalId === completedByPrincipalId &&
        decisionsMatch(result.session.reviewDecision, decision)
      ) {
        await this.settleItems(id, accepted);
        return { session: result.session, won: true };
      }
      if (result.session.state === "completed") {
        return { session: result.session, won: false };
      }
      throw new DomainError(
        "CONFLICT",
        "Concurrent claim completion conflict",
        {
          id,
        },
      );
    }
    // Only after winning: item rows say what was accepted, and a decision that
    // lost the swap must not be the one on record against them.
    await this.settleItems(id, accepted);
    return { session: result.session, won: true };
  }

  /**
   * Mark the items against a decision that is on record. The session swap and the
   * item rows are two writes, so a completion interrupted between them leaves
   * items unmarked and its retry lands on the idempotent path: that path settles
   * them here rather than reporting a completion whose items never moved. Safe to
   * repeat, and it writes nothing when they already agree.
   */
  private async settleItems(id: string, accepted: Set<string>): Promise<void> {
    const items = await this.store.getItems(id);
    const settled = items.map((item) => ({
      ...item,
      state: (accepted.has(item.id)
        ? "accepted"
        : "rejected") as ClaimItem["state"],
    }));
    if (settled.every((item, i) => item.state === items[i]?.state)) return;
    await this.store.putItems(id, settled);
  }

  async deny(id: string): Promise<ClaimSession> {
    return this.applyTransition(id, (s) => transitionDeny(s, this.clock()));
  }

  async revoke(id: string): Promise<ClaimSession> {
    return this.applyTransition(id, (s) => transitionRevoke(s, this.clock()));
  }

  async expire(id: string): Promise<ClaimSession> {
    return this.applyTransition(id, (s) => transitionExpire(s, this.clock()));
  }

  async get(id: string): Promise<ClaimSession | undefined> {
    const s = await this.store.get(id);
    if (!s) return undefined;
    return maybeExpireClaim(s, this.clock);
  }

  /** Items a reviewer must name in `acceptedItemIds`. There is no wildcard. */
  async getItems(id: string): Promise<ClaimItem[]> {
    return this.store.getItems(id);
  }
}

/**
 * Whether a completed claim already records this exact decision, and may
 * therefore be reported as this caller's own success. Everything the decision
 * carries has to agree: accepting the same items but naming a different
 * destination is a different decision, and answering it with the recorded one
 * would say ownership went somewhere it did not.
 */
function decisionsMatch(
  recorded: Record<string, unknown> | undefined,
  decision: CompleteDecision,
): boolean {
  if (!recorded) return false;
  const accepted = recorded.acceptedItemIds;
  if (!Array.isArray(accepted)) return false;
  if (accepted.length !== decision.acceptedItemIds.length) return false;
  const set = new Set(accepted);
  if (!decision.acceptedItemIds.every((id) => set.has(id))) return false;
  return (
    canonicalize(recorded.destination ?? null) ===
    canonicalize(decision.destination ?? null)
  );
}

export type {
  ClaimStore,
  ClaimEngineOptions,
  CompleteDecision,
} from "./store.js";
export { MemoryClaimStore } from "./memory-store.js";
