import type { FormRoad } from "@opensesame/app-core/lib/connect-roads.js";
import type { Provider } from "@opensesame/app-core/lib/connections.js";
import {
  readLocalGithubApp,
  subscribeLocalGithubApp,
} from "@opensesame/app-core/lib/github-app-manifest.js";
import type { Flash } from "@opensesame/app-core/sections/connections/shared.js";
import { type FormEvent, useSyncExternalStore } from "react";
import { FormCommit } from "../../components/FormCommit.js";
import { IconExternal } from "../../components/Icons.js";
import { PasskeyCeremonyNote } from "../../components/PasskeyCeremonyNote.js";
import { StatusMark } from "../../components/StatusMark.js";
import { GithubAppRegistrationPanel } from "./GithubAppRegistrationPanel.js";

function ScopePicker({
  provider,
  scopes,
  onToggleScope,
}: {
  provider: Provider;
  scopes: string[];
  onToggleScope: (scope: string) => void;
}) {
  if (provider.scopes.length === 0) return null;
  return (
    <fieldset className="conn-scope-picker">
      <legend className="label">Ask for</legend>
      {provider.scopes.map((scope) => (
        <label className="check" key={scope.name}>
          <input
            type="checkbox"
            checked={scopes.includes(scope.name)}
            onChange={() => onToggleScope(scope.name)}
          />
          <span>
            <code>{scope.name}</code>
            {scope.sensitive ? <StatusMark tone="warn" label="Broad" /> : null}
            <span className="hint">{scope.description}</span>
          </span>
        </label>
      ))}
    </fieldset>
  );
}

function AuthorizeForm({
  provider,
  online,
  busy,
  name,
  nameId,
  scopes,
  missingScope,
  oauthReady,
  onName,
  onToggleScope,
  onConnectOauth,
}: {
  provider: Provider;
  online: boolean;
  busy: boolean;
  name: string;
  nameId: string;
  scopes: string[];
  missingScope: boolean;
  oauthReady: boolean;
  onName: (value: string) => void;
  onToggleScope: (scope: string) => void;
  onConnectOauth: (event: FormEvent) => Promise<void>;
}) {
  return (
    <form onSubmit={(event) => void onConnectOauth(event)}>
      <PasskeyCeremonyNote />
      {oauthReady ? null : (
        <details className="conn-client-alt">
          <summary>Optional settings</summary>
          <div className="field">
            <label className="label" htmlFor={nameId}>
              Name it (optional)
            </label>
            <input
              id={nameId}
              value={name}
              onChange={(event) => onName(event.target.value)}
            />
          </div>
        </details>
      )}
      <ScopePicker
        provider={provider}
        scopes={scopes}
        onToggleScope={onToggleScope}
      />
      <FormCommit
        label={
          busy
            ? "Waiting for consent"
            : `Authorize with ${provider.displayName}`
        }
        disabled={busy || !online || missingScope || !oauthReady}
        icon={<IconExternal size={18} />}
      />
    </form>
  );
}

/**
 * OAuth half of the connect form: GitHub's own App registration, then scopes
 * and Authorize on Connect. With no road open only what the browser does
 * alone is drawn.
 */
export function OauthConnectBody({
  provider,
  online,
  busy,
  road,
  name,
  nameId,
  scopes,
  missingScope,
  onName,
  onToggleScope,
  onFlash,
  onConnectOauth,
}: {
  provider: Provider;
  online: boolean;
  busy: boolean;
  /**
   * The road Authorize runs on; null when none is open, and only what the
   * browser does alone is drawn.
   */
  road: FormRoad | null;
  name: string;
  nameId: string;
  scopes: string[];
  missingScope: boolean;
  onName: (value: string) => void;
  onToggleScope: (scope: string) => void;
  onFlash: (flash: Flash) => void;
  onConnectOauth: (event: FormEvent) => Promise<void>;
}) {
  const localGithubApp = useSyncExternalStore(
    subscribeLocalGithubApp,
    readLocalGithubApp,
    () => null,
  );
  const oauthReady =
    provider.configured ||
    (provider.id === "github" && localGithubApp !== null);

  return (
    <div className="conn-tile__body">
      <GithubAppRegistrationPanel
        provider={provider}
        online={online}
        onFlash={onFlash}
      />
      {road === null ? null : (
        <AuthorizeForm
          provider={provider}
          online={online}
          busy={busy}
          name={name}
          nameId={nameId}
          scopes={scopes}
          missingScope={missingScope}
          oauthReady={oauthReady}
          onName={onName}
          onToggleScope={onToggleScope}
          onConnectOauth={onConnectOauth}
        />
      )}
    </div>
  );
}
