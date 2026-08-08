import { isIP } from "node:net";
import type { OAuthProviderEnv } from "../types.js";

export class UnsafeMetadataUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeMetadataUrlError";
  }
}

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "localhost.",
  "metadata.google.internal",
  "metadata",
  "instance-data",
]);

/**
 * SSRF-hardened metadata URL checker for experimental CIMD / remote client metadata.
 * Denies localhost, private IPs, link-local, and cloud metadata endpoints.
 */
export function assertSafeMetadataUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new UnsafeMetadataUrlError(`Invalid metadata URL: ${rawUrl}`);
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new UnsafeMetadataUrlError(`Unsupported protocol: ${url.protocol}`);
  }

  const host = url.hostname.toLowerCase().replace(/\.$/, "").replace(/^\[|\]$/g, "");
  if (BLOCKED_HOSTNAMES.has(host) || host.endsWith(".localhost")) {
    throw new UnsafeMetadataUrlError(`Blocked hostname: ${host}`);
  }

  if (host === "169.254.169.254" || host === "metadata.google.internal") {
    throw new UnsafeMetadataUrlError(`Blocked metadata host: ${host}`);
  }

  // WHATWG URL already normalizes decimal/octal/hex IPv4 (e.g. 2130706433) and
  // collapses IPv6, so literal checks run on the canonical host.
  if (isIP(host) && isPrivateOrSpecialIp(host)) {
    throw new UnsafeMetadataUrlError(`Blocked address: ${host}`);
  }

  return url;
}

/** Expand any IPv6 text form to exactly 8 numeric hextets. */
function expandIpv6(ip: string): number[] | null {
  let text = ip.toLowerCase();
  // Trailing dotted-quad (::ffff:127.0.0.1) becomes two hextets.
  const dotted = /^(.*:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(text);
  if (dotted) {
    const octets = dotted[2]!.split(".").map(Number);
    if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    const hi = ((octets[0]! << 8) | octets[1]!).toString(16);
    const lo = ((octets[2]! << 8) | octets[3]!).toString(16);
    text = `${dotted[1]}${hi}:${lo}`;
  }

  const [head, tail, ...rest] = text.split("::");
  if (rest.length > 0) return null;
  const parse = (part: string) =>
    part === "" ? [] : part.split(":").map((h) => Number.parseInt(h, 16));
  const left = parse(head ?? "");
  const right = tail === undefined ? [] : parse(tail);
  if ([...left, ...right].some((n) => Number.isNaN(n) || n < 0 || n > 0xffff)) {
    return null;
  }
  if (tail === undefined) {
    return left.length === 8 ? left : null;
  }
  const fill = 8 - left.length - right.length;
  if (fill < 0) return null;
  return [...left, ...Array.from({ length: fill }, () => 0), ...right];
}

function isPrivateOrSpecialIpv6(ip: string): boolean {
  const parts = expandIpv6(ip);
  // Unparseable IPv6 is treated as unsafe rather than allowed through.
  if (!parts) return true;

  const isZeroPrefix = parts.slice(0, 5).every((h) => h === 0);
  // IPv4-mapped (::ffff:0:0/96) and IPv4-compatible (::/96) carry an IPv4 target.
  if (isZeroPrefix && (parts[5] === 0xffff || parts[5] === 0)) {
    const hi = parts[6]!;
    const lo = parts[7]!;
    const embedded = `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
    if (embedded === "0.0.0.0") return true; // :: unspecified
    if (hi === 0 && lo === 1) return true; // ::1 loopback
    return isPrivateOrSpecialIpv4(embedded);
  }

  const first = parts[0]!;
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((first & 0xff00) === 0xff00) return true; // ff00::/8 multicast

  // NAT64 (64:ff9b::/96) and 6to4 (2002::/16) wrap an IPv4 destination that the
  // network will unwrap for us, so judge the address inside.
  const embedded = embeddedIpv4(parts);
  if (embedded) return isPrivateOrSpecialIpv4(embedded);
  return false;
}

/** The IPv4 address carried by a NAT64 or 6to4 address, if any. */
function embeddedIpv4(parts: number[]): string | null {
  const dotted = (hi: number, lo: number) =>
    `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
  if (
    parts[0] === 0x0064 &&
    parts[1] === 0xff9b &&
    parts.slice(2, 6).every((h) => h === 0)
  ) {
    return dotted(parts[6]!, parts[7]!);
  }
  if (parts[0] === 0x2002) {
    return dotted(parts[1]!, parts[2]!);
  }
  return null;
}

function isPrivateOrSpecialIpv4(ip: string): boolean {
  const parts = ip.split(".").map((p) => Number(p));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n))) return true;
  const [a, b] = parts as [number, number, number, number];
  if (a === 0) return true;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0) return true; // 192.0.0.0/24 protocol assignments
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a >= 224) return true; // multicast + reserved + broadcast
  return false;
}

function isPrivateOrSpecialIp(ip: string): boolean {
  return ip.includes(":") ? isPrivateOrSpecialIpv6(ip) : isPrivateOrSpecialIpv4(ip);
}

export interface MetadataFetchResult {
  url: string;
  body: string;
  contentType: string | null;
}

/**
 * Stub SafeMetadataFetcher — validates URL then optionally fetches when CIMD is enabled.
 * Does not follow redirects to private targets (redirects disabled).
 */
export class SafeMetadataFetcher {
  constructor(
    private readonly env: Pick<OAuthProviderEnv, "cimdEnabled">,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async fetch(rawUrl: string): Promise<MetadataFetchResult> {
    if (!this.env.cimdEnabled) {
      throw new UnsafeMetadataUrlError(
        "CIMD / remote client metadata fetch is disabled (OPENSESAME_CIMD_ENABLED)",
      );
    }
    const url = assertSafeMetadataUrl(rawUrl);
    const res = await this.fetchImpl(url, {
      redirect: "error",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) {
      throw new UnsafeMetadataUrlError(`Metadata fetch failed: HTTP ${res.status}`);
    }
    return {
      url: url.toString(),
      body: await res.text(),
      contentType: res.headers.get("content-type"),
    };
  }
}
