import { localNetworkFetchSeams } from "@opensesame/app-core/lib/local-network-fetch.js";
import { type FormEvent, useState } from "react";
import { IconConnection } from "../../components/Icons.js";
import { StatusMark } from "../../components/StatusMark.js";
import { CLI_AUTHORIZE_LOAD_BLOCKED } from "./cli-authorize-panel-model.js";

export function CliAuthorizePairingForm({
  onPaired,
}: {
  onPaired: () => void;
}) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [mark, setMark] = useState<string | null>(null);
  const localCliBlocked = !localNetworkFetchSeams.eligible();

  async function onPair(event: FormEvent) {
    event.preventDefault();
    const raw = code.trim();
    if (!raw || busy) return;
    setBusy(true);
    setMark(null);
    const pairing = await import(
      "@opensesame/app-core/lib/cli-app-integration/pairing.js"
    );
    const parsed = pairing.parseCliAppPairingCode(raw);
    if (!parsed) {
      setBusy(false);
      setMark("Not a pairing code.");
      return;
    }
    const { completeCliAppPairing } = pairing;
    const outcome = await completeCliAppPairing(parsed);
    setBusy(false);
    if (!outcome) {
      setMark("The daemon refused that code.");
      return;
    }
    setMark(
      `Type ${outcome.registrationCode} into the terminal, then exchange the pairing code there.`,
    );
    setCode("");
    onPaired();
  }

  return (
    <>
      {localCliBlocked ? <p>{CLI_AUTHORIZE_LOAD_BLOCKED}</p> : null}
      <form className="plugin-tile__pair" onSubmit={onPair}>
        <label htmlFor="cli-authorize-pairing-code">Pairing code</label>
        <div className="field-inline">
          <input
            id="cli-authorize-pairing-code"
            type="text"
            value={code}
            placeholder="opensesame-cli-app:v1:…"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            readOnly={busy}
            onChange={(event) => setCode(event.target.value)}
          />
          <button
            type="submit"
            className="icon-btn"
            disabled={busy || code.trim() === ""}
            aria-busy={busy || undefined}
            aria-label="Pair with the daemon"
            title="Pair with the daemon"
          >
            <IconConnection size={16} />
          </button>
        </div>
      </form>
      {mark ? (
        <output aria-live="polite">
          <StatusMark tone="err" label={mark} />
        </output>
      ) : null}
    </>
  );
}
