import { FieldShell } from "../../components/FieldShell.js";
import { FormCommit } from "../../components/FormCommit.js";
import { IconKey } from "../../components/IconKey.js";
import { IconX } from "../../components/Icons.js";
import { StatusMark } from "../../components/StatusMark.js";
import { CliAuthorizePanelHints } from "./cli-authorize-panel-hints.js";
import { useCliAuthorizePanel } from "./cli-authorize-panel-model.js";

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
        <CliAuthorizePanelHints row={row} hint={hint} onPaired={panel.onPaired} />
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
