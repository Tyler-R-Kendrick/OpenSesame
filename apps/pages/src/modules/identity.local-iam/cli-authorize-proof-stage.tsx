import { CliAuthorizeProofForm } from "./cli-authorize-proof-form.js";
import type { CliAuthorizeRow } from "./cli-authorize-session.js";
import { cliAuthorizeUi } from "./cli-authorize-ui.js";
import { useCliAuthorizeProofState } from "./use-cli-authorize-proof-state.js";

const ui = cliAuthorizeUi;

type Props = Readonly<{
  row: CliAuthorizeRow;
  busy: boolean;
  onBusyChange: (busy: boolean) => void;
  onClose: () => void;
  onRespond: (
    decision: "approve" | "deny",
    humanProof?: string,
  ) => Promise<boolean>;
}>;

export function CliAuthorizeProofStage(props: Props) {
  const { row, busy, onBusyChange, onClose, onRespond } = props;
  const proof = useCliAuthorizeProofState(row, busy, onBusyChange, onRespond);

  if (!proof.canPasskey && !proof.canPin) {
    return (
      <section className="panel" aria-label={ui.sheetTitle}>
        <div className="panel__head">
          <h1>{ui.sheetTitle}</h1>
        </div>
        <div className="panel__body">
          <p>Unlock with a PIN or passkey on this device first.</p>
        </div>
      </section>
    );
  }

  return (
    <CliAuthorizeProofForm
      row={row}
      busy={busy}
      proofMode={proof.proofMode}
      pin={proof.pin}
      mark={proof.mark}
      canPasskey={proof.canPasskey}
      canPin={proof.canPin}
      onClose={onClose}
      onPinChange={proof.setPin}
      onSwitchMode={proof.setProofMode}
      onProvePasskey={() => void proof.provePasskey()}
      onProvePin={(e) => void proof.provePin(e)}
    />
  );
}
