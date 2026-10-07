import type { VaultItem } from "@opensesame/vault-core";

/**
 * Replace a secret item's value. A write that cannot be confirmed is reported
 * without its cause and is never retried on the person's behalf.
 */
export async function updateItemSecret(
  item: VaultItem,
  value: string,
  save: (item: VaultItem) => Promise<void>,
) {
  if (item.kind !== "secret") throw new Error("Choose a credential item.");
  try {
    await save({ ...item, value, updatedAt: new Date().toISOString() });
  } catch {
    throw new Error(
      "Credential update unverified. Do not retry automatically.",
    );
  }
}
