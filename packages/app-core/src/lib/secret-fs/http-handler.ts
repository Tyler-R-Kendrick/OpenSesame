/**
 * The storage server's side of `http.ts` (ADR 0182): a `Request` in, a
 * `Response` out, over any secret file store. It is a function and not a
 * server so the host that owns the socket — the daemon, a Node process, a
 * worker, a container's init — mounts it where it already listens, and so a
 * test can drive it with no network at all.
 *
 * What it serves is ciphertext: every file is already sealed under a key the
 * server never holds. It still refuses everything but an authenticated,
 * validated request, because a store that anyone can overwrite is one that
 * anyone can corrupt. No token is a refusal to start, never an open door.
 */
import { sha256 } from "@noble/hashes/sha2";
import { Effect, Redacted } from "effect";
import type { SecretFsError } from "./errors.js";
import type { SecretFiles } from "./files.js";
import { checkPath } from "./files.js";
import { FILES_ROUTE, MAX_FILE_BYTES } from "./http.js";

export type FilesHandlerOptions = Readonly<{
  token: Redacted.Redacted<string>;
  /** The one page origin allowed to call across origins; left out, none is. */
  allowOrigin?: string | undefined;
  maxBytes?: number | undefined;
}>;

/** Headers every answer carries: nothing here is for a cache to keep. */
function plain(...pairs: Array<[string, string]>): Headers {
  const headers = new Headers({ "cache-control": "no-store" });
  for (const [name, value] of pairs) headers.set(name, value);
  return headers;
}

/** What the server says in JSON: a named error, or a listing. */
type JsonBody =
  | Readonly<{ error: string }>
  | Readonly<{ paths: ReadonlyArray<string> }>;

function json(status: number, body: JsonBody, extra?: Headers) {
  const headers = plain(["content-type", "application/json"]);
  for (const [name, value] of extra ?? []) headers.set(name, value);
  return new Response(JSON.stringify(body), { status, headers });
}

const header = (name: string, value: string) => new Headers([[name, value]]);

/** Equal without revealing, by timing, how much of a guess was right. */
function sameToken(given: string, expected: string): boolean {
  const a = sha256(new TextEncoder().encode(given));
  const b = sha256(new TextEncoder().encode(expected));
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) {
    difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }
  return difference === 0;
}

function answer(error: SecretFsError): Response {
  switch (error._tag) {
    case "SecretFsNotFound":
      return json(404, { error: "not-found" });
    case "SecretFsConflict":
      return json(
        412,
        { error: "conflict" },
        error.actual === null ? undefined : header("etag", `"${error.actual}"`),
      );
    case "SecretFsUnavailable":
      return json(503, { error: "unavailable" });
    case "SecretFsRejected":
      return json(
        error.kind === "permission"
          ? 403
          : error.kind === "corrupt"
            ? 422
            : 400,
        { error: error.kind },
      );
  }
}

type Served = Readonly<{
  files: SecretFiles;
  secret: string;
  max: number;
}>;

const run = <A>(effect: Effect.Effect<A, SecretFsError>) =>
  Effect.runPromise(Effect.result(effect));

function preflight(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-methods": "GET, PUT, DELETE",
      "access-control-allow-headers":
        "authorization, content-type, if-match, if-none-match",
      "access-control-max-age": "600",
    },
  });
}

function authorized(request: Request, secret: string): boolean {
  const bearer = request.headers.get("authorization") ?? "";
  return bearer.startsWith("Bearer ") && sameToken(bearer.slice(7), secret);
}

/** The path a URL names, decoded once; `null` when it is not decodable at all. */
function pathOf(url: URL): string | null {
  try {
    return url.pathname
      .slice(FILES_ROUTE.length + 1)
      .split("/")
      .map(decodeURIComponent)
      .join("/");
  } catch {
    return null;
  }
}

