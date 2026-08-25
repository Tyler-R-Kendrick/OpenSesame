import { useEffect, useState } from "react";
import { IconExternal } from "../../components/Icons.js";
import type { Integration, Provider } from "../../lib/connections.js";
import {
  listIntegrations,
  startGithubAppRegistration,
  submitGithubAppManifest,
} from "../../lib/connections.js";
import { type Flash, errorText } from "./shared.js";

export function GithubTenantAppPanel({
  provider,
  online,
  onFlash,
  onReady,
}: {
  provider: Provider;
  online: boolean;
  onFlash: (flash: Flash) => void;
  onReady: () => void;
}) {
  const [integrations, setIntegrations] = useState<Integration[] | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void listIntegrations()
      .then((rows) => {
        if (cancelled) return;
        const github = rows.filter(
          (row) =>
            row.providerId === "github" &&
            row.enabled &&
            row.configured &&
            row.source === "organization",
        );
        setIntegrations(github);
        if (github.length > 0 || provider.configured) onReady();
      })
      .catch(() => {
        if (!cancelled) setIntegrations([]);
      });
    return () => {
      cancelled = true;
    };
  }, [onReady, provider.configured]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const result = params.get("github_app");
    if (!result) return;
    const reason = params.get("reason");
    if (result === "registered") {
      onFlash({
        tone: "ok",
        text: "GitHub App registered for this organization. You can Authorize with GitHub now.",
      });
      onReady();
      void listIntegrations().then((rows) =>
        setIntegrations(
          rows.filter(
            (row) =>
              row.providerId === "github" &&
              row.enabled &&
              row.configured &&
              row.source === "organization",
          ),
        ),
      );
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
  }, [onFlash, onReady]);

  const ready = (integrations?.length ?? 0) > 0 || provider.configured;

  async function deploy() {
    setBusy(true);
    try {
      const registration = await startGithubAppRegistration({
        returnTo: `${window.location.origin}${window.location.pathname}`,
        displayName: `OpenSesame ${provider.displayName}`,
      });
      onFlash({
        tone: "ok",
        text: "Sending you to GitHub to create the app…",
      });
      submitGithubAppManifest(registration);
      window.setTimeout(() => {
        setBusy(false);
        onFlash({
          tone: "err",
          text: "GitHub did not open. Hard-refresh so CSP allows form posts to github.com, then try again.",
        });
      }, 2500);
    } catch (error) {
      onFlash({ tone: "err", text: errorText(error) });
      setBusy(false);
    }
  }

  if (ready) {
    return (
      <p className="hint">
        {provider.configured
          ? "This Host already has deployment GitHub OAuth credentials."
          : `Tenant GitHub App ready${
              integrations?.[0] ? ` (${integrations[0].displayName})` : ""
            }. Use Authorize below.`}
      </p>
    );
  }

  return (
    <div className="conn-github-app">
      <p className="hint">
        OpenSesame creates a GitHub App for this organization — you only confirm
        it on GitHub. No client id or secret paste, and no manual OAuth App
        setup.
      </p>
      <div className="actions">
        <button
          type="button"
          className="btn btn--primary btn--sm"
          disabled={!online || busy}
          onClick={() => void deploy()}
        >
          <IconExternal size={16} />
          {busy ? "Opening GitHub…" : "Create GitHub App for this organization"}
        </button>
      </div>
      <p className="hint">
        Continues in this tab on github.com — not a popup. After you confirm the
        app, GitHub returns you here.
      </p>
    </div>
  );
}
