/** The same approved Networking policy guards persisted and memory-only nodes. */
export type BrowserNodePolicy = Readonly<{
  assertCurrent(): void;
  approve(url: string, method: string): boolean;
  approvePeer(url: string): boolean;
}>;

export function browserNodeControlURL(value: string): URL {
  const url = new URL(value);
  const loopback =
    url.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !loopback) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error(
      "Use an HTTPS control server or an HTTP loopback test server.",
    );
  return url;
}

/** Where the node may send a person to sign in: its own control server, or Tailscale's login for Tailscale's. */
export function browserNodeAuthURL(href: string, controlURL: string): string {
  const url = new URL(href);
  const control = new URL(controlURL);
  if (
    url.username ||
    url.password ||
    (url.origin !== control.origin &&
      !(
        control.hostname === "controlplane.tailscale.com" &&
        url.origin === "https://login.tailscale.com"
      ))
  )
    throw new Error("Unexpected Tailscale authorization destination.");
  return url.href;
}
