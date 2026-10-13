import {
  clearCliAppIntegrationBearer,
  completeCliAppPairing,
  parseCliAppPairingCode,
  readCliAppIntegrationBearer,
} from "@opensesame/app-core/lib/cli-app-integration/pairing.js";
import { pageIsLoopback } from "@opensesame/app-core/lib/settings.js";
import { type FormEvent, useCallback, useState } from "react";
import { FailureNotice } from "../../components/FailureNotice.js";
import { IconKey } from "../../components/IconKey.js";
import { IconConnection, IconX } from "../../components/Icons.js";
import { StatusMark } from "../../components/StatusMark.js";

const PAIR = "Pair with the daemon";
const FORGET = "Forget CLI pairing";

function CliAppPairingForm({
  code,
  busy,
  onCode,
  onPair,
}: {
  code: string;
  busy: boolean;
  onCode: (value: string) => void;
  onPair: (event: FormEvent) => Promise<void>;
}) {
  const ready = code.trim().length > 0;
  const fieldId = "cli-app-pairing-code";
  return (
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
          onChange={(event) => onCode(event.target.value)}
        />
        {ready ? (
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
  );
}

export function CliAppPairingPanel() {
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

  if (!loopback) return null;

  return (
    <section className="panel" aria-label="Terminal CLI">
      <div className="panel__head">
        <h2>Terminal CLI</h2>
        {paired ? (
          <IconKey label={FORGET} small disabled={busy} onClick={onForget}>
            <IconX size={16} />
          </IconKey>
        ) : null}
      </div>
      <div className="panel__body">
        <FailureNotice
          id="identity:cli-app-pairing"
          title="Terminal CLI"
          message={mark}
        />
        {paired ? (
          <StatusMark
            tone="ok"
            label="Paired for CLI integration on this browser."
          />
        ) : (
          <CliAppPairingForm
            code={code}
            busy={busy}
            onCode={setCode}
            onPair={onPair}
          />
        )}
        {mark && !paired ? (
          <output aria-live="polite">
            <StatusMark tone="err" label={mark} />
          </output>
        ) : null}
      </div>
    </section>
  );
}
