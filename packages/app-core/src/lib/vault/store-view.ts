/** Existing presentation subscribers only; no root/key or permission checks. */
import type { VaultState } from "./store-state.js";
type Listener = () => void;

export class StoreListeners {
  readonly #listeners = new Set<Listener>();
  subscribe = (listener: Listener): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };
  [Symbol.iterator](): IterableIterator<Listener> {
    return this.#listeners.values();
  }
  emit(): void {
    for (const listener of this.#listeners) listener();
  }
}

export class StoreView {
  readonly #listeners = new StoreListeners();
  #snapshot: VaultState | undefined;
  subscribe = this.#listeners.subscribe;
  getSnapshot = (): VaultState => {
    if (!this.#snapshot)
      throw new Error("Vault presentation is not initialized.");
    return this.#snapshot;
  };
  publish(next: VaultState): void {
    this.#snapshot = next;
    this.#listeners.emit();
  }
}
