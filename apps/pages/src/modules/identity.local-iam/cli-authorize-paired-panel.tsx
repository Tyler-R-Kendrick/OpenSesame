import { FailureNotice } from "../../components/FailureNotice.js";
import { FieldShell } from "../../components/FieldShell.js";
import { FormCommit } from "../../components/FormCommit.js";
import { IconKey } from "../../components/IconKey.js";
import { IconX } from "../../components/Icons.js";
import { StatusMark } from "../../components/StatusMark.js";
import { CLI_AUTHORIZE_PASSKEY_NAME } from "./cli-authorize-messages.js";
import { useCliAuthorizePanel } from "./cli-authorize-panel-model.js";

function CliAuthorizeEmpty({ loadError }: { loadError: string | null }) {
  if (!loadError) return <p>No CLI request is waiting.</p>;
  return (
    <>
      <FailureNotice
        id="cli-authorize:pending"
        title="CLI"
        message={loadError}
      />
      <output aria-live="polite">
        <StatusMark tone="err" label={loadError} />
      </output>
    </>
  );
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
        <FormCommit
          label={CLI_AUTHORIZE_PASSKEY_NAME}
          disabled={busy}
          onClick={onPasskey}
        >
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
