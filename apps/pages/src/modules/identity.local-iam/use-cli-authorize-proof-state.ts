import type { VaultHeader } from "@opensesame/vault-core";
import { type FormEvent, useEffect, useState } from "react";
import { useFailureNotice } from "../../components/use-failure-notice.js";
import {
  runPasskeyApprove,
  runPinApprove,
} from "./cli-authorize-proof-actions.js";
import type { CliAuthorizeRow } from "./cli-authorize-session.js";
import { cliAuthorizeProofMethods } from "./cli-authorize-unlock-methods.js";

type ProofMode = "pin" | "passkey";

export function useCliAuthorizeProofState(
  row: CliAuthorizeRow,
  busy: boolean,
  onBusyChange: (busy: boolean) => void,
  onRespond: (
    decision: "approve" | "deny",
    humanProof?: string,
  ) => Promise<boolean>,
) {
  const [proofMode, setProofMode] = useState<ProofMode>("passkey");
  const [canPasskey, setCanPasskey] = useState(false);
  const [canPin, setCanPin] = useState(false);
  const [header, setHeader] = useState<VaultHeader | null>(null);
  const [pin, setPin] = useState("");
  const [mark, setMark] = useState<string | null>(null);
  const [failure, setFailure] = useState<{
    title: string;
    message: string;
    occurrence: number;
  } | null>(null);
  useFailureNotice(
    "cli-authorize-proof",
    failure?.title ?? "",
    failure?.message ?? null,
    "err",
    { occurrence: failure?.occurrence },
  );

  useEffect(() => {
    void import("@opensesame/app-core/lib/vault/store.js").then(
      ({ vaultStore }) => {
        const snapshotHeader = vaultStore.getSnapshot().header;
        setHeader(snapshotHeader);
        const methods = cliAuthorizeProofMethods(snapshotHeader);
        setCanPasskey(methods.includes("passkey"));
        setCanPin(methods.includes("pin"));
        setProofMode(methods.includes("passkey") ? "passkey" : "pin");
      },
    );
  }, []);

  function noteFailure(title: string, message: string) {
    setFailure((prev) => ({
      title,
      message,
      occurrence: (prev?.occurrence ?? 0) + 1,
    }));
  }

  async function onApprove(humanProof: string) {
    setMark(null);
    const ok = await onRespond("approve", humanProof);
    if (!ok) {
      noteFailure("CLI authorization failed", "That did not work.");
      setMark("That did not work.");
    }
  }

  const runInput = {
    row,
    busy,
    onBusyChange,
    onApprove,
    onError: noteFailure,
    clearMark: () => setMark(null),
    setMark,
  };

  return {
    proofMode,
    pin,
    mark,
    canPasskey,
    canPin,
    header,
    setPin,
    setProofMode,
    provePasskey: () => void runPasskeyApprove(runInput),
    provePin: (event: FormEvent) => {
      if (!header) return;
      void runPinApprove({ ...runInput, pin, header, event });
    },
  };
}
