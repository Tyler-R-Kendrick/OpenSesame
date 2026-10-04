/**
 * A fixed-window limit per client, for the one route an anonymous visitor can
 * make the server do work and remember something for (`/auth/start`).
 *
 * Deliberately small. It bounds how fast one address can fill the login store;
 * it is not a defence against many addresses, which is what the store's own
 * refusal at capacity is for. Behind a proxy, key it on the address the proxy
 * vouches for, and share it across instances if there are several.
 */

const WINDOW_MS = 60_000;

export class StartRateLimit {
  readonly #windows = new Map<string, { startedAt: number; count: number }>();
  readonly #perMinute: number;
  readonly #maxClients: number;
  readonly #now: () => number;

  constructor(
    perMinute: number,
    now: () => number = () => Date.now(),
    maxClients = 10_000,
  ) {
    this.#perMinute = perMinute;
    this.#maxClients = maxClients;
    this.#now = now;
  }

  /** True when `client` may start another login now, and counts it. */
  allow(client: string): boolean {
    const nowMs = this.#now();
    const held = this.#windows.get(client);
    if (held !== undefined && nowMs - held.startedAt < WINDOW_MS) {
      if (held.count >= this.#perMinute) return false;
      held.count += 1;
      return true;
    }
    if (held === undefined && this.#windows.size >= this.#maxClients) {
      this.#dropExpired(nowMs);
      if (this.#windows.size >= this.#maxClients) return false;
    }
    this.#windows.set(client, { startedAt: nowMs, count: 1 });
    return true;
  }

  #dropExpired(nowMs: number): void {
    for (const [client, held] of this.#windows) {
      if (nowMs - held.startedAt >= WINDOW_MS) this.#windows.delete(client);
    }
  }
}
