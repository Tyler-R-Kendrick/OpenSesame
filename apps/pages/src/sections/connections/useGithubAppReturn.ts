import {
  claimGithubAppCode,
  refreshGithubAppInstallations,
} from "@opensesame/app-core/lib/github-app-manifest.js";
import type { Flash } from "@opensesame/app-core/sections/connections/shared.js";
import { useEffect } from "react";

const LEFT_BY_REGISTRATION = [
  "code",
  "state",
  "github_app_code",
  "github_app_state",
  "github_app",
  "reason",
  "integration",
];

/** The address without what the App registration leaves on it. */
function cleaned(
  params: URLSearchParams,
  names: readonly string[] = LEFT_BY_REGISTRATION,
): string {
  for (const name of names) params.delete(name);
  const query = params.toString();
  return `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`;
}

/**
 * GitHub App Manifest registration returns to this page through
 * `?github_app=…` (or, from the Connect relay, a code and state to claim).
 * Read it once, say how it went, and take it off the address. The App a
 * claim registers is stored on this device, and the panels that draw from it
 * read it from there.
 */
export function useGithubAppReturn(
  providerId: string,
  onFlash: (flash: Flash) => void,
): void {
  useEffect(() => {
    if (providerId !== "github") return;
    const params = new URLSearchParams(window.location.search);
    const result = params.get("github_app");
    const reason = params.get("reason");
    // Relay renames GitHub's code/state so OIDC sign-in does not steal them.
    const code = params.get("github_app_code") ?? params.get("code");
    const state = params.get("github_app_state") ?? params.get("state");
    if (code && state) {
      void claimGithubAppCode(code, state).then((outcome) => {
        window.history.replaceState({}, "", cleaned(params));
        if (outcome === "registered") {
          onFlash({ tone: "ok", text: "GitHub App registered." });
          void refreshGithubAppInstallations();
        } else if (outcome === "failed") {
          onFlash({ tone: "err", text: "GitHub App registration failed." });
        }
        // "ignored" = not our ceremony (or already claimed) — leave the page alone.
      });
      return;
    }
    // A relay stamp without a code has nothing to claim; drop the marker.
    if (result === "claim") {
      window.history.replaceState({}, "", cleaned(params, ["github_app"]));
      return;
    }
    if (!result) return;
    if (result === "registered" || result === "installed") {
      onFlash({ tone: "ok", text: "GitHub App registered." });
      void refreshGithubAppInstallations();
    } else if (result === "error") {
      onFlash({
        tone: "err",
        text: reason
          ? `GitHub App registration failed: ${reason}`
          : "GitHub App registration failed.",
      });
    }
    window.history.replaceState({}, "", cleaned(params));
  }, [providerId, onFlash]);
}
