import {
  fetchFirstCliAppPending,
  readCliAppAuthHeaders,
  readDaemonOrigin,
} from "@opensesame/app-core/lib/cli-app-integration/client.js";
import type { VaultHeader } from "@opensesame/vault-core";
import type { FormEvent } from "react";
import { useEffect, useState } from "react";
import gate from "../../../../../spec/conformance/cli-app-integration.json" with {
  type: "json",
};
import type { CliAuthorizeRow } from "./cli-authorize-mint-proof.js";
import { postCliRespond } from "./cli-authorize-net.js";
import {
  runCliAuthorizePasskeyApprove,
  runCliAuthorizePinApprove,
} from "./cli-authorize-proof-run.js";

function toAuthorizeRow(
  row: NonNullable<Awaited<ReturnType<typeof fetchFirstCliAppPending>>>,
): CliAuthorizeRow {
  return [row.requestId, row.terminalSessionId, row.verb, row.respondNonce];
}

export function useCliAuthorizePanel() {
  const [row, setRow] = useState<CliAuthorizeRow | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [pinOpen, setPinOpen] = useState(false);
  const [pin, setPin] = useState("");
  const [mark, setMark] = useState<string | null>(null);
  const [header, setHeader] = useState<VaultHeader | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function refresh() {
      const origin = readDaemonOrigin();
      const headers = readCliAppAuthHeaders();
      if (!origin || !headers) {
        if (!cancelled) setRow(null);
        return;
      }
      const pending = await fetchFirstCliAppPending();
      if (!cancelled) setRow(pending ? toAuthorizeRow(pending) : null);
    }
    void refresh();
    const timer = setInterval(() => {
      void refresh();
    }, gate.pollIntervalMs);
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
  };
}
