/** Shared return_to allowlist for Connect and GitHub App relays. */

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function extraAllowedOrigins() {
  const raw = (process.env.OPENSESAME_CONNECT_APP_ORIGINS ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "");
  return new Set(raw);
}

/** Allowed app return URL, or null. */
export function returnToAllowed(raw, requestHost) {
  let target;
  try {
    target = new URL(raw);
  } catch {
    return null;
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") return null;
  if (LOOPBACK_HOSTS.has(target.hostname)) return target;
  if (target.protocol === "https:") {
    if (target.origin === requestHost) return target;
    if (extraAllowedOrigins().has(target.origin)) return target;
  }
  return null;
}

/** CORS origin for browser callers of the convert proxy. */
export function corsOrigin(origin) {
  if (!origin) return null;
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    return null;
  }
  if (LOOPBACK_HOSTS.has(parsed.hostname)) return origin;
  if (
    parsed.protocol === "https:" &&
    extraAllowedOrigins().has(parsed.origin)
  ) {
    return origin;
  }
  return null;
}
