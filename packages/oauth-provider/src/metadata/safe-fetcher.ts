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

  const ipVersion = isIP(host);
  if (ipVersion && isPrivateOrSpecialIp(host)) {
    throw new UnsafeMetadataUrlError(`Blocked address: ${host}`);
  }

  return url;
}

function isPrivateOrSpecialIp(ip: string): boolean {
  if (ip === "0.0.0.0" || ip === "::" || ip === "::1") return true;

  if (ip.includes(":")) {
    const normalized = ip.toLowerCase();
    if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true; // ULA
    if (normalized.startsWith("fe80")) return true; // link-local
    if (normalized.startsWith("::ffff:")) {
      return isPrivateOrSpecialIp(normalized.slice("::ffff:".length));
    }
    return false;
  }

  const parts = ip.split(".").map((p) => Number(p));
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return true;
  const [a, b] = parts as [number, number, number, number];
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  return false;
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
