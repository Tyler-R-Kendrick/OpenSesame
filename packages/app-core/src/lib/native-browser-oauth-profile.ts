/** Official public-browser routes are independent of confidential integration presets. */
import { connectPlan } from "./connect-plan.js";
import type {
  NativeConfiguration,
  NativeFieldClassification,
} from "./native-connector-schema.js";

export type NativeBrowserOAuthProvider =
  | "gitlab"
  | "microsoft"
  | "microsoft-teams"
  | "dropbox"
  | "spotify"
  | "google"
  | "openrouter"
  | "workos"
  | "resend";
// Browser CIMD clients use a deployment-owned HTTPS metadata document.
export type NativeBrowserOAuthProfile = {
  id: NativeBrowserOAuthProvider;
  mode: "pkce" | "google-token" | "openrouter-key" | "cimd";
  name: string;
  docsUrl: string;
  refresh: boolean;
  revoke: "form" | "dropbox" | "google" | "settings" | "refresh-grant";
  revocationEndpoint: string | null;
  settingsUrl: string | null;
  publicParameters: readonly string[];
  requiredScopes: readonly string[];
};
const PROFILES: readonly NativeBrowserOAuthProfile[] = [
  {
    id: "workos",
    mode: "cimd",
    name: "WorkOS",
    docsUrl: "https://workos.com/docs/authkit/connect/oauth",
    refresh: true,
    revoke: "form",
    revocationEndpoint: "https://signin.workos.com/oauth2/revoke",
    settingsUrl: "https://dashboard.workos.com/",
    publicParameters: [],
    requiredScopes: ["openid", "email"],
  },
  {
    id: "resend",
    mode: "cimd",
    name: "Resend",
    docsUrl: "https://resend.com/docs/guides/building-a-resend-oauth-client",
    refresh: true,
    revoke: "refresh-grant",
    revocationEndpoint: "https://api.resend.com/oauth/revoke",
    settingsUrl: "https://resend.com/",
    publicParameters: [],
    requiredScopes: ["full_access"],
  },
  {
    id: "gitlab",
    mode: "pkce",
    name: "GitLab",
    docsUrl: "https://docs.gitlab.com/api/oauth2/",
    refresh: true,
    revoke: "form",
    revocationEndpoint: "https://gitlab.com/oauth/revoke",
    settingsUrl: "https://gitlab.com/-/user_settings/applications",
    publicParameters: ["instance_url"],
    requiredScopes: ["read_user"],
  },
  {
    id: "microsoft",
    mode: "pkce",
    name: "Microsoft",
    docsUrl:
      "https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow",
    refresh: true,
    revoke: "settings",
    revocationEndpoint: null,
    settingsUrl: "https://myapps.microsoft.com/",
    publicParameters: ["tenant"],
    requiredScopes: ["openid", "User.Read"],
  },
  {
    id: "microsoft-teams",
    mode: "pkce",
    name: "Microsoft Teams",
    docsUrl:
      "https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow",
    refresh: true,
    revoke: "settings",
    revocationEndpoint: null,
    settingsUrl: "https://myapps.microsoft.com/",
    publicParameters: ["tenant"],
    requiredScopes: ["openid", "User.Read"],
  },
  {
    id: "dropbox",
    mode: "pkce",
    name: "Dropbox",
    docsUrl: "https://developers.dropbox.com/oauth-guide",
    refresh: false,
    revoke: "dropbox",
    revocationEndpoint: "https://api.dropboxapi.com/2/auth/token/revoke",
    settingsUrl: "https://www.dropbox.com/account/connected_apps",
    publicParameters: [],
    requiredScopes: ["account_info.read"],
  },
  {
    id: "spotify",
    mode: "pkce",
    name: "Spotify",
    docsUrl:
      "https://developer.spotify.com/documentation/web-api/tutorials/code-pkce-flow",
    refresh: true,
    revoke: "settings",
    revocationEndpoint: null,
    settingsUrl: "https://www.spotify.com/account/apps/",
    publicParameters: [],
    requiredScopes: ["user-read-private"],
  },
  {
    id: "google",
    mode: "google-token",
    name: "Google",
    docsUrl:
      "https://developers.google.com/identity/oauth2/web/guides/use-token-model",
    refresh: false,
    revoke: "google",
    revocationEndpoint: "https://oauth2.googleapis.com/revoke",
    settingsUrl: "https://myaccount.google.com/connections",
    publicParameters: [],
    requiredScopes: [
      "openid",
      "https://www.googleapis.com/auth/userinfo.email",
    ],
  },
  {
    id: "openrouter",
    mode: "openrouter-key",
    name: "OpenRouter",
    docsUrl: "https://openrouter.ai/docs/guides/overview/auth/oauth",
    refresh: false,
    revoke: "settings",
    revocationEndpoint: null,
    settingsUrl: "https://openrouter.ai/settings/keys",
    publicParameters: [],
    requiredScopes: [],
  },
];
export function nativeBrowserOAuthProfile(
  id: string,
): NativeBrowserOAuthProfile | null {
  const found = PROFILES.find((entry) => entry.id === id);
  return found ? structuredClone(found) : null;
}
export function requiredBrowserOAuthProfile(
  id: string,
): NativeBrowserOAuthProfile {
  const profile = nativeBrowserOAuthProfile(id);
  if (!profile)
    throw new Error(
      "This provider has no documented public browser authorization route",
    );
  return profile;
}
export function browserOAuthClassification(
  configuration: NativeConfiguration,
): NativeFieldClassification {
  return {
    publicParameters: requiredBrowserOAuthProfile(configuration.providerId)
      .publicParameters,
    privateCredentials: [],
  };
}
export function browserOAuthScopes(
  profile: NativeBrowserOAuthProfile,
  configuration: NativeConfiguration,
  actor: string,
): string[] {
  if (actor !== "user")
    throw new Error(
      "This browser route supports the delegated user actor only",
    );
  const selected = configuration.requestedScopes[actor] ?? [
    ...profile.requiredScopes,
  ];
  if (profile.requiredScopes.some((scope) => !selected.includes(scope)))
    throw new Error(
      "Keep the provider account-verification permissions selected",
    );
  const scopes =
    connectPlan(profile.id)?.methods.find((method) => method.kind === "oauth")
      ?.preset?.scopes ?? [];
  if (
    selected.some(
      (scope) =>
        !profile.requiredScopes.includes(scope) &&
        !scopes.some((choice) => choice.name === scope),
    )
  )
    throw new Error("Select documented provider permissions");
  return [...new Set(selected)];
}
export type NativeBrowserOAuthEndpoints = {
  issuer: string;
  authorization: string;
  token: string;
};
export function browserOAuthEndpoints(
  profile: NativeBrowserOAuthProfile,
  configuration: NativeConfiguration,
): NativeBrowserOAuthEndpoints {
  if (profile.id === "gitlab") {
    const instance =
      configuration.parameters.instance_url ?? "https://gitlab.com";
    if (instance !== "https://gitlab.com" && instance !== "https://gitlab.com/")
      throw new Error(
        "This browser route currently supports GitLab.com; a self-managed instance needs its own verified public-browser profile",
      );
    return {
      issuer: "https://gitlab.com",
      authorization: "https://gitlab.com/oauth/authorize",
      token: "https://gitlab.com/oauth/token",
    };
  }
  if (profile.id === "microsoft" || profile.id === "microsoft-teams") {
    const tenant = configuration.parameters.tenant || "common";
    if (
      !/^(common|organizations|consumers|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.test(
        tenant,
      )
    )
      throw new Error(
        "Enter a Microsoft tenant ID or a documented public tenant selector",
      );
    const issuer = `https://login.microsoftonline.com/${tenant}/v2.0`;
    return {
      issuer,
      authorization: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`,
      token: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
    };
  }
  const endpoints = {
    workos: {
      issuer: "https://signin.workos.com",
      authorization: "https://signin.workos.com/oauth2/authorize",
      token: "https://signin.workos.com/oauth2/token",
    },
    resend: {
      issuer: "https://api.resend.com",
      authorization: "https://api.resend.com/oauth/authorize",
      token: "https://api.resend.com/oauth/token",
    },
    dropbox: {
      issuer: "https://www.dropbox.com",
      authorization: "https://www.dropbox.com/oauth2/authorize",
      token: "https://api.dropboxapi.com/oauth2/token",
    },
    spotify: {
      issuer: "https://accounts.spotify.com",
      authorization: "https://accounts.spotify.com/authorize",
      token: "https://accounts.spotify.com/api/token",
    },
    google: {
      issuer: "https://accounts.google.com",
      authorization: "https://accounts.google.com/o/oauth2/v2/auth",
      token: "https://oauth2.googleapis.com/token",
    },
    openrouter: {
      issuer: "https://openrouter.ai",
      authorization: "https://openrouter.ai/auth",
      token: "https://openrouter.ai/api/v1/auth/keys",
    },
  };
  return endpoints[profile.id];
}
