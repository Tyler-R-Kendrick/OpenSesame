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
  createdAt: number,
  part: "meta" | "file",
): string {
  return new URL(
    `${new URL(scopeUrl).pathname}__share-target/${token}/${createdAt}/${part}`,
    scopeUrl,
  ).href;
}

/** The key and token travel in the fragment, which is never sent to a server. */
export function shareTargetPageUrl(
  scopeUrl: string,
  token: string,
  keyB64: string,
  createdAt: number,
): string {
  const url = new URL(scopeUrl);
  url.hash = new URLSearchParams({
    [SHARE_TARGET_PARAM]: `${token}.${keyB64}.${createdAt}`,
  }).toString();
  return url.href;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/gu, "-")
    .replace(/\//gu, "_")
    .replace(/=+$/u, "");
}

function base64UrlToBytes(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(value)) return null;
  try {
    const padded = value.replace(/-/gu, "+").replace(/_/gu, "/");
    const binary = atob(
      `${padded}${"=".repeat((4 - (padded.length % 4)) % 4)}`,
    );
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1)
      bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    return null;
  }
}

export function newShareTargetKey(): string {
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

export async function sealShareTarget(
  keyB64: string,
  plain: Uint8Array,
): Promise<Uint8Array> {
  const raw = base64UrlToBytes(keyB64);
  if (!raw) throw new Error("invalid share key");
  const key = await crypto.subtle.importKey(
    "raw",
    raw,
    { name: "AES-GCM" },
    false,
    ["encrypt"],
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plain),
  );
  const out = new Uint8Array(iv.length + cipher.length);
  out.set(iv);
  out.set(cipher, iv.length);
  return out;
}

export async function openShareTarget(
  keyB64: string,
  sealed: Uint8Array,
): Promise<Uint8Array> {
  const raw = base64UrlToBytes(keyB64);
  if (!raw || sealed.length <= 12) throw new Error("invalid share entry");
  const key = await crypto.subtle.importKey(
    "raw",
    raw,
    { name: "AES-GCM" },
    false,
    ["decrypt"],
  );
  return new Uint8Array(
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: sealed.subarray(0, 12) },
      key,
      sealed.subarray(12),
    ),
  );
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
