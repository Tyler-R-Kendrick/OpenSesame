/**
 * Vault export and import as SOPS documents (PERSIST-03), kept out of the
 * sheet component. Export mints a fresh data key for the selected items;
 * import is a separately consented copy under the destination vault's own
 * any-of protection, never a change to the source document's policy.
 */

import { setStatusNotice } from "@opensesame/app-core/lib/notices.js";
import { downloadText } from "@opensesame/app-core/lib/sops/download.js";
import { parseAgeRecipient } from "@opensesame/app-core/lib/sops/keys/age.js";
import {
  planDigest,
  planFromRecipients,
} from "@opensesame/app-core/lib/sops/plan.js";
import { sopsSession } from "@opensesame/app-core/lib/sops/session.js";
import {
  exportVaultSecrets,
  importVaultSecrets,
} from "@opensesame/app-core/lib/sops/vault-secrets.js";
import type { VaultItem } from "@opensesame/app-core/lib/vault/model.js";
import { identityList } from "@opensesame/app-core/sections/settings/sops/identities.js";
import { useCallback } from "react";

function notice(tone: "info" | "err", body: string): void {
  setStatusNotice({
    id: "formats-interoperability",
    tone,
    title: "Vault SOPS",
    body,
  });
}

export type VaultSecretActionsInput = {
  items: readonly VaultItem[];
  recipient: string;
  identity: string;
  fileText: string;
  consent: boolean;
  vaultIdentities: readonly string[];
  scope: string | null;
  setBusy: (busy: boolean) => void;
  /** One atomic write for the whole import — never a loop (SB-069). */
  saveItems: (items: readonly VaultItem[]) => Promise<void>;
};

export type VaultSecretActions = { onExport: () => void; onImport: () => void };

export function useVaultSecretActions(
  input: VaultSecretActionsInput,
): VaultSecretActions {
  const {
    items,
    recipient,
    identity,
    fileText,
    consent,
    vaultIdentities,
    scope,
    setBusy,
    saveItems,
  } = input;

  const onExport = useCallback(() => {
    setBusy(true);
    void (async () => {
      try {
        const recipients = recipient
          .split(/[\s,]+/u)
          .filter((entry) => entry !== "")
          .map(parseAgeRecipient);
        const plan = planFromRecipients({
          format: "json",
          groups: [recipients],
        });
        const body = await exportVaultSecrets({
          runner: sopsSession.runner,
          items,
          plan,
          permit: sopsSession.permit({
            vaultScope: scope,
            documentGeneration: sopsSession.nextDocument(),
            approvedPlanDigest: await planDigest(plan),
          }),
        });
        downloadText("vault-secrets.sops.json", body, "encrypted");
        notice("info", `${items.length} items encrypted.`);
      } catch (caught) {
        notice(
          "err",
          caught instanceof Error ? caught.message : "Export failed.",
        );
      } finally {
        setBusy(false);
      }
    })();
  }, [items, recipient, scope, setBusy]);

  const onImport = useCallback(() => {
    setBusy(true);
    void (async () => {
      try {
        const imported = await importVaultSecrets({
          runner: sopsSession.runner,
          ciphertext: fileText,
          identities: identityList({
            ephemeral: identity,
            vault: vaultIdentities,
          }),
          consentToVaultCopy: consent,
          permit: sopsSession.permit({
            vaultScope: scope,
            documentGeneration: sopsSession.nextDocument(),
          }),
        });
        // The whole import is decrypted before anything is written, then
        // written as one change: a failure part-way through leaves the
        // prior vault, never half an import (SB-069).
        await saveItems(imported.items);
        notice("info", `${imported.items.length} items imported.`);
      } catch (caught) {
        notice(
          "err",
          caught instanceof Error ? caught.message : "Import failed.",
        );
      } finally {
        setBusy(false);
      }
    })();
  }, [consent, fileText, identity, saveItems, scope, setBusy, vaultIdentities]);

  return { onExport, onImport };
}
