/**
 * Posting a request again until it is answered (ADR 0150 §6): a carrier can
 * drop a frame, so the joiner repeats its request on a timer, a bounded
 * number of times. It then stops posting but keeps listening — the owner may
 * answer long after, and a reply on a closed carrier is heard by nobody.
 */

import { REPOSTS, REPOST_MS } from "./guest-types.js";

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
