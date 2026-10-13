import {
  clearCliAppIntegrationBearer,
  completeCliAppPairing,
  parseCliAppPairingCode,
  readCliAppIntegrationBearer,
} from "@opensesame/app-core/lib/cli-app-integration/pairing.js";
import { pageIsLoopback } from "@opensesame/app-core/lib/settings.js";
import { type FormEvent, useCallback, useState } from "react";

export function useCliAppPairingPanel() {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [paired, setPaired] = useState(
    () => readCliAppIntegrationBearer() !== null,
  );
  const [mark, setMark] = useState<string | null>(null);
  const loopback = pageIsLoopback();

  const refreshPaired = useCallback(() => {
    setPaired(readCliAppIntegrationBearer() !== null);
  }, []);

  async function onPair(event: FormEvent) {
    event.preventDefault();
    const raw = code.trim();
    if (!raw || busy) return;
    const parsed = parseCliAppPairingCode(raw);
    if (!parsed) {
      setMark("Not a CLI pairing code.");
      return;
    }
    setBusy(true);
    setMark(null);
    const ok = await completeCliAppPairing(parsed);
    setBusy(false);
    if (!ok) {
      setMark("The daemon would not take that code.");
      return;
    }
    setCode("");
    refreshPaired();
  }

  function onForget() {
    clearCliAppIntegrationBearer();
    refreshPaired();
    setMark(null);
  }

  return {
    loopback,
    code,
    setCode,
    busy,
    paired,
    mark,
    onPair,
    onForget,
  };
}
