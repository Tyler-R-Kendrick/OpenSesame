import {
  completeCliAppPairing,
  parseCliAppPairingCode,
  readCliAppIntegrationBearer,
} from "@opensesame/app-core/lib/cli-app-integration/pairing.js";
import { type FormEvent, useCallback, useState } from "react";
import { IconConnection } from "../../components/Icons.js";
import { StatusMark } from "../../components/StatusMark.js";

const fieldId = "cli-authorize-pairing-code";
const PAIR = "Pair with the daemon";

export function CliAuthorizePairingForm({
  onPaired,
}: {
  onPaired: () => void;
}) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [mark, setMark] = useState<string | null>(null);
  const paired = readCliAppIntegrationBearer() !== null;

  const refresh = useCallback(() => {
    onPaired();
  }, [onPaired]);

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
    refresh();
  }

  if (paired) {
    return (
      <StatusMark
        tone="ok"
        label="Paired for CLI integration on this browser."
      />
    );
  }

  return (
    <>
      <form className="plugin-tile__pair" onSubmit={onPair}>
        <label htmlFor={fieldId}>Pairing code</label>
        <div className="field-inline">
          <input
            id={fieldId}
            type="text"
            value={code}
            placeholder="opensesame-cli-app:v1:…"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            readOnly={busy}
            onChange={(event) => setCode(event.target.value)}
          />
          {code.trim().length > 0 ? (
            <button
              type="submit"
              className="icon-btn"
              aria-busy={busy || undefined}
              aria-label={PAIR}
              title={PAIR}
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
