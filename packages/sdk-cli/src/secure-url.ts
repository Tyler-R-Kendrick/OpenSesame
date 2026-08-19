import { BlockList, isIP } from "node:net";

const LOOPBACK_HOSTS = new BlockList();
const PRIVATE_HOSTS = new BlockList();

// Stryker disable all: native BlockList tables initialize before per-mutant activation; URL boundary tests cover every range
for (const [network, prefix] of [
  ["127.0.0.0", 8],
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
] as const) {
  PRIVATE_HOSTS.addSubnet(network, prefix, "ipv4");
  PRIVATE_HOSTS.addSubnet(`::ffff:${network}`, 96 + prefix, "ipv6");
  PRIVATE_HOSTS.addSubnet(`::${network}`, 96 + prefix, "ipv6");
}
LOOPBACK_HOSTS.addSubnet("127.0.0.0", 8, "ipv4");
LOOPBACK_HOSTS.addSubnet("::ffff:127.0.0.0", 104, "ipv6");
LOOPBACK_HOSTS.addSubnet("::127.0.0.0", 104, "ipv6");
LOOPBACK_HOSTS.addAddress("::1", "ipv6");
PRIVATE_HOSTS.addAddress("::", "ipv6");
PRIVATE_HOSTS.addAddress("::1", "ipv6");
PRIVATE_HOSTS.addSubnet("fc00::", 7, "ipv6");
PRIVATE_HOSTS.addSubnet("fe80::", 10, "ipv6");
// Stryker restore all

function blockListContains(list: BlockList, host: string): boolean {
  const family = isIP(host);
  if (family === 4) return list.check(host, "ipv4");
  // Stryker disable next-line ConditionalExpression: non-IPv4 valid IPs are IPv6; invalid names fail BlockList either way
  if (family === 6) return list.check(host, "ipv6");
  return false;
}

function isLoopbackHost(hostname: string): boolean {
  const host = stripIpv6Brackets(hostname).toLowerCase();
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    blockListContains(LOOPBACK_HOSTS, host)
  );
}

function stripIpv6Brackets(hostname: string): string {
  // Stryker disable next-line all: URL.hostname supplies either both IPv6 brackets or neither
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}

/**
 * Every URL the CLI sends a code, a verifier, or a bearer token to must be one an
 * onlooker cannot rewrite. http is tolerated only on loopback, where the
 * development server lives.
 */
export function assertSecureUrl(raw: string, what: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${what} must be an absolute URL`);
  }
  if (url.protocol === "https:") return raw;
  if (url.protocol === "http:" && isLoopbackHost(url.hostname)) return raw;
  throw new Error(`${what} must use https (http is allowed only on loopback)`);
}

/**
 * Hosts that only mean something inside this machine's network.
 */
function isPrivateHost(hostname: string): boolean {
  const host = stripIpv6Brackets(hostname).toLowerCase();
  if (isLoopbackHost(host)) return true;
  return (
    blockListContains(PRIVATE_HOSTS, host) ||
    host.endsWith(".internal") ||
    host.endsWith(".local")
  );
}

/**
 * An endpoint the issuer told us about, rather than one the operator wrote.
 *
 * `assertSecureUrl` tolerates cleartext on loopback, which is right for a value in
 * this machine's own configuration and wrong for a value a remote party supplies:
 * it lets any issuer aim the CLI's next request — carrying a device code, a
 * verifier, or a client assertion — at a listener on this machine. A discovered
 * endpoint may only name private space when the issuer is itself private, which is
 * the local development case where both ends are here anyway.
 */
export function assertDiscoveredUrl(
  raw: string,
  what: string,
  issuer: string,
): string {
  const checked = assertSecureUrl(raw, what);
  let issuerHost: string;
  try {
    issuerHost = new URL(issuer).hostname;
  } catch {
    throw new Error("issuer must be an absolute URL");
  }
  if (isPrivateHost(issuerHost)) return checked;
  if (isPrivateHost(new URL(checked).hostname)) {
    throw new Error(
      `${what} names a private or loopback host, but the issuer is remote`,
    );
  }
  return checked;
}

export function trimSlash(url: string): string {
  return url.replace(/\/+$/u, "");
}

/**
 * The discovery document decides where the CLI sends the code and the verifier.
 * An issuer that does not name itself is a document that came from somewhere else.
 */
export function assertDiscoveryBelongsToIssuer(
  meta: { issuer?: string },
  issuer: string,
): void {
  if (trimSlash(meta.issuer ?? "") !== issuer) {
    throw new Error(
      "OIDC discovery issuer does not match the configured issuer",
    );
  }
}
