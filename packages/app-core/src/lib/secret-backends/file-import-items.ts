import type { VaultItem } from "@opensesame/vault-core";
import { isLocalSecretItem, localItemView } from "./local-items.js";
import type { SecretBackendItem } from "./types.js";

/** Rich records remain intact for the real vault import; this read-only view exposes their fields. */
export function importedItemView(item: VaultItem): SecretBackendItem | null {
  if (isLocalSecretItem(item)) return localItemView(item);
  if (item.kind === "card")
    return {
      id: item.id,
      name: item.name,
      kind: "secret",
      notes: item.notes,
      secret: item.number,
      fields: {
        cardholder: item.cardholder,
        brand: item.brand,
        expMonth: item.expMonth,
        expYear: item.expYear,
        code: item.code,
      },
    };
  if (item.kind === "passkey")
    return {
      id: item.id,
      name: item.name,
      kind: "note",
      notes: item.notes,
      secret: "",
      username: item.username,
      fields: {
        rpId: item.rpId,
        credentialIdB64: item.credentialIdB64,
        publicKeyB64: item.publicKeyB64,
      },
    };
  return null;
}
