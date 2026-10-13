import { FailureNotice } from "../../components/FailureNotice.js";
import { IconKey } from "../../components/IconKey.js";
import { IconConnection, IconX } from "../../components/Icons.js";
import { StatusMark } from "../../components/StatusMark.js";
import { useCliAppPairingPanel } from "./cli-app-pairing-panel-model.js";

const PAIR = "Pair with the daemon";
const FORGET = "Forget CLI pairing";
const fieldId = "cli-app-pairing-code";

export function CliAppPairingPanel() {
  const { loopback, code, setCode, busy, paired, mark, onPair, onForget } =
    useCliAppPairingPanel();

  if (!loopback) return null;

  const ready = code.trim().length > 0;

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
