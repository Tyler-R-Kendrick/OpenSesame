/**
 * Multi-select history backups grouped into Git and PostgreSQL (ADR 0114).
 *
 * Git cards reuse Host OAuth when needed. PostgreSQL-family cards mint an
 * anon/agent account on select so sealed history persists before a guest claim.
 */

import { useEffect, useState } from "react";
import { capabilityDef, connectorLabel } from "../../../lib/capabilities.js";
import {
  type Connection,
  authorizeConnection,
  awaitConsent,
  createConnection,
  listConnections,
} from "../../../lib/connections.js";
import {
  HISTORY_BACKUP_GROUPS,
  type HistoryBackupSelection,
  bindHistoryConnection,
  historyProviderLabel,
  historyRequiresHostAuth,
  loadHistorySelections,
  toggleHistoryProvider,
} from "../../../lib/history-backups.js";
import { ensureHostSession } from "../../../lib/identity.js";
import { usePlaneStatus } from "../../../lib/planes.js";

type ConnectState =
  | { phase: "idle" }
  | { phase: "busy" }
  | { phase: "connected"; as?: string }
  | { phase: "error"; text: string };

function openCeremonyTab(url: string): Window | null {
  return window.open(url, "_blank");
}

function selectionFor(
  selections: HistoryBackupSelection[],
  providerId: string,
): HistoryBackupSelection | undefined {
  return selections.find((row) => row.providerId === providerId);
}

function BackupCard({
  providerId,
  groupId,
  selection,
  connection,
  hostLive,
  onChanged,
}: {
  providerId: string;
  groupId: "git" | "postgres";
  selection: HistoryBackupSelection | undefined;
  connection: Connection | undefined;
  hostLive: boolean;
  onChanged: () => void;
}) {
  const [state, setState] = useState<ConnectState>({ phase: "idle" });
  const selected = selection !== undefined;
  const needsAuth = historyRequiresHostAuth(providerId);
  const active = connection?.status === "active";

  const toggle = async () => {
    await toggleHistoryProvider(providerId);
    onChanged();
  };

  const connect = async () => {
    setState({ phase: "busy" });
    const tab = openCeremonyTab("about:blank");
    try {
      await ensureHostSession();
      const def = capabilityDef("history");
      const scopes = def.authScopes?.(providerId);
      const live =
        connection && connection.status !== "revoked"
          ? connection
          : await createConnection({
              providerId,
              displayName: `${connectorLabel(providerId)} (history)`,
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
        if (!selected) await toggleHistoryProvider(providerId);
        bindHistoryConnection(providerId, outcome.connection.connectionId);
        setState({
          phase: "connected",
          as: outcome.connection.accountLabel ?? undefined,
        });
        onChanged();
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

  const kind =
    groupId === "postgres"
      ? selected
        ? selection?.claimState === "claimed"
          ? "claimed anon account"
          : "anon · claimable"
        : "anon on select"
      : needsAuth
        ? "account required"
        : "no account needed";

  return (
    <li className={`xcard${selected ? " is-on" : ""}`}>
      <button
        type="button"
        className="xcard__pick"
        aria-pressed={selected}
        onClick={() => void toggle()}
      >
        <span className="xcard__name">{historyProviderLabel(providerId)}</span>
        <span className="xcard__kind">{kind}</span>
      </button>
      <span className="xcard__side">
        {groupId === "postgres" ? (
          <span className={`chip${selected ? " chip--ok" : ""}`}>
            {selected
              ? selection?.claimState === "claimed"
                ? "Claimed"
                : "Claimable"
              : "Off"}
          </span>
        ) : !needsAuth ? (
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

export function BackupGroups() {
  const planes = usePlaneStatus();
  const hostLive = planes.host === "live";
  const [selections, setSelections] = useState(() => loadHistorySelections());
  const [connections, setConnections] = useState<Connection[]>([]);

  const refresh = () => setSelections(loadHistorySelections());

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
    <div className="backup-groups">
      {HISTORY_BACKUP_GROUPS.map((group) => (
        <section
          key={group.id}
          className="setup__stack"
          aria-label={group.title}
        >
          <h3 className="setup__group-title">{group.title}</h3>
          <ul className="xcards" aria-label={group.title}>
            {group.providerIds.map((providerId) => (
              <BackupCard
                key={providerId}
                providerId={providerId}
                groupId={group.id}
                selection={selectionFor(selections, providerId)}
                connection={connections.find(
                  (row) =>
                    row.providerId === providerId && row.status === "active",
                )}
                hostLive={hostLive}
                onChanged={refresh}
              />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
