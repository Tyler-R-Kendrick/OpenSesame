/**
 * The core-only worker (ownership.md §4.7).
 *
 * `installCoreWorker` wires install, activate, fetch and message on the scope
 * it is given. Install saves the shell — `index.html` and nothing else — into
 * this release's own cache. Activate retires this application's caches from
 * other releases under the same scope path, keeping any a still-open window
 * may be running from (PWA-04), then claims the clients. Fetch answers from
 * the release cache alone (PWA-08). Message accepts `WORKER_HELLO` and
 * `PLAN_ASSETS` from controlled same-scope windows and ignores everything
 * else (PWA-09).
 *
 * There is no `push` and no `notificationclick` here. The push variant
 * (`sw-push.ts`) adds them on top; the core worker cannot import them, and a
 * service worker cannot load a script it did not ship with (P-NOLOAD).
 */

import { isString } from "@opensesame/os-domain";
import { parseCacheName } from "./cache-names.js";
import { cleanupCaches } from "./cleanup.js";
import {
  type WorkerContext,
  controlledSender,
  isScopedWindow,
  workerContext,
} from "./context.js";
import { handleFetch } from "./fetch.js";
import { isWorkerHello } from "./messages.js";
import { PlanCoordinator } from "./plan-assets.js";
import { type ManifestEntry, releaseIdFromManifest, shellEntry } from "./release.js";

export type CoreWorkerOptions = Readonly<{
  /** `core-only` or `push`; the last cache-name segment. */
  variant: string;
  /** The injected `self.__WB_MANIFEST` (each entry references it once). */
  manifest: readonly ManifestEntry[];
  caches?: CacheStorage;
  fetch?: (input: string | Request) => Promise<Response>;
}>;

export type CoreWorker = Readonly<{
  ctx: WorkerContext;
  /** Release ids kept alive for windows that were open at activation. */
  retained: ReadonlySet<string>;
}>;

/** Window client ids that existed when this worker activated. */
type Takeover = { clientIds: Set<string>; retained: Set<string> };

async function windowsAtActivation(ctx: WorkerContext): Promise<Set<string>> {
  try {
    const windows = await ctx.sw.clients.matchAll({
      type: "window",
      includeUncontrolled: true,
    });
    return new Set(windows.filter((w) => isScopedWindow(ctx, w)).map((w) => w.id));
  } catch {
    return new Set();
  }
}

/**
 * Other releases of this application under this scope. Retained while any
 * window from before the takeover is still open — it may lazy-load a chunk
 * from the release it booted with — and released once every one of them
 * has gone (the page reloads on `controllerchange`).
 */
async function otherReleases(ctx: WorkerContext): Promise<Set<string>> {
  const releases = new Set<string>();
  try {
    for (const name of await ctx.caches.keys()) {
      const parsed = parseCacheName(name, ctx.scopePath);
      if (parsed && parsed.releaseId !== ctx.releaseId) releases.add(parsed.releaseId);
    }
  } catch {
    // No keys, nothing to retain.
  }
  return releases;
}

async function activate(ctx: WorkerContext, takeover: Takeover): Promise<void> {
  const open = await windowsAtActivation(ctx);
  for (const id of open) takeover.clientIds.add(id);
  if (open.size > 0) for (const r of await otherReleases(ctx)) takeover.retained.add(r);
  await cleanupCaches({
    caches: ctx.caches,
    scopePath: ctx.scopePath,
    releaseId: ctx.releaseId,
    retained: takeover.retained,
  });
  await ctx.sw.clients.claim();
}

/** Once every pre-takeover window is gone, the retained releases go too. */
async function releaseRetained(ctx: WorkerContext, takeover: Takeover): Promise<void> {
  if (takeover.retained.size === 0) return;
  let ids: Set<string>;
  try {
    const windows = await ctx.sw.clients.matchAll({
      type: "window",
      includeUncontrolled: true,
    });
    ids = new Set(windows.map((w) => w.id));
  } catch {
    return;
  }
  for (const id of takeover.clientIds) if (ids.has(id)) return;
  takeover.clientIds.clear();
  takeover.retained.clear();
  await cleanupCaches({
    caches: ctx.caches,
    scopePath: ctx.scopePath,
    releaseId: ctx.releaseId,
    retained: takeover.retained,
  });
}

async function precacheShell(ctx: WorkerContext, manifest: readonly ManifestEntry[]): Promise<void> {
  const shell = shellEntry(manifest);
  if (!shell) return;
  try {
    const cache = await ctx.caches.open(ctx.releaseCacheName);
    await cache.add(new URL(shell, ctx.scopeUrl).href);
  } catch {
    // Quota, or offline at install: the first navigation saves the shell.
  }
}

async function hello(ctx: WorkerContext, event: ExtendableMessageEvent, takeover: Takeover): Promise<void> {
  const client = await controlledSender(ctx, event.source);
  if (!client) return;
  client.postMessage({
    type: "WORKER_INFO",
    releaseId: ctx.releaseId,
    variant: ctx.variant,
    scopePath: ctx.scopePath,
  });
  await releaseRetained(ctx, takeover);
}

export function installCoreWorker(
  sw: ServiceWorkerGlobalScope,
  options: CoreWorkerOptions,
): CoreWorker {
  const ctx = workerContext({
    sw,
    variant: options.variant,
    releaseId: releaseIdFromManifest(options.manifest),
    caches: options.caches ?? caches,
    fetch: options.fetch ?? ((input) => fetch(input)),
  });
  const takeover: Takeover = { clientIds: new Set(), retained: new Set() };
  const plans = new PlanCoordinator(ctx);

  sw.addEventListener("install", (event) => {
    event.waitUntil(precacheShell(ctx, options.manifest).then(() => sw.skipWaiting()));
  });
  sw.addEventListener("activate", (event) => {
    event.waitUntil(activate(ctx, takeover));
  });
  sw.addEventListener("fetch", (event) => {
    handleFetch(ctx, event);
  });
  sw.addEventListener("message", (event) => {
    const data = event.data;
    if (isWorkerHello(data)) event.waitUntil(hello(ctx, event, takeover));
    else if (data && isString(data.type) && data.type === "PLAN_ASSETS")
      event.waitUntil(plans.handle(event));
    // Any other type is ignored (ownership.md §4.7).
  });
  return { ctx, retained: takeover.retained };
}
