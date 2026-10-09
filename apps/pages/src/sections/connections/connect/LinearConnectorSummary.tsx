import type { Connection } from "@opensesame/app-core/lib/connections.js";
import {
  beginLinearAuthorization,
  readLinearConnector,
} from "@opensesame/app-core/lib/linear-connectors.js";
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
import { LinearActions } from "./LinearActions.js";
import { LinearActorSummary } from "./LinearActorSummary.js";
import { LinearWebhookRetry } from "./LinearRecoveryControls.js";
import { LinearWebhookSummary } from "./LinearWebhookSummary.js";

function LinearSummaryHeader({
  active,
  confirming,
  busy,
  remove,
}: {
  active: boolean;
  confirming: boolean;
  busy: boolean;
  remove: () => Promise<void>;
}) {
  return (
    <>
      <div className="panel__head">
        <h2>
          <span className="cx-step">3</span>{" "}
          {active ? "Complete" : "Authorization"}
        </h2>
        <StatusMark
          tone={active ? "ok" : "warn"}
          label={
            active ? "Linear connected" : "Linear authorization incomplete"
          }
        />
        <button
          type="button"
          className={`icon-btn${confirming ? " is-armed" : ""}`}
          aria-label={
            confirming ? "Confirm remove connector" : "Remove connector"
          }
          title={
            confirming ? "Remove this local connector" : "Remove connector"
          }
          disabled={busy}
          onClick={() => void remove()}
        >
          <IconTrash size={16} />
        </button>
      </div>
    </>
  );
}

function useLinearSummaryActions(
  connectorId: string,
  onFlash: (flash: Flash) => void,
  onChanged: () => void,
) {
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);

  async function authorize(actor: "app" | "user") {
    setBusy(true);
    try {
      await beginLinearAuthorization(connectorId, actor);
    } catch (error) {
      onFlash({ tone: "err", text: errorText(error) });
    } finally {
      setBusy(false);
      onChanged();
    }
  }

  async function remove() {
    if (!confirming) {
      setConfirming(true);
      return;
    }
    setBusy(true);
    try {
      await revokeSelfHostedConnectorDurable(connectorId);
      onFlash({
        tone: "ok",
        text: "Linear connector removed from this device.",
      });
      onChanged();
    } catch (error) {
      onFlash({ tone: "err", text: errorText(error) });
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }

  return { busy, confirming, authorize, remove };
}

export function LinearConnectorSummary({
  connection,
  onFlash,
  onChanged,
}: {
  connection: Connection;
  onFlash: (flash: Flash) => void;
  onChanged: () => void;
}) {
  const saved = readSelfHostedConnector(connection.connectionId);
  const authorization = readLinearConnector(connection.connectionId);
  const { busy, confirming, authorize, remove } = useLinearSummaryActions(
    connection.connectionId,
    onFlash,
    onChanged,
  );
  if (!saved) return null;

  return (
    <section
      className="panel"
      id="complete"
      aria-label="Linear connection status"
    >
      <LinearSummaryHeader
        active={connection.status === "active"}
        confirming={confirming}
        busy={busy}
        remove={remove}
      />
      <div className="panel__body cx-form">
        <p>{connection.displayName}</p>
        {connection.statusDetail ? (
          <StatusMark tone="warn" label={connection.statusDetail} />
        ) : null}
        {(["app", "user"] as const).map((actor) => (
          <LinearActorSummary
            key={actor}
            actor={actor}
            connectorId={connection.connectionId}
            saved={saved}
            authorization={authorization}
            busy={busy}
            authorize={authorize}
            onFlash={onFlash}
            onChanged={onChanged}
          />
        ))}
        {authorization?.webhook ? (
          <LinearWebhookSummary
            connectorId={connection.connectionId}
            onFlash={onFlash}
          />
        ) : saved.options.webhookEnabled ? (
          <StatusMark tone="warn" label="Webhook registration incomplete" />
        ) : null}
        <LinearWebhookRetry
          connectorId={connection.connectionId}
          busy={busy}
          onFlash={onFlash}
          onChanged={onChanged}
        />
        {connection.status === "active" ? (
          <LinearActions
            connectorId={connection.connectionId}
            onFlash={onFlash}
            onChanged={onChanged}
          />
        ) : null}
      </div>
    </section>
  );
}
