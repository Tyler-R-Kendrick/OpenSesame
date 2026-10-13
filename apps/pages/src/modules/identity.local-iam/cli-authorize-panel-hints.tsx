import type { CliAuthorizeRow } from "./cli-authorize-mint-proof.js";
import { CliAuthorizePairingForm } from "./cli-authorize-pairing-form.js";
import type { CliAuthorizePanelHint } from "./cli-authorize-panel-model.js";

type Props = {
  row: CliAuthorizeRow | null | undefined;
  hint: CliAuthorizePanelHint;
  onPaired: () => void;
};

export function CliAuthorizePanelHints({ row, hint, onPaired }: Props) {
  if (row === undefined) {
    return <output>Reading CLI request…</output>;
  }
  if (row === null && hint === "unpaired") {
    return <CliAuthorizePairingForm onPaired={onPaired} />;
  }
  if (row === null && hint === "local-network-blocked") {
    return (
      <p>
        This origin cannot reach the local daemon. Open OpenSesame on loopback,
        or allow local network access in the browser, then pair here.
      </p>
    );
  }
  if (row === null && (hint === null || hint === "daemon-unreachable")) {
    return <p>No CLI request is waiting.</p>;
  }
  if (row) {
    return (
      <p>
        <code className="identity-ref">{row[2]}</code>
      </p>
    );
  }
  return null;
}
