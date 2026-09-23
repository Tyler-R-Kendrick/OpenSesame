/**
 * Default Settings › Vault key protection actions against the store + sheets.
 */

import { setStatusNotice } from "@opensesame/app-core/lib/notices.js";
import { ProtectionError } from "@opensesame/app-core/lib/vault/protection/errors.js";
import type { VaultKeyProtectionActions } from "@opensesame/app-core/sections/settings/vault-key-protection-panel-model.js";
import { useVault, useVaultStore } from "../../lib/vault/hooks.js";
import type { ProtectionSheetRequest } from "./VaultKeyProtectionCeremonies.js";

function status(
  tone: "info" | "warn" | "err",
  title: string,
  body: string,
): void {
  setStatusNotice({
    id: "vault-key-protection",
    tone,
    title,
    body,
  });
}

async function runProtected(
  work: () => Promise<void>,
  fallback: string,
): Promise<void> {
  try {
    await work();
  } catch (caught) {
    if (caught instanceof ProtectionError || caught instanceof Error) {
      status("err", "Vault key protection", caught.message);
      return;
    }
    status("err", "Vault key protection", fallback);
  }
}

export function useVaultKeyProtectionActions(input: {
  openSheet: (request: ProtectionSheetRequest) => void;
  methodKind: (protectorId: string) => string | undefined;
}): VaultKeyProtectionActions | undefined {
  const store = useVaultStore();
  const { status: vaultStatus, guest } = useVault();
  if (vaultStatus !== "unlocked" || guest) return undefined;

  return {
    onAdd: () => input.openSheet({ kind: "add" }),
    onTest: (protectorId) => {
      const kind = input.methodKind(protectorId);
      if (kind === "recovery-key") {
        input.openSheet({ kind: "test-recovery", protectorId });
        return;
      }
      void runProtected(async () => {
        await store.protection.testProtector(protectorId);
        status("info", "Vault key protection", "Protector proof succeeded.");
      }, "Protector proof failed.");
    },
    onPreferred: (protectorId) => {
      void runProtected(async () => {
        await store.protection.setPreferred(protectorId);
        status("info", "Vault key protection", "Preferred protector updated.");
      }, "Could not set preferred protector.");
    },
    onRemove: (protectorId) => {
      void runProtected(async () => {
        await store.protection.removeProtector(protectorId);
        status("info", "Vault key protection", "Protector removed.");
      }, "Could not remove protector.");
    },
    onRotateCompromised: () => input.openSheet({ kind: "rotate" }),
  };
}
