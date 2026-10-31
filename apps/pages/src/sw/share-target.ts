/**
 * Web Share Target ingress.
 *
 * A share is a navigation POST from the operating system, not an API call.
 * This handler bounds the form, stores one file (or the shared text) in the
 * scope-owned share cache, and redirects to a tokenised page. It does not
 * import, parse or mutate the vault; the page opens the normal Import review
 * and the person still presses Import.
 */

import {
  SHARE_TARGET_EXTENSIONS,
  SHARE_TARGET_MAX_BYTES,
  SHARE_TARGET_MAX_TEXT,
  SHARE_TARGET_MAX_TITLE,
  SHARE_TARGET_PATH,
  type ShareTargetFile,
  type ShareTargetMeta,
  newShareTargetKey,
  sealShareTarget,
  shareTargetCacheName,
  shareTargetEntryUrl,
  shareTargetPageUrl,
} from "../lib/share-target.js";
import type { WorkerContext } from "./context.js";
import { asBufferSource } from "@opensesame/os-domain";

const HEADERS = {
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'none'",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
} as const;

type Staged = {
  title: string;
  text: string;
  url: string;
  file: File | null;
  fileMeta: ShareTargetFile | null;
};

function fail(status: number, message: string): Response {
  return new Response(message, { status, headers: HEADERS });
}

function bounded(value: FormDataEntryValue | null, max: number): string | null {
  if (value === null) return "";
  if (value instanceof File) return null;
  return value.length <= max ? value : null;
}

function safeName(value: string): string {
  const base = value.split(/[/\\]/u).pop() ?? "";
  const clean = [...base]
    .filter((char) => {
      const code = char.codePointAt(0) ?? 0;
      return code >= 0x20 && code !== 0x7f;
    })
    .join("")
    .slice(0, 255);
  return clean === "" ? "shared-file" : clean;
}

function fileProblem(file: File | null): Response | null {
  if (file === null) return null;
  if (file.size <= 0 || file.size > SHARE_TARGET_MAX_BYTES)
    return fail(413, "That file is empty or too large.");
  if (file.name.length > 255) return fail(413, "That filename is too long.");
  const name = file.name.toLowerCase();
  const dot = name.lastIndexOf(".");
  const extension = dot < 0 ? "" : name.slice(dot);
  if (extension !== "" && !SHARE_TARGET_EXTENSIONS.has(extension))
    return fail(415, "That file type is not an import format.");
  return null;
}

function parseForm(form: FormData): Staged | Response {
  const files = form
    .getAll("files")
    .filter((entry): entry is File => entry instanceof File);
  if (files.length > 1) return fail(413, "Share one file at a time.");
  const file = files[0] ?? null;
  const problem = fileProblem(file);
  if (problem) return problem;

  const title = bounded(form.get("title"), SHARE_TARGET_MAX_TITLE);
  const sharedText = bounded(form.get("text"), SHARE_TARGET_MAX_TEXT);
  const sharedUrl = bounded(form.get("url"), 4096);
  if (title === null || sharedText === null || sharedUrl === null)
    return fail(413, "That share field is too large.");
  if (file === null && sharedText === "" && sharedUrl === "")
    return fail(400, "That share carried no text or file.");

  return {
    title,
    text: sharedText,
    url: sharedUrl,
    file,
    fileMeta:
      file === null
        ? null
        : {
            name: safeName(file.name),
            type: file.type.slice(0, 200) || "application/octet-stream",
            size: file.size,
          },
  };
}

/** Remove ciphertext older than one hour; never wipe a live pending share. */
async function sweep(cache: Cache, now: number): Promise<void> {
  for (const request of await cache.keys()) {
    const match = /\/__share-target\/[^/]+\/([^/]+)\//u.exec(request.url);
    if (!match) continue;
    const createdAt = Number(match[1]);
    if (
      !Number.isSafeInteger(createdAt) ||
      createdAt <= 0 ||
      now - createdAt > 60 * 60 * 1000
    )
      await cache.delete(request);
  }
}

