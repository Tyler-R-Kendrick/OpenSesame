import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { useLayoutEffect, useMemo } from "react";
import type { useSecretBackendAction } from "../secret-backends/useSecretBackendAction.js";
import type {
  NativeConnectorController,
  SafeActionResult,
} from "./native-connector-ui.js";
function nativeActionVaultScope() {
  const state = vaultStore.getSnapshot();
  return JSON.stringify([
    state.status,
    state.tomb,
    state.guest,
    state.awaitingSecondStep,
    state.decoy,
  ]);
}

export function useNativeActionWithdrawal(
  controller: NativeConnectorController,
  enabled: boolean,
  pending: ReturnType<typeof useSecretBackendAction>,
  setResult: (value: SafeActionResult | null) => void,
  options?: { scope: string; preserveDisabledResult: boolean },
) {
  const { busy, clear } = pending;
  const scope = options?.scope;
  const preserveDisabledResult = options?.preserveDisabledResult === true;
  const lifetime = useMemo(
    () => ({ controller, scope, end: clear }),
    [controller, scope, clear],
  );
  useLayoutEffect(() => {
    if (!enabled) {
      if (!preserveDisabledResult || busy) setResult(null);
      if (busy) clear();
    }
  }, [enabled, busy, clear, setResult, preserveDisabledResult]);
  useLayoutEffect(() => {
    setResult(null);
    let scope = nativeActionVaultScope();
    const end = () => {
      lifetime.end();
      setResult(null);
    };
    const stopLock = vaultStore.onLock(end);
    const stopSnapshot = vaultStore.subscribe(() => {
      const next = nativeActionVaultScope();
      if (scope !== next) {
        scope = next;
        end();
      }
    });
    return () => {
      stopLock();
      stopSnapshot();
      lifetime.end();
    };
  }, [lifetime, setResult]);
}
