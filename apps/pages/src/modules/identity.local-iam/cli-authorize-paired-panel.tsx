import { FailureNotice } from "../../components/FailureNotice.js";
import { FormCommit } from "../../components/FormCommit.js";
import { IconKey } from "../../components/IconKey.js";
import { IconX } from "../../components/Icons.js";
import { StatusMark } from "../../components/StatusMark.js";
import {
  CLI_AUTHORIZE_PASSKEY_MISSING,
  CLI_AUTHORIZE_PASSKEY_NAME,
  CLI_AUTHORIZE_PASSKEY_UNSUPPORTED,
} from "./cli-authorize-messages.js";
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

function CliAuthorizeDeny({
  busy,
  onDeny,
}: {
  busy: boolean;
  onDeny: () => void;
}) {
  return (
    <IconKey label="Deny" disabled={busy} onClick={onDeny}>
      <IconX size={16} />
    </IconKey>
  );
}

export function CliAuthorizePairedPanel() {
  const panel = useCliAuthorizePanel();
  const { row, loadError, busy, mark, passkeyReady, onPasskey, onDeny } = panel;
  let passkeyBlocked: string | null = null;
  if (passkeyReady === "missing")
    passkeyBlocked = CLI_AUTHORIZE_PASSKEY_MISSING;
  if (passkeyReady === "unsupported") {
    passkeyBlocked = CLI_AUTHORIZE_PASSKEY_UNSUPPORTED;
  }

  return (
    <>
      {row === undefined ? <output>Reading CLI request…</output> : null}
      {row === null ? <CliAuthorizeEmpty loadError={loadError} /> : null}
      {row ? (
        <p>
          <code className="identity-ref">{row[2]}</code>
        </p>
      ) : null}
      {row && passkeyBlocked ? (
        <>
          <FailureNotice
            id="cli-authorize:passkey"
            title="CLI"
            tone="warn"
            message={passkeyBlocked}
          />
          <output aria-live="polite">
            <StatusMark tone="warn" label={passkeyBlocked} />
          </output>
          <CliAuthorizeDeny busy={busy} onDeny={onDeny} />
        </>
      ) : null}
      {row && passkeyReady === "loading" ? (
        <CliAuthorizeDeny busy={busy} onDeny={onDeny} />
      ) : null}
      {row && passkeyReady === "ready" ? (
        <FormCommit
          label={CLI_AUTHORIZE_PASSKEY_NAME}
          disabled={busy}
          onClick={onPasskey}
        >
          <CliAuthorizeDeny busy={busy} onDeny={onDeny} />
        </FormCommit>
      ) : null}
      {mark && row ? (
        <output aria-live="polite">
          <StatusMark tone="err" label={mark} />
        </output>
      ) : null}
    </>
  );
}
