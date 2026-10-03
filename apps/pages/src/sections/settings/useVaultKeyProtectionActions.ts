/**
 * Default Settings › Vault key protection actions against the store + sheets.
 */

import { isGuestSessionTomb } from "@opensesame/app-core/lib/duress/store/decoy-scratch.js";
import { setStatusNotice } from "@opensesame/app-core/lib/notices.js";
import { ProtectionError } from "@opensesame/app-core/lib/vault/protection/errors.js";
import type { VaultKeyProtectionActions } from "@opensesame/app-core/sections/settings/vault-key-protection-panel-model.js";
import { testCloudFlow } from "@opensesame/app-core/sections/settings/vault-protector-enrollment-model.js";
import { useVault, useVaultStore } from "../../lib/vault/hooks.js";
import type { ProtectionSheetRequest } from "./VaultKeyProtectionCeremonies.js";

/** What the actions call beyond the store — a seam for tests. */
export const vaultKeyProtectionActionDependencies = { testCloudFlow };

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
  const { status: vaultStatus, guest, tomb: vaultTomb } = useVault();
  const tomb = vaultTomb ?? "";
  // The same rule the service enforces (`isGuestOrEphemeral`): the guest's own
  // tomb keeps its isolation after a key is enrolled in it, so its protectors
  // are not changed from here. Offering the keys would only fail on press.
  if (
    vaultStatus !== "unlocked" ||
    guest ||
    isGuestSessionTomb(vaultTomb ?? null)
  ) {
    return undefined;
  }

  return {
    onAdd: () => input.openSheet({ kind: "add" }),
    onTest: (protectorId) => {
      const kind = input.methodKind(protectorId);
      if (kind === "recovery-key") {
        input.openSheet({ kind: "test-recovery", protectorId });
        return;
      }
      if (kind === "age-recipient") {
        input.openSheet({ kind: "test-age", protectorId });
        return;
      }
      void runProtected(async () => {
        if (kind === "aws-kms" || kind === "gcp-kms") {
          await vaultKeyProtectionActionDependencies.testCloudFlow({
            protection: store.protection,
            tomb,
            protectorId,
            kind,
          });
        } else {
          // The age passkey asks for the passkey itself.
          await store.protection.testProtector(protectorId);
        }
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
