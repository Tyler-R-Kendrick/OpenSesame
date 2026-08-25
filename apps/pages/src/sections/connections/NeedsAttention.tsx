import { useState } from "react";
import { Link } from "react-router";
import type { Connection, Provider } from "../../lib/connections.js";
import {
  authorizeConnection,
  awaitConsent,
  openConsentPopup,
} from "../../lib/connections.js";
import {
  VERB_CHIP,
  VERB_LABEL,
  connectionVerb,
  unfinishedConnections,
} from "../../lib/identity-graph.js";
import { ensureHostSession } from "../../lib/identity.js";
import { ConnectorMark } from "./ConnectorMark.js";
import {
  type Flash,
  connectorPath,
  errorText,
  statusSentence,
} from "./shared.js";

/** Connections that exist but cannot be used until the user acts. Finishing
 *  an authorization is the same consent round trip the connect form runs, so
 *  it runs here, where the problem is reported — never a navigation. */
export function NeedsAttention({
  connections,
  providers,
  onFlash,
  onChanged,
}: {
  connections: Connection[];
  providers: Provider[];
  onFlash: (flash: Flash | null) => void;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const open = unfinishedConnections(connections);
  if (open.length === 0) return null;

  async function finish(connection: Connection) {
    const popup = openConsentPopup("about:blank");
    setBusy(connection.connectionId);
    try {
      await ensureHostSession();
      const { authorizationUrl } = await authorizeConnection(
        connection.connectionId,
      );
      if (popup) popup.location.href = authorizationUrl;
      else window.location.href = authorizationUrl;
      const outcome = await awaitConsent(connection.connectionId, popup);
      if (outcome.result === "active") {
        onFlash({
          tone: "ok",
          text: `${connection.displayName} is authorized.`,
        });
      } else if (outcome.result === "failed") {
        onFlash({
          tone: "err",
          text:
            outcome.connection.statusDetail ??
            "The provider refused the authorization.",
        });
      } else {
        onFlash({ tone: "warn", text: "Authorization was not completed." });
      }
      onChanged();
    } catch (error) {
      popup?.close();
      onFlash({ tone: "err", text: errorText(error) });
    } finally {
      setBusy(null);
    }
  }

  return (
    <section
      className="panel panel--attention"
      aria-labelledby="conn-inbox-title"
    >
      <div className="panel__head">
        <h2 id="conn-inbox-title">Needs attention</h2>
      </div>
      <ul className="conn-list">
        {open.map((connection) => {
          const provider =
            providers.find((item) => item.id === connection.providerId) ?? null;
          const verb = connectionVerb(connection.status);
          return (
            <li key={connection.connectionId} className="conn-service">
              <ConnectorMark
                providerId={connection.providerId}
                displayName={connection.displayName}
              />
              <div className="conn-service__copy">
                <h3>{connection.displayName}</h3>
                <p>{statusSentence(connection, provider)}</p>
              </div>
              <div className="conn-service__actions">
                <span className={`chip ${VERB_CHIP[verb]}`}>
                  {VERB_LABEL[verb]}
                </span>
                <button
                  type="button"
                  className="btn btn--sm btn--primary"
                  disabled={busy !== null}
                  aria-busy={busy === connection.connectionId}
                  onClick={() => void finish(connection)}
                >
                  {busy === connection.connectionId
                    ? "Authorizing…"
                    : "Finish authorization"}
                </button>
                <Link
                  className="btn btn--sm btn--ghost"
                  to={connectorPath(
                    connection.providerId,
                    connection.connectionId,
                  )}
                >
                  Details
                </Link>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
