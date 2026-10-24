import type { FormEvent } from "react";
import { FailureNotice } from "../../components/FailureNotice.js";
import { FormCommit } from "../../components/FormCommit.js";
import { IconConnection } from "../../components/Icons.js";
import { StatusMark } from "../../components/StatusMark.js";
import { useCliAuthorizePairingForm } from "./cli-authorize-pairing-form-model.js";

function CliAuthorizePairingCodeField({
  code,
  busy,
  onCodeChange,
  onSubmit,
}: {
  code: string;
  busy: boolean;
  onCodeChange: (value: string) => void;
  onSubmit: (event: FormEvent) => void;
}) {
  return (
    <form className="plugin-tile__pair" onSubmit={onSubmit}>
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
          onChange={(event) => onCodeChange(event.target.value)}
        />
        <button
          type="submit"
          className="icon-btn"
          disabled={busy || code.trim() === ""}
          aria-busy={busy || undefined}
          aria-label="Pair with the daemon"
          title="Pair with the daemon"
        >
          <IconConnection size={16} />
        </button>
      </div>
    </form>
  );
}

function CliAuthorizePairingRegistrationStep({
  registrationCode,
  busy,
  onFinish,
}: {
  registrationCode: string;
  busy: boolean;
  onFinish: () => void;
}) {
  return (
    <output aria-live="polite">
      <p>
        Type <code className="identity-ref">{registrationCode}</code> into the
        terminal, then finish pairing here.
      </p>
      <FormCommit
        label="Finish pairing"
        disabled={busy}
        busy={busy}
        onClick={onFinish}
      />
    </output>
  );
}

export function CliAuthorizePairingForm({
  onPaired,
}: {
  onPaired: () => void;
}) {
  const flow = useCliAuthorizePairingForm(onPaired);

  return (
    <>
      {flow.localCliBlocked ? (
        <>
          <FailureNotice
            id="cli-authorize:site"
            title="CLI"
            tone="warn"
            message={flow.localCliBlockedMessage}
          />
          <output aria-live="polite">
            <StatusMark tone="warn" label={flow.localCliBlockedMessage} />
          </output>
        </>
      ) : (
        <CliAuthorizePairingCodeField
          code={flow.code}
          busy={flow.busy}
          onCodeChange={flow.setCode}
          onSubmit={(event) => void flow.onPair(event)}
        />
      )}
      {flow.registrationCode ? (
        <CliAuthorizePairingRegistrationStep
          registrationCode={flow.registrationCode}
          busy={flow.busy}
          onFinish={() => void flow.onFinishExchange()}
        />
      ) : null}
      {flow.mark ? (
        <output aria-live="polite">
          <StatusMark tone="err" label={flow.mark} />
        </output>
      ) : null}
    </>
  );
}
