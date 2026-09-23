/**
 * A capability family's connectors as live cards (ADR 0114).
 *
 * Every card can be taken to a configured state without leaving the step. A
 * connector that needs no account binds the moment it is chosen. One that
 * needs authorization opens its ceremony in a new tab — Connect's callback
 * posts `opensesame:connection` back to the opener and closes itself — and
 * the card observes that notification (and polls, in case the message is
 * lost) through the same `awaitConsent` the Connections page uses.
 */

import {
  type CapabilityId,
  capabilityDef,
  connectorLabel,
} from "@opensesame/app-core/lib/capabilities.js";
import {
  type Connection,
  authorizeConnection,
  awaitConsent,
  createConnection,
  listConnections,
  openConsentPopup,
} from "@opensesame/app-core/lib/connections.js";
import { useEffect, useState } from "react";
import { IconConnection } from "../../../components/Icons.js";
import { StatusMark } from "../../../components/StatusMark.js";
import { useCapabilityChoice } from "./shared.js";

type CardState =
  | { phase: "idle" }
  | { phase: "busy" }
  | { phase: "connected"; as?: string }
  | { phase: "error"; text: string };

/** The connect round trip: connection, authorize, popup, observe. */
function useConnectFlow(
  capability: CapabilityId,
  providerId: string,
  connection: Connection | undefined,
  choose: (providerId: string, connectionId?: string) => void,
): [CardState, () => Promise<void>] {
  const def = capabilityDef(capability);
  const [state, setState] = useState<CardState>({ phase: "idle" });
  const connect = async () => {
    setState({ phase: "busy" });
    const tab = openConsentPopup("about:blank");
    try {
      const scopes = def.authScopes?.(providerId);
      const live =
        connection && connection.status !== "revoked"
          ? connection
          : await createConnection({
              providerId,
              displayName: `${connectorLabel(providerId)} (${def.title.toLowerCase()})`,
              scopes,
            });
      const { authorizationUrl } = await authorizeConnection(
        live.connectionId,
        scopes,
      );
      if (tab) tab.location.href = authorizationUrl;
      else window.location.href = authorizationUrl;
      const outcome = await awaitConsent(live.connectionId, tab);
      if (outcome.result === "active") {
        choose(providerId, outcome.connection.connectionId);
        setState({
          phase: "connected",
          as: outcome.connection.accountLabel ?? undefined,
        });
      } else {
        setState({
          phase: "error",
          text:
            outcome.result === "failed"
              ? (outcome.connection.statusDetail ??
                "The provider refused authorization.")
              : "Consent was not finished — the tab closed first. Connect again when ready.",
        });
      }
    } catch (error) {
      tab?.close();
      setState({
        phase: "error",
        text:
          error instanceof Error
            ? error.message
            : "Could not authorize this connector.",
      });
    }
  };
  return [state, connect];
}

function ConnectorCard({
  capability,
  providerId,
  connection,
}: {
  capability: CapabilityId;
  providerId: string;
  connection: Connection | undefined;
}) {
  const def = capabilityDef(capability);
  const [binding, choose] = useCapabilityChoice(capability);
  const [state, connect] = useConnectFlow(
    capability,
    providerId,
    connection,
    choose,
  );
  const selected = binding.providerId === providerId;
  const needsAuth = def.requiresAuth(providerId);
  const active = connection?.status === "active";

  return (
    <li className={`xcard${selected ? " is-on" : ""}`}>
      <button
        type="button"
        className="xcard__pick"
        aria-pressed={selected}
        onClick={() => choose(providerId)}
      >
        <span className="xcard__name">{connectorLabel(providerId)}</span>
        <span className="xcard__kind">
          {needsAuth ? "account required" : "no account needed"}
        </span>
      </button>
      <span className="xcard__side">
        {!needsAuth ? (
          <StatusMark
            tone={selected ? "ok" : "idle"}
            label={selected ? "Ready" : "Instant"}
          />
        ) : active || state.phase === "connected" ? (
          <StatusMark
            tone="ok"
            label={
              state.phase === "connected" && state.as
                ? `Connected as ${state.as}`
                : "Connected"
            }
          />
        ) : (
          <button
            type="button"
            className="icon-btn"
            disabled={state.phase === "busy"}
            aria-busy={state.phase === "busy"}
            aria-label={
              state.phase === "busy"
                ? "Authorizing"
                : connection
                  ? `Reconnect ${connectorLabel(providerId)}`
                  : `Connect ${connectorLabel(providerId)}`
            }
            title={connection ? "Reconnect" : "Connect"}
            onClick={() => void connect()}
          >
            <IconConnection size={17} />
          </button>
        )}
      </span>
      {state.phase === "error" ? (
        <p className="xcard__note" role="alert">
          {state.text}
        </p>
      ) : null}
    </li>
  );
}

export function ConnectorCards({ id }: { id: CapabilityId }) {
  const def = capabilityDef(id);
  const [connections, setConnections] = useState<Connection[]>([]);

  useEffect(() => {
    let live = true;
    void listConnections()
      .then((rows) => {
        if (live) setConnections(rows);
      })
      .catch(() => {
        if (live) setConnections([]);
      });
    return () => {
      live = false;
    };
  }, []);

  return (
    <ul className="xcards" aria-label={def.title}>
      {def.connectorIds.map((providerId) => (
        <ConnectorCard
          key={providerId}
          capability={id}
          providerId={providerId}
          connection={connections.find(
            (row) => row.providerId === providerId && row.status === "active",
          )}
        />
      ))}
    </ul>
  );
}
