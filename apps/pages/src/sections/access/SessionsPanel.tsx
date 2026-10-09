import { useVault } from "../../lib/vault/hooks.js";
import { LocalAuthorityPanel } from "./LocalAuthorityPanel.js";
import { LocalAuthorityTemplates } from "./LocalAuthorityTemplates.js";
import { VaultSessionsPanel } from "./VaultSessionsPanel.js";
import { Receipts } from "./receipts.js";

import { useReceiptsSession } from "./use-receipts-session.js";
export function SessionsPanel({
  online,
  panel = "local-sessions",
}: { online: boolean; panel?: string }) {
  const session = useReceiptsSession();
  const { tomb } = useVault();
  return (
    <>
      {panel === "local-sessions" ? (
        <LocalAuthorityPanel key={tomb} tomb={tomb} records="session" />
      ) : null}
      {panel === "local-authority-templates" ? (
        <LocalAuthorityTemplates />
      ) : null}
      {panel === "vault-share-sessions" ? (
        <VaultSessionsPanel key={`${tomb}-vault-sessions`} tomb={tomb} />
      ) : null}
      {panel === "access-receipts" && session ? (
        <Receipts online={online} sessionKey={session.key} />
      ) : null}
    </>
  );
}
