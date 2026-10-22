/**
 * The private hand-off between the Web Share Target POST and the page.
 *
 * The service worker receives a multipart form from the operating system,
 * writes the bounded file and its metadata into a scope-owned Cache Storage
 * bucket, and redirects to the app with an unguessable token. The page reads
 * that bucket once, deletes it, and holds the File for the import review. No
 * share value is ever put in the URL, and the worker never parses or writes a
 * vault item.
 */

export const SHARE_TARGET_CACHE_PREFIX = "opensesame-share-target";
export const SHARE_TARGET_PARAM = "share-target";
export const SHARE_TARGET_PATH = "share-target";
export const SHARE_TARGET_MAX_BYTES = 64 * 1024 * 1024;
export const SHARE_TARGET_MAX_TEXT = 64 * 1024;
export const SHARE_TARGET_MAX_TITLE = 200;
export const SHARE_TARGET_EXTENSIONS = new Set([
  ".kdbx",
  ".kdb",
  ".json",
  ".1pux",
  ".zip",
  ".csv",
  ".env",
]);

const TOKEN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export type ShareTargetFile = {
  name: string;
  type: string;
  size: number;
};

export type ShareTargetMeta = {
  token: string;
  createdAt: number;
  title: string;
  text: string;
  url: string;
  file: ShareTargetFile | null;
};

export function isShareTargetToken(value: string | null): value is string {
  return value !== null && TOKEN.test(value);
}

export function shareTargetCacheName(scopePath: string): string {
  return `${SHARE_TARGET_CACHE_PREFIX}:${scopePath}`;
}

/** The token-owned entry prefix inside the cache; no page can guess another. */
export function shareTargetEntryUrl(
  scopeUrl: string,
  token: string,
  part: "meta" | "file",
): string {
  return new URL(
    `${new URL(scopeUrl).pathname}__share-target/${token}/${part}`,
    scopeUrl,
  ).href;
}

export function shareTargetPageUrl(scopeUrl: string, token: string): string {
  const url = new URL(scopeUrl);
  url.searchParams.set(SHARE_TARGET_PARAM, token);
  return url.href;
}

function boundedText(value: unknown, max: number): string {
  return typeof value === "string" && value.length <= max ? value : "";
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : null;
}

function fileMeta(value: unknown): ShareTargetFile | null | undefined {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object") return undefined;
  const candidate = value as Record<string, unknown>;
  const size = positiveInteger(candidate.size);
  if (
    typeof candidate.name !== "string" ||
    candidate.name.length === 0 ||
    candidate.name.length > 255 ||
    typeof candidate.type !== "string" ||
    candidate.type.length > 200 ||
    size === null ||
    size > SHARE_TARGET_MAX_BYTES
  )
    return undefined;
  return { name: candidate.name, type: candidate.type, size };
}

export function parseShareTargetMeta(value: unknown): ShareTargetMeta | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const token = record.token;
  if (typeof token !== "string" || !isShareTargetToken(token)) return null;
  const createdAt = positiveInteger(record.createdAt);
  if (createdAt === null) return null;
  const file = fileMeta(record.file);
  if (file === undefined) return null;
  return {
    token,
    createdAt,
    title: boundedText(record.title, SHARE_TARGET_MAX_TITLE),
    text: boundedText(record.text, SHARE_TARGET_MAX_TEXT),
    url: boundedText(record.url, 4096),
    file,
  };
}
