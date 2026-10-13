import { Link } from "react-router";
import type { CliAuthorizeRow } from "./cli-authorize-mint-proof.js";
import type { CliAuthorizePanelHint } from "./cli-authorize-panel-model.js";

const DEVICES_CLI_PAIR = "/identity?view=devices#cli-terminal";

type Props = {
  row: CliAuthorizeRow | null | undefined;
  hint: CliAuthorizePanelHint;
};

export function CliAuthorizePanelHints({ row, hint }: Props) {
  if (row === undefined) {
    return <output>Reading CLI request…</output>;
  }
  if (row === null && hint === "unpaired") {
    return (
      <p>
        Pair this browser with the daemon under{" "}
        <Link to={DEVICES_CLI_PAIR}>Identity › Devices › Terminal CLI</Link>.
      </p>
    );
  }
  if (row === null && hint === "local-network-blocked") {
    return (
      <p>
        This origin cannot reach the local daemon. Open OpenSesame on loopback,
        or allow local network access in the browser, then pair under{" "}
        <Link to={DEVICES_CLI_PAIR}>Identity › Devices › Terminal CLI</Link>.
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