/** `null` means must-not-exist, a string a revision, `undefined` no check. */
function expectedRevision(request: Request): string | null | undefined {
  if (request.headers.get("if-none-match") === "*") return null;
  const ifMatch = request.headers.get("if-match");
  return ifMatch === null
    ? undefined
    : ifMatch.replace(/^W\//, "").replace(/^"|"$/g, "");
}

async function listReply(served: Served, url: URL): Promise<Response> {
  const listed = await run(
    served.files.list(url.searchParams.get("prefix") ?? ""),
  );
  return listed._tag === "Success"
    ? json(200, { paths: listed.success })
    : answer(listed.failure);
}

async function readReply(served: Served, path: string): Promise<Response> {
  const read = await run(served.files.read(path));
  return read._tag === "Failure"
    ? answer(read.failure)
    : new Response(read.success.bytes, {
        status: 200,
        headers: plain(
          ["content-type", "application/octet-stream"],
          ["etag", `"${read.success.revision}"`],
        ),
      });
}

async function removeReply(served: Served, path: string): Promise<Response> {
  const removed = await run(served.files.remove(path));
  return removed._tag === "Failure"
    ? answer(removed.failure)
    : new Response(null, { status: 204, headers: plain() });
}

async function writeReply(
  served: Served,
  path: string,
  request: Request,
): Promise<Response> {
  const tooLarge = () => json(413, { error: "too-large" });
  if (Number(request.headers.get("content-length") ?? 0) > served.max) {
    return tooLarge();
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > served.max) return tooLarge();
  const ifRevision = expectedRevision(request);
  const written = await run(
    served.files.write(
      path,
      bytes,
      ifRevision === undefined ? {} : { ifRevision },
    ),
  );
  return written._tag === "Failure"
    ? answer(written.failure)
    : new Response(null, {
        status: 200,
        headers: plain(["etag", `"${written.success}"`]),
      });
}

async function fileReply(
  served: Served,
  request: Request,
  path: string,
): Promise<Response> {
  const checked = await run(checkPath(path));
  if (checked._tag === "Failure") return answer(checked.failure);
  switch (request.method) {
    case "GET":
      return readReply(served, path);
    case "DELETE":
      return removeReply(served, path);
    case "PUT":
      return writeReply(served, path, request);
    default:
      return json(
        405,
        { error: "method-not-allowed" },
        header("allow", "GET, PUT, DELETE"),
      );
  }
}

async function route(served: Served, request: Request): Promise<Response> {
  if (request.method === "OPTIONS") return preflight();
  if (!authorized(request, served.secret)) {
    return json(
      401,
      { error: "unauthorized" },
      header("www-authenticate", "Bearer"),
    );
  }
  const url = new URL(request.url);
  if (url.pathname === FILES_ROUTE && request.method === "GET") {
    return listReply(served, url);
  }
  if (!url.pathname.startsWith(`${FILES_ROUTE}/`)) {
    return json(404, { error: "not-found" });
  }
  const path = pathOf(url);
  return path === null
    ? json(400, { error: "invalid-path" })
    : fileReply(served, request, path);
}

/** The headers that let the one configured page origin call across origins. */
function corsHeaders(allowOrigin: string | undefined): Headers {
  const cors = new Headers();
  if (allowOrigin) {
    cors.set("access-control-allow-origin", allowOrigin);
    cors.set("access-control-expose-headers", "etag");
    cors.set("vary", "origin");
  }
  return cors;
}

export function makeFilesHandler(
  files: SecretFiles,
  options: FilesHandlerOptions,
): (request: Request) => Promise<Response> {
  const secret = Redacted.value(options.token);
  if (secret.length < 16) {
    throw new TypeError(
      "a storage server needs a token of 16 characters or more",
    );
  }
  const served: Served = {
    files,
    secret,
    max: options.maxBytes ?? MAX_FILE_BYTES,
  };
  const cors = corsHeaders(options.allowOrigin);
  return async (request) => {
    const response = await route(served, request);
    for (const [name, value] of cors) response.headers.set(name, value);
    return response;
  };
}
