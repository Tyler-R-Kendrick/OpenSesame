import type { JsonObject } from "@opensesame/os-domain";
/**
 * GitHub App Manifest flow for every Pages origin.
 *
 * Conversion and installation discovery use GitHub directly from this device.
 * The callback is this static app, including deployments beneath a base path.
 */
import { maybePage } from "../ports.js";
import {
  githubAppRedirectUrl,
  githubAppRelayBase,
} from "./github-app-relay.js";
import { startGithubRegistration } from "./github-app-vault-transport.js";

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
  verifyGithubAppInstallations,
} from "./github-app-claim.js";

export { githubAppRedirectUrl, githubAppRelayBase };

const REGISTER_URL = "https://github.com/settings/apps/new";

export type GithubAppRegistration = {
  action: string;
  state: string;
  manifest: JsonObject;
  redirectUrl: string;
};

/** Registration permissions; each operation further scopes its installation token. */
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
  const url = new URL(returnTo);
  url.searchParams.set("github_app", "installed");
  return url.toString();
}

function manifestFor(name: string, redirectUrl: string): JsonObject {
  return {
    name,
    url: "https://github.com",
    redirect_url: redirectUrl,
    callback_urls: [redirectUrl],
    setup_url: setupUrl(redirectUrl),
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
  const origin = body.origin ?? maybePage()?.location.origin ?? "";
  const redirectUrl = githubAppRedirectUrl(body.returnTo, origin);
  const state = crypto.randomUUID().replaceAll("-", "");
  startGithubRegistration(state, redirectUrl);
  return {
    action: REGISTER_URL,
    state,
    manifest: manifestFor(name, redirectUrl),
    redirectUrl,
  };
}
