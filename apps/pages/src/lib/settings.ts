import {
  type CapabilityConnectorMap,
  defaultCapabilityConnectors,
  normalizeCapabilityConnectors,
} from "./capabilities.js";
import { kvGet, kvSet, kvSetDurable } from "./kv.js";
import { isLoopbackUrl, normalizeTailnetBase } from "./urls.js";

export type PagesSettings = {
  hostApi: string;
  identityApi: string;
  daemonApi: string;
  tursoUrl: string;
  /** Optional Mobile MFA PWA URL for passkey ceremony handoff QR. */
  mfaAppUrl: string;
  /** Capability → Host connector bindings (encryption, git history, …). */
  capabilityConnectors: CapabilityConnectorMap;
  /**
   * Active Host project id for secrets/env scope (outside the encrypted vault).
   * Empty until personal/ensure or the operator picks a project.
   */
  activeProjectId?: string;
};

const PERSIST_KEY = "settings.v1";

type PersistedSettings = {
  hostApi: string;
  identityApi: string;
  daemonApi: string;
  tursoUrl: string;
  mfaAppUrl: string;
  capabilityConnectors: CapabilityConnectorMap;
  activeProjectId: string;
};

/** Local Host for `pages-dev.sh` — avoids the common :8787 collision. */
export const shippedHostApi = "http://127.0.0.1:18787";
/** Local Identity for `pages-dev.sh` — avoids the common :8788 collision. */
export const shippedIdentityApi = "http://127.0.0.1:18788";
export const shippedDaemonApi = "http://127.0.0.1:18790";
export const shippedMfaAppUrl = "http://127.0.0.1:5177";

/** Legacy loopback endpoints we replace when VITE_* is set at runtime. */
const LEGACY_HOST_APIS = [
  shippedHostApi,
  "http://127.0.0.1:8787",
  "http://localhost:8787",
  "http://localhost:18787",
] as const;
const LEGACY_IDENTITY_APIS = [
  shippedIdentityApi,
  "http://127.0.0.1:8788",
  "http://localhost:8788",
  "http://localhost:18788",
] as const;

const runtimeHostApi = import.meta.env.VITE_HOST_API?.trim();
const runtimeIdentityApi = import.meta.env.VITE_IDENTITY_API?.trim();
const runtimeDaemonApi = import.meta.env.VITE_DAEMON_API?.trim();
const runtimeMfaAppUrl = import.meta.env.VITE_MFA_APP_URL?.trim();

const listeners = new Set<() => void>();

/** True when this tab is served from the same machine it can reach on loopback. */
export function pageIsLoopback(
  hostname: string | undefined = typeof location === "undefined"
    ? "127.0.0.1"
    : location.hostname,
): boolean {
  return (
    hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]"
  );
}

function localDefaults(): PersistedSettings {
  return {
    hostApi: runtimeHostApi || shippedHostApi,
    identityApi: runtimeIdentityApi || shippedIdentityApi,
    daemonApi: runtimeDaemonApi || shippedDaemonApi,
    tursoUrl: "",
    mfaAppUrl: runtimeMfaAppUrl || shippedMfaAppUrl,
    capabilityConnectors: defaultCapabilityConnectors(),
    activeProjectId: "",
  };
}

function remoteDefaults(): PersistedSettings {
  return {
    hostApi: runtimeHostApi || "",
    identityApi: runtimeIdentityApi || "",
    // github.io cannot reach loopback — leave empty so the pairing UI asks for
    // the Tailscale Serve FQDN instead of looking like localhost will work.
    daemonApi: runtimeDaemonApi || "",
    tursoUrl: "",
    // Remote Pages: operator must point at a reachable MFA PWA.
    mfaAppUrl: runtimeMfaAppUrl || "",
    capabilityConnectors: defaultCapabilityConnectors(),
    activeProjectId: "",
  };
}

function defaultsForPage(): PersistedSettings {
  return pageIsLoopback() ? localDefaults() : remoteDefaults();
}

