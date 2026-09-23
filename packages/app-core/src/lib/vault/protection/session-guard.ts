/**
 * Session-generation gate for in-flight protection operations (C03/C11).
 * Lock, logout, guest entry, and vault switch bump generation and abort
 * pending work so late callbacks cannot mutate the newly selected scope.
 */

import { ProtectionError } from "./errors.js";

export class ProtectionSessionGuard {
  #generation = 0;
  #controller = new AbortController();

  get generation(): number {
    return this.#generation;
  }

  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  /** Cancel in-flight ops and invalidate captured session generations. */
  bump(): number {
    this.#generation += 1;
    this.#controller.abort(
      new ProtectionError(
        "stale_operation",
        "Session generation changed; discarding stale protection operation.",
      ),
    );
    this.#controller = new AbortController();
    return this.#generation;
  }
}
