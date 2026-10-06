/**
 * Pairing this device with a drive on the tailnet (ADR 0144), as a ceremony
 * in a sheet. A pairing link fills the code in; in a guest session the same
 * code sets this device up from the drive instead: the vault is written into
 * this device's own place and the unlock screen asks for its password.
 */

import { useState } from "react";
import { CeremonySheet } from "../../components/CeremonySheet.js";
import {
  type CeremonyFact,
  CeremonyShell,
} from "../../components/CeremonyShell.js";
import { FailureNotice } from "../../components/FailureNotice.js";
import { FieldShell } from "../../components/FieldShell.js";
import { IconConnection } from "../../components/Icons.js";
import { StatusMark } from "../../components/StatusMark.js";

function driveFacts(guest: boolean): CeremonyFact[] {
  return guest
    ? [
        { key: "Writes", value: "the vault, into this device's own place" },
        { key: "Then", value: "the unlock screen asks for its password" },
      ]
    : [
        { key: "Pairs", value: "this vault with the drive" },
        { key: "Code from", value: "opensesame daemon drive create" },
      ];
}

export function TailnetPairSheet({
  initialCode,
  guest,
  canPair,
  onPair,
  onClose,
}: {
  initialCode: string;
  guest: boolean;
  canPair: boolean;
  /** Resolves when paired; rejects with the reason it was refused. */
  onPair: (code: string) => Promise<void>;
  onClose: () => void;
}) {
  const [code, setCode] = useState(initialCode);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const action = guest
    ? "Set this device up from the drive"
    : "Pair with this drive";
  const ready = canPair && code.trim().length > 0;

  const pair = () => {
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    onPair(code)
      .catch((caught) =>
        setError(caught instanceof Error ? caught.message : String(caught)),
      )
      .finally(() => setBusy(false));
  };

  return (
    <CeremonySheet
      title="Pair with a drive"
      mark={<IconConnection size={20} />}
      onClose={onClose}
    >
      <form
        aria-label="Pair with a drive"
        onSubmit={(event) => {
          event.preventDefault();
          pair();
        }}
      >
        <CeremonyShell
          ok={error === null}
          // The sheet is a modal ceremony: its focus is trapped, so the bell
          // is out of reach while it is open. The refusal is read here, in
          // the sheet, and also kept in the tray for after it closes.
          top={error ?? undefined}
          name="Tailnet drive"
          facts={driveFacts(guest)}
          primary={{
            label: action,
            submit: true,
            busy,
            disabled: !ready,
            onClick: pair,
          }}
        >
          <FieldShell
            id="tailnet-sync-code"
            label="Pairing code"
            mono
            autoComplete="off"
            placeholder="opensesame-drive:v1:…"
            value={code}
            disabled={!canPair}
            readOnly={busy}
            status={
              error === null ? null : <StatusMark tone="err" label={error} />
            }
            onValueChange={(next) => {
              setCode(next);
              setError(null);
            }}
          />
          <output className="visually-hidden" aria-live="polite">
            {error ?? ""}
          </output>
          <FailureNotice
            id="tailnet:pair"
            title="Tailnet pairing"
            message={error}
          />
        </CeremonyShell>
      </form>
    </CeremonySheet>
  );
}
