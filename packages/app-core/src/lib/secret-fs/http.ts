/**
 * The secret file store reached over HTTP (ADR 0182): what a PWA served from
 * one machine uses when its secrets live on another — a daemon, a NAS, a
 * container with the vault directory mounted. Its four operations are the
 * contract's four, spoken as `GET`, `PUT`, `DELETE` and a listing, with the
 * file's revision as its `ETag` and the revision check as `If-Match` /
 * `If-None-Match`, so the server decides a race and not the network.
 *
 * It does no retrying of its own. Every failure is mapped onto the contract's
 * four (a dead socket, a 5xx, a 429 are `SecretFsUnavailable`; a 401 or 403 is
 * a refusal) and `resilient.ts` decides what to do about it, the same as for
 * a disk. The bearer token is held `Redacted`, so no log line or error
 * message made from this object can print it.
 */
import { Effect, Redacted, Schema } from "effect";
import {
  SecretFsConflict,
  SecretFsNotFound,
  SecretFsRejected,
  SecretFsUnavailable,
} from "./errors.js";
import type { SecretFsError } from "./errors.js";
import { checkPath, revisionOf } from "./files.js";
import type { SecretFiles } from "./files.js";

const listing = Schema.fromJsonString(
  Schema.Struct({ paths: Schema.Array(Schema.String) }),
);

/** What the client sends beyond the credential. */
type HttpRequest = Readonly<{
  method: "GET" | "PUT" | "DELETE";
  headers?: Headers;
  body?: Uint8Array;
}>;

export const FILES_ROUTE = "/v1/files";
export const MAX_FILE_BYTES = 4 * 1024 * 1024;

export type HttpFilesConfig = Readonly<{
  /** The storage server's origin, e.g. `https://vault.example.net`. */
  baseUrl: string;
  token: Redacted.Redacted<string>;
  /** Left out, the host's own `fetch`. A test or a pinned-certificate client replaces it. */
  fetch?: typeof fetch;
  maxBytes?: number;
}>;

const unquote = (etag: string | null): string | null =>
  etag === null ? null : etag.replace(/^W\//, "").replace(/^"|"$/g, "");

async function readBounded(
  response: Response,
  max: number,
): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > max) throw new RangeError("response too large");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > max) throw new RangeError("response too large");
  return bytes;
}

/** Name an unsuccessful response the way every other backend names it. */
function refusal(path: string, response: Response): SecretFsError {
  const { status } = response;
  if (status === 404) return new SecretFsNotFound({ path });
  if (status === 412) {
    return new SecretFsConflict({
      path,
      expected: null,
      actual: unquote(response.headers.get("etag")),
    });
  }
  if (status === 401 || status === 403) {
    return new SecretFsRejected({
      path,
      kind: "permission",
      reason: "the storage server refused the credential",
    });
  }
  if (status === 400 || status === 413) {
    return new SecretFsRejected({
      path,
      kind: "invalid-path",
      reason: `the storage server refused the request (${status})`,
    });
  }
  return new SecretFsUnavailable({
    path,
    reason: `the storage server answered ${status}`,
  });
}

/** What every request of one client shares: where, as whom, and how big an answer may be. */
type Wire = Readonly<{
  base: string;
  max: number;
  send: typeof fetch;
  request: (
    path: string,
    url: string,
    init: HttpRequest,
  ) => Effect.Effect<Response, SecretFsError>;
  body: (
    path: string,
    response: Response,
  ) => Effect.Effect<Uint8Array, SecretFsError>;
}>;

