/** Only Google Drive's account email scopes have these equivalent spellings. */
export function nativeOAuthScopeIncludes(
  providerId: string,
  scopes: readonly string[],
  scope: string,
): boolean {
  if (scopes.includes(scope)) return true;
  if (providerId !== "google-drive") return false;
  const email = "https://www.googleapis.com/auth/userinfo.email";
  return (
    (scope === "email" && scopes.includes(email)) ||
    (scope === email && scopes.includes("email"))
  );
}
