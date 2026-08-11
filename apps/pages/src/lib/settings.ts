import { kvGet, kvSet } from "./kv.js";
import { isLoopbackUrl, normalizeApiBase } from "./urls.js";

export type PagesSettings = {
  hostApi: string;
  identityApi: string;
};

const PERSIST_KEY = "settings.v1";

type PersistedSettings = {
  hostApi: string;
  identityApi: string;
};

const defaults: PersistedSettings = {
  hostApi: "http://127.0.0.1:8787",
  identityApi: "http://127.0.0.1:8788",
};

function loadPersisted(): PersistedSettings {
  try {
    const raw = kvGet(PERSIST_KEY);
    if (!raw) return { ...defaults };
    const parsed = JSON.parse(raw) as Partial<PersistedSettings> & {
      operatorToken?: string;
    };
    // Drop any legacy operatorToken that may have been written before this fence,
    // and refuse a persisted base we would not accept today: storage is not a
    // place where a destination gets to be trusted for having been written once.
    return {
      hostApi: normalizeApiBase(parsed.hostApi ?? "") ?? defaults.hostApi,
      identityApi:
        normalizeApiBase(parsed.identityApi ?? "") ?? defaults.identityApi,
    };
  } catch {
    return { ...defaults };
  }
}

function alignLocalIdentityHost(identityApi: string): string {
  if (typeof location === "undefined" || !isLoopbackUrl(location.origin)) {
    return identityApi;
  }
  if (!isLoopbackUrl(identityApi)) return identityApi;
  const page = new URL(location.href);
  const url = new URL(identityApi);
  url.hostname = page.hostname;
  return url.toString().replace(/\/$/, "");
}

export function loadSettings(): PagesSettings {
  const settings = loadPersisted();
  return {
    ...settings,
    identityApi: alignLocalIdentityHost(settings.identityApi),
  };
}

/** Thrown so the settings form can say which field it will not take. */
export class SettingsRejected extends Error {}

export function saveSettings(next: PagesSettings): void {
  const hostApi =
    normalizeApiBase(next.hostApi) ??
    (next.hostApi.trim() ? null : defaults.hostApi);
  const identityApi =
    normalizeApiBase(next.identityApi) ??
    (next.identityApi.trim() ? null : defaults.identityApi);
  if (hostApi === null) {
    throw new SettingsRejected(
      "Host API must be an https URL, or http on loopback.",
    );
  }
  if (identityApi === null) {
    throw new SettingsRejected(
      "Identity API must be an https URL, or http on loopback.",
    );
  }
  const persisted: PersistedSettings = { hostApi, identityApi };
  kvSet(PERSIST_KEY, JSON.stringify(persisted));
}
