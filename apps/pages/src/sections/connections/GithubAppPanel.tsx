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
    if (result === "registered" || result === "installed") {
      onFlash({ tone: "ok", text: "GitHub App registered." });
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
  }, [onFlash, onReady]);

  const ready = (integrations?.length ?? 0) > 0 || provider.configured;

  async function deploy() {
    setBusy(true);
    try {
      const registration = await startGithubAppRegistration({
        returnTo: `${window.location.origin}${window.location.pathname}`,
        displayName: `OpenSesame ${provider.displayName}`,
      });
      submitGithubAppManifest(registration);
      window.setTimeout(() => {
        setBusy(false);
        onFlash({
          tone: "err",
          text: "GitHub did not open.",
        });
      }, 2500);
    } catch (error) {
      onFlash({ tone: "err", text: errorText(error) });
      setBusy(false);
    }
  }

  if (ready) return null;

  return (
    <div className="conn-github-app actions">
      <button
        type="button"
        className="icon-btn icon-btn--sm"
        disabled={!online || busy}
        aria-label={busy ? "Opening GitHub" : "Create GitHub App"}
        title={busy ? "Opening GitHub" : "Create GitHub App"}
        onClick={() => void deploy()}
      >
        <IconExternal size={16} />
      </button>
    </div>
  );
}
