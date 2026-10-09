/**
 * AWS Signature Version 4 for S3 (ADR 0182), the one signer the S3 store
 * needs. It is pure — a method, a URL, headers and a body hash in, the
 * request to send out — so it runs unchanged in a browser, a worker and Node,
 * and is checked against the worked examples Amazon publishes.
 *
 * S3 differs from the other services in two ways that matter here: the path
 * is encoded once, never twice, and the body's hash travels as
 * `x-amz-content-sha256`. The secret key is held `Redacted`, so nothing made
 * from these objects can print it.
 */
import { hmac } from "@noble/hashes/hmac";
import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex } from "@noble/hashes/utils";
import { Redacted } from "effect";

export type S3Credentials = Readonly<{
  accessKeyId: string;
  secretAccessKey: Redacted.Redacted<string>;
  sessionToken?: Redacted.Redacted<string> | undefined;
}>;

export type S3Signing = Readonly<{
  method: "GET" | "PUT" | "DELETE" | "HEAD";
  /** The request address; its path is signed as given, decoded and encoded once. */
  url: URL;
  /** Headers to send and to sign, beyond host, date and the body hash. */
  headers?: Headers | undefined;
  /** Hex SHA-256 of the body; `EMPTY_PAYLOAD` for none. */
  payloadHash: string;
  region: string;
  credentials: S3Credentials;
  now?: Date | undefined;
}>;

export type SignedS3 = Readonly<{ url: string; headers: Headers }>;

export const EMPTY_PAYLOAD = bytesToHex(sha256(new Uint8Array(0)));

const text = (value: string) => new TextEncoder().encode(value);

/** RFC 3986 encoding: what `encodeURIComponent` leaves, SigV4 does not. */
const encode = (value: string) =>
  encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );

export function canonicalPath(pathname: string): string {
  return pathname
    .split("/")
    .map((segment) => encode(decodeURIComponent(segment)))
    .join("/");
}

function canonicalQuery(url: URL): string {
  return [...url.searchParams]
    .map(([key, value]) => [encode(key), encode(value)] as const)
    .sort(([a, aValue], [b, bValue]) =>
      a === b ? aValue.localeCompare(bValue) : a < b ? -1 : 1,
    )
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
}

function signingKey(
  secret: string,
  day: string,
  region: string,
): Uint8Array<ArrayBufferLike> {
  const step = (key: Uint8Array, data: string) => hmac(sha256, key, text(data));
  return step(
    step(step(step(text(`AWS4${secret}`), day), region), "s3"),
    "aws4_request",
  );
}

export function signS3(input: S3Signing): SignedS3 {
  const stamp = (input.now ?? new Date())
    .toISOString()
    .replace(/[:-]|\.\d{3}/g, "");
  const day = stamp.slice(0, 8);
  const { credentials } = input;

  const headers = new Headers(input.headers);
  headers.set("host", input.url.host);
  headers.set("x-amz-date", stamp);
  headers.set("x-amz-content-sha256", input.payloadHash);
  if (credentials.sessionToken !== undefined) {
    headers.set(
      "x-amz-security-token",
      Redacted.value(credentials.sessionToken),
    );
  }

  const named = [...headers]
    .map(([name, value]) => [name.toLowerCase(), value.trim()] as const)
    .sort(([a], [b]) => (a < b ? -1 : 1));
  const signedNames = named.map(([name]) => name).join(";");
  const path = canonicalPath(input.url.pathname);
  const canonical = [
    input.method,
    path,
    canonicalQuery(input.url),
    `${named.map(([name, value]) => `${name}:${value}`).join("\n")}\n`,
    signedNames,
    input.payloadHash,
  ].join("\n");

  const scope = `${day}/${input.region}/s3/aws4_request`;
  const toSign = [
    "AWS4-HMAC-SHA256",
    stamp,
    scope,
    bytesToHex(sha256(text(canonical))),
  ].join("\n");
  const key = signingKey(
    Redacted.value(credentials.secretAccessKey),
    day,
    input.region,
  );
  const signature = bytesToHex(hmac(sha256, key, text(toSign)));
  headers.set(
    "authorization",
    `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${signedNames}, Signature=${signature}`,
  );

  // Signed, but a browser forbids setting it and sends the same one itself.
  headers.delete("host");
  const query = canonicalQuery(input.url);
  return {
    url: `${input.url.origin}${path}${query === "" ? "" : `?${query}`}`,
    headers,
  };
}
