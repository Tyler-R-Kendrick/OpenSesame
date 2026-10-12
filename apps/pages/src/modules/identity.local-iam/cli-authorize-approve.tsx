import type { FormEvent } from "react";
import { FieldShell } from "../../components/FieldShell.js";
import { FormCommit } from "../../components/FormCommit.js";
import { IconKey } from "../../components/IconKey.js";
import { IconPasskey, IconX } from "../../components/Icons.js";
import { StatusMark } from "../../components/StatusMark.js";
import { useCliAuthorizeApproveState } from "./cli-authorize-approve-state.js";
import type { CliAuthorizeRow } from "./cli-authorize-mint-proof.js";

export type { CliAuthorizeRow };

type Props = Readonly<{
  row: CliAuthorizeRow;
  busy: boolean;
  onBusyChange: (busy: boolean) => void;
  onDone: () => void;
  onRespond: (
    decision: "approve" | "deny",
    humanProof?: string,
  ) => Promise<boolean>;
}>;

export function CliAuthorizeApprove(props: Props) {
  const { row, busy, onBusyChange, onDone, onRespond } = props;
  const state = useCliAuthorizeApproveState(
    row,
    busy,
    onBusyChange,
    onDone,
    onRespond,
  );

  if (!state.canPasskey && !state.canPin) {
    return (
      <section className="panel" aria-label="Authorize CLI">
        <div className="panel__head">
          <h1>Authorize CLI</h1>
        </div>
        <div className="panel__body">
          <p>Unlock with a PIN or passkey on this device first.</p>
        </div>
      </section>
    );
  }

  return (
    <section className="panel" aria-label="Authorize CLI">
      <div className="panel__head">
        <h1>Authorize CLI</h1>
        <IconKey label="Close" onClick={onDone} disabled={busy}>
          <IconX size={16} />
        </IconKey>
      </div>
      <div className="panel__body">
        <p>
          <code className="identity-ref">{row[2]}</code>
        </p>
        {state.pinOpen && state.canPin ? (
          <form onSubmit={(e: FormEvent) => void state.provePin(e)}>
            <FieldShell
              label="PIN"
              type="password"
              inputMode="numeric"
              autoComplete="off"
              placeholder="PIN"
              value={state.pin}
              disabled={busy}
              onValueChange={state.setPin}
              status={
                state.mark ? <StatusMark tone="err" label={state.mark} /> : null
              }
            />
            <FormCommit
              label="Authorize"
              disabled={busy || state.pin.length === 0}
              busy={busy}
            >
              {state.canPasskey ? (
                <IconKey
                  label="Passkey"
                  disabled={busy}
                  onClick={() => {
                    state.setPinOpen(false);
                    void state.provePasskey();
                  }}
                >
                  <IconPasskey size={16} />
                </IconKey>
              ) : null}
            </FormCommit>
          </form>
        ) : (
          <FormCommit
            label="Authorize"
            disabled={busy}
            onClick={() => {
              if (state.canPasskey) void state.provePasskey();
              else state.setPinOpen(true);
            }}
          >
            {state.canPin ? (
              <IconKey
                label="PIN"
                disabled={busy}
                onClick={() => state.setPinOpen(true)}
              >
                <IconPasskey size={16} />
              </IconKey>
            ) : null}
          </FormCommit>
        )}
        {state.mark && !state.pinOpen ? (
          <output aria-live="polite">
            <StatusMark tone="err" label={state.mark} />
          </output>
        ) : null}
      </div>
    </section>
  );
}
