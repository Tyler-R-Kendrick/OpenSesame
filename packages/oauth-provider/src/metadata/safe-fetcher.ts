import { lookup as dnsLookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import { overlapCast } from "@opensesame/os-domain";
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

  const host = url.hostname
    .toLowerCase()
    .replace(/\.$/, "")
    .replace(/^\[|\]$/g, "");
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
    const octets = (dotted[2] ?? "").split(".").map(Number);
    if (
      octets.length !== 4 ||
      octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)
    )
      return null;
    const [a = 0, b = 0, c = 0, d = 0] = octets;
    const hi = ((a << 8) | b).toString(16);
    const lo = ((c << 8) | d).toString(16);
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
  const [
    first = 0xffff,
    ,
    ,
    ,
    ,
    sixth = 0xffff,
    seventh = 0xffff,
    eighth = 0xffff,
  ] = parts;

  const isZeroPrefix = parts.slice(0, 5).every((h) => h === 0);
  // IPv4-mapped (::ffff:0:0/96) and IPv4-compatible (::/96) carry an IPv4 target.
  if (isZeroPrefix && (sixth === 0xffff || sixth === 0)) {
    const hi = seventh;
    const lo = eighth;
    const embedded = `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
    if (embedded === "0.0.0.0") return true; // :: unspecified
    if (hi === 0 && lo === 1) return true; // ::1 loopback
    return isPrivateOrSpecialIpv4(embedded);
  }

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
  const [first, second, third, , , , seventh, eighth] = parts;
  if (
    first === 0x0064 &&
    second === 0xff9b &&
    parts.slice(2, 6).every((h) => h === 0)
  ) {
    return seventh === undefined || eighth === undefined
      ? null
      : dotted(seventh, eighth);
  }
  if (first === 0x2002) {
    return second === undefined || third === undefined
      ? null
      : dotted(second, third);
  }
  return null;
}

function isPrivateOrSpecialIpv4(ip: string): boolean {
  const parts = ip.split(".").map((p) => Number(p));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n)))
    return true;
  const a = parts[0] ?? -1;
  const b = parts[1] ?? -1;
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
  return ip.includes(":")
    ? isPrivateOrSpecialIpv6(ip)
    : isPrivateOrSpecialIpv4(ip);
}

export interface MetadataFetchResult {
  url: string;
  body: string;
  contentType: string | null;
}

const MAX_METADATA_BODY_BYTES = 64 * 1024;

/** Injected DNS lookup — `{ all: true }` so every resolved address is judged. */
export type MetadataDnsLookup = (
  hostname: string,
  options: { all: true },
) => Promise<Array<{ address: string; family: number }>>;

export interface PinnedMetadataResponse {
  status: number;
  contentType: string | null;
  body: string;
}

/**
 * HTTP(S) GET pinned to a resolved address, with SNI/Host of the original name.
 * Redirects are refused — a 3xx to a private IP must not be followed.
 */
export type MetadataTransport = (args: {
  url: URL;
  address: string;
  timeoutMs: number;
}) => Promise<PinnedMetadataResponse>;

export interface SafeMetadataFetcherOptions {
  lookup?: MetadataDnsLookup;
  transport?: MetadataTransport;
}

function hostnameOf(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, "");
}

/**
 * Resolve `url` and refuse if **any** address is private/special.
 * Literal IPs are judged without DNS.
 */
export async function resolveSafeMetadataAddresses(
  url: URL,
  lookupFn: MetadataDnsLookup,
): Promise<string[]> {
  const host = hostnameOf(url);
  if (isIP(host)) {
    if (isPrivateOrSpecialIp(host)) {
      throw new UnsafeMetadataUrlError(`Blocked address: ${host}`);
    }
    return [host];
  }
  let records: Array<{ address: string; family: number }>;
  try {
    records = await lookupFn(host, { all: true });
  } catch {
    throw new UnsafeMetadataUrlError(`DNS lookup failed for ${host}`);
  }
  if (!records.length) {
    throw new UnsafeMetadataUrlError(`No DNS records for ${host}`);
  }
  const addresses = [...new Set(records.map((r) => r.address))];
  for (const addr of addresses) {
    if (isPrivateOrSpecialIp(addr)) {
      throw new UnsafeMetadataUrlError(`Blocked resolved address: ${addr}`);
    }
  }
  return addresses;
}

// Exported for tests: the SSRF policy lives in SafeMetadataFetcher.fetch, this
// is the raw pinned GET it delegates to once an address is verified.
export function defaultPinnedTransport(args: {
  url: URL;
  address: string;
  timeoutMs: number;
}): Promise<PinnedMetadataResponse> {
  const { url, address, timeoutMs } = args;
  const proto = url.protocol === "https:" ? https : http;
  const port = url.port
    ? Number(url.port)
    : url.protocol === "https:"
      ? 443
      : 80;
  const servername = hostnameOf(url);
  const path = `${url.pathname}${url.search}` || "/";

  return new Promise((resolve, reject) => {
    const req = proto.request(
      {
        hostname: address,
        port,
        path,
        method: "GET",
        headers: {
          host: url.host,
          accept: "application/json",
        },
        timeout: timeoutMs,
        ...(url.protocol === "https:" ? { servername } : undefined),
        family: address.includes(":") ? 6 : 4,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          res.resume();
          reject(
            new UnsafeMetadataUrlError("Metadata fetch refused a redirect"),
          );
          return;
        }
        const contentType = headerToString(res.headers["content-type"]);
        if (!contentType.toLowerCase().includes("application/json")) {
          res.resume();
          reject(
            new UnsafeMetadataUrlError(
              "Metadata content-type must be application/json",
            ),
          );
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_METADATA_BODY_BYTES) {
            req.destroy();
            reject(new UnsafeMetadataUrlError("Metadata body exceeds 64KiB"));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          resolve({
            status,
            contentType,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
        res.on("error", reject);
      },
    );
    req.on("timeout", () => {
      req.destroy();
      reject(new UnsafeMetadataUrlError("Metadata fetch timed out"));
    });
    req.on("error", (err) => {
      reject(
        new UnsafeMetadataUrlError(`Metadata fetch failed: ${err.message}`),
      );
    });
    req.end();
  });
}

function headerToString(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value.join(", ");
  return value ?? "";
}

/**
 * SSRF-hardened metadata fetcher for experimental CIMD / remote client metadata.
 *
 * Hostname denylist is not enough: a public name can resolve to RFC1918 or
 * link-local metadata. Every resolved address is judged, then the GET is pinned
 * to a verified IP with the original name as SNI/Host (rewriting the URL to an
 * IP would break TLS). Redirects are disabled; body size and JSON content-type
 * are capped.
 */
export class SafeMetadataFetcher {
  constructor(
    private readonly env: Pick<OAuthProviderEnv, "cimdEnabled">,
    private readonly options: SafeMetadataFetcherOptions = {},
  ) {}

  async fetch(rawUrl: string): Promise<MetadataFetchResult> {
    if (!this.env.cimdEnabled) {
      throw new UnsafeMetadataUrlError(
        "CIMD / remote client metadata fetch is disabled (OPENSESAME_CIMD_ENABLED)",
      );
    }
    const url = assertSafeMetadataUrl(rawUrl);
    const lookupFn: MetadataDnsLookup =
      this.options.lookup ?? ((hostname) => dnsLookup(hostname, { all: true }));
    const addresses = await resolveSafeMetadataAddresses(url, lookupFn);
    const address = addresses[0];
    if (!address) throw new UnsafeMetadataUrlError("DNS returned no addresses");
    const transport = this.options.transport ?? defaultPinnedTransport;
    const res = await transport({
      url,
      address,
      timeoutMs: 5_000,
    });
    if (res.status < 200 || res.status >= 300) {
      throw new UnsafeMetadataUrlError(
        `Metadata fetch failed: HTTP ${res.status}`,
      );
    }
    return {
      url: url.toString(),
      body: res.body,
      contentType: res.contentType,
    };
  }
}
