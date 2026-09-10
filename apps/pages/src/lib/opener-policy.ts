/** Local IAM popups must keep window.opener; every other route stays isolated. */
export function crossOriginOpenerPolicy(
  pathname: string,
  basePath: string,
): "unsafe-none" | "same-origin" {
  const root = basePath.endsWith("/") ? basePath : `${basePath}/`;
  return pathname === `${root}identity/authorize`
    ? "unsafe-none"
    : "same-origin";
}
