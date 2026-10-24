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
