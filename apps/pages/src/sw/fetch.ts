/**
 * Answer same-origin GETs from this worker's own release cache (PWA-08).
 *
 * Three roads, none of which reaches for another cache:
 *
 * - a navigation is network-first, because GitHub Pages has no SPA rewrite
 *   (deep links 404) and a cached shell points at hashed assets the last
 *   deploy deleted; the shell saved under *this* release is the offline
 *   fallback;
 * - `os-runtime-config.json` is network-first too — the deploy writes it
 *   after the build, so the first copy the worker sees may be a placeholder
 *   and cache-first would pin an installed client to it;
 * - anything else is served from the release cache when the approved plan put
 *   it there, else fetched and returned untouched. Nothing outside the plan is
 *   ever written to a cache from here.
 */

import type { WorkerContext } from "./context.js";
import { isolated, isolatedWorkerScript } from "./isolation.js";

async function releaseCache(ctx: WorkerContext): Promise<Cache> {
  return ctx.caches.open(ctx.releaseCacheName);
}

async function saveShell(
  ctx: WorkerContext,
  response: Response,
): Promise<void> {
  try {
    const cache = await releaseCache(ctx);
    await cache.put(ctx.shellUrl, response);
  } catch {
    // Quota or a closed store: the shell still renders from the network.
  }
}

/** Fetch the current shell and refresh this release's copy; null when offline. */
async function freshShell(
  ctx: WorkerContext,
  url: URL,
): Promise<Response | null> {
  try {
    const response = await ctx.fetch(ctx.shellUrl);
    if (!response.ok) return null;
    await saveShell(ctx, response.clone());
    return isolated(response, url, ctx.scopePath);
  } catch {
    return null;
  }
}

async function cachedShell(ctx: WorkerContext, url: URL): Promise<Response> {
  const cache = await releaseCache(ctx);
  const cached = await cache.match(ctx.shellUrl);
  if (cached) return isolated(cached, url, ctx.scopePath);
  throw new Error("offline shell unavailable");
}

async function navigation(
  ctx: WorkerContext,
  request: Request,
): Promise<Response> {
  const url = new URL(request.url);
  try {
    const response = await ctx.fetch(request);
    if (!response.ok)
      return (await freshShell(ctx, url)) ?? cachedShell(ctx, url);
    await saveShell(ctx, response.clone());
    return isolated(response, url, ctx.scopePath);
  } catch {
    return cachedShell(ctx, url);
  }
}

async function runtimeConfig(
  ctx: WorkerContext,
  request: Request,
): Promise<Response> {
  const cache = await releaseCache(ctx);
  try {
    const response = await ctx.fetch(request);
    if (response.ok) {
      await cache.put(request, response.clone()).catch(() => undefined);
      return response;
    }
  } catch {
    // Offline, or the file is not there. The cache answers below.
  }
  return (await cache.match(request)) ?? ctx.fetch(request);
}

async function asset(ctx: WorkerContext, request: Request): Promise<Response> {
  const cache = await releaseCache(ctx);
  const cached = await cache.match(request);
  const response = cached ?? (await ctx.fetch(request));
  // A worker script has to carry the isolation its owner document was given,
  // or Chromium refuses it with an `error` event that names nothing.
  if (
    request.destination === "worker" ||
    request.destination === "sharedworker"
  ) {
    return isolatedWorkerScript(response);
  }
  return response;
}

/** Route one request; `null` when the worker should not respond at all. */
export function respondTo(
  ctx: WorkerContext,
  request: Request,
): Promise<Response> | null {
  if (request.method !== "GET") return null;
  const url = new URL(request.url);
  if (url.origin !== new URL(ctx.scopeUrl).origin) return null;
  if (request.mode === "navigate") return navigation(ctx, request);
  if (url.pathname.endsWith("/os-runtime-config.json"))
    return runtimeConfig(ctx, request);
  return asset(ctx, request);
}

export function handleFetch(ctx: WorkerContext, event: FetchEvent): void {
  const response = respondTo(ctx, event.request);
  if (response) event.respondWith(response);
}
