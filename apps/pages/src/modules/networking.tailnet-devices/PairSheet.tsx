/**
 * Pairing this page with the daemon that manages the tailnet (ADR 0166 §3),
 * as a ceremony in a sheet. A pairing link fills the code in. The code works
 * once, from this page's address only, within five minutes; what it is
 * traded for is sealed in the open vault.
 */

import { tailnetErrorText } from "@opensesame/app-core/lib/tailnet-admin/errors.js";
import { TailnetAdminError } from "@opensesame/app-core/lib/tailnet-admin/errors.js";
import { useState } from "react";
import { CeremonySheet } from "../../components/CeremonySheet.js";
import { CeremonyShell } from "../../components/CeremonyShell.js";
import { FieldShell } from "../../components/FieldShell.js";
import { IconConnection } from "../../components/Icons.js";
import { ErrorMark } from "./SwitchRow.js";

export function PairSheet({
  initialCode,
  blocked,
  onPair,
  onClose,
}: {
  initialCode: string;
  /** Why this page cannot pair, in words; empty when it can. */
  blocked: string;
  onPair: (code: string) => Promise<void>;
  onClose: () => void;
}) {
  const [code, setCode] = useState(initialCode);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const canPair = blocked === "";
  const ready = canPair && code.trim().length > 0 && !busy;

  const pair = () => {
    if (!ready) return;
    setBusy(true);
    setError("");
    onPair(code)
      .then(onClose, (caught) =>
        setError(
          tailnetErrorText(
            caught instanceof TailnetAdminError
              ? caught
              : new TailnetAdminError("unreachable"),
          ),
        ),
      )
      .finally(() => setBusy(false));
  };

  return (
    <CeremonySheet
      title="Pair with the tailnet daemon"
      mark={<IconConnection size={20} />}
      foot="The code is used once and is not kept."
      onClose={onClose}
    >
      <form
        aria-label="Pair with the tailnet daemon"
        onSubmit={(event) => {
          event.preventDefault();
          pair();
        }}
      >
        <CeremonyShell
          ok={error === ""}
          name="Tailnet devices"
          facts={[
            { key: "Code from", value: "opensesame daemon tailnet pair" },
            {
              key: "Kept",
              value: canPair ? "sealed in this vault" : "nowhere",
            },
          ]}
          primary={{
            label: "Pair with this daemon",
            submit: true,
            busy,
            disabled: !ready,
            onClick: pair,
          }}
        >
          <FieldShell
            id="tailnet-admin-code"
            label="Pairing code"
            mono
            autoComplete="off"
            placeholder="opensesame-tailnet:v1:…"
            value={code}
            disabled={!canPair}
            readOnly={busy}
            onValueChange={(next) => {
              setCode(next);
              setError("");
            }}
          />
          <ErrorMark error={error || blocked} />
        </CeremonyShell>
      </form>
    </CeremonySheet>
  );
}
