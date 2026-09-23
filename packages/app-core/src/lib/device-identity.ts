/**
 * Device-native Identity plane (ADR 0118).
 *
 * When Settings has no remote Identity API, Pages *is* the identity host.
 * Callers keep using `identityBase` / `identityFetch`; this module decides
 * whether those resolve to the in-tab host or a networked control-plane.
 */

import { isString } from "@opensesame/os-domain";
import { env } from "../host.js";
import { maybePage } from "../ports.js";
import { deviceIdentityFetch } from "./device-identity-host.js";
import { localNetworkFetch } from "./local-network-fetch.js";
import { loadSettings } from "./settings.js";

const IDENTITY_FETCH_MS = 8000;

/** Fallback issuer when `location` is unavailable (Vitest node). */
const DEVICE_FALLBACK_BASE = "https://device.identity.local";

export const deviceIdentitySeams = {
  remoteIdentityApi(): string {
    return (loadSettings().identityApi ?? "").replace(/\/$/, "");
  },
};

/** Remote Identity API from settings — empty means device-native mode. */
export function remoteIdentityApi(): string {
  return deviceIdentitySeams.remoteIdentityApi();
}

export function isRemoteIdentityConfigured(): boolean {
  return remoteIdentityApi().length > 0;
}

/** True when this tab serves the Identity plane itself. */
export function isDeviceIdentityMode(): boolean {
  return !isRemoteIdentityConfigured();
}

/**
 * Public base for the active Identity plane: configured remote URL, else this
 * Pages origin (the device-native host).
 */
export function resolveIdentityBase(): string {
  const remote = remoteIdentityApi();
  if (remote) return remote;
  return pagesIdentityPublicBase();
}

/** Origin + Vite base, no trailing slash — the device identity issuer URL. */
export function pagesIdentityPublicBase(
  origin = maybePage()?.location.origin ?? "",
  base = env().BASE_URL || "/",
): string {
  if (!isString(origin) || origin.length === 0) {
    return DEVICE_FALLBACK_BASE;
  }
  try {
    return new URL(base, origin).href.replace(/\/$/, "");
  } catch {
    return DEVICE_FALLBACK_BASE;
  }
}

export function deviceIdentityOrigin(): string {
  try {
    return new URL(resolveIdentityBase()).origin;
  } catch {
    return DEVICE_FALLBACK_BASE;
  }
}

/**
 * Every Identity-plane HTTP call goes here so device mode never hits the
 * network and remote mode keeps one timeout/credentials path.
 */
export async function identityPlaneRequest(
  path: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<Response> {
  if (isDeviceIdentityMode()) {
    return deviceIdentityFetch(path, init);
  }
  const { timeoutMs = IDENTITY_FETCH_MS, ...rest } = init;
  return localNetworkFetch(`${resolveIdentityBase()}${path}`, {
    ...rest,
    timeoutMs,
  });
}
