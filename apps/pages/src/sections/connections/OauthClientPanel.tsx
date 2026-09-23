import type {
  Integration,
  Provider,
} from "@opensesame/app-core/lib/connections.js";
import {
  createIntegration,
  listIntegrations,
} from "@opensesame/app-core/lib/connections.js";
import {
  claimGithubAppCode,
  readLocalGithubApp,
  refreshGithubAppInstallations,
  subscribeLocalGithubApp,
} from "@opensesame/app-core/lib/github-app-manifest.js";
import {
  type Flash,
  errorText,
} from "@opensesame/app-core/sections/connections/shared.js";
import {
  type FormEvent,
  useCallback,
  useEffect,
  useId,
  useState,
  useSyncExternalStore,
} from "react";
import { IconCheck, IconCopy, IconExternal } from "../../components/Icons.js";
import { useGithubAppRegistration } from "./useGithubAppRegistration.js";

function usableFor(provider: Provider) {
  return (row: Integration) =>
    row.providerId === provider.id && row.enabled && row.configured;
}

export function callbackUrlFor(provider: Provider): string {
  if (provider.callbackUrl) return provider.callbackUrl;
  const origin = window.location.origin;
  return `${origin}/api/v1/oauth/callback/${encodeURIComponent(provider.id)}`;
}

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
  const deployGithubApp = useGithubAppRegistration(provider, onFlash, setBusy);
  const localGithubApp = useSyncExternalStore(
    subscribeLocalGithubApp,
    readLocalGithubApp,
    () => null,
  );

  const refresh = useCallback(async () => {
    const rows = await listIntegrations().catch((): Integration[] => []);
    const found = rows.find(usableFor(provider)) ?? null;
    setIntegration(found);
    const localReady =
      provider.id === "github" && readLocalGithubApp() !== null;
    onClientState(found !== null || localReady || provider.configured);
  }, [provider, onClientState]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // GitHub App Manifest registration returns through ?github_app=….
  useEffect(() => {
    if (provider.id !== "github") return;
    const params = new URLSearchParams(window.location.search);
    const result = params.get("github_app");
    const reason = params.get("reason");
    // Relay renames GitHub's code/state so OIDC sign-in does not steal them.
    const code = params.get("github_app_code") ?? params.get("code");
    const state = params.get("github_app_state") ?? params.get("state");
    if (code && state) {
      void claimGithubAppCode(code, state).then((outcome) => {
        params.delete("code");
        params.delete("state");
        params.delete("github_app_code");
        params.delete("github_app_state");
        params.delete("github_app");
        params.delete("reason");
        params.delete("integration");
        const next = `${window.location.pathname}${params.toString() ? `?${params}` : ""}${window.location.hash}`;
        window.history.replaceState({}, "", next);
        if (outcome === "registered") {
          onFlash({ tone: "ok", text: "GitHub App registered." });
          void refresh();
          void refreshGithubAppInstallations();
        } else if (outcome === "failed") {
          onFlash({ tone: "err", text: "GitHub App registration failed." });
        }
        // "ignored" = not our ceremony (or already claimed) — leave the page alone.
      });
      return;
    }
    if (result === "claim") {
      // Relay stamp without a code — nothing to claim; drop the marker.
      params.delete("github_app");
      const next = `${window.location.pathname}${params.toString() ? `?${params}` : ""}${window.location.hash}`;
      window.history.replaceState({}, "", next);
      return;
    }
    if (!result) return;
    if (result === "registered" || result === "installed") {
      onFlash({ tone: "ok", text: "GitHub App registered." });
      void refresh();
      void refreshGithubAppInstallations();
    } else if (result === "error") {
      onFlash({
        tone: "err",
        text: reason
          ? `GitHub App registration failed: ${reason}`
          : "GitHub App registration failed.",
      });
    }
    params.delete("github_app");
    params.delete("reason");
    params.delete("integration");
    const next = `${window.location.pathname}${params.toString() ? `?${params}` : ""}${window.location.hash}`;
    window.history.replaceState({}, "", next);
  }, [provider.id, onFlash, refresh]);

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
        text: `${provider.displayName} OAuth client saved.`,
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

  // Already sealed: App presence lives in GithubAppPresence. Do not re-draw
  // Create App, Client ID/secret, Install-on-account, or any other setup chrome.
  if (
    provider.configured ||
    integration !== null ||
    (provider.id === "github" && localGithubApp !== null)
  ) {
    return null;
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
      </div>
      <div className="conn-callback">
        <span className="conn-callback__label">Callback URL</span>
        <code>{callbackUrlFor(provider)}</code>
        <button
          type="button"
          className="icon-btn icon-btn--sm"
          aria-label="Copy callback URL"
          title="Copy callback URL"
          onClick={() => void copyCallback()}
        >
          <IconCopy size={16} />
        </button>
      </div>
      <div className="actions">
        <button
          type="submit"
          className="icon-btn icon-btn--sm"
          disabled={
            busy !== null ||
            !online ||
            clientId.trim() === "" ||
            clientSecret.trim() === ""
          }
          aria-label={busy === "client" ? "Sealing" : "Save OAuth client"}
          title={busy === "client" ? "Sealing" : "Save OAuth client"}
        >
          <IconCheck size={16} />
        </button>
      </div>
    </form>
  );

  if (provider.id !== "github") {
    return <div className="conn-client-setup">{form}</div>;
  }

  return (
    <div className="conn-client-setup">
      <div className="actions">
        <button
          type="button"
          className="icon-btn icon-btn--sm"
          disabled={!online || busy !== null}
          aria-label={
            busy === "app"
              ? "Opening GitHub"
              : "Create GitHub App for this organization"
          }
          title={
            busy === "app"
              ? "Opening GitHub"
              : "Create GitHub App for this organization"
          }
          onClick={() => void deployGithubApp()}
        >
          <IconExternal size={16} />
        </button>
      </div>
      <details className="conn-client-alt">
        <summary>Or use an existing OAuth app</summary>
        {form}
      </details>
    </div>
  );
}
