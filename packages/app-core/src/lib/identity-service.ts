/**
 * The sign-in service address — the one setting that lets an Identity service
 * send email and text codes as a second step (ADR 0091). Reading and writing
 * it is one place, so Settings › Security, Setup and the Access panel cannot
 * disagree about what a valid address is.
 *
 * Whether the service is reachable is not decided here: a device with no
 * network still keeps the address, and sending a code reports its own failure.
 */
import { applyWaysInPatch } from "../screens/setup/ways-in-patch.js";
import { remoteIdentityApi } from "./device-identity.js";
import { defaultIdentityApi, loadSettings, saveSettings } from "./settings.js";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * The origin-and-path a person typed, without a trailing slash — or null when
 * it is not an address a code may be requested from. https anywhere; http only
 * on this machine, where there is no wire to protect.
 */
export function normalizeSignInService(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.username || url.password || url.search || url.hash) return null;
  const secure = url.protocol === "https:";
  const local = url.protocol === "http:" && LOOPBACK.has(url.hostname);
  if (!secure && !local) return null;
  return url.href.replace(/\/+$/, "");
}

/** The address kept on this device, or "" when there is none. */
export function readSignInService(): string {
  return remoteIdentityApi();
}

/** Keep `address` (already normalised). Everything else in Settings stands. */
export function writeSignInService(address: string): void {
  saveSettings(applyWaysInPatch(loadSettings(), { identityApi: address }));
}

/**
 * True when the address in use is the one the deployment supplies. Forgetting
 * it would fall straight back to it, so there is nothing to forget: Change
 * overrides it, and Remove is not offered.
 */
export function signInServiceIsDeployed(): boolean {
  const deployed = defaultIdentityApi().trim().replace(/\/+$/, "");
  return deployed.length > 0 && readSignInService() === deployed;
}

/** Forget the address; email and text codes stop being offered. */
export function clearSignInService(): void {
  writeSignInService("");
}
