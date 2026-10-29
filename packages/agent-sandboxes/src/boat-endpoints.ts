/** Boat control-plane and returned URLs are credential boundaries. */
const isLoopback = (url: URL) =>
  url.hostname === "127.0.0.1" || url.hostname === "[::1]";
const literalLoopbackHttp = (value: string) =>
  /^http:\/\/(?:127\.0\.0\.1|\[::1\])(?::[0-9]+)?\/?$/iu.test(value);

function parseEndpoint(value: string, base?: string): URL {
  try {
    return new URL(value, base);
  } catch {
    // Never expose returned URLs: hosted URLs can contain credentials.
    throw new Error("boat: invalid endpoint URL");
  }
}

export function boatOrigin(value: string): string {
  const url = parseEndpoint(value);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    (url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        isLoopback(url) &&
        literalLoopbackHttp(value)
      ))
  )
    throw new Error("boat: invalid control-plane origin");
  return url.origin;
}

export function boatClaimUrl(value: string, origin: string): string {
  const url = parseEndpoint(value, origin);
  if (
    url.origin !== origin ||
    url.username ||
    url.password ||
    url.hash ||
    url.pathname !== "/api/boat/agent/identity/claim"
  )
    throw new Error("boat: invalid claim URL");
  return url.href;
}

export function boatCheckoutUrl(value: string, origin: string): string {
  const url = parseEndpoint(value, origin);
  const development =
    isLoopback(parseEndpoint(origin)) && url.origin === origin;
  if (
    url.username ||
    url.password ||
    url.hash ||
    !(
      development ||
      (url.protocol === "https:" &&
        url.hostname === "checkout.stripe.com" &&
        !url.port)
    )
  )
    throw new Error("boat: invalid checkout URL");
  return url.href;
}

export type BoatHostedRelay = { url: string; cookie?: string };

/** Bind a protected port to the authenticated sandbox's documented base URL. */
export function boatHostedRelay(
  hosted: string,
  sandboxUrl: string,
  origin: string,
  port: number,
): BoatHostedRelay {
  const api = parseEndpoint(origin);
  const base = parseEndpoint(sandboxUrl);
  const url = parseEndpoint(hosted);
  if (
    isLoopback(api) &&
    api.protocol === "http:" &&
    isLoopback(base) &&
    isLoopback(url) &&
    literalLoopbackHttp(origin) &&
    literalLoopbackHttp(sandboxUrl) &&
    literalLoopbackHttp(hosted) &&
    base.protocol === "http:" &&
    base.origin === api.origin &&
    base.pathname === "/" &&
    !base.username &&
    !base.password &&
    !base.search &&
    !base.hash &&
    url.protocol === "http:" &&
    url.hostname === api.hostname &&
    Number(url.port) === port &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash &&
    url.pathname === "/"
  ) {
    url.protocol = "ws:";
    return { url: url.href };
  }
  const suffix = ".on.boat.dev";
  const label = base.hostname.endsWith(suffix)
    ? base.hostname.slice(0, -suffix.length)
    : "";
  if (
    base.protocol !== "https:" ||
    base.port ||
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    base.pathname !== "/" ||
    !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label) ||
    url.protocol !== "https:" ||
    url.port ||
    url.username ||
    url.password ||
    url.hash ||
    url.pathname !== "/" ||
    url.hostname !== `${label}-${port}${suffix}`
  )
    throw new Error("boat: invalid hosted relay destination");
  const entries = [...url.searchParams.entries()];
  const token =
    entries.length === 1 && entries[0]?.[0] === "_token" ? entries[0][1] : "";
  if (!/^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]+$/u.test(token))
    throw new Error("boat: invalid hosted relay credential");
  url.search = "";
  url.protocol = "wss:";
  return { url: url.href, cookie: `_port_auth=${token}` };
}
