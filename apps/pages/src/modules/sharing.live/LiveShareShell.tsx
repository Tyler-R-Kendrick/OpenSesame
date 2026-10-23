/**
 * Live sessions as one wrapper around the shell body (ADR 0150 as
 * amended): it puts the Share key in the prompt's seat beside the
 * vault's name and owns the sheet that key (and the rail menu's
 * Share › Session) opens. The core shell knows only the seat, so
 * nothing of hosting — the sheet, the form, the routes — is reachable
 * from a build that excludes this capability.
 */

import { type ReactNode, useCallback, useMemo, useState } from "react";
import { CeremonySheet } from "../../components/CeremonySheet.js";
import { IconShare } from "../../components/Icons.js";
import {
  type VaultShare,
  VaultShareProvider,
} from "../../components/vault-share-seat.js";
import { LiveSessionBanner } from "./LiveSessionBanner.js";
import { LiveShareButton } from "./LiveShareButton.js";
import { LiveSharePanel, useVaultName } from "./LiveSharePanel.js";

export function LiveShareShell({ children }: { children?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const name = useVaultName();
  const show = useCallback(() => setOpen(true), []);
  const hide = useCallback(() => setOpen(false), []);
  const share = useMemo<VaultShare>(
    () => ({ Button: LiveShareButton, Banner: LiveSessionBanner, open: show }),
    [show],
  );
  return (
    <VaultShareProvider value={share}>
      {children}
      {open ? (
        <CeremonySheet
          title={`Share ${name}`}
          mark={<IconShare size={20} />}
          onClose={hide}
        >
          <LiveSharePanel />
        </CeremonySheet>
      ) : null}
    </VaultShareProvider>
  );
}

