import {
  type PendingRequest,
  cliAuthorizeCopy,
  presentCliAuthorizeRequest,
  respondCliIntegration,
} from "@opensesame/app-core/lib/cli-app-integration/index.js";
import { listAvailableUnlockMethods } from "@opensesame/app-core/lib/vault/unlock-methods.js";
import type { VaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { WrongPasswordError } from "@opensesame/vault-core";
import { useMemo, useRef, useState } from "react";

export function useCliAuthorizeSheet(
  store: VaultStore,
  request: PendingRequest,
  onClose: () => void,
  onSettled: () => void,
) {
  const copy = cliAuthorizeCopy();
  const view = useMemo(() => presentCliAuthorizeRequest(request), [request]);
  const header = store.getSnapshot().header;
  const methods = header ? listAvailableUnlockMethods(header) : [];
  const canPasskey = methods.includes("passkey");
  const canPin = methods.includes("pin");
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pinRef = useRef<HTMLInputElement>(null);

  const facts = [
    { key: copy.terminalLabel, value: view.terminalLabel },
    { key: copy.commandLabel, value: view.commandLabel },
    ...(view.targetLine
      ? [{ key: copy.targetLabel, value: view.targetLine }]
      : []),
    ...(view.fieldLine
      ? [{ key: copy.fieldLabel, value: view.fieldLine }]
      : []),
  ];

  async function afterConfirm(decision: "approve" | "deny") {
    const ok = await respondCliIntegration(
      request.requestId,
      request.terminalSessionId,
      decision,
    );
    if (!ok) {
      setError("CLI integration could not reach the daemon.");
      return;
    }
    onSettled();
    onClose();
  }

  async function authorize() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      if (canPasskey) {
        const { confirmPasskeyStepUpForCli } = await import("./cli-step-up.js");
        await confirmPasskeyStepUpForCli(store, undefined);
      } else if (canPin) {
        const { confirmPinStepUpForCli } = await import("./cli-step-up.js");
        await confirmPinStepUpForCli(store, pin);
      } else throw new Error("Enroll a passkey or PIN in Settings › Security.");
      await afterConfirm("approve");
    } catch (failure) {
      setError(
        failure instanceof WrongPasswordError
          ? failure.message
          : failure instanceof Error
            ? failure.message
            : "Authorization was not completed.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function deny() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await afterConfirm("deny");
    } finally {
      setBusy(false);
    }
  }

  return {
    copy,
    facts,
    canPasskey,
    canPin,
    pin,
    setPin,
    busy,
    error,
    pinRef,
    authorize,
    deny,
    authorizeReady: canPasskey || (canPin && pin.length > 0),
  };
}
