/**
 * GitHub App Manifest flow for every Pages origin.
 *
 * Conversion and installation listing go through the Connect relay
 * (`apps/connect-backend`) — one shape for localhost, GitHub Pages, and Vercel.
 */
import type { JsonObject } from "@opensesame/os-domain";
import {
  githubAppRedirectUrl,
  githubAppRelayBase,
} from "./github-app-relay.js";

export {
  forgetLocalGithubApp,
  readLocalGithubApp,
  refreshGithubAppOwner,
  sealPendingGithubAppPem,
  subscribeLocalGithubApp,
  type LocalGithubApp,
  type LocalGithubInstall,
} from "./github-app-local.js";

export {
  claimGithubAppCode,
  refreshGithubAppInstallations,
} from "./github-app-claim.js";

export { githubAppRedirectUrl, githubAppRelayBase };

const REGISTER_URL = "https://github.com/settings/apps/new";
const STATE_KEY = "opensesame.github-app.state";

export type GithubAppRegistration = {
  action: string;
  state: string;
  manifest: JsonObject;
  redirectUrl: string;
};

function permissions(): JsonObject {
  return {
    metadata: "read",
    contents: "write",
    administration: "write",
    workflows: "write",
    pull_requests: "write",
  };
}

function setupUrl(returnTo: string): string {
  return returnTo.includes("?")
    ? `${returnTo}&github_app=installed`
    : `${returnTo}?github_app=installed`;
}

function manifestFor(
  name: string,
  returnTo: string,
  redirectUrl: string,
): JsonObject {
  return {
    name,
    url: "https://github.com",
    redirect_url: redirectUrl,
    callback_urls: [returnTo],
    setup_url: setupUrl(returnTo),
    public: false,
    request_oauth_on_install: false,
    default_permissions: permissions(),
    default_events: [],
  };
}

export function buildGithubAppRegistration(body: {
  returnTo: string;
  displayName?: string;
  origin?: string;
}): GithubAppRegistration {
  const name = (body.displayName?.trim() || "OpenSesame").slice(0, 32);
  const state = crypto.randomUUID().replaceAll("-", "");
  try {
    sessionStorage.setItem(STATE_KEY, state);
  } catch {
    /* node / private mode — claim still carries state in the form body */
  }
  const origin = body.origin ?? globalThis.location?.origin ?? "";
  const redirectUrl = githubAppRedirectUrl(body.returnTo, origin);
  return {
    action: REGISTER_URL,
    state,
    manifest: manifestFor(name, body.returnTo, redirectUrl),
    redirectUrl,
  };
}
