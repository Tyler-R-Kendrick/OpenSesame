/**
 * Where this page is allowed to send things.
 *
 * Both API base URLs are settings a person types and the app then persists, so
 * they are attacker-influenced the moment anything can write our storage. One of
 * them carries authentication, so the destination has to be checked, not assumed.
 *
 * The checks themselves live in `@opensesame/api-client` alongside the fence the
 * extension already uses; there is one definition of "loopback" in this repo, not
 * one per surface.
 */
import {
  normalizeHttpBaseUrl,
  normalizeLoopbackBaseUrl,
} from "@opensesame/api-client";

function isLoopbackUrlDefault(raw: string): boolean {
  return normalizeLoopbackBaseUrl(raw) !== null;
}

export const urlSeams = {
  isLoopbackUrl: isLoopbackUrlDefault,
};

export function isLoopbackUrl(raw: string): boolean {
  return urlSeams.isLoopbackUrl(raw);
}

/**
 * Normalize an API base, or return null when it is not one this page may use:
 * http is confined to loopback, and embedded credentials, queries and fragments
 * are refused outright.
 */
export function normalizeApiBase(raw: string): string | null {
  return normalizeHttpBaseUrl(raw);
}

/** Loopback, https, Tailscale MagicDNS / CGNAT — for daemon pairing only. */
export function normalizeTailnetBase(raw: string): string | null {
  const allowed = normalizeHttpBaseUrl(raw);
  if (allowed) return allowed;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password || url.search || url.hash) return null;
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  const tailnetName = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(host);
  const tsNet = host.endsWith(".ts.net");
  const cgnat =
    /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}$/.test(host);
  if (!tsNet && !cgnat && !(url.protocol === "http:" && tailnetName)) {
    return null;
  }
  return `${url.origin}${url.pathname.replace(/\/$/, "")}`;
}

/**
 * Whether a base URL is this page's own origin.
 *
 * The session cookie is `SameSite=Lax`, so a browser drops it from a cross-site
 * POST anyway. Asking for it regardless invites a CSRF story nobody wrote: the
 * page would be relying on ambient credentials it cannot see travelling to an
 * origin it does not control.
 */
export function isSameOrigin(base: string): boolean {
  if (globalThis.location === undefined) return false;
  try {
    return (
      new URL(base, globalThis.location.href).origin ===
      globalThis.location.origin
    );
  } catch {
    return false;
  }
}

/** Send the ambient session only where it can legitimately be used. */
export function credentialsFor(base: string): RequestCredentials {
  return isSameOrigin(base) ? "include" : "omit";
}
