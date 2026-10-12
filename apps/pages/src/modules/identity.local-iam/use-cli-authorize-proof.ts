import type { VaultHeader } from "@opensesame/vault-core";
import { useEffect, useState } from "react";
import { useFailureNotice } from "../../components/use-failure-notice.js";
import {
  runCliAuthorizePasskeyProof,
  runCliAuthorizePinProof,
} from "./cli-authorize-proof-run.js";
import type { CliAuthorizeProofMode } from "./cli-authorize-proof-sheet.js";
import type { CliAuthorizeRow } from "./cli-authorize-session.js";
import { cliAuthorizeProofMethods } from "./cli-authorize-unlock-methods.js";

export function useCliAuthorizeProof(
  row: CliAuthorizeRow,
  busy: boolean,
  onBusyChange: (busy: boolean) => void,
  onRespond: (
    decision: "approve" | "deny",
    humanProof?: string,
  ) => Promise<boolean>,
  onDone: () => void,
) {
  const [proofMode, setProofMode] = useState<CliAuthorizeProofMode>("passkey");
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

  const runInput = {
    row,
    busy,
    onBusyChange,
    onRespond,
    onDone,
    noteFailure,
    clearMark: () => setMark(null),
    setMark,
  };

  return {
    proofMode,
    pin,
    mark,
    canPasskey,
    canPin,
    setProofMode,
    setPin,
    proveWithPasskey: () => void runCliAuthorizePasskeyProof(runInput),
    proveWithPin: (event: import("react").FormEvent) => {
      if (!header) return;
      void runCliAuthorizePinProof({ ...runInput, pin, header, event });
    },
  };
}
