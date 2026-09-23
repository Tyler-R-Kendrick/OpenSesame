/** Exact-origin safety — no generic webhooks / SSRF (INV-26). */
import { PEER_BOUNDS } from "./bounds.js";

const BLOCKED_HOSTS = new Set([
  "metadata.google.internal",
  "metadata.google.com",
  "169.254.169.254",
  "metadata",
]);

function isIpv4(host: string): boolean {
  return /^(?:\d{1,3}\.){3}\d{1,3}$/.test(host);
}

function isBlockedIpv4(host: string): boolean {
  if (!isIpv4(host)) return false;
  const o = host.split(".").map(Number);
  if (o.length !== 4 || o.some((n) => !Number.isInteger(n) || n < 0 || n > 255))
    return true;
  const [a, b] = o;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a >= 224) return true;
  return false;
}

function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h === "::1";
}

function parsePeerOriginUrl(origin: string): URL {
  if (origin.length < 8 || origin.length > PEER_BOUNDS.refMax * 4) {
    throw new Error("unapproved_route");
  }
  for (let i = 0; i < origin.length; i++) {
    const code = origin.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) throw new Error("unapproved_route");
  }
  try {
    return new URL(origin);
  } catch {
    throw new Error("unapproved_route");
  }
}

function assertAllowedPeerHost(url: URL): string {
  if (url.username || url.password || url.hash)
    throw new Error("unapproved_route");
  const host = url.hostname.toLowerCase();
  if (!host || BLOCKED_HOSTS.has(host)) throw new Error("unapproved_route");
  if (
    (host.endsWith(".internal") || host.endsWith(".local")) &&
    !isLoopbackHost(host)
  ) {
    throw new Error("unapproved_route");
  }
  return host;
}

function assertPeerProtocolAllowed(url: URL, host: string): void {
  const loopback = isLoopbackHost(host);
  if (url.protocol === "https:") {
    if (!loopback && isBlockedIpv4(host)) throw new Error("unapproved_route");
    return;
  }
  if (url.protocol === "http:" && loopback) return;
  throw new Error("unapproved_route");
}

/** Validate and return canonical URL. Throws `unapproved_route`. */
export function assertSafePeerOrigin(origin: string): URL {
  const url = parsePeerOriginUrl(origin);
  const host = assertAllowedPeerHost(url);
  assertPeerProtocolAllowed(url, host);
  return url;
}

export function originsExactMatch(
  registered: string,
  presented: string,
): boolean {
  try {
    const a = assertSafePeerOrigin(registered);
    const b = assertSafePeerOrigin(presented);
    return a.origin === b.origin;
  } catch {
    return false;
  }
}

export function assertBoundedPeerPath(path: string): string {
  if (path.length > 128) throw new Error("unapproved_route");
  if (path.includes("..") || path.includes("//") || path.includes("\\")) {
    throw new Error("unapproved_route");
  }
  if (!/^\/v1\/duress\/peer\/[a-z][a-z0-9_-]{0,31}$/.test(path)) {
    throw new Error("unapproved_route");
  }
  return path;
}
