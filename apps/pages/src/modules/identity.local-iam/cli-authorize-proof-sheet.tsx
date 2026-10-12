import type { FormEvent } from "react";
import { CeremonyShell } from "../../components/CeremonyShell.js";
import { FieldShell } from "../../components/FieldShell.js";
import { IconKey } from "../../components/IconKey.js";
import { IconPasskey, IconX } from "../../components/Icons.js";
import { StatusMark } from "../../components/StatusMark.js";
import type { CliAuthorizeRow } from "./cli-authorize-session.js";
import { cliAuthorizeUi } from "./cli-authorize-ui.js";

const ui = cliAuthorizeUi;

export type CliAuthorizeProofMode = "pin" | "passkey";

type Props = Readonly<{
  row: CliAuthorizeRow;
  mode: CliAuthorizeProofMode;
  busy: boolean;
  pin: string;
  mark: string | null;
  canPasskey: boolean;
  canPin: boolean;
  onClose: () => void;
  onPinChange: (value: string) => void;
  onProvePasskey: () => void;
  onProvePin: (event: FormEvent) => void;
  onSwitchMode: (mode: CliAuthorizeProofMode) => void;
}>;

export function CliAuthorizeProofSheet(props: Props) {
  const {
    row,
    mode,
    busy,
    pin,
    mark,
    canPasskey,
    canPin,
    onClose,
    onPinChange,
    onProvePasskey,
    onProvePin,
    onSwitchMode,
  } = props;

  const card =
    mode === "pin" && canPin ? (
      <form onSubmit={onProvePin}>
        <CeremonyShell
          name={ui.sheetTitle}
          facts={[{ key: "Request", value: row[2] }]}
          primary={{
            label: ui.allowKey,
            busy,
            disabled: busy || pin.length === 0,
            submit: true,
            onClick: () => undefined,
          }}
        >
          <p>{ui.sheetLead}</p>
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
          {canPasskey ? (
            <IconKey
              label={ui.confirmPasskey}
              disabled={busy}
              onClick={() => onSwitchMode("passkey")}
            >
              <IconPasskey size={16} />
            </IconKey>
          ) : null}
        </CeremonyShell>
      </form>
    ) : mode === "passkey" && canPasskey ? (
      <CeremonyShell
        name={ui.sheetTitle}
        facts={[{ key: "Request", value: row[2] }]}
        primary={{
          label: ui.confirmPasskey,
          icon: <IconPasskey size={18} />,
          busy,
          disabled: busy,
          onClick: onProvePasskey,
        }}
      >
        <p>{ui.sheetLead}</p>
        {canPin ? (
          <IconKey
            label={ui.confirmPin}
            disabled={busy}
            onClick={() => onSwitchMode("pin")}
          >
            <IconPasskey size={16} />
          </IconKey>
        ) : null}
        {mark ? (
          <output aria-live="polite">
            <StatusMark tone="err" label={mark} />
          </output>
        ) : null}
      </CeremonyShell>
    ) : null;

  return (
    <section className="panel" aria-label={ui.sheetTitle}>
      <div className="panel__head">
        <h1>{ui.sheetTitle}</h1>
        <IconKey label="Close" onClick={onClose} disabled={busy}>
          <IconX size={16} />
        </IconKey>
      </div>
      <div className="panel__body">{card}</div>
    </section>
  );
}
