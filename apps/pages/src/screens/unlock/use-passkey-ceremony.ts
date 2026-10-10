import { setStatusNotice } from "@opensesame/app-core/lib/notices.js";
import type { PasskeyAttachment } from "@opensesame/app-core/lib/vault/protection/adapters/webauthn-prf-ceremony.js";
import type { UnlockTabId } from "@opensesame/app-core/lib/vault/protection/unlock-protector-methods.js";
import { cancelPasskeyDuressCode } from "@opensesame/app-core/screens/unlock/unlock-passkey-duress.js";
import { useCallback, useEffect, useRef, useState } from "react";

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
  setError: (message: string | null) => void,
  setMethod: (id: UnlockTabId) => void,
) {
  const passkeyAbort = useRef<AbortController | null>(null);
  // Where a first-run passkey is made. Choosing the other kind is how a person
  // leaves a prompt that will never answer, so it cancels the pending one.
  const [attachment, setAttachment] = useState<PasskeyAttachment>("platform");
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
  const pickAttachment = useCallback(
    (kind: PasskeyAttachment) => {
      cancelPasskeyCeremony();
      setAttachment(kind);
      setError(null);
    },
    [cancelPasskeyCeremony, setError],
  );
  /**
   * An authenticator that cannot answer PRF cannot seal a vault, and no second
   * try on it will. That is not a failure: the form moves to the next road that
   * can work — a security key after this device, a PIN after a key — and the
   * tray says why with a plain line, not an error.
   */
  const sealUnsupported = useCallback(
    (kind: PasskeyAttachment) => {
      const onDevice = kind === "platform";
      if (onDevice) setAttachment("cross-platform");
      else setMethod("pin");
      setStatusNotice({
        id: "unlock:authenticator",
        tone: "info",
        title: "Passkey",
        body: onDevice
          ? "This device's passkey cannot seal a vault. Security key is selected."
          : "That security key cannot seal a vault. Seal with a PIN instead.",
      });
    },
    [setMethod],
  );
  return {
    passkeyAbort,
    cancelPasskeyCeremony,
    attachment,
    pickAttachment,
    sealUnsupported,
  };
}
