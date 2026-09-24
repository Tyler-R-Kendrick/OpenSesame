import type { JsonObject } from "@opensesame/os-domain";
/**
 * GitHub App Manifest flow for every Pages origin.
 *
 * Conversion and installation listing go through the Connect relay
 * (`apps/pages/server`) — one shape for localhost, GitHub Pages, and Vercel.
 */
import { maybePage, sessionStore } from "../ports.js";
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

/** Permissions this App asks GitHub for at registration (read-only after install). */
export const GITHUB_APP_REQUESTED_PERMISSIONS = [
  { name: "metadata", access: "read" },
  { name: "contents", access: "write" },
  { name: "administration", access: "write" },
  { name: "workflows", access: "write" },
  { name: "pull_requests", access: "write" },
] as const;

function permissions(): JsonObject {
  const out: JsonObject = {};
  for (const row of GITHUB_APP_REQUESTED_PERMISSIONS) {
    out[row.name] = row.access;
  }
  return out;
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
    sessionStore().setItem(STATE_KEY, state);
  } catch {
    /* node / private mode — claim still carries state in the form body */
  }
  const origin = body.origin ?? maybePage()?.location.origin ?? "";
  const redirectUrl = githubAppRedirectUrl(body.returnTo, origin);
  return {
    action: REGISTER_URL,
    state,
    manifest: manifestFor(name, body.returnTo, redirectUrl),
    redirectUrl,
  };
}
