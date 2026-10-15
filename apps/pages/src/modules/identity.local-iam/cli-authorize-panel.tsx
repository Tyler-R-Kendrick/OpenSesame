import { readCliAppIntegrationBearer } from "@opensesame/app-core/lib/cli-app-integration/bearer-session.js";
import { useState } from "react";
import { FieldShell } from "../../components/FieldShell.js";
import { FormCommit } from "../../components/FormCommit.js";
import { IconKey } from "../../components/IconKey.js";
import { IconX } from "../../components/Icons.js";
import { StatusMark } from "../../components/StatusMark.js";
import { CliAuthorizePairingForm } from "./cli-authorize-pairing-form.js";
import { useCliAuthorizePanel } from "./cli-authorize-panel-model.js";
import { cliAuthorizeVerbLabel } from "./cli-authorize-verb-label.js";

function CliAuthorizeEmpty({ loadError }: { loadError: string | null }) {
  return <p>{loadError ?? "No CLI request is waiting."}</p>;
}

function CliAuthorizePairedPanel() {
  const panel = useCliAuthorizePanel();
  const {
    rows,
    row,
    pendingCount,
    loadError,
    busy,
    pinOpen,
    pin,
    mark,
    setPin,
    onPasskey,
    onPin,
    onDeny,
  } = panel;

  return (
    <>
      {rows === undefined ? <output>Reading CLI request…</output> : null}
      {rows !== undefined && row === null ? (
        <CliAuthorizeEmpty loadError={loadError} />
      ) : null}
      {pendingCount > 0 ? (
        <p>
          {pendingCount === 1
            ? "1 CLI request waiting"
            : `${pendingCount} CLI requests waiting`}
        </p>
      ) : null}
      {rows && rows.length > 0 ? (
        <ul className="identity-cli-pending">
          {rows.map((entry) => (
            <li key={entry[0]}>
              <span className="identity-ref">
                {cliAuthorizeVerbLabel(entry[2])}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {row && pinOpen ? (
        <form onSubmit={onPin}>
          <FieldShell
            label="PIN"
            type="password"
            inputMode="numeric"
            autoComplete="off"
            placeholder="PIN"
            value={pin}
            disabled={busy}
            onValueChange={setPin}
            status={mark ? <StatusMark tone="err" label={mark} /> : null}
          />
          <FormCommit
            label="Authorize"
            disabled={busy || pin.length === 0}
            busy={busy}
          />
        </form>
      ) : null}
      {row && !pinOpen ? (
        <FormCommit label="Authorize" disabled={busy} onClick={onPasskey}>
          <IconKey label="Deny" disabled={busy} onClick={onDeny}>
            <IconX size={16} />
          </IconKey>
        </FormCommit>
      ) : null}
      {mark && row && !pinOpen ? (
        <output aria-live="polite">
          <StatusMark tone="err" label={mark} />
        </output>
      ) : null}
    </>
  );
}

export function CliAuthorizePanel() {
  const [paired, setPaired] = useState(
    () => readCliAppIntegrationBearer() !== null,
  );

  return (
    <section className="panel" aria-label="Authorize CLI">
      <div className="panel__head">
        <h1>Authorize CLI</h1>
      </div>
      <div className="panel__body">
        {paired ? (
          <CliAuthorizePairedPanel />
        ) : (
          <CliAuthorizePairingForm onPaired={() => setPaired(true)} />
        )}
      </div>
    </section>
  );
}
