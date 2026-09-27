/**
 * Reset this browser: everything this app keeps here removed, so the next
 * load is a first visit. Mostly a testing and hand-over tool.
 *
 * Deleting a vault (`VaultStore.destroy`) removes one tomb and leaves the
 * device's other vaults, its sign-in, its settings and its offline shell.
 * This removes all of it — and only it. The origin is shared (in production
 * with every GitHub Pages project site of the account), so each area goes
 * by the names the app owns (`storage-ownership.ts`, the service worker's
 * scope-prefixed caches), never by clearing the area whole.
 *
 * The whole reset runs under a Web Lock (`RESET_LOCK`), which other tabs
 * wait on before they reload. In order: other tabs are told first, so they
 * stop writing; the
 * session is signed out while the bearer its revocation sends is still in
 * memory; the writes this tab already started are waited for and then no
 * more are allowed; then the stores go, a second pass catches anything
 * another tab had in the air, and the others are told it is done, and
 * reload onto the emptied storage.
 *
 * The app shell stays unless the network answers: the Cache API holds only
 * the service worker's release assets, never anything a person stored, and
 * removing them with no network would leave the reload nothing to load.
 * Kept, the worker's push subscription still ends, so the previous
 * account's notifications stop.
 *
 * Not forensic erasure: what the browser keeps beyond the app's reach (the
 * HttpOnly cookie the Identity API sets, the HTTP cache, a granted storage
 * persistence) stays, and ciphertext already pushed to a backup remote is
 * untouched. The caller navigates afterwards, whatever the report says;
 * nothing here reloads.
 */

import { isOnline, lockManager } from "../ports.js";
import {
  appEntraClientIds,
  clearEntraInstances,
} from "./ambient-auth/entra-instances.js";
import {
  bounded,
  clearCaches,
  clearDatabases,
  clearOriginFiles,
  clearWebStorage,
  networkAnswers,
  unregisterServiceWorkers,
  unsubscribePush,
} from "./browser-reset-areas.js";
import { RESET_LOCK, announceBrowserReset } from "./browser-reset-channel.js";
import { settleRevokes } from "./identity.js";
import { kvFlush, kvForgetAll } from "./kv.js";
import { signOut } from "./session-exit.js";
import { beginBrowserReset, haltStorageWrites } from "./storage-halt.js";
import { vaultStore } from "./vault/store.js";

export type BrowserResetArea =
  | "session"
  | "origin_files"
  | "databases"
  | "web_storage"
  | "push_subscription"
  | "caches"
  | "service_workers";

/**
 * What went, what could not be removed, and what was kept on purpose (the
 * app shell, while the network does not answer). Every area is attempted.
 */
export type BrowserResetReport = Readonly<{
  cleared: readonly BrowserResetArea[];
  failed: readonly BrowserResetArea[];
  kept: readonly BrowserResetArea[];
}>;

export type BrowserResetOptions = Readonly<{
  /** The app's scope URL, absolute: its worker registration's `scope`. */
  scope: string;
  /** Whether a Cache API name is this app's (the worker's own naming). */
  ownsCache: (name: string) => boolean;
}>;

/**
 * The longest any one step may take. Every step is bounded, so the reset —
 * and every tab waiting on its lock — always ends.
 */
const STEP_MS = 10_000;
/** The shorter bound for work the reset only tries (flush, push, MSAL). */
const TRY_MS = 5000;

/** Every write this tab has started: vault persists, then the kv queue. */
async function flushWrites(): Promise<void> {
  await vaultStore.flushPendingWrites();
  await kvFlush();
}

/** Replaceable in tests. */
export const browserResetSeams = { flushWrites, networkAnswers };

async function endSession(): Promise<void> {
  signOut();
  // Bounded by the Identity fetch timeout; a failed revoke is not an error
  // here — the cookie is the server's to expire.
  await settleRevokes();
  // MSAL's own records, account entries included, through each instance.
  await attempt(clearEntraInstances, TRY_MS);
}

async function attempt(
  step: () => void | Promise<void>,
  ms: number = STEP_MS,
): Promise<boolean> {
  try {
    await bounded(Promise.resolve().then(step), ms);
    return true;
  } catch {
    return false;
  }
}

class Ledger {
  readonly cleared: BrowserResetArea[] = [];
  readonly failed: BrowserResetArea[] = [];
  readonly kept: BrowserResetArea[] = [];

  async run(area: BrowserResetArea, step: () => void | Promise<void>) {
    ((await attempt(step)) ? this.cleared : this.failed).push(area);
  }

  /** A second pass over an area already cleared; a refusal now is a failure. */
  async sweep(area: BrowserResetArea, step: () => void | Promise<void>) {
    if (!this.cleared.includes(area) || (await attempt(step))) return;
    this.cleared.splice(this.cleared.indexOf(area), 1);
    this.failed.push(area);
  }

  report(): BrowserResetReport {
    return { cleared: this.cleared, failed: this.failed, kept: this.kept };
  }
}

async function removeShell(ledger: Ledger, options: BrowserResetOptions) {
  // Unregistering ends the subscription too; ending it first means a worker
  // that will not unregister still stops delivering.
  const unsubscribed = await attempt(
    () => unsubscribePush(options.scope),
    TRY_MS,
  );
  await ledger.run("caches", () => clearCaches(options.ownsCache));
  await ledger.run("service_workers", () =>
    unregisterServiceWorkers(options.scope),
  );
  const pushGone = unsubscribed || ledger.cleared.includes("service_workers");
  (pushGone ? ledger.cleared : ledger.failed).push("push_subscription");
}

async function keepShell(ledger: Ledger, options: BrowserResetOptions) {
  const unsubscribed = await attempt(
    () => unsubscribePush(options.scope),
    TRY_MS,
  );
  (unsubscribed ? ledger.cleared : ledger.kept).push("push_subscription");
  ledger.kept.push("caches", "service_workers");
}

async function run(options: BrowserResetOptions): Promise<BrowserResetReport> {
  const ledger = new Ledger();
  const msalClients = appEntraClientIds();
  const clearOwnKeys = () => clearWebStorage(msalClients);
  announceBrowserReset("start");
  await ledger.run("session", endSession);
  // A write this tab started before now (the lock's last-vault pointer, a
  // vault persist) lands before the files are listed; none starts after.
  await attempt(browserResetSeams.flushWrites, TRY_MS);
  haltStorageWrites();
  await ledger.run("origin_files", clearOriginFiles);
  // Nothing read from memory from here on describes a file that is gone.
  kvForgetAll();
  await ledger.run("databases", () => clearDatabases());
  await ledger.run("web_storage", clearOwnKeys);
  const shellGoes =
    isOnline() && (await browserResetSeams.networkAnswers(options.scope));
  await (shellGoes ? removeShell : keepShell)(ledger, options);
  // Another tab may have had a write in the air when it heard the reset,
  // and the worker may have saved a shell before it was unregistered.
  await ledger.sweep("origin_files", clearOriginFiles);
  await ledger.sweep("web_storage", clearOwnKeys);
  if (shellGoes) {
    await ledger.sweep("caches", () => clearCaches(options.ownsCache));
  }
  announceBrowserReset("done");
  return ledger.report();
}

/**
 * Remove everything this app keeps in this browser. Never throws. From the
 * first moment the tab stops offering the app (`beginBrowserReset`), and it
 * never offers it again: the caller leaves for a fresh document.
 */
export async function resetBrowser(
  options: BrowserResetOptions,
): Promise<BrowserResetReport> {
  beginBrowserReset();
  const locks = lockManager();
  if (!locks) return run(options);
  return locks.request(RESET_LOCK, () => run(options));
}
