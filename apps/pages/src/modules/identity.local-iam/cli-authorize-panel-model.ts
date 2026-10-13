import type { VaultHeader } from "@opensesame/vault-core";
import type { FormEvent } from "react";
import { useEffect, useState } from "react";
import type { CliAuthorizeRow } from "./cli-authorize-mint-proof.js";
import { postCliRespond } from "./cli-authorize-net.js";
import {
  runCliAuthorizePasskeyApprove,
  runCliAuthorizePinApprove,
} from "./cli-authorize-proof-run.js";
import {
  CLI_AUTHORIZE_ROUTE,
  readCliAppAuthHeaders,
  readDaemonOrigin,
} from "./cli-authorize-session.js";
import type { CliDaemonPendingRow } from "./cli-daemon-pending-fetch.js";
import { fetchDaemonCliPending } from "./cli-daemon-pending-fetch.js";

export type CliAuthorizePanelHint =
  | null
  | "unpaired"
  | "local-network-blocked"
  | "daemon-unreachable";

const POLL_MS = 500;

function toAuthorizeRow(row: CliDaemonPendingRow): CliAuthorizeRow {
  return [row.requestId, row.terminalSessionId, row.verb, row.respondNonce];
}

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

  useEffect(() => {
    let cancelled = false;
    async function refresh() {
      const origin = readDaemonOrigin();
      const headers = readCliAppAuthHeaders();
      if (!origin) {
        if (!cancelled) {
          setRow(null);
          setHint("daemon-unreachable");
        }
        return;
      }
      if (!headers) {
        if (!cancelled) {
          setRow(null);
          setHint("unpaired");
        }
        return;
      }
      try {
        const pending = await fetchDaemonCliPending(origin, headers);
        if (!cancelled) {
          setHint(null);
          setRow(pending ? toAuthorizeRow(pending) : null);
        }
      } catch (error) {
        if (cancelled) return;
        setRow(null);
        if (error instanceof DOMException && error.name === "SecurityError") {
          setHint("local-network-blocked");
        } else {
          setHint("daemon-unreachable");
        }
      }
    }
    void refresh();
    const timer = setInterval(() => {
      void refresh();
    }, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

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
