import { CliAuthorizeProofForm } from "./cli-authorize-proof-form.js";
import { CliAuthorizeProofUnavailable } from "./cli-authorize-proof-unavailable.js";
import type { CliAuthorizeRow } from "./cli-authorize-session.js";
import { useCliAuthorizeProofState } from "./use-cli-authorize-proof-state.js";

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
    return <CliAuthorizeProofUnavailable />;
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
