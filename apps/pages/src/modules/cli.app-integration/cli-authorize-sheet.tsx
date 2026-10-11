import type { PendingRequest } from "@opensesame/app-core/lib/cli-app-integration/pending-request.js";
import {
  cliAuthorizeCopy as copy,
  cliVerbLabels,
} from "./cli-authorize-copy.js";
import { listAvailableUnlockMethods } from "@opensesame/app-core/lib/vault/unlock-methods.js";
import { useMemo, useRef, useState } from "react";
import { CeremonySheet } from "../../components/CeremonySheet.js";
import { CeremonyShell } from "../../components/CeremonyShell.js";
import { FieldShell } from "../../components/FieldShell.js";
import { IconTerminal } from "../../components/Icons.js";
import { useFailureNotice } from "../../components/use-failure-notice.js";
import { useVaultStore } from "../../lib/vault/hooks.js";
import {
  approveCliIntegrationRequest,
  cliAuthorizeErrorMessage,
  denyCliIntegrationRequest,
} from "./cli-authorize-actions.js";

function labelVerb(verb: string): string {
  if (verb === "read") return cliVerbLabels.read;
  if (verb === "run") return cliVerbLabels.run;
  if (verb === "env-resolve") return cliVerbLabels["env-resolve"];
  if (verb === "pass-reveal") return cliVerbLabels["pass-reveal"];
  return verb;
}

function present(row: PendingRequest) {
  const id = row.terminalSessionId.trim();
  const terminalLabel =
    id.length <= 12 ? id || "—" : `${id.slice(0, 6)}…${id.slice(-4)}`;
  const commandLabel = labelVerb(row.verb);
  const reference = row.reference?.trim();
  return { terminalLabel, commandLabel, targetLine: reference || null };
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
  const view = useMemo(() => present(request), [request]);
  const header = store.getSnapshot().header;
  const methods = header ? listAvailableUnlockMethods(header) : [];
  const canPasskey = methods.includes("passkey");
  const canPin = methods.includes("pin");
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pinRef = useRef<HTMLInputElement>(null);
  useFailureNotice("cli-authorize", copy.sheetTitle, error);

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

  const facts = [
    { key: copy.terminalLabel, value: view.terminalLabel },
    { key: copy.commandLabel, value: view.commandLabel },
    ...(view.targetLine
      ? [{ key: copy.targetLabel, value: view.targetLine }]
      : []),
  ];

  return (
    <CeremonySheet
      title={copy.sheetTitle}
      mark={<IconTerminal size={20} />}
      onClose={onClose}
      initialFocus={canPin && !canPasskey ? pinRef : undefined}
    >
      <CeremonyShell
        ok={!error}
        name={copy.sheetTitle}
        facts={facts}
        primary={{
          label: copy.allowKey,
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
          label: copy.denyKey,
          choice: true,
          onClick: () =>
            void settleAfter(() => denyCliIntegrationRequest(request)),
          busy,
          disabled: busy,
        }}
      >
        <p>{copy.sheetLead}</p>
        {canPin && !canPasskey ? (
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
        ) : null}
      </CeremonyShell>
    </CeremonySheet>
  );
}
