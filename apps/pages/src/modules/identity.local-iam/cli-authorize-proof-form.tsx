import type { FormEvent } from "react";
import { FieldShell } from "../../components/FieldShell.js";
import { FormCommit } from "../../components/FormCommit.js";
import { IconKey } from "../../components/IconKey.js";
import { IconPasskey, IconX } from "../../components/Icons.js";
import { StatusMark } from "../../components/StatusMark.js";
import type { CliAuthorizeRow } from "./cli-authorize-session.js";
import { cliAuthorizeUi } from "./cli-authorize-ui.js";

const ui = cliAuthorizeUi;

type ProofMode = "pin" | "passkey";

type Props = Readonly<{
  row: CliAuthorizeRow;
  busy: boolean;
  proofMode: ProofMode;
  pin: string;
  mark: string | null;
  canPasskey: boolean;
  canPin: boolean;
  onClose: () => void;
  onPinChange: (value: string) => void;
  onSwitchMode: (mode: ProofMode) => void;
  onProvePasskey: () => void;
  onProvePin: (event: FormEvent) => void;
}>;

export function CliAuthorizeProofForm(props: Props) {
  const {
    row,
    busy,
    proofMode,
    pin,
    mark,
    canPasskey,
    canPin,
    onClose,
    onPinChange,
    onSwitchMode,
    onProvePasskey,
    onProvePin,
  } = props;

  return (
    <section className="panel" aria-label={ui.sheetTitle}>
      <div className="panel__head">
        <h1>{ui.sheetTitle}</h1>
        <IconKey label="Close" onClick={onClose} disabled={busy}>
          <IconX size={16} />
        </IconKey>
      </div>
      <div className="panel__body">
        <p>{ui.sheetLead}</p>
        <p>
          <code className="identity-ref">{row[2]}</code>
        </p>
        {proofMode === "pin" && canPin ? (
          <form onSubmit={(e) => void onProvePin(e)}>
            <FieldShell
              label={ui.confirmPin}
              type="password"
              inputMode="numeric"
              autoComplete="off"
              placeholder={ui.pinPlaceholder}
              value={pin}
              disabled={busy}
              onValueChange={onPinChange}
              status={mark ? <StatusMark tone="err" label={mark} /> : null}
            />
            <FormCommit
              label={ui.allowKey}
              disabled={busy || pin.length === 0}
              busy={busy}
            >
              {canPasskey ? (
                <IconKey
                  label={ui.confirmPasskey}
                  disabled={busy}
                  onClick={() => onSwitchMode("passkey")}
                >
                  <IconPasskey size={16} />
                </IconKey>
              ) : null}
            </FormCommit>
          </form>
        ) : null}
        {proofMode === "passkey" && canPasskey ? (
          <FormCommit
            label={ui.confirmPasskey}
            disabled={busy}
            onClick={onProvePasskey}
          >
            {canPin ? (
              <IconKey
                label={ui.confirmPin}
                disabled={busy}
                onClick={() => onSwitchMode("pin")}
              >
                <IconPasskey size={16} />
              </IconKey>
            ) : null}
          </FormCommit>
        ) : null}
        {mark && proofMode === "passkey" ? (
          <output aria-live="polite">
            <StatusMark tone="err" label={mark} />
          </output>
        ) : null}
      </div>
    </section>
  );
}
