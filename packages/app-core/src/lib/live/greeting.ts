/**
 * The catalog handshake that does not trust one frame (ADR 0186).
 *
 * A joined session starts when the joiner holds the catalog. The owner used
 * to send it once, the moment its end of the channel opened — and WebRTC can
 * drop exactly that frame: in Chromium, a frame sent as the remote-created
 * data channel appears may never be delivered, though the connection stays up
 * and the next frame arrives. The joiner then waited on "Connecting" for good
 * while the owner counted them in.
 *
 * So the joiner asks: it greets (`hello`) as soon as its channel opens, and
 * again on a backoff until the catalog arrives. The owner answers every
 * greeting with the catalog, and counts the guest in at the first one, which
 * is also the first proof that the guest's end is there. Both sides stay
 * bounded: the joiner stops at the connect timeout, and the owner answers at
 * most `GREETINGS_MAX` greetings a seat.
 */

/** How long the joiner waits before greeting again, at first. */
export const GREETING_MS: readonly number[] = [200, 400, 800, 1600];
/** And after that, until the catalog comes or the attempt is over. */
export const GREETING_STEADY_MS = 3200;

/** How many greetings the owner answers for one seat. */
export const GREETINGS_MAX = 32;

/** Greets now, then again on the backoff, until stopped or a greeting fails. */
export class Greeter {
  #timer: ReturnType<typeof setTimeout> | null = null;

  /** `greet` says whether the greeting went out; one that did not stops it. */
  start(greet: () => boolean): void {
    this.stop();
    let sent = 0;
    const next = (): void => {
      this.#timer = null;
      if (!greet()) return;
      const wait = GREETING_MS[sent] ?? GREETING_STEADY_MS;
      sent += 1;
      this.#timer = setTimeout(next, wait);
    };
    next();
  }

  stop(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
  }
}