function loadPersisted(): PersistedSettings {
  const defaults = defaultsForPage();
  try {
    const raw = kvGet(PERSIST_KEY);
    if (!raw) return { ...defaults };
    const parsed = JSON.parse(raw) as Partial<PersistedSettings> & {
      capabilityConnectors?: Partial<CapabilityConnectorMap>;
    };
    return {
      hostApi:
        parsed.hostApi?.trim() &&
        !(
          runtimeHostApi &&
          (LEGACY_HOST_APIS as readonly string[]).includes(
            parsed.hostApi.trim(),
          )
        )
          ? parsed.hostApi.trim()
          : defaults.hostApi,
      identityApi:
        parsed.identityApi?.trim() &&
        !(
          runtimeIdentityApi &&
          (LEGACY_IDENTITY_APIS as readonly string[]).includes(
            parsed.identityApi.trim(),
          )
        )
          ? parsed.identityApi.trim()
          : defaults.identityApi,
      daemonApi: parsed.daemonApi?.trim() || defaults.daemonApi,
      tursoUrl: parsed.tursoUrl?.trim() || "",
      mfaAppUrl:
        parsed.mfaAppUrl !== undefined
          ? parsed.mfaAppUrl.trim()
          : defaults.mfaAppUrl,
      capabilityConnectors: normalizeCapabilityConnectors(
        parsed.capabilityConnectors,
      ),
      activeProjectId:
        typeof parsed.activeProjectId === "string"
          ? parsed.activeProjectId.trim()
          : defaults.activeProjectId,
    };
  } catch {
    return { ...defaults };
  }
}

export function loadSettings(): PagesSettings {
  return loadPersisted();
}

/**
 * Bumped on every write, so a component can re-render for a changed base URL
 * without owning a probe of its own. Reachability is the monitor's job; this
 * is only "the configured value moved".
 */
let epoch = 0;

export function settingsEpoch(): number {
  return epoch;
}

function emitSettings(): void {
  epoch += 1;
  for (const listener of listeners) listener();
}

export function subscribeSettings(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function persistShape(next: PagesSettings): PersistedSettings {
  const defaults = defaultsForPage();
  return {
    hostApi: next.hostApi.trim() || defaults.hostApi,
    identityApi: next.identityApi.trim() || defaults.identityApi,
    daemonApi: next.daemonApi.trim() || defaults.daemonApi,
    tursoUrl: next.tursoUrl?.trim() ?? "",
    mfaAppUrl: next.mfaAppUrl?.trim() ?? "",
    capabilityConnectors: normalizeCapabilityConnectors(
      next.capabilityConnectors ?? defaults.capabilityConnectors,
    ),
    activeProjectId: next.activeProjectId?.trim() ?? "",
  };
}

export function saveSettings(next: PagesSettings): void {
  kvSet(PERSIST_KEY, JSON.stringify(persistShape(next)));
  emitSettings();
}

/** Persist pairing and wait for OPFS so a reload in this browser keeps Host. */
export async function saveSettingsDurable(next: PagesSettings): Promise<void> {
  await kvSetDurable(PERSIST_KEY, JSON.stringify(persistShape(next)));
  emitSettings();
}

/**
 * Host/daemon already pointed at a reachable-from-github.io endpoint — do not
 * demand "Connect this machine" again until the operator clears Settings.
 */
export function hasRemoteHostPairing(
  settings: PagesSettings = loadSettings(),
): boolean {
  const host = settings.hostApi.trim();
  if (host && !isLoopbackUrl(host)) return true;
  const daemon = settings.daemonApi.trim();
  if (!daemon || isLoopbackUrl(daemon)) return false;
  return normalizeTailnetBase(daemon) !== null;
}

/** Auto-connect Identity only when this page can actually reach it. */
export function shouldAutoConnect(
  settings: PagesSettings = loadSettings(),
  hostname?: string,
): boolean {
  const identity = settings.identityApi.trim();
  if (!identity) return false;
  if (pageIsLoopback(hostname)) return true;
  return !isLoopbackUrl(identity);
}
