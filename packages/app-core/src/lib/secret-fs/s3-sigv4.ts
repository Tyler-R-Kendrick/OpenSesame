/**
 * AWS Signature Version 4 (ADR 0182). It is pure — a method, a URL, headers
 * and a body hash in, the request to send out — so it runs unchanged in a
 * browser, a worker and Node, and is checked against the worked examples
 * Amazon publishes: the S3 ones, and the SigV4 test suite for any other
 * service.
 *
 * S3 differs from the other services in two ways that matter here: the path
 * is encoded once, never twice, and the body's hash travels as
 * `x-amz-content-sha256`. `signS3` is that one; `signAws` is the rest. The
 * secret key is held `Redacted`, so nothing made from these objects can print
 * it.
 */
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { Redacted } from "effect";

export type S3Credentials = Readonly<{
  accessKeyId: string;
  secretAccessKey: Redacted.Redacted<string>;
  sessionToken?: Redacted.Redacted<string> | undefined;
}>;

export type S3Signing = Readonly<{
  method: "GET" | "PUT" | "DELETE" | "HEAD" | "POST";
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
  service: string,
): Uint8Array<ArrayBufferLike> {
  const step = (key: Uint8Array, data: string) => hmac(sha256, key, text(data));
  return step(
    step(step(step(text(`AWS4${secret}`), day), region), service),
    "aws4_request",
  );
}

/** What differs between S3 and every other service. */
export type AwsSigning = S3Signing &
  Readonly<{
    /** The service's signing name: `secretsmanager`, `ssm`, `sts`, `s3`. */
    service: string;
    /** S3 sends the body's hash as a header; no other service wants it. */
    payloadHashHeader: boolean;
    /** S3 encodes the path once in the canonical request; every other service twice. */
    pathEncoding: "once" | "twice";
  }>;

export function signS3(input: S3Signing): SignedS3 {
  return signAws({
    ...input,
    service: "s3",
    payloadHashHeader: true,
    pathEncoding: "once",
  });
}

export function signAws(input: AwsSigning): SignedS3 {
  const stamp = (input.now ?? new Date())
    .toISOString()
    .replace(/[:-]|\.\d{3}/g, "");
  const day = stamp.slice(0, 8);
  const { credentials } = input;

  const headers = new Headers(input.headers);
  headers.set("host", input.url.host);
  headers.set("x-amz-date", stamp);
  if (input.payloadHashHeader)
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
  const signedPath =
    input.pathEncoding === "twice"
      ? path.split("/").map(encode).join("/")
      : path;
  const canonical = [
    input.method,
    signedPath,
    canonicalQuery(input.url),
    `${named.map(([name, value]) => `${name}:${value}`).join("\n")}\n`,
    signedNames,
    input.payloadHash,
  ].join("\n");

  const scope = `${day}/${input.region}/${input.service}/aws4_request`;
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
    input.service,
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
