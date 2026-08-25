import { type FormEvent, useCallback, useEffect, useId, useState } from "react";
import { IconCheck, IconExternal } from "../../components/Icons.js";
import type { Integration, Provider } from "../../lib/connections.js";
import {
  createIntegration,
  listIntegrations,
  startGithubAppRegistration,
  submitGithubAppManifest,
} from "../../lib/connections.js";
import { hostBase } from "../../lib/identity.js";
import { type Flash, errorText } from "./shared.js";

function usableFor(provider: Provider) {
  return (row: Integration) =>
    row.providerId === provider.id && row.enabled && row.configured;
}

export function callbackUrlFor(provider: Provider): string {
  return (
    provider.callbackUrl ??
    `${hostBase()}/api/v1/oauth/callback/${encodeURIComponent(provider.id)}`
  );
}

/**
 * Makes an OAuth connector configurable from this page. Until the Host has a
 * client for the provider — deployment env vars, a sealed org integration, or
 * (GitHub only) a one-click App registration — Authorize cannot work, so this
 * panel offers the two ways to create one. Client secrets are sealed by the
 * Host on arrival and never read back.
 */
export function OauthClientPanel({
  provider,
  online,
  onFlash,
  onClientState,
}: {
  provider: Provider;
  online: boolean;
  onFlash: (flash: Flash) => void;
  /** Reports whether a sealed org OAuth client exists for this provider. */
  onClientState: (hasClient: boolean) => void;
}) {
  const [integration, setIntegration] = useState<Integration | null>(null);
  const [busy, setBusy] = useState<"app" | "client" | null>(null);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const fieldId = useId();

  const refresh = useCallback(async () => {
    const rows = await listIntegrations().catch((): Integration[] => []);
    const found = rows.find(usableFor(provider)) ?? null;
    setIntegration(found);
    onClientState(found !== null);
  }, [provider, onClientState]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // GitHub App Manifest registration returns through ?github_app=….
  useEffect(() => {
    if (provider.id !== "github") return;
    const params = new URLSearchParams(window.location.search);
    const result = params.get("github_app");
    if (!result) return;
    const reason = params.get("reason");
    if (result === "registered") {
      onFlash({
        tone: "ok",
        text: "GitHub App registered for this organization. You can Authorize with GitHub now.",
      });
      void refresh();
    } else if (result === "error") {
      onFlash({
        tone: "err",
        text: `GitHub App registration failed${reason ? `: ${reason}` : ""}. Try again.`,
      });
    }
    params.delete("github_app");
    params.delete("reason");
    params.delete("integration");
    const next = `${window.location.pathname}${params.toString() ? `?${params}` : ""}${window.location.hash}`;
    window.history.replaceState({}, "", next);
  }, [provider.id, onFlash, refresh]);

  async function deployGithubApp() {
    setBusy("app");
    try {
      const registration = await startGithubAppRegistration({
        returnTo: `${window.location.origin}${window.location.pathname}`,
        displayName: `OpenSesame ${provider.displayName}`,
      });
      onFlash({ tone: "ok", text: "Sending you to GitHub to create the app…" });
      submitGithubAppManifest(registration);
      window.setTimeout(() => {
        setBusy(null);
        onFlash({
          tone: "err",
          text: "GitHub did not open. Hard-refresh so CSP allows form posts to github.com, then try again.",
        });
      }, 2500);
    } catch (error) {
      onFlash({ tone: "err", text: errorText(error) });
      setBusy(null);
    }
  }

  async function saveClient(event: FormEvent) {
    event.preventDefault();
    setBusy("client");
    try {
      const created = await createIntegration({
        key: `${provider.id}-oauth`,
        providerId: provider.id,
        displayName: `${provider.displayName} OAuth client`,
        clientId: clientId.trim(),
        clientSecret: clientSecret.trim(),
      });
      setClientId("");
      setClientSecret("");
      setIntegration(created);
      onFlash({
        tone: "ok",
        text: `${provider.displayName} OAuth client sealed on this Host. Authorize is ready.`,
      });
      onClientState(true);
    } catch (error) {
      onFlash({ tone: "err", text: errorText(error) });
    } finally {
      setBusy(null);
    }
  }

  async function copyCallback() {
    try {
      await navigator.clipboard.writeText(callbackUrlFor(provider));
      onFlash({ tone: "ok", text: "Callback URL copied." });
    } catch {
      onFlash({ tone: "err", text: "Could not copy. Select the URL instead." });
    }
  }

  if (provider.configured) {
    return (
      <p className="hint">
        This Host already has deployment {provider.displayName} OAuth
        credentials.
      </p>
    );
  }

  if (integration) {
    return (
      <p className="hint conn-client-ready">
        <IconCheck size={15} /> OAuth client ready ({integration.displayName}).
        Use Authorize below.
      </p>
    );
  }

  const form = (
    <form
      className="conn-client-form"
      onSubmit={(event) => void saveClient(event)}
    >
      <div className="field">
        <label className="label" htmlFor={`${fieldId}-id`}>
          Client ID
        </label>
        <input
          id={`${fieldId}-id`}
          value={clientId}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => setClientId(event.target.value)}
        />
      </div>
      <div className="field">
        <label className="label" htmlFor={`${fieldId}-secret`}>
          Client secret
        </label>
        <input
          id={`${fieldId}-secret`}
          type="password"
          autoComplete="off"
          placeholder="Paste client secret once"
          value={clientSecret}
          onChange={(event) => setClientSecret(event.target.value)}
        />
        <p className="hint">
          Sealed on the Host on arrival; never shown again and never sent to
          this browser.
        </p>
      </div>
      <div className="conn-callback">
        <span className="conn-callback__label">Callback URL</span>
        <code>{callbackUrlFor(provider)}</code>
        <button
          type="button"
          className="btn btn--sm btn--ghost"
          onClick={() => void copyCallback()}
        >
          Copy
        </button>
      </div>
      <p className="hint">
        Register this exact callback URL in the provider&rsquo;s app settings.
      </p>
      <div className="actions">
        <button
          type="submit"
          className="btn btn--sm"
          disabled={
            busy !== null ||
            !online ||
            clientId.trim() === "" ||
            clientSecret.trim() === ""
          }
        >
          {busy === "client" ? "Sealing…" : "Save OAuth client"}
        </button>
      </div>
    </form>
  );

  if (provider.id !== "github") {
    return (
      <div className="conn-client-setup">
        <p className="hint">
          This Host has no {provider.displayName} OAuth client yet. Create an
          OAuth app in the provider console, then save its credentials here once
          for the whole organization.
        </p>
        {form}
      </div>
    );
  }

  return (
    <div className="conn-client-setup">
      <p className="hint">
        OpenSesame creates a GitHub App for this organization — you only confirm
        it on GitHub. No client id or secret paste.
      </p>
      <div className="actions">
        <button
          type="button"
          className="btn btn--primary btn--sm"
          disabled={!online || busy !== null}
          onClick={() => void deployGithubApp()}
        >
          <IconExternal size={16} />
          {busy === "app"
            ? "Opening GitHub…"
            : "Create GitHub App for this organization"}
        </button>
      </div>
      <p className="hint">
        Continues in this tab on github.com — not a popup. After you confirm the
        app, GitHub returns you here.
      </p>
      <details className="conn-client-alt">
        <summary>Or use an existing OAuth app</summary>
        {form}
      </details>
    </div>
  );
}
