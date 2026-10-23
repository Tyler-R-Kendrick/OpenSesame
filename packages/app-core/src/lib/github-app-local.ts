import {
  type JsonObject,
  type JsonValue,
  isJsonObject,
  isString,
  overlapCast,
} from "@opensesame/os-domain";
/**
 * Local GitHub App record, claim, and install listing. The App's secret
 * (memory until sealed, then a bound vault item) lives in
 * `github-app-secret.ts`. Registration URLs live in `github-app-manifest.ts`.
 */
import { maybeLocalStore, sessionStore } from "../ports.js";
import { readGithubApp } from "./github-app-direct.js";
import {
  adoptLegacyPendingPem,
  forgetGithubAppSecret,
  pemFromVault as pemFromVaultForOwner,
  sealPendingGithubAppSecret,
} from "./github-app-secret.js";
import {
  captureGithubAuthority,
  invalidateGithubAppAuthority,
} from "./github-app-vault-transport.js";

export {
  hasPendingGithubAppSecret,
  pemFromVault,
  stashPendingGithubAppSecret,
} from "./github-app-secret.js";

const PUBLIC_KEY = "opensesame.github-app.public";
const STATE_KEY = "opensesame.github-app.state";

const localAppListeners = new Set<() => void>();

/** Subscribe to local GitHub App public-record writes (claim / refresh). */
export function subscribeLocalGithubApp(listener: () => void): () => void {
  localAppListeners.add(listener);
  return () => {
    localAppListeners.delete(listener);
  };
}

function notifyLocalGithubApp(): void {
  for (const listener of localAppListeners) listener();
}

/** Drop the local App record (uninstall on GitHub or Remove on this device). */
export function forgetLocalGithubApp(): void {
  const app = readLocalGithubApp();
  invalidateGithubAppAuthority();
  maybeLocalStore()?.removeItem(PUBLIC_KEY);
  forgetGithubAppSecret(app ?? undefined);
  try {
    sessionStore().removeItem(STATE_KEY);
  } catch {
    /* private mode */
  }
  const had = cachedPublicApp !== null || cachedPublicRaw !== null;
  cachedPublicRaw = null;
  cachedPublicApp = null;
  if (had) notifyLocalGithubApp();
}

export type LocalGithubInstall = {
  id: string;
  accountLogin: string;
  accountType: string;
};

export type LocalGithubApp = {
  id: string;
  key: string;
  displayName: string;
  htmlUrl: string | null;
  /** Account that owns / registered the App (e.g. Tyler-R-Kendrick). */
  ownerLogin: string | null;
  ownerType: string | null;
  /** GitHub user who installed the App (owner when they registered as a User). */
  installedByLogin: string | null;
  /** Orgs/users where the App is installed. */
  installations: LocalGithubInstall[];
};

export function readInstallations(
  value: JsonValue | undefined,
): LocalGithubInstall[] {
  if (!Array.isArray(value)) return [];
  const rows: LocalGithubInstall[] = [];
  for (const item of value) {
    const row = overlapCast(item);
    if (!isString(row.id) || !/^\d+$/u.test(row.id)) continue;
    if (!isString(row.accountLogin) || row.accountLogin === "") continue;
    rows.push({
      id: row.id,
      accountLogin: row.accountLogin,
      accountType: isString(row.accountType) ? row.accountType : "",
    });
  }
  return rows;
}

type GithubAppOwnerFields = {
  ownerLogin: string | null;
  ownerType: string | null;
};

export function ownerFromPayload(payload: JsonObject): GithubAppOwnerFields {
  // Accept the legacy flattened owner fields; native GitHub responses use
  // the nested owner object from conversion or an authenticated App read.
  if (isString(payload.ownerLogin) && payload.ownerLogin !== "") {
    return {
      ownerLogin: payload.ownerLogin,
      ownerType: isString(payload.ownerType) ? payload.ownerType : null,
    };
  }
  const owner = isJsonObject(payload.owner) ? payload.owner : null;
  const login = owner && isString(owner.login) ? owner.login : null;
  const type = owner && isString(owner.type) ? owner.type : null;
  return { ownerLogin: login, ownerType: type } satisfies GithubAppOwnerFields;
}

