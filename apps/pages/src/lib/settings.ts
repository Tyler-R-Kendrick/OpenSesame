import { kvGet, kvSet } from "./kv.js";

export type PagesSettings = {
  hostApi: string;
  identityApi: string;
  /** Session-only — never persisted (operator token must not live in durable browser storage). */
  operatorToken: string;
};

const PERSIST_KEY = "settings.v1";

/** In-memory operator token for the current tab session only. */
let sessionOperatorToken = "";

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
    // Drop any legacy operatorToken that may have been written before this fence.
    return {
      hostApi: parsed.hostApi?.trim() || defaults.hostApi,
      identityApi: parsed.identityApi?.trim() || defaults.identityApi,
    };
  } catch {
    return { ...defaults };
  }
}

export function loadSettings(): PagesSettings {
  const persisted = loadPersisted();
  return {
    ...persisted,
    operatorToken: sessionOperatorToken,
  };
}

export function saveSettings(next: PagesSettings): void {
  sessionOperatorToken = next.operatorToken.trim();
  const persisted: PersistedSettings = {
    hostApi: next.hostApi.trim() || defaults.hostApi,
    identityApi: next.identityApi.trim() || defaults.identityApi,
  };
  kvSet(PERSIST_KEY, JSON.stringify(persisted));
}
