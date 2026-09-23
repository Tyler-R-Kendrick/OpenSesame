import type {
  Connection,
  Provider,
} from "@opensesame/app-core/lib/connections.js";
import {
  VERB_CHIP,
  VERB_LABEL,
  connectionVerb,
  providerVerb,
} from "@opensesame/app-core/lib/identity-graph.js";
import {
  STATUS_CHIP,
  type connectorCeremonyRoot,
  connectorPath,
  statusSentence,
} from "@opensesame/app-core/sections/connections/shared.js";
import { Link } from "react-router";
import {
  StatusMark,
  type StatusTone,
  statusTone,
} from "../../components/StatusMark.js";

export type ConnectorTitleStatus = { tone: StatusTone; label: string };

export function githubConnectorStatus(
  provider: Provider,
  connection: Connection | null,
  connections: Connection[],
  backupReady: boolean,
  localApp: boolean,
): ConnectorTitleStatus {
  if (provider.id === "github") {
    if (connection !== null && !backupReady) {
      return {
        tone: "warn",
        label: "Needs a backup repository",
      } satisfies ConnectorTitleStatus;
    }
    if (connection !== null) {
      return {
        tone: statusTone(VERB_CHIP[connectionVerb(connection.status)]),
        label: VERB_LABEL[connectionVerb(connection.status)],
      } satisfies ConnectorTitleStatus;
    }
    if (localApp || provider.configured) {
      return {
        tone: "ok",
        label: "GitHub App ready",
      } satisfies ConnectorTitleStatus;
    }
  }
  if (connections.length > 1 && !connection) {
    return {
      tone: "idle",
      label: `${connections.length} authorizations`,
    } satisfies ConnectorTitleStatus;
  }
  const verb = providerVerb(provider, connection);
  return {
    tone: statusTone(VERB_CHIP[verb]),
    label: VERB_LABEL[verb],
  } satisfies ConnectorTitleStatus;
}

export function AuthorizedAccount({
  connection,
  provider,
  ceremonyRoot,
}: {
  connection: Connection;
  provider: Provider | null;
  ceremonyRoot: ReturnType<typeof connectorCeremonyRoot>;
}) {
  const chip = STATUS_CHIP[connection.status];
  return (
    <li className="conn-service">
      <div className="conn-service__copy">
        <h3>{connection.displayName}</h3>
        <p>{statusSentence(connection, provider)}</p>
      </div>
      <div className="conn-service__actions">
        <StatusMark tone={statusTone(chip.tone)} label={chip.label} />
        <Link
          className="btn btn--sm"
          to={connectorPath(
            connection.providerId,
            connection.connectionId,
            ceremonyRoot,
          )}
          aria-label={`Settings for ${connection.displayName}`}
        >
          Open
        </Link>
      </div>
    </li>
  );
}
