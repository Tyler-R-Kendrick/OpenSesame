import { kvGet, kvSet } from "./kv.js";

export type PagesSettings = {
  hostApi: string;
  identityApi: string;
  tursoUrl: string;
};

const PERSIST_KEY = "settings.v1";

type PersistedSettings = {
  hostApi: string;
  identityApi: string;
  tursoUrl: string;
};

const shippedHostApi = "http://127.0.0.1:8787";
const runtimeHostApi = import.meta.env.VITE_HOST_API?.trim();
const shippedIdentityApi = "http://localhost:8788";
const runtimeIdentityApi = import.meta.env.VITE_IDENTITY_API?.trim();

const defaults: PersistedSettings = {
  hostApi: runtimeHostApi || shippedHostApi,
  identityApi: runtimeIdentityApi || shippedIdentityApi,
  tursoUrl: "",
};

function loadPersisted(): PersistedSettings {
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
          parsed.identityApi.trim() === "http://127.0.0.1:8788"
        )
          ? parsed.identityApi.trim()
          : defaults.identityApi,
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
  const persisted: PersistedSettings = {
    hostApi: next.hostApi.trim() || defaults.hostApi,
    identityApi: next.identityApi.trim() || defaults.identityApi,
    tursoUrl: next.tursoUrl?.trim() ?? "",
  };
  kvSet(PERSIST_KEY, JSON.stringify(persisted));
}
