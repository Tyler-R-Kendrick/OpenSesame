/** Local IAM popups must keep window.opener; every other route stays isolated. */
export function crossOriginOpenerPolicy(
  pathname: string,
  basePath: string,
): "unsafe-none" | "same-origin" | null {
  const root = basePath.endsWith("/") ? basePath : `${basePath}/`;
  // MSAL v5 redirect bridge must not be served with COOP.
  if (
    pathname === `${root}auth/redirect.html` ||
    pathname === `${root}auth/redirect`
  ) {
    return null;
  }
  return pathname === `${root}identity/authorize` ||
    pathname === `${root}identity/siop`
    ? "unsafe-none"
    : "same-origin";
}
