import {
  claimGithubAppCode,
  readLocalGithubApp,
  refreshGithubAppInstallations,
  verifyGithubAppInstallations,
} from "@opensesame/app-core/lib/github-app-manifest.js";
import { hasPendingGithubAppSecret } from "@opensesame/app-core/lib/github-app-secret.js";
import { captureGithubAuthority } from "@opensesame/app-core/lib/github-app-vault-transport.js";
import type { Flash } from "@opensesame/app-core/sections/connections/shared.js";
import { type RefObject, useEffect, useRef } from "react";

/** Callback service boundary: verification is distinct from cached presence. */
export const githubAppReturnSeams = {
  claimGithubAppCode,
  readLocalGithubApp,
  refreshGithubAppInstallations,
  verifyGithubAppInstallations,
  hasPendingGithubAppSecret,
  captureGithubAuthority,
};
type GithubClaimRequest = {
  arrival: string;
  pending: ReturnType<typeof claimGithubAppCode>;
};
type GithubVerificationRequest = {
  arrival: string;
  pending: ReturnType<typeof verifyGithubAppInstallations>;
};
type ReturnContext = {
  arrival: string;
  active(): boolean;
  finish(): void;
  failed(): void;
  flash(next: Flash): void;
};

function cleaned(params: URLSearchParams): string {
  for (const name of [
    "code",
    "state",
    "github_app_code",
    "github_app_state",
    "github_app",
    "reason",
    "integration",
  ])
    params.delete(name);
  const query = params.toString();
  return `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`;
}

function announceClaim(
  context: ReturnContext,
  outcome: Awaited<ReturnType<typeof claimGithubAppCode>>,
): void {
  if (outcome === "registered") {
    const app = githubAppReturnSeams.readLocalGithubApp();
    if (!app) return;
    const pending = githubAppReturnSeams.hasPendingGithubAppSecret(app.id);
    context.flash({
      tone: "ok",
      text: pending
        ? "GitHub App registered. Unlock your vault to save its key."
        : "GitHub App registered.",
    });
    void githubAppReturnSeams.refreshGithubAppInstallations();
  } else if (outcome === "failed")
    context.flash({ tone: "err", text: "GitHub App registration failed." });
  context.finish();
}

function startClaim(
  context: ReturnContext,
  request: RefObject<GithubClaimRequest | null>,
  code: string,
  state: string,
): () => void {
  let operation: ReturnType<typeof captureGithubAuthority>;
  try {
    operation = githubAppReturnSeams.captureGithubAuthority({
      allowBeforeVault: true,
    });
  } catch {
    context.failed();
    return () => {};
  }
  if (request.current?.arrival !== context.arrival)
    request.current = {
      arrival: context.arrival,
      pending: githubAppReturnSeams.claimGithubAppCode(code, state),
    };
  void request.current.pending
    .then((outcome) => {
      if (!context.active()) return;
      operation.transport.assertCurrent();
      announceClaim(context, outcome);
    })
    .catch(context.failed)
    .finally(operation.close);
  return operation.close;
}

function startVerification(
  context: ReturnContext,
  request: RefObject<GithubVerificationRequest | null>,
  result: string,
): () => void {
  let operation: ReturnType<typeof captureGithubAuthority>;
  try {
    operation = githubAppReturnSeams.captureGithubAuthority();
  } catch {
    context.failed();
    return () => {};
  }
  if (request.current?.arrival !== context.arrival)
    request.current = {
      arrival: context.arrival,
      pending: githubAppReturnSeams.verifyGithubAppInstallations(),
    };
  void request.current.pending
    .then((app) => {
      if (!context.active()) return;
      operation.transport.assertCurrent();
      if (githubAppReturnSeams.readLocalGithubApp() !== app) return;
      if (result === "installed" && app.installations.length === 0)
        context.flash({
          tone: "err",
          text: "GitHub has not confirmed an App installation.",
        });
      else
        context.flash({
          tone: "ok",
          text:
            result === "installed"
              ? "GitHub App installation verified."
              : "GitHub App registration verified.",
        });
      context.finish();
    })
    .catch(context.failed)
    .finally(operation.close);
  return operation.close;
}

/** One same-origin return, coalesced across StrictMode replay and changing callbacks. */
export function useGithubAppReturn(
  providerId: string,
  onFlash: (flash: Flash) => void,
): void {
  const flash = useRef(onFlash);
  flash.current = onFlash;
  const claim = useRef<GithubClaimRequest | null>(null);
  const verification = useRef<GithubVerificationRequest | null>(null);
  useEffect(() => {
    if (providerId !== "github") return;
    const arrival = window.location.href;
    let mounted = true;
    const active = () => mounted && window.location.href === arrival;
    const params = new URLSearchParams(window.location.search);
    const finish = () => {
      if (active()) window.history.replaceState({}, "", cleaned(params));
    };
    const context: ReturnContext = {
      arrival,
      active,
      finish,
      flash: (next) => flash.current(next),
      failed() {
        if (!active()) return;
        flash.current({
          tone: "err",
          text: "GitHub App registration could not be verified. Unlock its vault and try again.",
        });
        finish();
      },
    };
    const result = params.get("github_app");
    const code = params.get("github_app_code") ?? params.get("code");
    const state = params.get("github_app_state") ?? params.get("state");
    let close = () => {};
    if (code && state) close = startClaim(context, claim, code, state);
    else if (result === "registered" || result === "installed")
      close = startVerification(context, verification, result);
    else if (result) {
      if (result === "error")
        flash.current({ tone: "err", text: "GitHub App registration failed." });
      finish();
    }
    return () => {
      mounted = false;
      close();
    };
  }, [providerId]);
}
