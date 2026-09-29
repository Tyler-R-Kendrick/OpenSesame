/**
 * Host match patterns for the companion's optional permissions.
 *
 * A match pattern carries no port: Firefox refuses one, and Chromium matches
 * every port of a host when none is given. So a grant covers one scheme and
 * one host; the exact origin — scheme, host *and* port — is enforced three
 * more times on every fill: by the guard (`location.origin`), by the
 * background (the browser-reported sender origin against the switched-on
 * origin), and by the daemon (the entry's declared URL).
 */
import { ENDPOINTS } from "@opensesame/os-domain";

/** The local daemon, loopback only (ADR 0048). */
export const DAEMON_BASE: string = ENDPOINTS.daemon.default;

/** `https://example.com/*` for `https://example.com:8443`; null for non-web. */
export function hostPattern(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  if (!parsed.hostname) return null;
  return `${parsed.protocol}//${parsed.hostname}/*`;
}

const daemon = new URL(DAEMON_BASE);

/** The daemon's loopback host, requested with the first site switched on. */
export const DAEMON_PATTERN = `${daemon.protocol}//${daemon.hostname}/*`;
