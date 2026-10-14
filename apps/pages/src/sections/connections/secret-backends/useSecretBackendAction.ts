import {
  type Flash,
  errorText,
} from "@opensesame/app-core/sections/connections/shared.js";
import { useCallback, useRef, useState } from "react";

/** One attempted operation owns its mark and tray notice until the next edit. */
export function useSecretBackendAction(onFlash: (flash: Flash) => void) {
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState("");
  const [result, setResult] = useState("");
  const clear = useCallback(() => {
    setFailure("");
    setResult("");
  }, []);
  async function run(action: () => Promise<string | undefined>) {
    if (pending.current) return false;
    pending.current = true;
    setBusy(true);
    clear();
    try {
      const message = await action();
      if (message) setResult(message);
      return true;
    } catch (error) {
      const message = errorText(error);
      setFailure(message);
      onFlash({ tone: "err", text: message });
      return false;
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  return { busy, failure, result, clear, run };
}
