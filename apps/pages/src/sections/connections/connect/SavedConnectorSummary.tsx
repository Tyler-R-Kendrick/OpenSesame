import type { Connection } from "@opensesame/app-core/lib/connections.js";
import {
  readSelfHostedConnector,
  revokeSelfHostedConnectorDurable,
} from "@opensesame/app-core/lib/self-hosted-connectors.js";
import {
  type Flash,
  errorText,
} from "@opensesame/app-core/sections/connections/shared.js";
import { useState } from "react";
import { IconTrash } from "../../../components/Icons.js";
import { StatusMark } from "../../../components/StatusMark.js";
import { LinearConnectorSummary } from "./LinearConnectorSummary.js";

type Props = {
  connection: Connection | null;
  onFlash: (flash: Flash) => void;
  onChanged: () => void;
};

export function SavedConnectorSummary(props: Props) {
  return props.connection?.providerId === "linear" ? (
    <LinearConnectorSummary {...props} connection={props.connection} />
  ) : (
    <ConfigurationSummary {...props} />
  );
}

function ConfigurationSummary({ connection, onFlash, onChanged }: Props) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const saved = connection
    ? readSelfHostedConnector(connection.connectionId)
    : null;
  async function remove() {
    if (!connection) return;
    if (!confirming) {
      setConfirming(true);
      return;
    }
    setBusy(true);
    try {
      await revokeSelfHostedConnectorDurable(connection.connectionId);
      onFlash({
        tone: "ok",
        text: `${connection.displayName} configuration was removed.`,
      });
      onChanged();
    } catch (error) {
      onFlash({ tone: "err", text: errorText(error) });
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }
  return (
    <section
      className={`panel${saved ? "" : " cx-pending-step"}`}
      id="complete"
      aria-label="Complete"
    >
      <div className="panel__head">
        <h2>
          <span className="cx-step">3</span> Complete
        </h2>
        {saved ? (
          <>
            <StatusMark tone="ok" label="Connector configuration saved" />
            <button
              type="button"
              className={`icon-btn${confirming ? " is-armed" : ""}`}
              aria-label={
                confirming ? "Confirm remove connector" : "Remove connector"
              }
              title={
                confirming
                  ? "Remove this local configuration"
                  : "Remove connector"
              }
              disabled={busy}
              onClick={() => void remove()}
            >
              <IconTrash size={16} />
            </button>
          </>
        ) : null}
      </div>
      {saved ? (
        <div className="panel__body">
          <p>{saved.state.name}</p>
          {saved.options.workspace ? <p>{saved.options.workspace}</p> : null}
          <StatusMark tone="warn" label="Provider authorization pending" />
        </div>
      ) : null}
    </section>
  );
}
