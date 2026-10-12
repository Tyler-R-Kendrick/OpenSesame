import { cliAppIntegrationAuthorizeUi } from "@opensesame/app-core/lib/cli-app-integration/policy-ui.js";
import { CliAuthorizeProofSheet } from "./cli-authorize-proof-sheet.js";
import type { CliAuthorizeRow } from "./cli-authorize-session.js";
import { useCliAuthorizeProof } from "./use-cli-authorize-proof.js";

const ui = cliAppIntegrationAuthorizeUi;

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

export function CliAuthorizeApproveFlow(props: Props) {
  const { row, busy, onBusyChange, onDone, onRespond } = props;
  const proof = useCliAuthorizeProof(
    row,
    busy,
    onBusyChange,
    onRespond,
    onDone,
  );

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
    <CliAuthorizeProofSheet
      row={row}
      mode={proof.proofMode}
      busy={busy}
      pin={proof.pin}
      mark={proof.mark}
      canPasskey={proof.canPasskey}
      canPin={proof.canPin}
      onClose={onDone}
      onPinChange={proof.setPin}
      onProvePasskey={() => void proof.proveWithPasskey()}
      onProvePin={(e) => void proof.proveWithPin(e)}
      onSwitchMode={proof.setProofMode}
    />
  );
}
