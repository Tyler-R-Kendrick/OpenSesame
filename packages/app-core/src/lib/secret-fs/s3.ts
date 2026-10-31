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
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { Effect } from "effect";
import {
  SecretFsNotFound,
  SecretFsRejected,
  SecretFsUnavailable,
} from "./errors.js";
import type { SecretFsError } from "./errors.js";
import { checkPath, revisionOf } from "./files.js";
import type { SecretFiles } from "./files.js";
import { keysOf, moreAfter } from "./s3-listing.js";
import { s3Exchange } from "./s3-response.js";
import type { S3Reply } from "./s3-response.js";
import { EMPTY_PAYLOAD, signS3 } from "./s3-sigv4.js";
import type { S3Credentials } from "./s3-sigv4.js";
import { s3Write } from "./s3-write.js";
import { asBufferSource } from "@opensesame/os-domain";

export const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_LIST_PAGES = 1000;

export type S3FilesConfig = Readonly<{
  /** The service address, e.g. `https://s3.eu-west-1.amazonaws.com` or `https://minio.lan:9000`. */
  endpoint: string;
  region: string;
  bucket: string;
  /** Where in the bucket the vault lives: `vaults/me`. Left out, the bucket's root. */
  prefix?: string | undefined;
  /** Internal opt-in: concatenate the exact logical S3 prefix, without directory normalization. */
  prefixMode?: "directory" | "literal" | undefined;
  credentials: S3Credentials;
  /** `path` (`host/bucket/key`, the default) or `virtual` (`bucket.host/key`). */
  addressing?: "path" | "virtual" | undefined;
  /** Left out, the host's own `fetch`. A test or a pinned-certificate client replaces it. */
  fetch?: typeof fetch | undefined;
  maxBytes?: number | undefined;
  now?: (() => Date) | undefined;
  signal?: AbortSignal | undefined;
  assertCurrent?: (() => void) | undefined;
}>;

const BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

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

type Call = Readonly<{
  beforeCommit?: (() => void) | undefined;
  method: "GET" | "PUT" | "DELETE";
  /** The object's path within the vault, or "" for the bucket. */
  path: string;
  query?: ReadonlyArray<readonly [string, string]> | undefined;
  headers?: Headers | undefined;
  body?: Uint8Array | undefined;
}>;

export type Wire = Readonly<{
  max: number;
  rootPrefix: string;
  current: (path: string) => Effect.Effect<void, SecretFsRejected>;
  call: (call: Call) => Effect.Effect<S3Reply, SecretFsError>;
}>;

function ownerCheck(config: S3FilesConfig): () => void {
  const signal = config.signal;
  const assertCurrent = config.assertCurrent;
  return () => {
    if (signal?.aborted) throw new Error("bucket owner ended");
    assertCurrent?.();
    if (signal?.aborted) throw new Error("bucket owner ended");
  };
}

function ownerRejected(path: string): SecretFsRejected {
  return new SecretFsRejected({
    path,
    kind: "permission",
    reason: "the bucket operation is no longer current",
  });
}

type Target = Readonly<{
  base: string;
  rootPrefix: string;
  max: number;
  send: typeof fetch;
  check: () => void;
  owner: AbortSignal | undefined;
  literal: boolean;
}>;

function exchangeCall(
  config: S3FilesConfig,
  target: Target,
  call: Call,
): Effect.Effect<S3Reply, SecretFsError> {
  const current = () => {
    target.check();
    call.beforeCommit?.();
  };
  return Effect.tryPromise({
    try: async (signal) => {
      current();
      // The bucket itself (a listing) is addressed with no key.
      const key = call.path === "" ? "" : `${target.rootPrefix}${call.path}`;
      const path = target.literal
        ? key.split("/").map(encodeURIComponent).join("/")
        : key;
      const url = new URL(`${target.base}/${path}`);
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
      return s3Exchange({
        send: target.send,
        url: signed.url,
        signal,
        owner: target.owner,
        check: current,
        max: target.max,
        retain: call.method === "GET",
        init: {
          method: call.method,
          body: call.body ? asBufferSource(call.body) : null,
          cache: "no-store",
          redirect: "error",
          headers: signed.headers,
        },
      });
    },
    catch: () => {
      try {
        current();
      } catch {
        return ownerRejected(call.path);
      }
      return new SecretFsUnavailable({
        path: call.path,
        reason: "the bucket's answer did not arrive whole",
      });
    },
  });
}

function s3RootPrefix(config: S3FilesConfig): string {
  const prefix = config.prefix ?? "";
  if (config.prefixMode !== "literal") {
    const directory = prefix.replace(/^\/+|\/+$/g, "");
    return directory === "" ? "" : `${directory}/`;
  }
  if (prefix.split("/").some((part) => part === "." || part === ".."))
    throw new TypeError("a literal S3 prefix cannot contain dot segments");
  return prefix;
}

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
  const literal = config.prefixMode === "literal";
  const rootPrefix = s3RootPrefix(config);
  const send = config.fetch ?? ((...args) => fetch(...args));
  const max = config.maxBytes ?? MAX_FILE_BYTES;
  if (!Number.isSafeInteger(max) || max <= 0) {
    throw new TypeError("a bucket response bound is a positive safe integer");
  }
  const check = ownerCheck(config);
  const owner = config.signal;
  const origin = virtual
    ? `${endpoint.protocol}//${config.bucket}.${endpoint.host}`
    : endpoint.origin;
  const base = `${origin}${virtual ? "" : `/${config.bucket}`}`;

  return {
    max,
    rootPrefix,
    current: (path) =>
      Effect.try({ try: check, catch: () => ownerRejected(path) }),
    call: (call) =>
      exchangeCall(
        config,
        { base, rootPrefix, max, send, check, owner, literal },
        call,
      ),
  };
}

const readFile =
  (wire: Wire): SecretFiles["read"] =>
  (path) =>
    Effect.gen(function* () {
      yield* checkPath(path);
      yield* wire.current(path);
      const response = yield* wire.call({ method: "GET", path });
      if (!response.ok) return yield* refusal(path, response.status);
      const bytes = response.bytes;
      // The revision is the content's, so it is computed here and the bucket's
      // claim is not trusted: a store that lies only fails the next write.
      const revision = revisionOf(bytes);
      yield* wire.current(path);
      return { bytes, revision };
    });

const removeFile =
  (wire: Wire): SecretFiles["remove"] =>
  (path) =>
    Effect.gen(function* () {
      yield* checkPath(path);
      yield* wire.current(path);
      const response = yield* wire.call({ method: "DELETE", path });
      if (!response.ok && response.status !== 404) {
        return yield* refusal(path, response.status);
      }
      yield* wire.current(path);
    });

const listFiles =
  (wire: Wire): SecretFiles["list"] =>
  (prefix) =>
    Effect.gen(function* () {
      const under = yield* checkPath(prefix, { allowEmpty: true });
      yield* wire.current(under);
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
        const xml = new TextDecoder().decode(response.bytes);
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
        yield* wire.current(under);
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
    write: s3Write(wire, refusal),
    writeGuarded: (path, bytes, check, options) =>
      s3Write(wire, refusal, check)(path, bytes, options),
    remove: removeFile(wire),
    list: listFiles(wire),
  };
}
