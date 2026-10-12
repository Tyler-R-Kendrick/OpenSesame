/**
 * The secret file store on an S3-compatible bucket (ADR 0182): AWS S3, MinIO,
 * Cloudflare R2, Backblaze B2, Ceph — anything that speaks the S3 API. It is
 * the store a browser can reach with no server of ours in between, which is
 * why the PWA offers it in setup beside the emulation: the bucket holds only
 * sealed documents, under keys the bucket never sees.
 *
 * The contract's four operations are `GetObject`, `PutObject`,
 * `DeleteObject` and `ListObjectsV2`. A revision is the SHA-256 of the bytes,
 * as everywhere, so a write that names one reads the object, compares, and
 * puts with `If-Match: <ETag>` — the bucket decides a race, not the network.
 * A create-only write is `If-None-Match: *`.
 *
 * It does no retrying of its own: a dead socket, a 5xx, a 429 or a 503
 * `SlowDown` are `SecretFsUnavailable` and `resilient.ts` decides what to do.
 * The secret key is held `Redacted`, and a request is never followed across
 * a redirect, so a signature is not sent somewhere it was not made for.
 */
import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex } from "@noble/hashes/utils";
import { Effect } from "effect";
import {
  SecretFsConflict,
  SecretFsNotFound,
  SecretFsRejected,
  SecretFsUnavailable,
} from "./errors.js";
import type { SecretFsError } from "./errors.js";
import { checkPath, revisionOf } from "./files.js";
import type { SecretFiles } from "./files.js";
import { keysOf, moreAfter } from "./s3-listing.js";
import { EMPTY_PAYLOAD, signS3 } from "./s3-sigv4.js";
import type { S3Credentials } from "./s3-sigv4.js";

export const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_LIST_PAGES = 1000;

export type S3FilesConfig = Readonly<{
  /** The service address, e.g. `https://s3.eu-west-1.amazonaws.com` or `https://minio.lan:9000`. */
  endpoint: string;
  region: string;
  bucket: string;
  /** Where in the bucket the vault lives: `vaults/me`. Left out, the bucket's root. */
  prefix?: string | undefined;
  credentials: S3Credentials;
  /** `path` (`host/bucket/key`, the default) or `virtual` (`bucket.host/key`). */
  addressing?: "path" | "virtual" | undefined;
  /** Left out, the host's own `fetch`. A test or a pinned-certificate client replaces it. */
  fetch?: typeof fetch | undefined;
  maxBytes?: number | undefined;
  now?: (() => Date) | undefined;
}>;

const BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const unquote = (etag: string | null): string | null =>
  etag === null ? null : etag.replace(/^W\//, "");

/** Name an unsuccessful response the way every other backend names it. */
function refusal(path: string, status: number): SecretFsError {
  if (status === 404) return new SecretFsNotFound({ path });
  if (status === 401 || status === 403) {
    return new SecretFsRejected({
      path,
      kind: "permission",
      reason: "the bucket refused the credential",
    });
  }
  if (status === 400 || status === 413) {
    return new SecretFsRejected({
      path,
      kind: "invalid-path",
      reason: `the bucket refused the request (${status})`,
    });
  }
  return new SecretFsUnavailable({
    path,
    reason: `the bucket answered ${status}`,
  });
}

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

type Call = Readonly<{
  method: "GET" | "PUT" | "DELETE";
  /** The object's path within the vault, or "" for the bucket. */
  path: string;
  query?: ReadonlyArray<readonly [string, string]> | undefined;
  headers?: Headers | undefined;
  body?: Uint8Array | undefined;
}>;

type Wire = Readonly<{
  max: number;
  rootPrefix: string;
  call: (call: Call) => Effect.Effect<Response, SecretFsUnavailable>;
  body: (
    path: string,
    response: Response,
  ) => Effect.Effect<Uint8Array, SecretFsUnavailable>;
}>;

function makeWire(config: S3FilesConfig): Wire {
  const endpoint = new URL(config.endpoint);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(
    endpoint.hostname,
  );
  if (
    endpoint.protocol !== "https:" &&
    !(endpoint.protocol === "http:" && loopback)
  ) {
    throw new TypeError(
      "a bucket is reached over https; plain http only to this machine",
    );
  }
  if (!BUCKET.test(config.bucket)) {
    throw new TypeError("that is not a bucket name");
  }
  const virtual = config.addressing === "virtual";
  const prefix = (config.prefix ?? "").replace(/^\/+|\/+$/g, "");
  const rootPrefix = prefix === "" ? "" : `${prefix}/`;
  const send = config.fetch ?? ((...args) => fetch(...args));
  const max = config.maxBytes ?? MAX_FILE_BYTES;
  const origin = virtual
    ? `${endpoint.protocol}//${config.bucket}.${endpoint.host}`
    : endpoint.origin;
  const base = `${origin}${virtual ? "" : `/${config.bucket}`}`;

  return {
    max,
    rootPrefix,
    call: (call) =>
      Effect.tryPromise({
        try: (signal) => {
          // The bucket itself (a listing) is addressed with no key.
          const key = call.path === "" ? "" : `${rootPrefix}${call.path}`;
          const url = new URL(`${base}/${key}`);
          for (const [name, value] of call.query ?? []) {
            url.searchParams.set(name, value);
          }
          const signed = signS3({
            method: call.method,
            url,
            headers: call.headers,
            payloadHash:
              call.body === undefined
                ? EMPTY_PAYLOAD
                : bytesToHex(sha256(call.body)),
            region: config.region,
            credentials: config.credentials,
            now: config.now?.(),
          });
          return send(signed.url, {
            method: call.method,
            body: call.body ?? null,
            signal,
            cache: "no-store",
            redirect: "error",
            headers: signed.headers,
          });
        },
        catch: () =>
          new SecretFsUnavailable({
            path: call.path,
            reason: "the bucket could not be reached",
          }),
      }),
    body: (path, response) =>
      Effect.tryPromise({
        try: () => readBounded(response, max),
        catch: () =>
          new SecretFsUnavailable({
            path,
            reason: "the bucket's answer did not arrive whole",
          }),
      }),
  };
}

const readFile =
  (wire: Wire): SecretFiles["read"] =>
  (path) =>
    Effect.gen(function* () {
      yield* checkPath(path);
      const response = yield* wire.call({ method: "GET", path });
      if (!response.ok) return yield* refusal(path, response.status);
      const bytes = yield* wire.body(path, response);
      // The revision is the content's, so it is computed here and the bucket's
      // claim is not trusted: a store that lies only fails the next write.
      return { bytes, revision: revisionOf(bytes) };
    });

/** What the object is now, for a conflict to name and a conditional put to hold. */
const currentOf = (wire: Wire, path: string) =>
  Effect.gen(function* () {
    const response = yield* wire.call({ method: "GET", path });
    if (response.status === 404) return null;
    if (!response.ok) return yield* refusal(path, response.status);
    const bytes = yield* wire.body(path, response);
    return {
      etag: unquote(response.headers.get("etag")),
      revision: revisionOf(bytes),
    };
  });

const writeFile =
  (wire: Wire): SecretFiles["write"] =>
  (path, bytes, options) =>
    Effect.gen(function* () {
      yield* checkPath(path);
      if (bytes.byteLength > wire.max) {
        return yield* new SecretFsRejected({
          path,
          kind: "invalid-path",
          reason: "the file is larger than a store holds",
        });
      }
      const expected = options?.ifRevision;
      const headers = new Headers({
        "content-type": "application/octet-stream",
      });
      const conflict = (actual: string | null) =>
        new SecretFsConflict({ path, expected: expected ?? null, actual });

      if (expected === null) headers.set("if-none-match", "*");
      else if (expected !== undefined) {
        const current = yield* currentOf(wire, path);
        if (current === null || current.revision !== expected) {
          return yield* conflict(current?.revision ?? null);
        }
        if (current.etag !== null) headers.set("if-match", current.etag);
      }
      const response = yield* wire.call({
        method: "PUT",
        path,
        headers,
        body: bytes,
      });
      // 412 is a failed precondition; 409 is a rival conditional write in flight.
      if (response.status === 412 || response.status === 409) {
        const now = yield* currentOf(wire, path).pipe(
          Effect.orElseSucceed(() => null),
        );
        return yield* conflict(now?.revision ?? null);
      }
      if (!response.ok) return yield* refusal(path, response.status);
      return revisionOf(bytes);
    });

const removeFile =
  (wire: Wire): SecretFiles["remove"] =>
  (path) =>
    Effect.gen(function* () {
      yield* checkPath(path);
      const response = yield* wire.call({ method: "DELETE", path });
      if (!response.ok && response.status !== 404) {
        return yield* refusal(path, response.status);
      }
    });

const listFiles =
  (wire: Wire): SecretFiles["list"] =>
  (prefix) =>
    Effect.gen(function* () {
      const under = yield* checkPath(prefix, { allowEmpty: true });
      const found: string[] = [];
      let token: string | null = null;
      for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
        const query: Array<readonly [string, string]> = [
          ["list-type", "2"],
          ["prefix", `${wire.rootPrefix}${under}`],
        ];
        if (token !== null) query.push(["continuation-token", token]);
        const response = yield* wire.call({ method: "GET", path: "", query });
        if (!response.ok) return yield* refusal(under, response.status);
        const xml = new TextDecoder().decode(yield* wire.body(under, response));
        for (const key of keysOf(xml)) {
          if (!key.startsWith(wire.rootPrefix)) continue;
          const path = key.slice(wire.rootPrefix.length);
          const inside =
            under === "" || path === under || path.startsWith(`${under}/`);
          // A bucket's word for what is a valid path is not taken over our own.
          const valid = yield* checkPath(path).pipe(
            Effect.match({ onFailure: () => false, onSuccess: () => true }),
          );
          if (inside && valid) found.push(path);
        }
        token = moreAfter(xml);
        if (token === null) return found.sort();
      }
      return yield* new SecretFsUnavailable({
        path: under,
        reason: "the bucket's listing did not end",
      });
    });

export function makeS3SecretFiles(config: S3FilesConfig): SecretFiles {
  const wire = makeWire(config);
  return {
    read: readFile(wire),
    write: writeFile(wire),
    remove: removeFile(wire),
    list: listFiles(wire),
  };
}
