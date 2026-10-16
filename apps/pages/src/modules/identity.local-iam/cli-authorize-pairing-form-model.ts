import type { CliAppPairingCode } from "@opensesame/app-core/lib/cli-app-integration/pairing.js";
import { localNetworkFetchSeams } from "@opensesame/app-core/lib/local-network-fetch.js";
import { type FormEvent, useState } from "react";
import { CLI_AUTHORIZE_LOAD_BLOCKED } from "./cli-authorize-messages.js";

export function useCliAuthorizePairingForm(onPaired: () => void) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [mark, setMark] = useState<string | null>(null);
  const [registrationCode, setRegistrationCode] = useState<string | null>(null);
  const [pendingParsed, setPendingParsed] = useState<CliAppPairingCode | null>(
    null,
  );
  const localCliBlocked = !localNetworkFetchSeams.eligible();

  async function onPair(event: FormEvent) {
    event.preventDefault();
    const raw = code.trim();
    if (!raw || busy) return;
    setBusy(true);
    setMark(null);
    setRegistrationCode(null);
    const pairing = await import(
      "@opensesame/app-core/lib/cli-app-integration/pairing.js"
    );
    const parsed = pairing.parseCliAppPairingCode(raw);
    if (!parsed) {
      setBusy(false);
      setMark("Not a pairing code.");
      return;
    }
    const confirmed = await pairing.confirmCliAppPairingCode(parsed);
    setBusy(false);
    if (!confirmed) {
      setMark("The daemon refused that code.");
      return;
    }
    setPendingParsed(parsed);
    setRegistrationCode(confirmed.registrationCode);
    setCode("");
  }

  async function onFinishExchange() {
    if (!pendingParsed || busy) return;
    setBusy(true);
    setMark(null);
    const pairing = await import(
      "@opensesame/app-core/lib/cli-app-integration/pairing.js"
    );
    const ok = await pairing.exchangeCliAppPairingCode(pendingParsed);
    setBusy(false);
    if (!ok) {
      setMark("The daemon refused to finish pairing.");
      return;
    }
    setPendingParsed(null);
    setRegistrationCode(null);
    onPaired();
  }

  return {
    localCliBlocked,
    localCliBlockedMessage: CLI_AUTHORIZE_LOAD_BLOCKED,
    code,
    setCode,
    busy,
    mark,
    registrationCode,
    onPair,
    onFinishExchange,
  };
}
