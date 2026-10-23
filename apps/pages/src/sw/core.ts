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

import { SamlPostCommandSchema } from "@opensesame/app-core/browser/saml/post-wire.js";
import {
  type BoundaryValue,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";
import { SHARE_TARGET_PATH } from "../lib/share-target.js";
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
import {
  type ManifestEntry,
  releaseIdFromManifest,
  shellEntry,
} from "./release.js";
import { createSamlPostIngress } from "./saml-post.js";
import { respondToShareTarget, sweepShareTargetCache } from "./share-target.js";

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

/** A missing callback means this distribution excludes native SAML. Never guess an asset URL. */
function samlCallbackScript(
  manifest: readonly ManifestEntry[],
  scopeUrl: string,
): string | null {
  const matches = manifest
    .map((entry) => (isString(entry) ? entry : entry.url))
    .filter((entry) =>
      /^assets\/native-saml-[A-Za-z0-9_-]{8,64}\.js$/.test(entry),
    );
  if (matches.length > 1)
    throw new Error("Release contains ambiguous SAML callbacks");
  return matches.length === 1 ? new URL(matches[0], scopeUrl).href : null;
}

/** Window client ids that existed when this worker activated. */
type Takeover = { clientIds: Set<string>; retained: Set<string> };

async function windowsAtActivation(ctx: WorkerContext): Promise<Set<string>> {
  try {
    const windows = await ctx.sw.clients.matchAll({
      type: "window",
      includeUncontrolled: true,
    });
    return new Set(
      windows.filter((w) => isScopedWindow(ctx, w)).map((w) => w.id),
    );
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
      if (parsed && parsed.releaseId !== ctx.releaseId)
        releases.add(parsed.releaseId);
    }
  } catch {
    // No keys, nothing to retain.
  }
  return releases;
}

async function activate(ctx: WorkerContext, takeover: Takeover): Promise<void> {
  const open = await windowsAtActivation(ctx);
  for (const id of open) takeover.clientIds.add(id);
  if (open.size > 0)
    for (const r of await otherReleases(ctx)) takeover.retained.add(r);
  await cleanupCaches({
    caches: ctx.caches,
    scopePath: ctx.scopePath,
    releaseId: ctx.releaseId,
    retained: takeover.retained,
  });
  await sweepShareTargetCache(ctx);
  await ctx.sw.clients.claim();
}

/** Once every pre-takeover window is gone, the retained releases go too. */
async function releaseRetained(
  ctx: WorkerContext,
  takeover: Takeover,
): Promise<void> {
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

async function precacheShell(
  ctx: WorkerContext,
  manifest: readonly ManifestEntry[],
): Promise<void> {
  const shell = shellEntry(manifest);
  if (!shell) return;
  try {
    const cache = await ctx.caches.open(ctx.releaseCacheName);
    await cache.add(new URL(shell, ctx.scopeUrl).href);
  } catch {
    // Quota, or offline at install: the first navigation saves the shell.
  }
}

/** Identify an existing hashed JS module; this grants no fetch or execution authority. */
function moduleHandoff(
  ctx: WorkerContext,
  value: BoundaryValue,
  manifest: readonly ManifestEntry[],
): { pageModuleUrl: string; proofNonce: string } | null {
  if (
    !isJsonObject(value) ||
    !isString(value.pageModuleUrl) ||
    !isString(value.proofNonce) ||
    !/^[A-Za-z0-9_-]{32,128}$/.test(value.proofNonce)
  )
    return null;
  let url: URL;
  try {
    url = new URL(value.pageModuleUrl);
  } catch {
    return null;
  }
  if (
    url.href !== value.pageModuleUrl ||
    !url.href.startsWith(ctx.scopeUrl) ||
    url.search ||
    url.hash
  )
    return null;
  const relative = url.href.slice(ctx.scopeUrl.length);
  if (!/^assets\/[A-Za-z0-9._-]+-[A-Za-z0-9_-]{8,64}\.js$/.test(relative))
    return null;
  if (
    !manifest.some(
      (entry) => (isString(entry) ? entry : entry.url) === relative,
    )
  )
    return null;
  return { pageModuleUrl: url.href, proofNonce: value.proofNonce };
}

async function hello(
  ctx: WorkerContext,
  event: ExtendableMessageEvent,
  takeover: Takeover,
  manifest: readonly ManifestEntry[],
): Promise<void> {
  const client = await controlledSender(ctx, event.source);
  if (!client || (event.ports?.length ?? 0) > 1) {
    for (const port of event.ports ?? []) port.close();
    return;
  }
  const info = {
    type: "WORKER_INFO",
    releaseId: ctx.releaseId,
    variant: ctx.variant,
    scopePath: ctx.scopePath,
  };
  const port = event.ports?.length === 1 ? event.ports[0] : undefined;
  const proof = moduleHandoff(ctx, event.data, manifest);
  if (port) {
    try {
      if (proof) port.postMessage({ ...info, ...proof });
    } finally {
      port.close();
    }
  } else client.postMessage(info);
  await releaseRetained(ctx, takeover);
}

export function installCoreWorker(
  sw: ServiceWorkerGlobalScope,
  options: CoreWorkerOptions,
): CoreWorker {
  const manifest = Object.freeze(
    options.manifest.map((entry) =>
      isString(entry)
        ? entry
        : Object.freeze({ url: entry.url, revision: entry.revision }),
    ),
  );
  const ctx = workerContext({
    sw,
    variant: options.variant,
    releaseId: releaseIdFromManifest(manifest),
    caches: options.caches ?? caches,
    fetch: options.fetch ?? ((input) => fetch(input)),
  });
  const takeover: Takeover = { clientIds: new Set(), retained: new Set() };
  const plans = new PlanCoordinator(ctx);
  const callbackScriptUrl = samlCallbackScript(manifest, ctx.scopeUrl);
  const saml = callbackScriptUrl
    ? createSamlPostIngress({
        scopeUrl: ctx.scopeUrl,
        callbackScriptUrl,
        clients: sw.clients,
      })
    : null;

  sw.addEventListener("install", (event) => {
    event.waitUntil(precacheShell(ctx, manifest).then(() => sw.skipWaiting()));
  });
  sw.addEventListener("activate", (event) => {
    event.waitUntil(activate(ctx, takeover));
  });
  sw.addEventListener("fetch", (event) => {
    const post = saml?.respond(event);
    if (post) {
      event.respondWith(post);
      return;
    }
    const url = new URL(event.request.url);
    if (
      event.request.method === "POST" &&
      url.origin === new URL(ctx.scopeUrl).origin &&
      url.pathname === `${ctx.scopePath}${SHARE_TARGET_PATH}`
    ) {
      event.respondWith(
        respondToShareTarget(ctx, event.request).then(
          (response) => response ?? new Response("Not found", { status: 404 }),
        ),
      );
      return;
    }
    handleFetch(ctx, event);
  });
  sw.addEventListener("message", (event) => {
    const data = event.data;
    if (isWorkerHello(data))
      event.waitUntil(hello(ctx, event, takeover, manifest));
    else if (data && isString(data.type) && data.type === "PLAN_ASSETS")
      event.waitUntil(plans.handle(event));
    else if (saml && SamlPostCommandSchema.safeParse(data).success)
      event.waitUntil(saml.message(event));
    // Any other type is ignored (ownership.md §4.7).
  });
  return { ctx, retained: takeover.retained };
}
