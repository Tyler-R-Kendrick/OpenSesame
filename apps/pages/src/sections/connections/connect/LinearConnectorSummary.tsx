import type { Connection } from "@opensesame/app-core/lib/connections.js";
import {
  type LinearAuthorizationReservation,
  reserveLinearAuthorizationWindow,
} from "@opensesame/app-core/lib/linear-auth-reservation.js";
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
import { LinearCancelSignIn } from "./LinearCancelSignIn.js";
import { LinearWebhookRetry } from "./LinearRecoveryControls.js";
import { LinearWebhookSummary } from "./LinearWebhookSummary.js";
import { linearAuthorization } from "./linear-authorization-ui.js";
import type { NativeAuthorizationSink } from "./native-connector-controller.js";

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

type LinearSummaryProps = {
  connection: Connection;
  onFlash: (flash: Flash) => void;
  onChanged: () => void;
  onAuthorization?: NativeAuthorizationSink;
  captureUiCurrent?: () => () => boolean;
};

function useLinearSummaryActions(props: LinearSummaryProps) {
  const {
    connection: { connectionId: connectorId },
    onFlash,
    onChanged,
  } = props;
  const [removing, setRemoving] = useState(false);
  const [pending, setPending] = useState<(() => boolean) | null>(null);
  const [confirming, setConfirming] = useState(false);
  const authorizing = !!pending?.();
  const busy = removing || authorizing;

  async function authorize(actor: "app" | "user") {
    if (busy) return;
    const current = props.captureUiCurrent?.() ?? (() => true);
    if (!current()) return;
    const authorization = linearAuthorization(
      connectorId,
      props.onAuthorization,
    );
    let reservation: LinearAuthorizationReservation | undefined;
    setPending(() => current);
    try {
      reservation = reserveLinearAuthorizationWindow();
      const assertCurrent = authorization.reserve(reservation);
      authorization.bind(connectorId);
      await beginLinearAuthorization(connectorId, actor, {
        ...reservation,
        assertCurrent,
      });
    } catch (error) {
      if (current()) onFlash({ tone: "err", text: errorText(error) });
    } finally {
      try {
        authorization.finish();
      } finally {
        reservation?.release();
      }
      if (current()) {
        setPending(null);
        onChanged();
      }
    }
  }

  async function remove() {
    if (!confirming) {
      setConfirming(true);
      return;
    }
    setRemoving(true);
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
      setRemoving(false);
      setConfirming(false);
    }
  }

  return { busy, authorizing, confirming, authorize, remove };
}

export function LinearConnectorSummary(props: LinearSummaryProps) {
  const { connection, onFlash, onChanged } = props;
  const saved = readSelfHostedConnector(connection.connectionId);
  const authorization = readLinearConnector(connection.connectionId);
  const { busy, authorizing, confirming, authorize, remove } =
    useLinearSummaryActions(props);
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
        {props.onAuthorization ? null : (
          <LinearCancelSignIn authorizing={authorizing} />
        )}
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
