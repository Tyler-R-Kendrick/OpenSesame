/**
 * Posting a request again until it is answered (ADR 0150 §6): a carrier can
 * drop a frame, so the joiner repeats its request on a timer, a bounded
 * number of times. It then stops posting but keeps listening — the owner may
 * answer long after, and a reply on a closed carrier is heard by nobody.
 */

import { type GuestCarriers, REPOSTS, REPOST_MS } from "./guest-types.js";

export class Reposter {
  #timer: ReturnType<typeof setInterval> | null = null;

  /** Call `post` every interval while `waiting()` says nobody has answered. */
  start(post: () => void, waiting: () => boolean): void {
    this.stop();
    let left = REPOSTS;
    this.#timer = setInterval(() => {
      left -= 1;
      if (!waiting() || left <= 0) this.stop();
      else post();
    }, REPOST_MS);
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }
}

/**
 * A joiner's request on the link's carriers: posted, and again until it is
 * answered; the carriers let go once the session no longer rides on them.
 */
export class RequestPosts {
  readonly #reposts = new Reposter();

  constructor(private readonly carriers: GuestCarriers | null | undefined) {}

  /** Post `request` now, and again while `waiting()` holds. */
  carry(request: string, waiting: () => boolean): void {
    const carriers = this.carriers;
    if (!carriers) return;
    void carriers.post(request);
    this.#reposts.start(() => void carriers.post(request), waiting);
  }

  /** Stop posting: the request was answered. */
  stop(): void {
    this.#reposts.stop();
  }

  /**
   * Stop, and close the carriers unless the session is relayed on them. A
   * goodbye still on its way out is sent over these carriers: let them go
   * once it has left, not before.
   */
  release(relayed: boolean, after: Promise<void> | null = null): void {
    this.#reposts.stop();
    const carriers = this.carriers;
    if (relayed || !carriers) return;
    if (after) void after.then(() => carriers.close());
    else carriers.close();
  }
}
