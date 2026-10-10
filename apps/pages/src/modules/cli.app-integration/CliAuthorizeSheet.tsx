/**
 * 1Password-style "Authorize CLI" sheet: pending request facts, then PIN or
 * passkey confirmation before the daemon receives approve/deny.
 */

import {
  type PendingRequest,
  cliAuthorizeCopy,
  presentCliAuthorizeRequest,
  respondCliIntegration,
} from "@opensesame/app-core/lib/cli-app-integration/index.js";
import { listAvailableUnlockMethods } from "@opensesame/app-core/lib/vault/unlock-methods.js";
import { WrongPasswordError } from "@opensesame/vault-core";
import { useMemo, useRef, useState } from "react";
import { CeremonySheet } from "../../components/CeremonySheet.js";
import { CeremonyShell } from "../../components/CeremonyShell.js";
import { FailureNotice } from "../../components/FailureNotice.js";
import { FieldShell } from "../../components/FieldShell.js";
import { IconPasskey, IconTerminal } from "../../components/Icons.js";
import { useVaultStore } from "../../lib/vault/hooks.js";

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
  const copy = cliAuthorizeCopy();
  const view = useMemo(() => presentCliAuthorizeRequest(request), [request]);
  const header = store.getSnapshot().header;
  const methods = header ? listAvailableUnlockMethods(header) : [];
  const canPasskey = methods.includes("passkey");
  const canPin = methods.includes("pin");
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pinRef = useRef<HTMLInputElement>(null);

  const facts = [
    { key: copy.terminalLabel, value: view.terminalLabel },
    { key: copy.commandLabel, value: view.commandLabel },
    ...(view.targetLine
      ? [{ key: copy.targetLabel, value: view.targetLine }]
      : []),
    ...(view.fieldLine
      ? [{ key: copy.fieldLabel, value: view.fieldLine }]
      : []),
  ];

  async function afterConfirm(decision: "approve" | "deny") {
    const ok = await respondCliIntegration(
      request.requestId,
      request.terminalSessionId,
      decision,
    );
    if (!ok) {
      setError("CLI integration could not reach the daemon.");
      return;
    }
    onSettled();
    onClose();
  }

  async function authorize() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      if (canPasskey) await store.confirmPasskeyStepUp();
      else if (canPin) await store.confirmPinStepUp(pin);
      else throw new Error("Enroll a passkey or PIN in Settings › Security.");
      await afterConfirm("approve");
    } catch (failure) {
      setError(
        failure instanceof WrongPasswordError
          ? failure.message
          : failure instanceof Error
            ? failure.message
            : "Authorization was not completed.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function deny() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await afterConfirm("deny");
    } finally {
      setBusy(false);
    }
  }

  const authorizeReady = canPasskey || (canPin && pin.length > 0);

  return (
    <CeremonySheet
      title={copy.sheetTitle}
      mark={<IconTerminal size={20} />}
      onClose={onClose}
      initialFocus={canPin && !canPasskey ? pinRef : undefined}
    >
      <CeremonyShell
        ok={error === ""}
        name={copy.sheetTitle}
        facts={facts}
        primary={{
          label: copy.allowKey,
          choice: true,
          onClick: () => void authorize(),
          busy,
          disabled: busy || !authorizeReady,
        }}
        secondary={{
          label: copy.denyKey,
          choice: true,
          onClick: () => void deny(),
          busy,
          disabled: busy,
        }}
        alts={
          canPasskey
            ? [
                {
                  id: "passkey",
                  label: copy.confirmPasskey,
                  icon: <IconPasskey size={16} />,
                  render: () => (
                    <p className="found__hint">{copy.confirmPasskey}</p>
                  ),
                },
              ]
            : canPin
              ? [
                  {
                    id: "pin",
                    label: copy.confirmPin,
                    icon: <IconPasskey size={16} />,
                    render: () => (
                      <FieldShell label={copy.confirmPin}>
                        <input
                          ref={pinRef}
                          type="password"
                          inputMode="numeric"
                          autoComplete="off"
                          className="field"
                          placeholder={copy.pinPlaceholder}
                          value={pin}
                          disabled={busy}
                          onChange={(event) => setPin(event.target.value)}
                        />
                      </FieldShell>
                    ),
                  },
                ]
              : []
        }
      >
        <p>{copy.sheetLead}</p>
      </CeremonyShell>
      {error ? (
        <FailureNotice
          id="cli-authorize:error"
          title={copy.sheetTitle}
          message={error}
        />
      ) : null}
    </CeremonySheet>
  );
}
