import type { PendingRequest } from "@opensesame/app-core/lib/cli-app-integration/pending-request.js";
import { listAvailableUnlockMethods } from "@opensesame/app-core/lib/vault/unlock-methods.js";
import { useRef, useState } from "react";
import { IconTerminal } from "../../components/Icons.js";
import { CeremonySheet } from "../../components/CeremonySheet.js";
import { CeremonyShell } from "../../components/CeremonyShell.js";
import { FieldShell } from "../../components/FieldShell.js";
import { useFailureNotice } from "../../components/use-failure-notice.js";
import { useVaultStore } from "../../lib/vault/hooks.js";
import {
  approveCliIntegrationRequest,
  cliAuthorizeErrorMessage,
  denyCliIntegrationRequest,
} from "./cli-authorize-actions.js";

const title = "Authorize CLI";

function terminalLabel(sessionId: string): string {
  const id = sessionId.trim();
  if (!id) return "—";
  return id.length <= 12 ? id : `${id.slice(0, 6)}…${id.slice(-4)}`;
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
  const header = store.getSnapshot().header;
  const methods = header ? listAvailableUnlockMethods(header) : [];
  const canPasskey = methods.includes("passkey");
  const canPin = methods.includes("pin");
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pinRef = useRef<HTMLInputElement>(null);
  useFailureNotice("cli-authorize", title, error);

  async function settleAfter(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await action();
      onSettled();
      onClose();
    } catch (failure) {
      setError(cliAuthorizeErrorMessage(failure));
    } finally {
      setBusy(false);
    }
  }

  const ref = request.reference?.trim();
  const facts = [
    { key: "Terminal session", value: terminalLabel(request.terminalSessionId) },
    { key: "Command", value: request.verb },
    ...(ref ? [{ key: "Item", value: ref }] : []),
  ];

  return (
    <CeremonySheet
      title={title}
      mark={<IconTerminal size={20} />}
      onClose={onClose}
      initialFocus={canPin && !canPasskey ? pinRef : undefined}
    >
      <CeremonyShell
        ok={!error}
        name={title}
        facts={facts}
        primary={{
          label: "Authorize",
          choice: true,
          onClick: () =>
            void settleAfter(() =>
              approveCliIntegrationRequest(store, request, {
                canPasskey,
                canPin,
                pin,
              }),
            ),
          busy,
          disabled: busy || !(canPasskey || (canPin && pin.length > 0)),
        }}
        secondary={{
          label: "Deny",
          choice: true,
          onClick: () =>
            void settleAfter(() => denyCliIntegrationRequest(request)),
          busy,
          disabled: busy,
        }}
      >
        <p>OpenSesame CLI wants vault access from this terminal.</p>
        {canPin && !canPasskey ? (
          <FieldShell
            inputRef={pinRef}
            label="Confirm with PIN"
            type="password"
            inputMode="numeric"
            autoComplete="off"
            placeholder="PIN"
            value={pin}
            disabled={busy}
            onValueChange={setPin}
          />
        ) : null}
      </CeremonyShell>
    </CeremonySheet>
  );
}
