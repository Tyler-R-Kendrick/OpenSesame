import {
  type JsonObject,
  type JsonValue,
  isNumber,
  isString,
  overlapCast,
} from "@opensesame/os-domain";
/**
 * Local GitHub App record, claim, and install listing. The App's secret
 * (memory until sealed, then a bound vault item) lives in
 * `github-app-secret.ts`. Registration URLs live in `github-app-manifest.ts`.
 */
import { maybeLocalStore, sessionStore } from "../ports.js";
import { readBoundedObject } from "./bounded-response.js";
import { githubAppRelayBase } from "./github-app-relay.js";
import {
  adoptLegacyPendingPem,
  forgetGithubAppSecret,
  sealPendingGithubAppSecret,
} from "./github-app-secret.js";

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
  maybeLocalStore()?.removeItem(PUBLIC_KEY);
  forgetGithubAppSecret();
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
  // Prefer top-level fields the relay adds from JWT GET /app; fall back to
  // GitHub's nested `owner` object from convert / public lookup.
  if (isString(payload.ownerLogin) && payload.ownerLogin !== "") {
    return {
      ownerLogin: payload.ownerLogin,
      ownerType: isString(payload.ownerType) ? payload.ownerType : null,
    };
  }
  const owner = overlapCast(payload.owner);
  const login = isString(owner.login) ? owner.login : null;
  const type = isString(owner.type) ? owner.type : null;
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

function slugFromHtmlUrl(htmlUrl: string | null): string | null {
  if (!htmlUrl) return null;
  const match = /github\.com\/apps\/([^/?#]+)/u.exec(htmlUrl);
  return match?.[1] ?? null;
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

/** Fill owner from the public apps card when convert omitted it. */
export async function refreshGithubAppOwner(
  app: LocalGithubApp = readLocalGithubApp() ?? emptyApp(),
): Promise<LocalGithubApp | null> {
  if (app.id === "") return null;
  if (app.ownerLogin) return app;
  const slug = slugFromHtmlUrl(app.htmlUrl);
  if (!slug) return app;
  const base = githubAppRelayBase();
  if (base === "") return app;
  try {
    const response = await fetch(`${base}/api/github-app/lookup`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ slug }),
    });
    const payload = overlapCast(
      await readBoundedObject(response, 16384, 8000).catch(() => null),
    );
    if (!response.ok || !isString(payload.ownerLogin)) return app;
    const ownerType = isString(payload.ownerType) ? payload.ownerType : null;
    const next: LocalGithubApp = {
      ...app,
      ownerLogin: payload.ownerLogin,
      ownerType,
    };
    rememberLocalGithubApp(next);
    return next;
  } catch {
    return app;
  }
}
