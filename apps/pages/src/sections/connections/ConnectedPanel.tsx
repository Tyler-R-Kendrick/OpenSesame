import type {
  Connection,
  Provider,
} from "@opensesame/app-core/lib/connections.js";
import {
  STATUS_CHIP,
  connectorPath,
  statusSentence,
} from "@opensesame/app-core/sections/connections/shared.js";
import { type ReactNode, useState, useTransition } from "react";
import { Link, useLocation } from "react-router";
import { EmptyTip } from "../../components/EmptyTip.js";
import { IconPlus, IconSettings } from "../../components/Icons.js";
import { StatusMark, statusTone } from "../../components/StatusMark.js";
import { useGuideTarget } from "../../tutorial/registry/react.jsx";
import { ConnectorMark } from "./ConnectorMark.js";
import { CONNECTIONS_PAGE_SIZE, nextPageCount } from "./page-cap.js";

function nothingConnected() {
  return (
    <div className="empty">
      <h3>Nothing connected</h3>
      <EmptyTip tip="rail" />
    </div>
  );
}

/** Live authorizations. First page matches the nav catalog cap. */
export function ConnectedPanel({
  connections,
  providers,
  loading,
  setupRequired,
  hostConfigured = false,
  tools,
  sheet,
  imported,
}: {
  connections: Connection[] | null;
  providers: Provider[];
  loading: boolean;
  setupRequired: boolean;
  /** Unconfigured Connect is empty, not a failed read (ADR 0090/0128). */
  hostConfigured?: boolean;
  /** Keys in the head beside the title (Import). */
  tools?: ReactNode;
  /** What those keys open, above the list. */
  sheet?: ReactNode;
  /** Connectors imported from a directory, listed after the live ones. */
  imported?: ReactNode;
}) {
  const panelRef = useGuideTarget<HTMLElement>("connections.connected");
  const [limit, setLimit] = useState(CONNECTIONS_PAGE_SIZE);
  const [pending, startTransition] = useTransition();
  const live = (connections ?? []).filter((c) => c.status !== "revoked");
  const shown = live.slice(0, limit);
  const more = nextPageCount(live.length, limit);

  return (
    <section id="connected" className="panel" ref={panelRef}>
      <div className="panel__head">
        <h2>Connected</h2>
        {tools ? <div className="vtree__keys">{tools}</div> : null}
      </div>
      <div className="panel__body panel__body--tight">
        {sheet}
        {connections !== null && live.length === 0 ? (
          imported ? null : (
            nothingConnected()
          )
        ) : setupRequired ? (
          <div className="empty conn-gate">
            <h3>Choose an organization</h3>
          </div>
        ) : connections === null ? (
          loading ? (
            <div className="conn-pad">
              <p className="hint">Reading connections…</p>
            </div>
          ) : hostConfigured ? (
            <div className="conn-pad">
              <p className="hint">Connections could not be read.</p>
            </div>
          ) : (
            nothingConnected()
          )
        ) : (
          <>
            <ul className="conn-list">
              {shown.map((connection) => (
                <AuthorizedConnection
                  key={connection.connectionId}
                  connection={connection}
                  provider={
                    providers.find((p) => p.id === connection.providerId) ??
                    null
                  }
                />
              ))}
            </ul>
            {more > 0 ? (
              <div className="conn-pad">
                <button
                  type="button"
                  className="icon-btn icon-btn--sm"
                  disabled={pending}
                  aria-label={
                    pending ? "Loading connections" : `Load ${more} more`
                  }
                  title={pending ? "Loading connections" : `Load ${more} more`}
                  onClick={() => {
                    if (pending) return;
                    startTransition(() => {
                      setLimit((previous) => previous + CONNECTIONS_PAGE_SIZE);
                    });
                  }}
                >
                  <IconPlus size={16} />
                </button>
              </div>
            ) : null}
          </>
        )}
        {imported}
      </div>
    </section>
  );
}

function AuthorizedConnection({
  connection,
  provider,
}: {
  connection: Connection;
  provider: Provider | null;
}) {
  const chip = STATUS_CHIP[connection.status];
  const { hash } = useLocation();
  return (
    <li
      className={`conn-service${hash === `#connected-${encodeURIComponent(connection.connectionId)}` ? " is-selected" : ""}`}
      id={`connected-${encodeURIComponent(connection.connectionId)}`}
    >
      <ConnectorMark
        providerId={connection.providerId}
        displayName={connection.displayName}
      />
      <div className="conn-service__copy">
        <h3>{connection.displayName}</h3>
        <p>{statusSentence(connection, provider)}</p>
      </div>
      <div className="conn-service__actions">
        <StatusMark tone={statusTone(chip.tone)} label={chip.label} />
        <Link
          className="btn btn--sm"
          to={connectorPath(connection.providerId, connection.connectionId)}
          aria-label={`Settings for ${connection.displayName}`}
        >
          <IconSettings size={16} /> Settings
        </Link>
      </div>
    </li>
  );
}
