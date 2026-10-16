import { FieldShell } from "../../components/FieldShell.js";
import { FormCommit } from "../../components/FormCommit.js";
import { IconKey } from "../../components/IconKey.js";
import { IconX } from "../../components/Icons.js";
import { StatusMark } from "../../components/StatusMark.js";
import { useCliAuthorizePanel } from "./cli-authorize-panel-model.js";

function CliAuthorizeEmpty({ loadError }: { loadError: string | null }) {
  return <p>{loadError ?? "No CLI request is waiting."}</p>;
}

export function CliAuthorizePairedPanel() {
  const panel = useCliAuthorizePanel();
  const {
    row,
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
      {row === undefined ? <output>Reading CLI request…</output> : null}
      {row === null ? <CliAuthorizeEmpty loadError={loadError} /> : null}
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
    </>
  );
}
