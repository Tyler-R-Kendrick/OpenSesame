/**
 * What every worker module is handed: the global scope, the names of its own
 * caches, and the two effects it may perform (fetch and Cache Storage). The
 * handlers never reach for `caches` or `fetch` off the global, which is what
 * lets the test environment stand in for a browser.
 */

import { cacheName, scopePathOf, stagingCacheName } from "./cache-names.js";

export type WorkerContext = Readonly<{
  sw: ServiceWorkerGlobalScope;
  /** `/OpenSesame/` — the registration scope's pathname. */
  scopePath: string;
  /** `https://host/OpenSesame/` — the registration scope, absolute. */
  scopeUrl: string;
  releaseId: string;
  variant: string;
  releaseCacheName: string;
  stagingCacheName: string;
  /** The shell's absolute URL. */
  shellUrl: string;
  caches: CacheStorage;
  fetch: (input: string | Request) => Promise<Response>;
}>;

export type WorkerContextInput = Readonly<{
  sw: ServiceWorkerGlobalScope;
  releaseId: string;
  variant: string;
  caches: CacheStorage;
  fetch: (input: string | Request) => Promise<Response>;
}>;

export function workerContext(input: WorkerContextInput): WorkerContext {
  const scopeUrl = input.sw.registration.scope;
  const scopePath = scopePathOf(scopeUrl);
  return {
    sw: input.sw,
    scopePath,
    scopeUrl,
    releaseId: input.releaseId,
    variant: input.variant,
    releaseCacheName: cacheName(scopePath, input.releaseId, input.variant),
    stagingCacheName: stagingCacheName(scopePath, input.releaseId),
    shellUrl: new URL("index.html", scopeUrl).href,
    caches: input.caches,
    fetch: input.fetch,
  };
}

/** Whether a client is a window inside this worker's scope. */
export function isScopedWindow(
  ctx: WorkerContext,
  client: Readonly<{ url: string; type?: string }> | null | undefined,
): boolean {
  if (!client) return false;
  if (client.type !== undefined && client.type !== "window") return false;
  return client.url.startsWith(ctx.scopeUrl);
}

/**
 * The controlled window a message came from, or `null`. `matchAll` without
 * `includeUncontrolled` lists only clients this worker controls, so a page
 * outside the scope, a worker, or an uncontrolled tab cannot pass (PWA-09).
 */
export async function controlledSender(
  ctx: WorkerContext,
  source: ExtendableMessageEvent["source"],
): Promise<Client | null> {
  if (!source || !("id" in source)) return null;
  let windows: readonly Client[];
  try {
    windows = await ctx.sw.clients.matchAll({ type: "window" });
  } catch {
    return null;
  }
  const match = windows.find((c) => c.id === source.id) ?? null;
  return match && isScopedWindow(ctx, match) ? match : null;
}
