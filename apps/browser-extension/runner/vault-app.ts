/** Navigation only: no owner credentials or management operations cross the extension bridge. */
export function vaultSecurityPage(value: string): string {
  const url = new URL(value);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error(
      "Use your vault app's HTTPS base URL, or HTTP on localhost, without credentials or query parameters.",
    );
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return new URL("settings/security#retired-passwords", url).href;
}
