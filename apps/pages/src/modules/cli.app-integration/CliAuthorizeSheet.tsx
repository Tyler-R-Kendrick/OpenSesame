/**
 * 1Password-style "Authorize CLI" sheet: pending request facts, then PIN or
 * passkey confirmation before the daemon receives approve/deny.
 */

import type { cliAuthorizeCopy } from "@opensesame/app-core/lib/cli-app-integration/index.js";
import type { PendingRequest } from "@opensesame/app-core/lib/cli-app-integration/index.js";
import type { RefObject } from "react";
import { CeremonySheet } from "../../components/CeremonySheet.js";
import { CeremonyShell } from "../../components/CeremonyShell.js";
import { FailureNotice } from "../../components/FailureNotice.js";
import { FieldShell } from "../../components/FieldShell.js";
import { IconPasskey, IconTerminal } from "../../components/Icons.js";
import { useVaultStore } from "../../lib/vault/hooks.js";
import { useCliAuthorizeSheet } from "./use-cli-authorize-sheet.js";

function cliAuthorizeAlts(
  canPasskey: boolean,
  canPin: boolean,
  copy: ReturnType<typeof cliAuthorizeCopy>,
  pin: string,
  setPin: (value: string) => void,
  busy: boolean,
  pinRef: RefObject<HTMLInputElement | null>,
) {
  if (canPasskey) {
    return [
      {
        id: "passkey",
        label: copy.confirmPasskey,
        icon: <IconPasskey size={16} />,
        render: () => <p className="found__hint">{copy.confirmPasskey}</p>,
      },
    ];
  }
  if (canPin) {
    return [
      {
        id: "pin",
        label: copy.confirmPin,
        icon: <IconPasskey size={16} />,
        render: () => (
          <FieldShell
            inputRef={pinRef}
            label={copy.confirmPin}
            type="password"
            inputMode="numeric"
            autoComplete="off"
            placeholder={copy.pinPlaceholder}
            value={pin}
            disabled={busy}
            onValueChange={setPin}
          />
        ),
      },
    ];
  }
  return [];
}

export function CliAuthorizeSheet({
  request,
  onClose,
  onSettled,
}: {
  request: PendingRequest;
  onClose: () => void;
  onSettled: () => void;
}) {
  const store = useVaultStore();
  const sheet = useCliAuthorizeSheet(store, request, onClose, onSettled);

  return (
    <CeremonySheet
      title={sheet.copy.sheetTitle}
      mark={<IconTerminal size={20} />}
      onClose={onClose}
      initialFocus={
        sheet.canPin && !sheet.canPasskey ? sheet.pinRef : undefined
      }
    >
      <CeremonyShell
        ok={sheet.error === ""}
        name={sheet.copy.sheetTitle}
        facts={sheet.facts}
        primary={{
          label: sheet.copy.allowKey,
          choice: true,
          onClick: () => void sheet.authorize(),
          busy: sheet.busy,
          disabled: sheet.busy || !sheet.authorizeReady,
        }}
        secondary={{
          label: sheet.copy.denyKey,
          choice: true,
          onClick: () => void sheet.deny(),
          busy: sheet.busy,
          disabled: sheet.busy,
        }}
        alts={cliAuthorizeAlts(
          sheet.canPasskey,
          sheet.canPin,
          sheet.copy,
          sheet.pin,
          sheet.setPin,
          sheet.busy,
          sheet.pinRef,
        )}
      >
        <p>{sheet.copy.sheetLead}</p>
      </CeremonyShell>
      {sheet.error ? (
        <FailureNotice
          id="cli-authorize:error"
          title={sheet.copy.sheetTitle}
          message={sheet.error}
        />
      ) : null}
    </CeremonySheet>
  );
}
