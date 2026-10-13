import { Link } from "react-router";
import { FieldShell } from "../../components/FieldShell.js";
import { FormCommit } from "../../components/FormCommit.js";
import { IconKey } from "../../components/IconKey.js";
import { IconX } from "../../components/Icons.js";
import { StatusMark } from "../../components/StatusMark.js";
import {
  type CliAuthorizePanelHint,
  useCliAuthorizePanel,
} from "./cli-authorize-panel-model.js";

const DEVICES_CLI_PAIR = "/identity?view=devices#cli-terminal";

function CliAuthorizeHint({ hint }: { hint: CliAuthorizePanelHint }) {
  if (hint === "unpaired") {
    return (
      <p>
        Pair this browser with the daemon under{" "}
        <Link to={DEVICES_CLI_PAIR}>Identity › Devices › Terminal CLI</Link>.
      </p>
    );
  }
  if (hint === "local-network-blocked") {
    return (
      <p>
        This origin cannot reach the local daemon. Open OpenSesame on loopback,
        or allow local network access in the browser, then pair under{" "}
        <Link to={DEVICES_CLI_PAIR}>Identity › Devices › Terminal CLI</Link>.
      </p>
    );
  }
  return <p>No CLI request is waiting.</p>;
}

export function CliAuthorizePanel() {
  const panel = useCliAuthorizePanel();
  const {
    row,
    hint,
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
    <section className="panel" aria-label="Authorize CLI">
      <div className="panel__head">
        <h1>Authorize CLI</h1>
      </div>
      <div className="panel__body">
        {row === undefined ? <output>Reading CLI request…</output> : null}
        {row === null ? <CliAuthorizeHint hint={hint} /> : null}
        {row ? (
          <p>
            <code className="identity-ref">{row[2]}</code>
          </p>
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
      </div>
    </section>
  );
}
