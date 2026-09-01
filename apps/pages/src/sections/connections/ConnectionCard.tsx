import { useState } from "react";
import {
  IconClock,
  IconExternal,
  IconInfo,
  IconRefresh,
  IconTrash,
} from "../../components/Icons.js";
import type { Connection, Provider } from "../../lib/connections.js";
import {
  authorizeConnection,
  awaitConsent,
  openConsentPopup,
  refreshConnection,
  revokeConnection,
} from "../../lib/connections.js";
import { ensureHostSession } from "../../lib/identity.js";
import { useGuideTarget } from "../../tutorial/registry/react.jsx";
import { ActivityLog } from "./ActivityLog.js";
import { BindingEditor } from "./BindingEditor.js";
import {
  type Flash,
  STATUS_CHIP,
  errorText,
  formatWhen,
  statusSentence,
} from "./shared.js";

export function ConnectionCard({
  connection,
  provider,
  online,
  onFlash,
  onChanged,
  showBindings = true,
}: {
  connection: Connection;
  provider: Provider | null;
  online: boolean;
  onFlash: (flash: Flash) => void;
  onChanged: () => void;
  showBindings?: boolean;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [showActivity, setShowActivity] = useState(false);
  const renewRef = useGuideTarget<HTMLButtonElement>("connections.renew");
  const revokeRef = useGuideTarget<HTMLButtonElement>("connections.revoke");
  const chip = STATUS_CHIP[connection.status];
  const revoked = connection.status === "revoked";

  async function act(label: string, work: () => Promise<void>, done: string) {
    setBusy(label);
    try {
      await work();
      onFlash({ tone: "ok", text: done });
      onChanged();
    } catch (error) {
      onFlash({ tone: "err", text: errorText(error) });
    } finally {
      setBusy(null);
    }
  }

  async function reauthorize() {
    const popup = openConsentPopup("about:blank");
    setBusy("authorize");
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
          text: `${connection.displayName} is authorized again.`,
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

  async function revoke() {
    setBusy("revoke");
    try {
      const result = await revokeConnection(connection.connectionId);
      const upstream = result.providerRevocation;
      onFlash(
        upstream === "ok"
          ? { tone: "ok", text: `${connection.displayName} was revoked.` }
          : {
              tone: "warn",
              text: `${connection.displayName} was removed locally, but provider revocation was ${upstream}. Revoke it in the provider's security settings too.`,
            },
      );
      onChanged();
    } catch (error) {
      onFlash({ tone: "err", text: errorText(error) });
    } finally {
      setBusy(null);
    }
  }

  const scopes = connection.grantedScopes.length
    ? connection.grantedScopes
    : connection.requestedScopes;

  return (
    <li
      id={`connection-${connection.connectionId}`}
      className={`conn-card${revoked ? " is-revoked" : ""}`}
    >
      <div className="conn-card__top">
        <div className="conn-card__title">
          <h3>{connection.displayName}</h3>
          <p className="conn-card__ref">{connection.connectionRef}</p>
        </div>
        <div className="conn-card__chips">
          <span className={`chip ${chip.tone}`}>{chip.label}</span>
          {provider ? (
            <span className="chip">{provider.displayName}</span>
          ) : null}
        </div>
      </div>

      <p className="conn-card__status">
        {statusSentence(connection, provider)}
      </p>

      {scopes.length > 0 ? (
        <div className="conn-card__block">
          <p className="conn-card__label">Allowed to</p>
          <ul className="conn-scopes">
            {scopes.map((scope) => {
              const def = provider?.scopes.find((s) => s.name === scope);
              return (
                <li key={scope} title={def?.description ?? undefined}>
                  <code>{scope}</code>
                  {def ? <span>{def.description}</span> : null}
                  {def?.sensitive ? (
                    <span className="chip chip--warn chip--sm">broad</span>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      {connection.egress.authorities.length > 0 ? (
        <p className="conn-card__egress">
          <IconInfo size={15} />
          The credential is only ever attached to{" "}
          <code>{connection.egress.scheme}</code> requests to{" "}
          {connection.egress.authorities.map((authority, index) => (
            <span key={authority}>
              {index > 0 ? ", " : ""}
              <code>{authority}</code>
              {/* Glued to the host so the period cannot wrap onto its own line. */}
              {index === connection.egress.authorities.length - 1 ? "." : ""}
            </span>
          ))}{" "}
          Anywhere else, it is not sent.
        </p>
      ) : null}

      {revoked || !showBindings ? null : (
        <BindingEditor
          connection={connection}
          online={online}
          onFlash={onFlash}
          onChanged={onChanged}
        />
      )}

      <div className="conn-card__foot">
        <div className="actions">
          {revoked ? null : (
            <>
              {connection.status === "active" && connection.refreshable ? (
                <button
                  ref={renewRef}
                  type="button"
                  className="btn btn--sm"
                  disabled={busy !== null || !online}
                  onClick={() =>
                    void act(
                      "refresh",
                      () =>
                        refreshConnection(connection.connectionId).then(
                          () => undefined,
                        ),
                      `${connection.displayName} was renewed.`,
                    )
                  }
                >
                  <IconRefresh size={16} />
                  {busy === "refresh" ? "Renewing…" : "Renew now"}
                </button>
              ) : null}
              {provider?.authKind === "oauth2_authorization_code" ? (
                <button
                  type="button"
                  className={`btn btn--sm${
                    connection.status === "active" ? "" : " btn--primary"
                  }`}
                  disabled={busy !== null || !online}
                  onClick={() => void reauthorize()}
                >
                  <IconExternal size={16} />
                  {busy === "authorize"
                    ? "Waiting for consent…"
                    : connection.status === "pending"
                      ? "Authorize"
                      : "Re-authorize"}
                </button>
              ) : null}
            </>
          )}
          <button
            type="button"
            className="btn btn--sm btn--ghost"
            onClick={() => setShowActivity((on) => !on)}
          >
            <IconClock size={16} />
            {showActivity ? "Hide history" : "History"}
          </button>
          {revoked ? null : (
            <button
              ref={revokeRef}
              type="button"
              className="btn btn--sm btn--danger"
              disabled={busy !== null || !online}
              onClick={() => setConfirming(true)}
            >
              <IconTrash size={16} />
              Revoke
            </button>
          )}
        </div>
        <p className="conn-card__meta">
          Authorized {formatWhen(connection.createdAt)}
          {connection.lastRefreshedAt
            ? ` · renewed ${formatWhen(connection.lastRefreshedAt)}`
            : ""}
        </p>
      </div>

      {confirming ? (
        <div className="conn-confirm">
          <p>
            Revoking cuts off every project and agent bound to{" "}
            <strong>{connection.displayName}</strong> at once, and asks the
            provider to invalidate the token. Reconnecting means approving it
            again.
          </p>
          <div className="actions">
            <button
              type="button"
              className="btn btn--sm btn--danger"
              disabled={busy !== null}
              onClick={() => {
                setConfirming(false);
                void revoke();
              }}
            >
              Revoke it
            </button>
            <button
              type="button"
              className="btn btn--sm"
              onClick={() => setConfirming(false)}
            >
              Keep it
            </button>
          </div>
        </div>
      ) : null}

      {showActivity ? (
        <ActivityLog connectionId={connection.connectionId} />
      ) : null}
    </li>
  );
}
