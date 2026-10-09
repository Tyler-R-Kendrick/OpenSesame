import {
  linearActorCleanupPending,
  type readLinearConnector,
} from "@opensesame/app-core/lib/linear-connectors.js";
import type { readSelfHostedConnector } from "@opensesame/app-core/lib/self-hosted-connectors.js";
import type { Flash } from "@opensesame/app-core/sections/connections/shared.js";
import { IconRefresh, IconShield } from "../../../components/Icons.js";
import { StatusMark } from "../../../components/StatusMark.js";
import {
  LinearActorCleanup,
  LinearReconnectHint,
  linearReconnectActionTitle,
} from "./LinearRecoveryControls.js";
import { Facts } from "./fields.js";

type ActorProps = {
  actor: "app" | "user";
  connectorId: string;
  saved: NonNullable<ReturnType<typeof readSelfHostedConnector>>;
  authorization: ReturnType<typeof readLinearConnector>;
  busy: boolean;
  authorize: (actor: "app" | "user") => Promise<void>;
  onFlash: (flash: Flash) => void;
  onChanged: () => void;
};
function expirationLabel(expiresAt: number | null): string {
  return expiresAt
    ? new Date(expiresAt).toLocaleString()
    : "No expiry reported";
}
function LinearActorControls({
  actor,
  connectorId,
  saved,
  authorization,
  busy,
  authorize,
  onFlash,
  onChanged,
}: ActorProps) {
  const granted = authorization?.[actor];
  const action = `${granted ? "Reconnect" : "Authorize"} ${actor === "app" ? "application" : "user"}`;
  const unselected =
    saved.options[actor === "app" ? "appScopes" : "userScopes"].length === 0;
  if (unselected && linearActorCleanupPending(connectorId, actor))
    return (
      <LinearActorCleanup
        connectorId={connectorId}
        actor={actor}
        busy={busy}
        onFlash={onFlash}
        onChanged={onChanged}
      />
    );
  if (saved.state.method !== "oauth") return null;
  return (
    <>
      {actor === "app" ? (
        <LinearReconnectHint connectorId={connectorId} />
      ) : null}
      <button
        type="button"
        className="icon-btn icon-btn--sm"
        aria-label={action}
        title={
          actor === "app"
            ? linearReconnectActionTitle(connectorId, action)
            : action
        }
        disabled={busy}
        onClick={() => void authorize(actor)}
      >
        {granted ? <IconRefresh size={16} /> : <IconShield size={16} />}
      </button>
    </>
  );
}
function actorVisible(props: ActorProps): boolean {
  const { actor, saved, authorization, connectorId } = props;
  if (saved.state.method === "api-key") return actor === "app";
  return (
    !!authorization?.[actor] ||
    linearActorCleanupPending(connectorId, actor) ||
    (actor === "app" && !!authorization?.recovery) ||
    saved.options[actor === "app" ? "appScopes" : "userScopes"].length > 0
  );
}
function pendingLabel(props: ActorProps, title: string): string {
  const scopes =
    props.saved.options[props.actor === "app" ? "appScopes" : "userScopes"];
  return scopes.length === 0 &&
    linearActorCleanupPending(props.connectorId, props.actor)
    ? `${title} cleanup pending`
    : `${title} required`;
}
export function LinearActorSummary(props: ActorProps) {
  if (!actorVisible(props)) return null;
  const { actor, saved, authorization } = props;
  const granted = authorization?.[actor];
  const title =
    saved.state.method === "api-key"
      ? "API key"
      : actor === "app"
        ? "App authorization"
        : "User authorization";
  return (
    <section className="cx-block" aria-label={title}>
      <div className="panel__head">
        <h3>{title}</h3>
        <LinearActorControls {...props} />
      </div>
      {granted ? (
        <Facts
          rows={[
            ["Account", granted.accountLabel],
            ["Workspace", granted.workspaceName],
            ["Workspace ID", granted.workspaceId],
            [
              "Granted scopes",
              granted.grantedScopes.join(", ") ||
                "Key permissions managed in Linear",
            ],
            ["Expires", expirationLabel(granted.expiresAt)],
          ]}
        />
      ) : (
        <StatusMark tone="warn" label={pendingLabel(props, title)} />
      )}
      {granted?.needsReauth ? (
        <StatusMark tone="warn" label={`${title} needs reconnection`} />
      ) : null}
    </section>
  );
}
