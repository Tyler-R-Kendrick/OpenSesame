/**
 * Read one shared file/text from the service worker's cache and hold it for
 * the normal Import review. The token is removed from the address before any
 * await, and the cache entry is deleted whether or not the read succeeds.
 */

import { holdPendingImport } from "@opensesame/app-core/lib/vault/pending-import.js";
import {
  SHARE_TARGET_MAX_BYTES,
  SHARE_TARGET_PARAM,
  type ShareTargetMeta,
  isShareTargetToken,
  parseShareTargetMeta,
  shareTargetCacheName,
  shareTargetEntryUrl,
} from "./share-target.js";

function scopeUrl(): URL {
  return new URL(import.meta.env.BASE_URL, window.location.origin);
}

function withoutParam(url: URL, history: History): void {
  const next = new URL(url);
  next.searchParams.delete(SHARE_TARGET_PARAM);
  history.replaceState(
    history.state,
    "",
    `${next.pathname}${next.search}${next.hash}`,
  );
}

async function readFile(
  cache: Cache,
  scope: URL,
  token: string,
  meta: ShareTargetMeta,
): Promise<File | null> {
  if (meta.file === null) {
    const body = [meta.title, meta.text, meta.url]
      .filter((part) => part !== "")
      .join("\n\n");
    if (body === "") return null;
    return new File([body], ".opensesame-share.txt", {
      type: "text/plain",
      lastModified: meta.createdAt,
    });
  }
  const response = await cache.match(
    shareTargetEntryUrl(scope.href, token, "file"),
  );
  if (!response) return null;
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength === 0 || bytes.byteLength > SHARE_TARGET_MAX_BYTES)
    return null;
  return new File([bytes], meta.file.name, {
    type: meta.file.type,
    lastModified: meta.createdAt,
  });
}

/** Capture the share token now; the Import key takes the held File on mount. */
export async function captureShareTarget(
  location: Location = window.location,
  history: History = window.history,
): Promise<File | null> {
  const url = new URL(location.href);
  const token = url.searchParams.get(SHARE_TARGET_PARAM);
  if (token === null) return null;
  withoutParam(url, history);
  if (!isShareTargetToken(token)) return null;

  const scope = scopeUrl();
  const cacheName = shareTargetCacheName(scope.pathname);
  let cache: Cache;
  try {
    cache = await caches.open(cacheName);
  } catch {
    return null;
  }
  try {
    const response = await cache.match(
      shareTargetEntryUrl(scope.href, token, "meta"),
    );
    if (!response) return null;
    const meta = parseShareTargetMeta(await response.json());
    if (!meta || meta.token !== token) return null;
    const file = await readFile(cache, scope, token, meta);
    if (file === null) return null;
    holdPendingImport(file);
    return file;
  } catch {
    return null;
  } finally {
    await cache
      .delete(shareTargetEntryUrl(scope.href, token, "meta"))
      .catch(() => undefined);
    await cache
      .delete(shareTargetEntryUrl(scope.href, token, "file"))
      .catch(() => undefined);
  }
}
