import { isString, overlapCast } from "@opensesame/os-domain";
import { createItem } from "@opensesame/vault-core";
/**
 * The GitHub App's private key and client secret, from claim to seal.
 *
 * A claim can land before any durable vault is open, so the secret waits in
 * module memory — never in `localStorage` or `sessionStorage`, which every
 * page on a shared github.io origin can read — until an unlocked, non-guest
 * vault seals it. The memory copy is dropped the moment the seal lands.
 *
 * The sealed item is bound by id to the App it belongs to. Nothing here ever
 * falls back to "some private key in the vault": an unrelated SSH key must
 * never be mistaken for the App key and posted to the relay.
 */
import {
  type WebStorage,
  maybeLocalStore,
  maybeSessionStore,
} from "../ports.js";
import { GUEST_TOMB, vaultStore } from "./vault/store.js";

/** Where earlier builds parked the PEM in the clear. Only ever removed. */
const LEGACY_PENDING_PEM_KEY = "opensesame.github-app.pending-pem";
/** `{ appId, itemId }` — which vault item holds the App's secret. No value. */
const BINDING_KEY = "opensesame.github-app.secret-item";

export type GithubAppRef = { id: string; displayName: string };

type PendingSecret = { appId: string; name: string; secret: string };
type SecretBinding = { appId: string; itemId: string };

let pending: PendingSecret | null = null;
let sealing: Promise<void> | null = null;
let stopWatchingVault: (() => void) | null = null;

/** Only an `RSA PRIVATE KEY` or PKCS#8 `PRIVATE KEY` block, END line included. */
const APP_PEM_BLOCK =
  /-----BEGIN ((?:RSA )?PRIVATE KEY)-----[A-Za-z0-9+/=\s]+?-----END \1-----/u;

/** The one App-key PEM block in `value`, or null. Never runs past its END. */
export function extractGithubAppPem(value: string): string | null {
  const match = APP_PEM_BLOCK.exec(value);
  return match ? match[0] : null;
}

function readStorage(
  store: WebStorage | undefined,
  key: string,
): string | null {
  try {
    return store?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function removeStorage(store: WebStorage | undefined, key: string): void {
  try {
    store?.removeItem(key);
  } catch {
    /* private mode */
  }
}

function sessionOrNone(): WebStorage | undefined {
  try {
    return maybeSessionStore();
  } catch {
    return undefined;
  }
}

/**
 * Remove the cleartext PEM an earlier build left in web storage. When an App
 * record is known and nothing is pending, the value moves into memory so the
 * next unlock can still seal it; the storage key is gone either way.
 */
export function adoptLegacyPendingPem(app: GithubAppRef | null): void {
  const local = maybeLocalStore();
  const session = sessionOrNone();
  const raw =
    readStorage(local, LEGACY_PENDING_PEM_KEY) ??
    readStorage(session, LEGACY_PENDING_PEM_KEY);
  if (raw === null) return;
  removeStorage(local, LEGACY_PENDING_PEM_KEY);
  removeStorage(session, LEGACY_PENDING_PEM_KEY);
  if (app && app.id !== "" && !pending) stashPendingGithubAppSecret(app, raw);
}

function readBinding(): SecretBinding | null {
  const raw = readStorage(maybeLocalStore(), BINDING_KEY);
  if (!raw) return null;
  try {
    const row = overlapCast(JSON.parse(raw));
    if (!isString(row.appId) || !isString(row.itemId)) return null;
    return { appId: row.appId, itemId: row.itemId };
  } catch {
    return null;
  }
}

function writeBinding(binding: SecretBinding): void {
  try {
    maybeLocalStore()?.setItem(BINDING_KEY, JSON.stringify(binding));
  } catch {
    /* private mode — the exact-name lookup still finds it */
  }
}

function durableVaultOpen(): boolean {
  const { status, tomb, guest } = vaultStore.getSnapshot();
  return status === "unlocked" && !guest && tomb !== GUEST_TOMB;
}

function watchVaultUntilSealed(): void {
  if (stopWatchingVault) return;
  stopWatchingVault = vaultStore.subscribe(() => {
    if (pending && durableVaultOpen()) void sealPendingGithubAppSecret();
  });
}

/** Hold a freshly claimed secret in memory until a durable vault seals it. */
export function stashPendingGithubAppSecret(
  app: GithubAppRef,
  secret: string,
): void {
  if (secret.trim() === "" || app.id === "") return;
  pending = { appId: app.id, name: app.displayName, secret };
  watchVaultUntilSealed();
}

export function hasPendingGithubAppSecret(appId: string): boolean {
  return pending !== null && pending.appId === appId;
}

/** Forget the unsealed secret and the item binding (Remove / uninstall). */
export function forgetGithubAppSecret(): void {
  pending = null;
  stopWatchingVault?.();
  stopWatchingVault = null;
  removeStorage(maybeLocalStore(), BINDING_KEY);
  removeStorage(maybeLocalStore(), LEGACY_PENDING_PEM_KEY);
  removeStorage(sessionOrNone(), LEGACY_PENDING_PEM_KEY);
}

function dropPending(sealed: PendingSecret): void {
  if (pending !== sealed) return;
  pending = null;
  stopWatchingVault?.();
  stopWatchingVault = null;
}

async function sealNow(next: PendingSecret): Promise<void> {
  try {
    const item = createItem("secret", next.name);
    item.value = next.secret;
    await vaultStore.addItems([item]);
    writeBinding({ appId: next.appId, itemId: item.id });
    dropPending(next);
  } catch {
    // Stays in memory until the next unlock.
  }
}

/**
 * Seal the pending secret into the open vault. A no-op while locked, as a
 * guest (the guest tomb is wiped on lock), or with nothing pending.
 */
export function sealPendingGithubAppSecret(): Promise<void> {
  if (sealing) return sealing;
  const next = pending;
  if (!next || !durableVaultOpen()) return Promise.resolve();
  const run = sealNow(next).finally(() => {
    if (sealing === run) sealing = null;
  });
  sealing = run;
  return run;
}

/**
 * The App's PEM, only from an unlocked, non-guest vault: the unsealed claim
 * for this App, else the item bound to this App, else (records sealed before
 * the binding existed, and only when no binding exists) a secret named
 * exactly after the App. Null otherwise — never another item's key.
 */
export function pemFromVault(app: GithubAppRef): string | null {
  if (app.id === "" || !durableVaultOpen()) return null;
  if (pending && pending.appId === app.id) {
    return extractGithubAppPem(pending.secret);
  }
  const live = vaultStore
    .getSnapshot()
    .items.filter((item) => item.kind === "secret" && !item.deletedAt);
  const binding = readBinding();
  if (binding && binding.appId === app.id) {
    const bound = live.find((item) => item.id === binding.itemId);
    return bound?.kind === "secret" ? extractGithubAppPem(bound.value) : null;
  }
  for (const item of live) {
    if (item.kind !== "secret" || item.name !== app.displayName) continue;
    const pem = extractGithubAppPem(item.value);
    if (pem) return pem;
  }
  return null;
}
