/**
 * Where this page is allowed to send things.
 *
 * Both API base URLs are settings a person types and the app then persists, so
 * they are attacker-influenced the moment anything can write our storage. One of
 * them receives the operator token — a secret shared between processes on one
 * machine — so the destination has to be checked, not assumed.
 */

export function isLoopbackUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  const host = url.hostname
    .toLowerCase()
    .replace(/^\[|\]$/gu, "")
    .replace(/\.$/u, "");
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "::1" || host === "0:0:0:0:0:0:0:1") return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/u.test(host);
}

/**
 * Normalize an API base, or return null when it is not one this page may use:
 * http is confined to loopback, and embedded credentials are refused outright.
 */
export function normalizeApiBase(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  const base = `${url.origin}${url.pathname.replace(/\/+$/u, "")}`;
  if (url.protocol === "http:" && !isLoopbackUrl(base)) return null;
  return base;
}

/**
 * The operator token is only ever offered to this machine. A remote Host API is
 * somebody else's listener as far as that secret is concerned.
 */
export function operatorHeadersFor(
  base: string,
  operatorToken: string,
): Record<string, string> {
  if (!operatorToken || !isLoopbackUrl(base)) return {};
  return { authorization: `Bearer operator:${operatorToken}` };
}
