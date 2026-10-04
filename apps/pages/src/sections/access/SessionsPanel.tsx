import { useVault } from "../../lib/vault/hooks.js";
import { LocalAuthorityPanel } from "./LocalAuthorityPanel.js";
import { LocalAuthorityTemplates } from "./LocalAuthorityTemplates.js";
import { VaultSessionsPanel } from "./VaultSessionsPanel.js";
import { Receipts } from "./receipts.js";

import { useReceiptsSession } from "./use-receipts-session.js";
export function SessionsPanel({ online }: { online: boolean }) {
  const session = useReceiptsSession();
  const { tomb } = useVault();
  return (
    <>
      <LocalAuthorityPanel key={tomb} tomb={tomb} records="session" />
      <LocalAuthorityTemplates />
      <VaultSessionsPanel key={`${tomb}-vault-sessions`} tomb={tomb} />
      {session ? (
        <Receipts online={online} sessionKey={session.principalId} />
      ) : null}
    </>
  );
}
