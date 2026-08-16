import { kvGet, kvSet, kvSetDurable } from "./kv.js";
import { isLoopbackUrl, normalizeTailnetBase } from "./urls.js";

export type PagesSettings = {
  hostApi: string;
  identityApi: string;
  daemonApi: string;
  tursoUrl: string;
};

const PERSIST_KEY = "settings.v1";

type PersistedSettings = {
  hostApi: string;
  identityApi: string;
  daemonApi: string;
  tursoUrl: string;
};

export const shippedHostApi = "http://127.0.0.1:8787";
export const shippedIdentityApi = "http://127.0.0.1:8788";
export const shippedDaemonApi = "http://127.0.0.1:18790";

const runtimeHostApi = import.meta.env.VITE_HOST_API?.trim();
const runtimeIdentityApi = import.meta.env.VITE_IDENTITY_API?.trim();
const runtimeDaemonApi = import.meta.env.VITE_DAEMON_API?.trim();

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
    const parsed = JSON.parse(raw) as Partial<PersistedSettings>;
    return {
      hostApi:
        parsed.hostApi?.trim() &&
        !(
          runtimeHostApi &&
          [shippedHostApi, "http://127.0.0.1:18787"].includes(
            parsed.hostApi.trim(),
          )
        )
          ? parsed.hostApi.trim()
          : defaults.hostApi,
      identityApi:
        parsed.identityApi?.trim() &&
        !(
          runtimeIdentityApi &&
          [shippedIdentityApi, "http://localhost:8788"].includes(
            parsed.identityApi.trim(),
          )
        )
          ? parsed.identityApi.trim()
          : defaults.identityApi,
      daemonApi: parsed.daemonApi?.trim() || defaults.daemonApi,
      tursoUrl: parsed.tursoUrl?.trim() || "",
    };
  } catch {
    return { ...defaults };
  }
}

export function loadSettings(): PagesSettings {
  return loadPersisted();
}

function emitSettings(): void {
  for (const listener of listeners) listener();
}

export function subscribeSettings(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function saveSettings(next: PagesSettings): void {
  const defaults = defaultsForPage();
  const persisted: PersistedSettings = {
    hostApi: next.hostApi.trim() || defaults.hostApi,
    identityApi: next.identityApi.trim() || defaults.identityApi,
    daemonApi: next.daemonApi.trim() || defaults.daemonApi,
    tursoUrl: next.tursoUrl?.trim() ?? "",
  };
  kvSet(PERSIST_KEY, JSON.stringify(persisted));
  emitSettings();
}

/** Persist pairing and wait for OPFS so a reload in this browser keeps Host. */
export async function saveSettingsDurable(next: PagesSettings): Promise<void> {
  const defaults = defaultsForPage();
  const persisted: PersistedSettings = {
    hostApi: next.hostApi.trim() || defaults.hostApi,
    identityApi: next.identityApi.trim() || defaults.identityApi,
    daemonApi: next.daemonApi.trim() || defaults.daemonApi,
    tursoUrl: next.tursoUrl?.trim() ?? "",
  };
  await kvSetDurable(PERSIST_KEY, JSON.stringify(persisted));
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
