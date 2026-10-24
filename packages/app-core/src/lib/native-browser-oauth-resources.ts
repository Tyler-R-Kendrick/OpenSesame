/** The exact existing provider identity-read endpoints, shared with carrier admission. */
const endpoints = new Map([
  ["gitlab", "https://gitlab.com/api/v4/user"],
  ["dropbox", "https://api.dropboxapi.com/2/users/get_current_account"],
  ["spotify", "https://api.spotify.com/v1/me"],
  ["google", "https://openidconnect.googleapis.com/v1/userinfo"],
  ["workos", "https://signin.workos.com/oauth2/userinfo"],
  ["resend", "https://api.resend.com/domains"],
]);

export function nativeBrowserOAuthVerificationEndpoint(
  providerId: string,
): string | null {
  return endpoints.get(providerId) ?? null;
}
