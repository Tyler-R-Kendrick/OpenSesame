import type { ChallengeMeta } from "./webauthn.js";
export interface PasskeyChallengeStore {
  set(challenge: string, meta: ChallengeMeta): void | Promise<void>;
  consume(
    challenge: string,
  ): ChallengeMeta | undefined | Promise<ChallengeMeta | undefined>;
  /**
   * Read a challenge's metadata without spending it.
   *
   * The transaction-bound ceremony needs to check what a challenge was minted
   * *for* before handing the assertion to the verifier that consumes it.
   * Consuming it here instead would leave the verifier with nothing to check
   * the assertion against, and re-inserting it afterwards would open a window
   * where two callers hold the same one-time value.
   */
  peek(
    challenge: string,
  ): ChallengeMeta | undefined | Promise<ChallengeMeta | undefined>;
}