function makeWire(config: HttpFilesConfig): Wire {
  const origin = new URL(config.baseUrl);
  if (origin.protocol !== "https:" && origin.protocol !== "http:") {
    throw new TypeError("a storage server is reached over http or https");
  }
  const send = config.fetch ?? ((...args) => fetch(...args));
  const max = config.maxBytes ?? MAX_FILE_BYTES;
  return {
    base: `${origin.origin}${FILES_ROUTE}`,
    max,
    send,
    request: (path, url, init) =>
      Effect.tryPromise({
        try: (signal) => {
          const headers = new Headers(init.headers);
          headers.set(
            "authorization",
            `Bearer ${Redacted.value(config.token)}`,
          );
          return send(url, {
            method: init.method,
            body: init.body ?? null,
            signal,
            cache: "no-store",
            redirect: "error",
            headers,
          });
        },
        catch: () =>
          new SecretFsUnavailable({
            path,
            reason: "the storage server could not be reached",
          }),
      }),
    body: (path, response) =>
      Effect.tryPromise({
        try: () => readBounded(response, max),
        catch: () =>
          new SecretFsUnavailable({
            path,
            reason: "the storage server's answer did not arrive whole",
          }),
      }),
  };
}

const readFile =
  (wire: Wire): SecretFiles["read"] =>
  (path) =>
    Effect.gen(function* () {
      yield* checkPath(path);
      const response = yield* wire.request(path, `${wire.base}/${path}`, {
        method: "GET",
      });
      if (!response.ok) return yield* refusal(path, response);
      const bytes = yield* wire.body(path, response);
      // The revision is the content's, so it is computed here and the server's
      // claim is not trusted: a store that lies about it only fails the check
      // on the next write.
      return { bytes, revision: revisionOf(bytes) };
    });

const writeFile =
  (wire: Wire): SecretFiles["write"] =>
  (path, bytes, options) =>
    Effect.gen(function* () {
      yield* checkPath(path);
      const headers = new Headers({
        "content-type": "application/octet-stream",
      });
      if (options?.ifRevision === null) headers.set("if-none-match", "*");
      else if (options?.ifRevision !== undefined) {
        headers.set("if-match", `"${options.ifRevision}"`);
      }
      const response = yield* wire.request(path, `${wire.base}/${path}`, {
        method: "PUT",
        headers,
        body: bytes,
      });
      if (response.status === 412) {
        return yield* new SecretFsConflict({
          path,
          expected: options?.ifRevision ?? null,
          actual: unquote(response.headers.get("etag")),
        });
      }
      if (!response.ok) return yield* refusal(path, response);
      return revisionOf(bytes);
    });

const removeFile =
  (wire: Wire): SecretFiles["remove"] =>
  (path) =>
    Effect.gen(function* () {
      yield* checkPath(path);
      const response = yield* wire.request(path, `${wire.base}/${path}`, {
        method: "DELETE",
      });
      if (!response.ok && response.status !== 404) {
        return yield* refusal(path, response);
      }
    });

const listFiles =
  (wire: Wire): SecretFiles["list"] =>
  (prefix) =>
    Effect.gen(function* () {
      const under = yield* checkPath(prefix, { allowEmpty: true });
      const response = yield* wire.request(
        under,
        `${wire.base}?prefix=${encodeURIComponent(under)}`,
        { method: "GET" },
      );
      if (!response.ok) return yield* refusal(under, response);
      const bytes = yield* wire.body(under, response);
      const { paths } = yield* Schema.decodeUnknownEffect(listing)(
        new TextDecoder().decode(bytes),
      ).pipe(
        Effect.mapError(
          () =>
            new SecretFsUnavailable({
              path: under,
              reason: "the storage server's listing was not a listing",
            }),
        ),
      );
      // A server's word for what is a valid path is not taken over our own.
      const valid: string[] = [];
      for (const path of paths) {
        const ok = yield* checkPath(path).pipe(
          Effect.match({ onFailure: () => false, onSuccess: () => true }),
        );
        if (ok) valid.push(path);
      }
      return valid.sort();
    });

export function makeHttpSecretFiles(config: HttpFilesConfig): SecretFiles {
  const wire = makeWire(config);
  return {
    read: readFile(wire),
    write: writeFile(wire),
    remove: removeFile(wire),
    list: listFiles(wire),
  };
}
