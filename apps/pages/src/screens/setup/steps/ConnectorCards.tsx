/**
 * A capability family's connectors as live cards (ADR 0114).
 *
 * Nango-style: every card can be taken to a configured state without leaving
 * the step. A connector that needs no account binds the moment it is chosen.
 * One that needs authorization opens its ceremony in a NEW TAB — the Host's
 * callback page posts `opensesame:connection` back to the opener and closes
 * itself — and the card observes that notification (and polls, in case the
 * message is lost) through the same `awaitConsent` the Connections page uses,
 * flipping to Connected when the connection is established.
 *
 * Where no Host answers, nothing pretends: the card says so and the action is
 * withheld, because a button that can only fail is a lie about the road.
 */

import { useEffect, useState } from "react";
import {
  type CapabilityId,
  capabilityDef,
  connectorLabel,
} from "../../../lib/capabilities.js";
import {
  type Connection,
  authorizeConnection,
  awaitConsent,
  createConnection,
  listConnections,
} from "../../../lib/connections.js";
import { ensureHostSession } from "../../../lib/identity.js";
import { usePlaneStatus } from "../../../lib/planes.js";
import { useCapabilityChoice } from "./shared.js";

type CardState =
  | { phase: "idle" }
  | { phase: "busy" }
  | { phase: "connected"; as?: string }
  | { phase: "error"; text: string };

/** Open the ceremony in a new tab — the opener link stays, so the Host's
 * callback can post the event notification back and close itself. */
function openCeremonyTab(url: string): Window | null {
  return window.open(url, "_blank");
}

/** The connect round trip: session, connection, authorize, new tab, observe. */
function useConnectFlow(
  capability: CapabilityId,
  providerId: string,
  connection: Connection | undefined,
  choose: (providerId: string) => void,
): [CardState, () => Promise<void>] {
  const def = capabilityDef(capability);
  const [state, setState] = useState<CardState>({ phase: "idle" });
  const connect = async () => {
    setState({ phase: "busy" });
    const tab = openCeremonyTab("about:blank");
    try {
      await ensureHostSession();
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
        choose(providerId);
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
  hostLive,
}: {
  capability: CapabilityId;
  providerId: string;
  connection: Connection | undefined;
  hostLive: boolean;
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
          <span className={`chip${selected ? " chip--ok" : ""}`}>
            {selected ? "Ready" : "Instant"}
          </span>
        ) : active || state.phase === "connected" ? (
          <span className="chip chip--ok">
            Connected
            {state.phase === "connected" && state.as ? ` as ${state.as}` : ""}
          </span>
        ) : !hostLive ? (
          <span className="chip chip--warn">Needs a Host</span>
        ) : (
          <button
            type="button"
            className="btn btn--sm"
            disabled={state.phase === "busy"}
            aria-busy={state.phase === "busy"}
            onClick={() => void connect()}
          >
            {state.phase === "busy"
              ? "Authorizing…"
              : connection
                ? "Reconnect"
                : "Connect"}
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
  const planes = usePlaneStatus();
  const [connections, setConnections] = useState<Connection[]>([]);
  const hostLive = planes.host === "live";

  useEffect(() => {
    if (!hostLive) {
      setConnections([]);
      return;
    }
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
  }, [hostLive]);

  return (
    <>
      <ul className="xcards" aria-label={def.title}>
        {def.connectorIds.map((providerId) => (
          <ConnectorCard
            key={providerId}
            capability={id}
            providerId={providerId}
            connection={connections.find(
              (row) => row.providerId === providerId && row.status === "active",
            )}
            hostLive={hostLive}
          />
        ))}
      </ul>
      {!hostLive ? (
        <p className="hint">
          Authorization talks to the Host. Name one in Settings › Endpoints —
          every choice here is already saved.
        </p>
      ) : null}
    </>
  );
}
