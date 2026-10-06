import type { VaultBody } from "@opensesame/vault-core";

export const MAX_DECOY_ITEMS = 100;
export const MAX_DECOY_BODY_BYTES = 256 * 1024;

/** Includes inline file payloads and every other body field, not just visible items. */
export function assertDecoyBodyBudget(body: VaultBody): void {
  if (
    body.items.length > MAX_DECOY_ITEMS ||
    new TextEncoder().encode(JSON.stringify(body)).byteLength >
      MAX_DECOY_BODY_BYTES
  ) {
    throw new Error("This session has reached its storage limit.");
  }
}
