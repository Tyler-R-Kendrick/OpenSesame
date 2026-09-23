/**
 * Scoped handles for verified documents and key material (B07, B11). A
 * handle is an opaque id bound to the session generation it was minted in;
 * a bump invalidates every handle and zeroes the buffers it guarded.
 */

import { SopsError } from "./errors.js";

export type HandleScope = {
  sessionGeneration: number;
  vaultScope: string | null;
};

type Held<T> = { value: T; scope: HandleScope; secrets: Uint8Array[] };

function randomId(prefix: string): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return `${prefix}_${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export class HandleRegistry<T> {
  readonly #held = new Map<string, Held<T>>();
  #generation: () => number;

  constructor(generation: () => number) {
    this.#generation = generation;
  }

  mint(
    value: T,
    scope: HandleScope,
    secrets: Uint8Array[],
    prefix = "sops",
  ): string {
    this.assertLive(scope);
    const id = randomId(prefix);
    this.#held.set(id, { value, scope, secrets });
    return id;
  }

  assertLive(scope: HandleScope): void {
    if (scope.sessionGeneration !== this.#generation()) {
      throw new SopsError(
        "stale_session",
        "The session changed while the operation was pending.",
      );
    }
  }

  get(id: string, scope: HandleScope): T {
    const held = this.#held.get(id);
    if (!held)
      throw new SopsError(
        "stale_session",
        "The document handle is no longer valid.",
      );
    if (
      held.scope.sessionGeneration !== scope.sessionGeneration ||
      held.scope.vaultScope !== scope.vaultScope
    ) {
      throw new SopsError(
        "stale_session",
        "The document handle belongs to another session or vault.",
      );
    }
    this.assertLive(scope);
    return held.value;
  }

  dispose(id: string): void {
    const held = this.#held.get(id);
    if (!held) return;
    for (const secret of held.secrets) secret.fill(0);
    this.#held.delete(id);
  }

  disposeAll(): void {
    for (const id of [...this.#held.keys()]) this.dispose(id);
  }

  get size(): number {
    return this.#held.size;
  }
}