let cachedPublicRaw: string | null = null;
let cachedPublicApp: LocalGithubApp | null = null;

export function readLocalGithubApp(): LocalGithubApp | null {
  const app = readPublicRecord();
  adoptLegacyPendingPem(app);
  return app;
}

function readPublicRecord(): LocalGithubApp | null {
  const store = maybeLocalStore();
  if (!store) return null;
  const raw = store.getItem(PUBLIC_KEY);
  if (raw === cachedPublicRaw) return cachedPublicApp;
  cachedPublicRaw = raw;
  if (!raw) {
    cachedPublicApp = null;
    return null;
  }
  try {
    const parsed = overlapCast(JSON.parse(raw));
    if (!isString(parsed.id) || !isString(parsed.displayName)) {
      cachedPublicApp = null;
      return null;
    }
    const html = isString(parsed.htmlUrl) ? parsed.htmlUrl : null;
    cachedPublicApp = {
      id: parsed.id,
      key: isString(parsed.key) ? parsed.key : "github-oauth",
      displayName: parsed.displayName,
      htmlUrl: html?.startsWith("https://github.com/apps/") ? html : null,
      ownerLogin: isString(parsed.ownerLogin) ? parsed.ownerLogin : null,
      ownerType: isString(parsed.ownerType) ? parsed.ownerType : null,
      installedByLogin: isString(parsed.installedByLogin)
        ? parsed.installedByLogin
        : null,
      installations: readInstallations(parsed.installations),
    };
    return cachedPublicApp;
  } catch {
    cachedPublicApp = null;
    return null;
  }
}

export function rememberLocalGithubApp(app: LocalGithubApp): void {
  const store = maybeLocalStore();
  if (!store) return;
  const raw = JSON.stringify({
    id: app.id,
    key: app.key,
    displayName: app.displayName,
    htmlUrl: app.htmlUrl,
    ownerLogin: app.ownerLogin,
    ownerType: app.ownerType,
    installedByLogin: app.installedByLogin,
    installations: app.installations,
  });
  const previous = store.getItem(PUBLIC_KEY);
  store.setItem(PUBLIC_KEY, raw);
  cachedPublicRaw = raw;
  cachedPublicApp = app;
  // Identical writes must not notify — Presence reload → refresh → remember
  // would otherwise loop forever.
  if (previous !== raw) notifyLocalGithubApp();
}

/** Seal a pending App secret once a durable vault is unlocked. */
export async function sealPendingGithubAppPem(): Promise<void> {
  readLocalGithubApp();
  await sealPendingGithubAppSecret();
}

const emptyApp = (): LocalGithubApp => ({
  id: "",
  key: "github-oauth",
  displayName: "",
  htmlUrl: null,
  ownerLogin: null,
  ownerType: null,
  installedByLogin: null,
  installations: [],
});

/** Fill a missing owner through a locally signed, direct GitHub App read. */
export async function refreshGithubAppOwner(
  app: LocalGithubApp = readLocalGithubApp() ?? emptyApp(),
): Promise<LocalGithubApp | null> {
  if (app.id === "") return null;
  if (app.ownerLogin) return app;
  const pem = pemFromVaultForOwner(app);
  if (!pem) return app;
  let operation: ReturnType<typeof captureGithubAuthority> | null = null;
  try {
    operation = captureGithubAuthority({
      binding: () =>
        readLocalGithubApp() === app && pemFromVaultForOwner(app) === pem,
    });
    const payload = await readGithubApp(operation.transport, {
      appId: app.id,
      privateKey: pem,
    });
    operation.transport.assertCurrent();
    if (String(payload.id) !== app.id || !payload.owner) return app;
    const next: LocalGithubApp = {
      ...app,
      ownerLogin: payload.owner.login,
      ownerType: payload.owner.type,
    };
    rememberLocalGithubApp(next);
    return next;
  } catch {
    return readLocalGithubApp();
  } finally {
    operation?.close();
  }
}
