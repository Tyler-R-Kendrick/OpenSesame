import type { VaultHeader } from "@opensesame/vault-core";
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { useFailureNotice } from "../../components/use-failure-notice.js";
import type { CliAuthorizeRow } from "./cli-authorize-mint-proof.js";
import {
  runCliAuthorizePasskeyProof,
  runCliAuthorizePinProof,
} from "./cli-authorize-proof-actions.js";

function proofMethods(header: VaultHeader | null | undefined) {
  const unlocks = header?.unlocks;
  const canPasskey =
    (unlocks?.passkeys?.length ?? 0) > 0 || Boolean(unlocks?.passkey);
  return { canPasskey, canPin: Boolean(unlocks?.pin) };
}

export function useCliAuthorizeApproveState(
  row: CliAuthorizeRow,
  busy: boolean,
  onBusyChange: (busy: boolean) => void,
  onDone: () => void,
  onRespond: (
    decision: "approve" | "deny",
    humanProof?: string,
  ) => Promise<boolean>,
) {
  const [canPasskey, setCanPasskey] = useState(false);
  const [canPin, setCanPin] = useState(false);
  const [header, setHeader] = useState<VaultHeader | null>(null);
  const [pinOpen, setPinOpen] = useState(false);
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
        const loadedHeader = vaultStore.getSnapshot().header;
        setHeader(loadedHeader);
        const methods = proofMethods(loadedHeader);
        setCanPasskey(methods.canPasskey);
        setCanPin(methods.canPin);
        setPinOpen(!methods.canPasskey && methods.canPin);
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
    setMark,
    clearMark: () => setMark(null),
  };

  return {
    canPasskey,
    canPin,
    pinOpen,
    pin,
    mark,
    setPinOpen,
    setPin,
    provePasskey: () =>
      void runCliAuthorizePasskeyProof({
        ...runInput,
        onNeedPin: () => {
          if (canPin) setPinOpen(true);
        },
      }),
    provePin: (event: FormEvent) => {
      if (!header) return;
      void runCliAuthorizePinProof({ ...runInput, pin, header, event });
    },
  };
}
