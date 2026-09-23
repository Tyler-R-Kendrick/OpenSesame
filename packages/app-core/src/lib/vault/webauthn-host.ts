/**
 * Whether this page can run a WebAuthn ceremony at all, and what to tell the
 * person when it cannot: relying-party ids must be DNS names, so a tab on a
 * raw IP is steered to `localhost` or a hostname before any prompt.
 */
import { maybePage } from "../../ports.js";
import { PrfCeremonyError } from "./protection/adapters/webauthn-prf-output.js";

/** True when `hostname` is a bare IPv4/IPv6 literal (not a DNS name). */
export function isIpHostname(hostname: string): boolean {
  const host = hostname.trim().replace(/^\[|\]$/g, "");
  if (!host) return false;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return true;
  // IPv6 (including compressed forms) — any colon means not a DNS label for us.
  return host.includes(":");
}

export type WebauthnHostCheck = {
  ok: boolean;
  hostname: string;
  /** Suggested same-path URL on a WebAuthn-compatible host, when we can offer one. */
  fixUrl: string | null;
  /** Short operator-facing diagnosis. */
  reason: string;
};

/** The hostname asked about, else this page's, else the one in `href`. */
function webauthnHost(hostname: string | undefined, href: string): string {
  const host = hostname?.trim() || (maybePage()?.location.hostname ?? "");
  if (host) return host;
  try {
    return new URL(href).hostname;
  } catch {
    return "localhost";
  }
}

/**
 * WebAuthn RP IDs must be DNS names. Chrome rejects `127.0.0.1` (and other IPs)
 * with `SecurityError: This is an invalid domain.` before any authenticator prompt.
 */
function checkWebauthnHostDefault(
  hostname?: string,
  href?: string,
): WebauthnHostCheck {
  const resolvedHref =
    href ?? maybePage()?.location.href ?? "http://localhost/";
  const host = webauthnHost(hostname, resolvedHref);
  if (!isIpHostname(host)) {
    return {
      ok: true,
      hostname: host,
      fixUrl: null,
      reason: "Origin uses a DNS hostname suitable for WebAuthn.",
    };
  }
  let fixUrl: string | null = null;
  try {
    const url = new URL(resolvedHref);
    if (host === "127.0.0.1" || host === "::1" || host === "0:0:0:0:0:0:0:1") {
      url.hostname = "localhost";
      fixUrl = url.toString();
    }
  } catch {
    /* ignore */
  }
  return {
    ok: false,
    hostname: host,
    fixUrl,
    reason:
      host === "127.0.0.1" || host === "::1"
        ? "This tab is on a loopback IP. Browsers reject passkeys on IP origins — use localhost instead."
        : `This tab is on IP ${host}. Passkeys require a DNS hostname (not a raw IP).`,
  };
}

/** Relying-party id for WebAuthn on this origin. */
export function webauthnRpId(
  hostname: string = maybePage()?.location.hostname ?? "localhost",
): string {
  const host = hostname.trim() || "localhost";
  // Never hand the browser an IP RP ID — preflight should have redirected first.
  if (isIpHostname(host)) return "localhost";
  return host;
}

export class WebauthnHostError extends Error {
  readonly check: WebauthnHostCheck;
  constructor(check: WebauthnHostCheck) {
    super(formatWebauthnHostError(check));
    this.name = "WebauthnHostError";
    this.check = check;
  }
}

export function formatWebauthnHostError(check: WebauthnHostCheck): string {
  if (check.fixUrl) {
    return `${check.reason} Open ${check.fixUrl} (same vault), then enroll again.`;
  }
  return `${check.reason} Open this app via a hostname (for example a Tailscale MagicDNS name or localhost), then enroll again.`;
}

export const webauthnHostSeams = {
  checkWebauthnHost: checkWebauthnHostDefault,
  describeWebauthnError: describeWebauthnErrorDefault,
};

export function checkWebauthnHost(
  hostname?: string,
  href?: string,
): WebauthnHostCheck {
  return webauthnHostSeams.checkWebauthnHost(hostname, href);
}

export function describeWebauthnError<Thrown>(error: Thrown): string {
  return webauthnHostSeams.describeWebauthnError(error);
}

/** Map browser WebAuthn failures into actionable copy. */
function describeWebauthnErrorDefault<Thrown>(error: Thrown): string {
  if (error instanceof WebauthnHostError) return error.message;
  if (error instanceof PrfCeremonyError) return error.message;
  if (!(error instanceof Error)) return "Passkey ceremony failed.";
  const name = error.name;
  const message = error.message.trim();
  if (
    name === "SecurityError" ||
    /invalid domain/i.test(message) ||
    /is an invalid domain/i.test(message)
  ) {
    const check = checkWebauthnHost();
    if (!check.ok) return formatWebauthnHostError(check);
    return "The browser rejected this origin for passkeys. Use a DNS hostname (localhost for local dev), not a raw IP address.";
  }
  if (name === "NotAllowedError") {
    return "Passkey was cancelled or timed out. Try again, or use a PIN / password unlock instead.";
  }
  if (name === "InvalidStateError") {
    return "A passkey for this site may already exist on this authenticator. Remove it from the OS password manager, or enroll on another device.";
  }
  if (name === "NotSupportedError") {
    return "This browser or authenticator does not support the passkey features OpenSesame needs (WebAuthn PRF). Use Chrome/Edge on a supported OS, or enroll a PIN / password instead.";
  }
  if (/receiving end does not exist/i.test(message)) {
    return "Your browser's passkey extension disconnected. Reload this page after reconnecting or unlocking it, then try again.";
  }
  return message || "Passkey ceremony failed.";
}

export function assertWebauthnHost(): WebauthnHostCheck {
  const check = checkWebauthnHost();
  if (!check.ok) throw new WebauthnHostError(check);
  return check;
}

/** Prefer localhost for loopback IPs so WebAuthn can run. */
export function localhostEquivalentHref(href?: string): string | null {
  return checkWebauthnHost(undefined, href).fixUrl;
}
