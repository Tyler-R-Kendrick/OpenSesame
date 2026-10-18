/** Drainable detection writes; holds metadata only, never a root or owner grant. */
import { host } from "../../host.js";
import {
  type RetiredLoginData,
  appendRetiredInteraction,
} from "./retired-login-operation.js";
export type RetiredInteraction =
  | "vault_read"
  | "vault_export"
  | "vault_write"
  | "authority_denied";
export class RetiredInteractionQueue {
  #pending: Promise<void> = Promise.resolve();
  #failures: unknown[] = [];
  enqueue(data: RetiredLoginData, action: RetiredInteraction): void {
    const installed = host();
    // Accepted detection writes survive session exit; exact context/trap is revalidated.
    this.#pending = this.#pending.then(async () => {
      try {
        await appendRetiredInteraction(data, action, () => {
          if (host() !== installed)
            throw new Error("Original detection storage changed.");
        });
      } catch (error) {
        this.#failures.push(error);
      }
    });
  }

  async drain(): Promise<void> {
    await this.#pending;
    if (!this.#failures.length) return;
    const failures = this.#failures.splice(0);
    throw new AggregateError(
      failures,
      "Retired credential detection could not be recorded.",
    );
  }
}
