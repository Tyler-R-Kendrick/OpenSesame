import {
  completeCliAppPairing,
  parseCliAppPairingCode,
} from "@opensesame/app-core/lib/cli-app-integration/pairing.js";
import { type FormEvent, useState } from "react";
import { IconConnection } from "../../components/Icons.js";
import { StatusMark } from "../../components/StatusMark.js";

export function CliAuthorizePairingForm({
  onPaired,
}: {
  onPaired: () => void;
}) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [mark, setMark] = useState<string | null>(null);

  async function onPair(event: FormEvent) {
    event.preventDefault();
    const raw = code.trim();
    if (!raw || busy) return;
    const parsed = parseCliAppPairingCode(raw);
    if (!parsed) {
      setMark("Not a pairing code.");
      return;
    }
    setBusy(true);
    setMark(null);
    const ok = await completeCliAppPairing(parsed);
    setBusy(false);
    if (!ok) {
      setMark("The daemon refused that code.");
      return;
    }
    setCode("");
    onPaired();
  }

  return (
    <>
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
          {code.trim() ? (
            <button
              type="submit"
              className="icon-btn"
              aria-busy={busy || undefined}
              aria-label="Pair with the daemon"
              title="Pair with the daemon"
            >
              <IconConnection size={16} />
            </button>
          ) : null}
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
