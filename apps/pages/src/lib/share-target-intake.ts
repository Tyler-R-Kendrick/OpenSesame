/**
 * Read one shared file/text from the service worker's encrypted cache and
 * hold it for the normal Import review. The cache key and the decryption key
 * arrive in the URL fragment, which is removed before any await.
 */

import {
  dismissNotice,
  setStatusNotice,
} from "@opensesame/app-core/lib/notices.js";
import { holdPendingImport } from "@opensesame/app-core/lib/vault/pending-import.js";
import {
  SHARE_TARGET_MAX_BYTES,
  SHARE_TARGET_PARAM,
  type ShareTargetMeta,
  isShareTargetToken,
  openShareTarget,
  parseShareTargetMeta,
  shareTargetCacheName,
  shareTargetEntryUrl,
} from "./share-target.js";
import { asBufferSource } from "@opensesame/os-domain";

function scopeUrl(): URL {
  return new URL(import.meta.env.BASE_URL, window.location.origin);
}

/** The parts of the page's location and history the intake reads. */
type IntakeLocation = Pick<Location, "href" | "hash">;
type IntakeHistory = Pick<History, "state" | "replaceState">;

function withoutHash(url: URL, history: IntakeHistory): void {
  const next = new URL(url);
  next.hash = "";
  history.replaceState(history.state, "", `${next.pathname}${next.search}`);
}

function address(
  location: IntakeLocation,
): { token: string; key: string; createdAt: number } | null {
  const raw = new URLSearchParams(location.hash.replace(/^#/u, "")).get(
    SHARE_TARGET_PARAM,
  );
  if (raw === null) return null;
  const [token = "", key = "", stamp = ""] = raw.split(".");
  const createdAt = Number(stamp);
  if (
    !isShareTargetToken(token) ||
    !/^[A-Za-z0-9_-]{43}$/u.test(key) ||
    !Number.isSafeInteger(createdAt) ||
    createdAt <= 0
  )
    return null;
  return { token, key, createdAt };
}

async function decrypt(response: Response, key: string): Promise<Uint8Array> {
  return openShareTarget(key, new Uint8Array(await response.arrayBuffer()));
}

async function readFile(
  cache: Cache,
  scope: URL,
  token: string,
  key: string,
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
    shareTargetEntryUrl(scope.href, token, meta.createdAt, "file"),
  );
  if (!response) return null;
  const bytes = await decrypt(response, key);
  if (bytes.byteLength === 0 || bytes.byteLength > SHARE_TARGET_MAX_BYTES)
    return null;
  const name = /\.(?:txt|md)$/iu.test(meta.file.name)
    ? ".opensesame-share.txt"
    : meta.file.name;
  return new File([asBufferSource(bytes)], name, {
    type: meta.file.type,
    lastModified: meta.createdAt,
  });
}

/** Capture the share now; the Import key takes the held File on mount. */
export async function captureShareTarget(
  location: IntakeLocation = window.location,
  history: IntakeHistory = window.history,
): Promise<File | null> {
  const found = address(location);
  if (found === null) return null;
  withoutHash(new URL(location.href), history);
  const fail = () => {
    setStatusNotice({
      id: "share-target",
      tone: "err",
      title: "Shared file",
      body: "The shared item could not be opened. Ask the sender to share it again.",
    });
    return null;
  };
  const scope = scopeUrl();
  let cache: Cache;
  try {
    cache = await caches.open(shareTargetCacheName(scope.pathname));
  } catch {
    return null;
  }
  const metaEntry = shareTargetEntryUrl(
    scope.href,
    found.token,
    found.createdAt,
    "meta",
  );
  const fileEntry = shareTargetEntryUrl(
    scope.href,
    found.token,
    found.createdAt,
    "file",
  );
  try {
    const response = await cache.match(metaEntry);
    if (!response) return fail();
    const meta = parseShareTargetMeta(
      JSON.parse(new TextDecoder().decode(await decrypt(response, found.key))),
    );
    if (!meta || meta.token !== found.token) return fail();
    const file = await readFile(cache, scope, found.token, found.key, meta);
    if (file === null) return fail();
    holdPendingImport(file, "share");
    dismissNotice("share-target");
    return file;
  } catch {
    return fail();
  } finally {
    await cache.delete(metaEntry).catch(() => undefined);
    await cache.delete(fileEntry).catch(() => undefined);
  }
}
