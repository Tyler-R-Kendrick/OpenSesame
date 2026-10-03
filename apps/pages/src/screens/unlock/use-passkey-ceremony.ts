import { cancelPasskeyDuressCode } from "@opensesame/app-core/screens/unlock/unlock-passkey-duress.js";
import { useCallback, useEffect, useRef } from "react";

/**
 * The pending platform prompt and what a ceremony held for its complete code —
 * the root an age passkey opened, the PRF output and the duress evidence.
 *
 * Switching methods (or leaving the passkey tab) must cancel any pending
 * prompt: a blocking WebAuthn request must never hold the other unlock modes
 * hostage. And leaving the screen by any road — all vaults, setup, sign-in, a
 * vault switch, an unlock — must drop what was held, not only a tab click: a
 * root left in memory after the person walked away is spendable by whatever
 * code runs next.
 */
export function usePasskeyCeremony(
  setAwaitingCode: (value: boolean) => void,
  setBusy: (value: boolean) => void,
) {
  const passkeyAbort = useRef<AbortController | null>(null);
  const cancelPasskeyCeremony = useCallback(() => {
    if (passkeyAbort.current) {
      passkeyAbort.current.abort();
      passkeyAbort.current = null;
    }
    cancelPasskeyDuressCode();
    setAwaitingCode(false);
    setBusy(false);
  }, [setAwaitingCode, setBusy]);
  useEffect(
    () => () => {
      passkeyAbort.current?.abort();
      passkeyAbort.current = null;
      cancelPasskeyDuressCode();
    },
    [],
  );
  return { passkeyAbort, cancelPasskeyCeremony };
}
