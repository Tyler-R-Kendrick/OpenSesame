/**
 * A bucket in memory, answering as S3 does (ADR 0182): path-style
 * `GetObject`, `PutObject`, `DeleteObject` and `ListObjectsV2` with
 * continuation pages, `If-Match` / `If-None-Match`, an `ETag` of its own that
 * is not the file's revision, and SigV4 checked the way a real bucket checks
 * it — the signature recomputed from the request that arrived, against a body
 * whose hash it also checks. A client whose signature is wrong, or whose body
 * is not the one it signed, is refused 403.
 */
import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex } from "@noble/hashes/utils";
import { Redacted } from "effect";
import { signS3 } from "./s3-sigv4.js";

export const ACCESS_KEY = "AKIATESTONLY";
export const SECRET_KEY = "test-secret-key-0123456789abcdef";
export const REGION = "eu-west-1";
export const BUCKET_NAME = "vault-bucket";
export const ENDPOINT = "https://s3.test";

type Stored = { bytes: Uint8Array; etag: string };

export type FakeBucket = Readonly<{
  fetch: typeof fetch;
  objects: Map<string, Stored>;
  /** Every request seen, method and key. */
  log: string[];
}>;

const xmlEscape = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const reply = (status: number, body = "", headers?: Headers) =>
  new Response(body === "" ? null : body, { status, headers });

type Objects = Map<string, Stored>;

function methodOf(name: string): "GET" | "PUT" | "DELETE" | null {
  switch (name) {
    case "GET":
    case "PUT":
    case "DELETE":
      return name;
    default:
      return null;
  }
}

/** SigV4 as a bucket checks it: recomputed from the request that arrived. */
async function signedCorrectly(
  request: Request,
  body: Uint8Array,
): Promise<boolean> {
  const claimed = request.headers.get("x-amz-content-sha256");
  if (claimed !== bytesToHex(sha256(body))) return false;
  const auth = request.headers.get("authorization") ?? "";
  const names = /SignedHeaders=([^,]+)/.exec(auth)?.[1]?.split(";") ?? [];
  const carried = new Headers();
  for (const name of names) {
    const value = request.headers.get(name);
    if (value !== null && name !== "host" && !name.startsWith("x-amz-")) {
      carried.set(name, value);
    }
  }
  const token = request.headers.get("x-amz-security-token");
  const stamp = request.headers.get("x-amz-date") ?? "";
  const method = methodOf(request.method);
  if (method === null) return false;
  const expected = signS3({
    method,
    url: new URL(request.url),
    headers: carried,
    payloadHash: claimed,
    region: REGION,
    credentials: {
      accessKeyId: ACCESS_KEY,
      secretAccessKey: Redacted.make(SECRET_KEY),
      sessionToken: token === null ? undefined : Redacted.make(token),
    },
    now: new Date(
      `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}Z`,
    ),
  });
  return expected.headers.get("authorization") === auth;
}

function listing(objects: Objects, url: URL, pageSize: number): Response {
  const prefix = url.searchParams.get("prefix") ?? "";
  const after = url.searchParams.get("continuation-token") ?? "";
  const keys = [...objects.keys()]
    .filter((name) => name.startsWith(prefix) && name > after)
    .sort();
  const page = keys.slice(0, pageSize);
  const more = keys.length > page.length;
  const contents = page
    .map((name) => `<Contents><Key>${xmlEscape(name)}</Key></Contents>`)
    .join("");
  const next = more
    ? `<NextContinuationToken>${xmlEscape(page.at(-1) ?? "")}</NextContinuationToken>`
    : "";
  return reply(
    200,
    `<?xml version="1.0"?><ListBucketResult>${contents}<IsTruncated>${more}</IsTruncated>${next}</ListBucketResult>`,
  );
}

function put(
  objects: Objects,
  key: string,
  request: Request,
  body: Uint8Array,
  etag: string,
): Response {
  const found = objects.get(key);
  const match = request.headers.get("if-match");
  if (request.headers.get("if-none-match") === "*" && found !== undefined) {
    return reply(412);
  }
  if (match !== null && found?.etag !== match) return reply(412);
  objects.set(key, { bytes: body, etag });
  return reply(200, "", new Headers([["etag", etag]]));
}

function object(
  objects: Objects,
  key: string,
  request: Request,
  body: Uint8Array,
  etag: string,
): Response {
  if (request.method === "PUT") return put(objects, key, request, body, etag);
  if (request.method === "DELETE") {
    objects.delete(key);
    return reply(204);
  }
  const found = objects.get(key);
  if (request.method !== "GET") return reply(405);
  return found === undefined
    ? reply(404, "<Error><Code>NoSuchKey</Code></Error>")
    : new Response(found.bytes, { status: 200, headers: { etag: found.etag } });
}

export function fakeBucket(pageSize = 2): FakeBucket {
  const objects: Objects = new Map();
  const log: string[] = [];
  let serial = 0;

  const handle = async (request: Request): Promise<Response> => {
    const body = new Uint8Array(await request.arrayBuffer());
    if (!(await signedCorrectly(request, body))) {
      return reply(403, "<Error><Code>SignatureDoesNotMatch</Code></Error>");
    }
    const url = new URL(request.url);
    const [bucket, ...rest] = url.pathname
      .split("/")
      .filter((part) => part !== "")
      .map(decodeURIComponent);
    if (bucket !== BUCKET_NAME) return reply(404);
    const key = rest.join("/");
    log.push(`${request.method} ${key}`);
    if (request.method === "GET" && key === "") {
      return listing(objects, url, pageSize);
    }
    serial += 1;
    return object(objects, key, request, body, `"etag-${serial}"`);
  };

  return {
    fetch: (input, init) => handle(new Request(input, init)),
    objects,
    log,
  };
}
