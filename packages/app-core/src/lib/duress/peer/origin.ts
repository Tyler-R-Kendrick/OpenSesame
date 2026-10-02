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

function parseIpv6Groups(part: string): number[] | null {
  if (part === "") return [];
  const out: number[] = [];
  for (const group of part.split(":")) {
    if (group === "" || group.length > 4 || !/^[0-9a-fA-F]+$/.test(group)) {
      return null;
    }
    out.push(Number.parseInt(group, 16));
  }
  return out;
}

function parseIpv6(host: string): Uint8Array | null {
  const h = host.startsWith("[") ? host.slice(1, -1) : host;
  if (!h.includes(":")) return null;
  const halves = h.split("::");
  if (halves.length > 2) return null;
  const head = parseIpv6Groups(halves[0] ?? "");
  const tail = halves.length === 2 ? parseIpv6Groups(halves[1] ?? "") : [];
  if (head === null || tail === null) return null;
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const groups = [...head, ...new Array<number>(missing).fill(0), ...tail];
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    const g = groups[i] ?? 0;
    bytes[i * 2] = (g >> 8) & 0xff;
    bytes[i * 2 + 1] = g & 0xff;
  }
  return bytes;
}

function mappedIpv4(bytes: Uint8Array): string | null {
  const head = bytes.slice(0, 10);
  if (!head.every((b) => b === 0) || bytes[10] !== 0xff || bytes[11] !== 0xff) {
    return null;
  }
  return `${bytes[12] ?? 0}.${bytes[13] ?? 0}.${bytes[14] ?? 0}.${bytes[15] ?? 0}`;
}

function isBlockedIpv6Network(bytes: Uint8Array): boolean {
  const b0 = bytes[0] ?? 0;
  const b1 = bytes[1] ?? 0;
  if ((b0 & 0xfe) === 0xfc) return true;
  if (b0 === 0xfe && (b1 & 0xc0) === 0x80) return true;
  if (b0 === 0xff) return true;
  return b0 === 0x20 && b1 === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8;
}

function isBlockedIpv6(host: string): boolean {
  const bytes = parseIpv6(host);
  if (!bytes) return false;
  if (bytes.every((b) => b === 0)) return true;
  const mapped = mappedIpv4(bytes);
  if (mapped !== null) return isBlockedIpv4(mapped);
  return isBlockedIpv6Network(bytes);
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

/** A hostname still has to be resolved. Address literals are already classified. */
export function peerHostnameNeedsResolution(host: string): boolean {
  return !isIpv4(host) && parseIpv6(host) === null;
}

/**
 * One DNS answer for a peer name. Loopback is blocked here even though a
 * literal loopback origin is allowed: a name must not retarget onto it.
 */
export function resolvedPeerAddressBlocked(address: string): boolean {
  const host = address.trim().toLowerCase();
  if (host.length === 0 || host.includes("%") || host.includes("/"))
    return true;
  if (BLOCKED_HOSTS.has(host) || isLoopbackHost(host)) return true;
  if (isBlockedIpv4(host) || isBlockedIpv6(host)) return true;
  return !isIpv4(host) && parseIpv6(host) === null;
}

function assertPeerProtocolAllowed(url: URL, host: string): void {
  const loopback = isLoopbackHost(host);
  if (url.protocol === "https:") {
    if (!loopback && (isBlockedIpv4(host) || isBlockedIpv6(host))) {
      throw new Error("unapproved_route");
    }
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
