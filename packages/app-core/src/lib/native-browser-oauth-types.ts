/** Public browser OAuth contracts shared by approved provider profiles. */
export type NativeBrowserOAuthProvider =
  | "gitlab"
  | "microsoft"
  | "microsoft-teams"
  | "dropbox"
  | "spotify"
  | "google"
  | "openrouter"
  | "workos"
  | "resend"
  | "vercel"
  | "codeberg"
  | "auth0"
  | "okta"
  | "crowdin"
  | "databricks"
  | "twitch"
  | "discord";
// Browser CIMD clients use a deployment-owned HTTPS metadata document.
export type NativeBrowserOAuthProfile = {
  id: NativeBrowserOAuthProvider;
  mode:
    | "pkce"
    | "google-token"
    | "openrouter-key"
    | "cimd"
    | "device-code"
    | "implicit";
  name: string;
  docsUrl: string;
  refresh: boolean;
  revoke: "form" | "dropbox" | "google" | "settings" | "refresh-grant";
  revocationEndpoint: string | null;
  settingsUrl: string | null;
  publicParameters: readonly string[];
  requiredScopes: readonly string[];
};
