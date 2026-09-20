import { useState } from "react";
import {
  IconExternal,
  IconInfo,
  IconTrash,
  IconX,
} from "../../components/Icons.js";
import { StatusMark, statusTone } from "../../components/StatusMark.js";
import type { Connection, Provider } from "../../lib/connections.js";
import {
  authorizeConnection,
  awaitConsent,
  openConsentPopup,
  revokeConnection,
} from "../../lib/connections.js";
import { useGuideTarget } from "../../tutorial/registry/react.jsx";
import { isLocalGitRemoteId } from "../../lib/git-remote-local.js";
import { GithubBackupField } from "./GithubBackupRepo.js";
import { GithubCardDetails } from "./GithubInstallationPanel.js";
import {
  type Flash,
  STATUS_CHIP,
  errorText,
  formatWhen,
  statusSentence,
} from "./shared.js";

function ignoreBackupReady(_ready: boolean): void {}

export function ConnectionCard({
  connection,
  provider,
  online,
  onFlash,
  onChanged,
  onBackupReady,
}: {
  connection: Connection;
  provider: Provider | null;
  online: boolean;
  onFlash: (flash: Flash) => void;
  onChanged: () => void;
  onBackupReady?: (ready: boolean) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const revokeRef = useGuideTarget<HTMLButtonElement>("connections.revoke");
  const chip = STATUS_CHIP[connection.status];
  const revoked = connection.status === "revoked";
  const localGit = isLocalGitRemoteId(connection.connectionId);
  const authorizeLabel =
    busy === "authorize"
      ? "Waiting for consent"
      : connection.status === "pending"
        ? "Authorize"
        : "Re-authorize";

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
          {provider?.id === "github" ? (
            <GithubBackupField
              connection={connection}
              online={online}
              onFlash={onFlash}
              onReady={onBackupReady ?? ignoreBackupReady}
            />
          ) : null}
          <p className="conn-card__ref">{connection.connectionRef}</p>
        </div>
        <div className="conn-card__chips">
          <StatusMark tone={statusTone(chip.tone)} label={chip.label} />
          {provider ? (
            <span className="chip">{provider.displayName}</span>
          ) : null}
        </div>
      </div>

      <p className="conn-card__status">
        {statusSentence(connection, provider)}
      </p>

      {provider?.id === "github" ? (
        <GithubCardDetails connection={connection} />
      ) : null}

      {provider?.id === "github" || scopes.length === 0 ? null : (
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
                    <StatusMark tone="warn" label="Broad" />
                  ) : null}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {provider?.id === "github" ||
      connection.egress.authorities.length === 0 ? null : (
        <p className="conn-card__egress">
          <IconInfo size={15} />
          The credential is only ever attached to{" "}
          <code>{connection.egress.scheme}</code> requests to{" "}
          {connection.egress.authorities.map((authority, index) => (
            <span key={authority}>
              {index > 0 ? ", " : ""}
              <code>{authority}</code>
              {/* Glued to the authority so the period cannot wrap onto its own line. */}
              {index === connection.egress.authorities.length - 1 ? "." : ""}
            </span>
          ))}{" "}
          Anywhere else, it is not sent.
        </p>
      )}

      <div className="conn-card__foot">
        <div className="actions">
          {revoked ? null : (
            <>
              {provider?.authKind === "oauth2_authorization_code" ? (
                <button
                  type="button"
                  className="icon-btn icon-btn--sm"
                  disabled={busy !== null || !online}
                  aria-label={authorizeLabel}
                  title={authorizeLabel}
                  onClick={() => void reauthorize()}
                >
                  <IconExternal size={16} />
                </button>
              ) : null}
            </>
          )}
          {revoked ? null : (
            <button
              ref={revokeRef}
              type="button"
              className={`icon-btn icon-btn--sm icon-btn--danger${
                confirming ? " is-armed" : ""
              }`}
              disabled={busy !== null || (!online && !localGit)}
              aria-label={confirming ? "Revoke it" : "Revoke"}
              title={
                confirming
                  ? `Revoke ${connection.displayName}. Bindings to it stop.`
                  : "Revoke"
              }
              onClick={() => {
                if (!confirming) {
                  setConfirming(true);
                  return;
                }
                setConfirming(false);
                void revoke();
              }}
            >
              <IconTrash size={16} />
            </button>
          )}
          {confirming ? (
            <button
              type="button"
              className="icon-btn icon-btn--sm"
              aria-label="Keep it"
              title="Keep it"
              onClick={() => setConfirming(false)}
            >
              <IconX size={16} />
            </button>
          ) : null}
        </div>
        <p className="conn-card__meta">
          {confirming
            ? `Revoke ${connection.displayName}. Bindings to it stop.`
            : `Authorized ${formatWhen(connection.createdAt)}${
                connection.lastRefreshedAt
                  ? ` · renewed ${formatWhen(connection.lastRefreshedAt)}`
                  : ""
              }`}
        </p>
      </div>
    </li>
  );
}
