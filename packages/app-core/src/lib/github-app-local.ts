import {
  type JsonObject,
  type JsonValue,
  isNumber,
  isString,
  overlapCast,
} from "@opensesame/os-domain";
import { createItem } from "@opensesame/vault-core";
/**
 * Local GitHub App record, PEM stash, claim, and install listing.
 * Registration URLs live in `github-app-manifest.ts`.
 */
import { maybeLocalStore, sessionStore } from "../ports.js";
import { readBoundedObject } from "./bounded-response.js";
import { githubAppRelayBase } from "./github-app-relay.js";
import { GUEST_TOMB, vaultStore } from "./vault/store.js";

const PUBLIC_KEY = "opensesame.github-app.public";
/** Held only until the vault can seal the PEM (claim may land before unlock). */
const PENDING_PEM_KEY = "opensesame.github-app.pending-pem";
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
  const store = maybeLocalStore();
  if (store) {
    store.removeItem(PUBLIC_KEY);
    store.removeItem(PENDING_PEM_KEY);
  }
  try {
    sessionStore().removeItem(PENDING_PEM_KEY);
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

export async function sealGithubAppSecret(
  name: string,
  secret: string,
): Promise<void> {
  const item = createItem("secret", name);
  item.value = secret;
  await vaultStore.addItems([item]);
}

export function clearPendingPemIfOwned(): void {
  if (!readLocalGithubApp()?.ownerLogin) return;
  // Guest cannot seal the PEM (wipe on lock). Keep pending until a durable vault.
  const snap = vaultStore.getSnapshot();
  if (snap.guest || snap.tomb === "guest") return;
  clearPendingPem();
}

export function stashPendingPem(secret: string): void {
  if (!secret.includes("PRIVATE KEY")) return;
  const store = maybeLocalStore();
  if (store) store.setItem(PENDING_PEM_KEY, secret);
  else sessionStore().setItem(PENDING_PEM_KEY, secret);
}

function clearPendingPem(): void {
  sessionStore().removeItem(PENDING_PEM_KEY);
  maybeLocalStore()?.removeItem(PENDING_PEM_KEY);
}

export function pendingPem(): string | null {
  const raw =
    maybeLocalStore()?.getItem(PENDING_PEM_KEY) ??
    sessionStore().getItem(PENDING_PEM_KEY);
  if (!raw || !raw.includes("PRIVATE KEY")) return null;
  const pemStart = raw.indexOf("-----BEGIN");
  return pemStart >= 0 ? raw.slice(pemStart) : raw.trim();
}

function extractPem(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.includes("BEGIN") && trimmed.includes("PRIVATE KEY")) {
    const pemStart = trimmed.indexOf("-----BEGIN");
    return pemStart >= 0 ? trimmed.slice(pemStart) : trimmed;
  }
  return null;
}

export function pemFromVault(appName: string): string | null {
  if (vaultStore.getSnapshot().tomb === GUEST_TOMB) return null;
  const pending = pendingPem();
  if (pending) return pending;
  const { status, items } = vaultStore.getSnapshot();
  if (status !== "unlocked") return null;
  for (const item of items) {
    if (item.kind !== "secret") continue;
    if (item.name !== appName) continue;
    const pem = extractPem(item.value);
    if (pem) return pem;
  }
  for (const item of items) {
    if (item.kind !== "secret") continue;
    const pem = extractPem(item.value);
    if (pem) return pem;
  }
  return null;
}

/** Seal a pending PEM once the vault is unlocked, then list installs. */
export async function sealPendingGithubAppPem(): Promise<void> {
  const app = readLocalGithubApp();
  const secret = pendingPem();
  if (!app || !secret) return;
  const { status, tomb } = vaultStore.getSnapshot();
  if (status !== "unlocked" || tomb === "guest") return;
  try {
    await sealGithubAppSecret(app.displayName, secret);
  } catch {
    // Stay pending until the next unlock.
  }
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
    clearPendingPemIfOwned();
    return next;
  } catch {
    return app;
  }
}