/** Origin/Referer, when present, must name this worker's own origin. */
function sameOriginRequest(ctx: WorkerContext, request: Request): boolean {
  const origin = new URL(ctx.scopeUrl).origin;
  const site = request.headers.get("sec-fetch-site");
  const mode = request.headers.get("sec-fetch-mode");
  // An OS share is a browser-initiated navigation: `none` or the app's own
  // origin. Missing or unknown fetch metadata is not evidence of either.
  if (site !== "none" && site !== "same-origin") return false;
  if (mode !== null && mode !== "navigate") return false;
  const claimedOrigin = request.headers.get("origin");
  if (
    claimedOrigin !== null &&
    claimedOrigin !== origin &&
    !(claimedOrigin === "null" && site === "none")
  )
    return false;
  const referer = request.headers.get("referer");
  if (referer !== null) {
    try {
      if (new URL(referer).origin !== origin) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/** Remove expired staged ciphertext without waiting for another share. */
export async function sweepShareTargetCache(ctx: WorkerContext): Promise<void> {
  try {
    const name = shareTargetCacheName(ctx.scopePath);
    if (!(await ctx.caches.has(name))) return;
    const cache = await ctx.caches.open(name);
    await sweep(cache, Date.now());
  } catch {
    // No cache, nothing to collect.
  }
}

async function boundedForm(request: Request): Promise<FormData | null> {
  const reader = request.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.length;
      if (total > SHARE_TARGET_MAX_BYTES + 256 * 1024) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.length;
  }
  const type = request.headers.get("content-type");
  if (type === null) return null;
  return new Response(joined, { headers: { "Content-Type": type } }).formData();
}

async function stage(
  ctx: WorkerContext,
  token: string,
  createdAt: number,
  staged: Staged,
): Promise<string | null> {
  const meta: ShareTargetMeta = {
    token,
    createdAt,
    title: staged.title,
    text: staged.text,
    url: staged.url,
    file: staged.fileMeta,
  };
  const key = newShareTargetKey();
  const encoder = new TextEncoder();
  const metaEntry = shareTargetEntryUrl(ctx.scopeUrl, token, createdAt, "meta");
  const fileEntry = shareTargetEntryUrl(ctx.scopeUrl, token, createdAt, "file");
  try {
    const cache = await ctx.caches.open(shareTargetCacheName(ctx.scopePath));
    await sweep(cache, createdAt);
    await cache.put(
      new Request(metaEntry),
      new Response(
        asBufferSource(await sealShareTarget(key, encoder.encode(JSON.stringify(meta)))),
        { headers: { "Content-Type": "application/octet-stream" } },
      ),
    );
    if (staged.file !== null) {
      await cache.put(
        new Request(fileEntry),
        new Response(
          asBufferSource(await sealShareTarget(
            key,
            new Uint8Array(await staged.file.arrayBuffer()),
          )),
          { headers: { "Content-Type": "application/octet-stream" } },
        ),
      );
    }
    return key;
  } catch {
    try {
      const cache = await ctx.caches.open(shareTargetCacheName(ctx.scopePath));
      await cache.delete(metaEntry);
      await cache.delete(fileEntry);
    } catch {
      // The cache itself is unavailable; nothing else can be removed.
    }
    return null;
  }
}

/**
 * Answer `/share-target`; `null` for every other request so the normal fetch
 * path can decide. Same-origin is checked by the caller and again here.
 */
export async function respondToShareTarget(
  ctx: WorkerContext,
  request: Request,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (
    request.method !== "POST" ||
    url.origin !== new URL(ctx.scopeUrl).origin ||
    url.pathname !== `${ctx.scopePath}${SHARE_TARGET_PATH}`
  )
    return null;

  // An OS share is a user-initiated navigation (`none`) or the app itself.
  // A cross-site form in a hidden iframe must not clear or fill this cache.
  if (!sameOriginRequest(ctx, request))
    return fail(403, "Cross-origin shares are not accepted.");
  if (request.headers.get("sec-fetch-site") === "cross-site")
    return fail(403, "Cross-site shares are not accepted.");

  const createdAt = Date.now();
  try {
    const cache = await ctx.caches.open(shareTargetCacheName(ctx.scopePath));
    // Sweep even when this share is rejected below: old ciphertext must not
    // wait for a later successful share to be collected.
    await sweep(cache, createdAt);
  } catch {
    // The cache is unavailable; staging reports that below.
  }

  const rawLength = request.headers.get("content-length");
  if (
    rawLength !== null &&
    Number(rawLength) > SHARE_TARGET_MAX_BYTES + 256 * 1024
  )
    return fail(413, "That share is too large.");

  let form: FormData;
  try {
    const parsed = await boundedForm(request);
    if (parsed === null) return fail(413, "That share is too large.");
    form = parsed;
  } catch {
    return fail(400, "That share could not be read.");
  }
  const staged = parseForm(form);
  if (staged instanceof Response) return staged;

  const token = crypto.randomUUID();
  const key = await stage(ctx, token, createdAt, staged);
  if (key === null) return fail(507, "This device could not stage that share.");
  return new Response(null, {
    status: 303,
    headers: {
      ...HEADERS,
      Location: shareTargetPageUrl(ctx.scopeUrl, token, key, createdAt),
    },
  });
}
