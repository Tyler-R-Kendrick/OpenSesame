const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/**
 * Base URL for a service that may legitimately be remote. Plaintext HTTP is
 * confined to loopback. Returns a normalized origin+path, or null when unusable.
 */
export function normalizeHttpBaseUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  if (url.search || url.hash) return null;
  const normalized = `${url.origin}${url.pathname.replace(/\/$/, "")}`;
  if (
    url.protocol === "http:" &&
    normalizeLoopbackBaseUrl(normalized) === null
  ) {
    return null;
  }
  return normalized;
}

/** Loopback http(s) only — same fence the relay bind uses locally. */
export function normalizeLoopbackBaseUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  const isLoopbackV4 = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
  if (
    !LOOPBACK_HOSTS.has(host) &&
    !host.endsWith(".localhost") &&
    !isLoopbackV4
  ) {
    return null;
  }
  if (url.search || url.hash) return null;
  return `${url.origin}${url.pathname.replace(/\/$/, "")}`;
}
