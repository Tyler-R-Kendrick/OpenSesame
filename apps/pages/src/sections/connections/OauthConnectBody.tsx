import type { Provider } from "@opensesame/app-core/lib/connections.js";
import {
  readLocalGithubApp,
  subscribeLocalGithubApp,
} from "@opensesame/app-core/lib/github-app-manifest.js";
import type { Flash } from "@opensesame/app-core/sections/connections/shared.js";
import { type FormEvent, useState, useSyncExternalStore } from "react";
import { IconCheck, IconExternal } from "../../components/Icons.js";
import { PasskeyCeremonyNote } from "../../components/PasskeyCeremonyNote.js";
import { StatusMark } from "../../components/StatusMark.js";
import { OauthClientPanel } from "./OauthClientPanel.js";

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

function PatForm({
  provider,
  online,
  busy,
  keyId,
  apiKey,
  onApiKey,
  onSaveKey,
}: {
  provider: Provider;
  online: boolean;
  busy: boolean;
  keyId: string;
  apiKey: string;
  onApiKey: (value: string) => void;
  onSaveKey: (event: FormEvent) => Promise<void>;
}) {
  return (
    <form className="cap-pat" onSubmit={(event) => void onSaveKey(event)}>
      <div className="field">
        <label className="label" htmlFor={`${keyId}-pat`}>
          Or connect with a personal access token
        </label>
        <input
          id={`${keyId}-pat`}
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder={
            provider.id === "github"
              ? "ghp_… or github_pat_… (repo scope)"
              : provider.id === "bitbucket"
                ? "Bitbucket HTTP access token"
                : provider.id === "codeberg"
                  ? "Codeberg access token"
                  : provider.id === "origin"
                    ? "oit_… installation token"
                    : "glpat-…"
          }
          value={apiKey}
          onChange={(event) => onApiKey(event.target.value)}
        />
      </div>
      <div className="actions">
        <button
          type="submit"
          className="icon-btn icon-btn--sm"
          disabled={busy || !online || apiKey.trim() === ""}
          aria-label={
            busy ? "Saving" : `Connect ${provider.displayName} with token`
          }
          title={busy ? "Saving" : `Connect ${provider.displayName} with token`}
        >
          <IconCheck size={16} />
        </button>
      </div>
    </form>
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
      <div className="actions">
        <button
          type="submit"
          className="icon-btn icon-btn--sm"
          disabled={busy || !online || missingScope || !oauthReady}
          aria-label={
            busy
              ? "Waiting for consent"
              : `Authorize with ${provider.displayName}`
          }
          title={
            busy
              ? "Waiting for consent"
              : `Authorize with ${provider.displayName}`
          }
        >
          <IconExternal size={16} />
        </button>
      </div>
    </form>
  );
}

/** OAuth half of the connect form: client panel, scopes, Authorize, optional PAT. */
export function OauthConnectBody({
  provider,
  online,
  busy,
  name,
  nameId,
  keyId,
  apiKey,
  scopes,
  missingScope,
  onName,
  onApiKey,
  onToggleScope,
  onFlash,
  onConnectOauth,
  onSaveKey,
}: {
  provider: Provider;
  online: boolean;
  busy: boolean;
  name: string;
  nameId: string;
  keyId: string;
  apiKey: string;
  scopes: string[];
  missingScope: boolean;
  onName: (value: string) => void;
  onApiKey: (value: string) => void;
  onToggleScope: (scope: string) => void;
  onFlash: (flash: Flash) => void;
  onConnectOauth: (event: FormEvent) => Promise<void>;
  onSaveKey: (event: FormEvent) => Promise<void>;
}) {
  const acceptsPat =
    provider.id === "github" ||
    provider.id === "gitlab" ||
    provider.id === "bitbucket" ||
    provider.id === "codeberg" ||
    provider.id === "origin";
  const [hasClient, setHasClient] = useState(false);
  const localGithubApp = useSyncExternalStore(
    subscribeLocalGithubApp,
    readLocalGithubApp,
    () => null,
  );
  // PAT is a fallback when no App/OAuth client exists — never after one does.
  const oauthReady =
    provider.configured ||
    hasClient ||
    (provider.id === "github" && localGithubApp !== null);

  return (
    <div className="conn-tile__body">
      <OauthClientPanel
        provider={provider}
        online={online}
        onFlash={onFlash}
        onClientState={setHasClient}
      />
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
      {acceptsPat && !oauthReady ? (
        <PatForm
          provider={provider}
          online={online}
          busy={busy}
          keyId={keyId}
          apiKey={apiKey}
          onApiKey={onApiKey}
          onSaveKey={onSaveKey}
        />
      ) : null}
    </div>
  );
}
