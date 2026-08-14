import { kvGet, kvSet } from "./kv.js";
import { isLoopbackUrl } from "./urls.js";

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
    daemonApi: runtimeDaemonApi || shippedDaemonApi,
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

export function saveSettings(next: PagesSettings): void {
  const defaults = defaultsForPage();
  const persisted: PersistedSettings = {
    hostApi: next.hostApi.trim() || defaults.hostApi,
    identityApi: next.identityApi.trim() || defaults.identityApi,
    daemonApi: next.daemonApi.trim() || defaults.daemonApi,
    tursoUrl: next.tursoUrl?.trim() ?? "",
  };
  kvSet(PERSIST_KEY, JSON.stringify(persisted));
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
