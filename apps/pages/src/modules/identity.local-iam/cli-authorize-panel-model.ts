import type { VaultHeader } from "@opensesame/vault-core";
import type { FormEvent } from "react";
import { useState } from "react";
import type { CliAuthorizeRow } from "./cli-authorize-mint-proof.js";
import { postCliRespond } from "./cli-authorize-net.js";
import { useCliAuthorizePendingPoll } from "./cli-authorize-panel-poll.js";
import {
  runCliAuthorizePasskeyApprove,
  runCliAuthorizePinApprove,
} from "./cli-authorize-proof-run.js";
import {
  CLI_AUTHORIZE_ROUTE,
  readCliAppAuthHeaders,
  readDaemonOrigin,
} from "./cli-authorize-session.js";

export type CliAuthorizePanelHint =
  | null
  | "unpaired"
  | "local-network-blocked"
  | "daemon-unreachable";

export function useCliAuthorizePanel() {
  const [row, setRow] = useState<CliAuthorizeRow | null | undefined>(undefined);
  const [hint, setHint] = useState<CliAuthorizePanelHint>(null);
  const [busy, setBusy] = useState(false);
  const [pinOpen, setPinOpen] = useState(false);
  const [pin, setPin] = useState("");
  const [mark, setMark] = useState<string | null>(null);
  const [header, setHeader] = useState<VaultHeader | null>(null);

  const onPaired = () => {
    setHint(null);
    setRow(undefined);
  };

  useCliAuthorizePendingPoll(setRow, setHint);

  async function finish(decision: "approve" | "deny", humanProof?: string) {
    if (!row || busy) return;
    setBusy(true);
    const origin = readDaemonOrigin();
    const headers = readCliAppAuthHeaders();
    if (!origin || !headers) {
      setBusy(false);
      return;
    }
    const ok = await postCliRespond(origin, headers, row, decision, humanProof);
    setBusy(false);
    if (ok) setRow(null);
    else setMark("That did not work.");
  }

  const proofInput = {
    row,
    busy,
    setBusy,
    setMark,
    setHeader,
    setPinOpen,
    finish,
  };

  return {
    row,
    hint,
    authorizeRoute: CLI_AUTHORIZE_ROUTE,
    busy,
    pinOpen,
    pin,
    mark,
    setPin,
    onPasskey: () => {
      if (row) void runCliAuthorizePasskeyApprove({ ...proofInput, row });
    },
    onPin: (event: FormEvent) => {
      if (row)
        void runCliAuthorizePinApprove({
          ...proofInput,
          row,
          pin,
          header,
          event,
        });
    },
    onDeny: () => void finish("deny"),
    onPaired,
  };
}
