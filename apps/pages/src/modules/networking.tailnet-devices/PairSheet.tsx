/**
 * Pairing this page with the daemon that manages the tailnet (ADR 0166 §3),
 * as a ceremony in a sheet. A pairing link fills the code in. The code works
 * once, from this page's address only, within five minutes; what it is
 * traded for is sealed in the open vault. Before anything is pressed the sheet
 * says which daemon the code points at, with which role and name, and which
 * pairing it would replace: a link from someone else must not quietly
 * re-point this page at their tailnet.
 */

import type { TailnetTarget } from "@opensesame/app-core/lib/tailnet-admin/client.js";
import {
  TailnetAdminError,
  tailnetErrorText,
} from "@opensesame/app-core/lib/tailnet-admin/errors.js";
import { parseTailnetPairingCode } from "@opensesame/app-core/lib/tailnet-admin/pairing.js";
import { useState } from "react";
import { CeremonySheet } from "../../components/CeremonySheet.js";
import { CeremonyShell } from "../../components/CeremonyShell.js";
import { FieldShell } from "../../components/FieldShell.js";
import { IconConnection } from "../../components/Icons.js";
import { ErrorMark } from "./SwitchRow.js";

/** What the pasted code says, before it is spent: where, as what, replacing what. */
function codeFacts(code: string, current: TailnetTarget | null) {
  const parsed = parseTailnetPairingCode(code);
  const facts = parsed
    ? [
        { key: "Daemon", value: new URL(parsed.url).host },
        { key: "Role", value: parsed.role },
        { key: "Named", value: parsed.label || "unnamed" },
      ]
    : [{ key: "Code from", value: "opensesame daemon tailnet pair" }];
  if (current)
    facts.push({
      key: "Replaces",
      value: [current.label, current.host].filter(Boolean).join(" at "),
    });
  return facts;
}

export function PairSheet({
  initialCode,
  current,
  blocked,
  onPair,
  onClose,
}: {
  initialCode: string;
  /** The pairing this one would replace, if any. */
  current: TailnetTarget | null;
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
            ...codeFacts(code, current),
            {
              key: "Kept",
              value: canPair ? "sealed in this vault" : "nowhere",
            },
          ]}
          primary={{
            label: current
              ? "Replace the paired daemon"
              : "Pair with this daemon",
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
