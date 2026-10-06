import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex } from "@noble/hashes/utils";
import { z } from "zod";
import { type Address, isPublicAddress } from "./request-address.js";
export { isPublicAddress, type Address } from "./request-address.js";
export interface RequestOptions {
  url: string;
  reference: string;
  header?: string;
  prefix?: string;
}
export interface Binding {
  capability: "request";
  method: "GET";
  reference: string;
  destination: string;
  destinationFingerprint: string;
  header: "Authorization" | "X-API-Key";
  prefix: string;
}
export interface PreparedRequest {
  url: URL;
  header: Binding["header"];
  prefix: string;
  binding: Binding;
}
export interface RawResponse {
  status: number;
  body: string;
  bytes: number;
}
export interface RequestLimits {
  maxBytes: number;
  timeoutMs: number;
}
export interface RequestPorts {
  addresses(hostname: string): Promise<readonly Address[]>;
  resolve(reference: string): Promise<string>;
  /** Must pin TLS to address, verify the URL hostname, never redirect, and enforce limits. */
  send(
    prepared: PreparedRequest,
    secret: string,
    address: Address,
    limits: RequestLimits,
  ): Promise<RawResponse>;
}
export const requestLimits: Readonly<RequestLimits> = Object.freeze({
  maxBytes: 64 * 1024,
  timeoutMs: 15_000,
});
export function referenceLocation(reference: string) {
  if (!reference.startsWith("op://") || /[\r\n\0?#]/.test(reference))
    throw new Error("Secret reference is malformed");
  const parts = reference.slice(5).split("/");
  if (parts.length < 3 || parts.some((part) => !part.length))
    throw new Error("Secret reference is malformed");
  try {
    const decoded = parts.map(decodeURIComponent);
    if (decoded.some((part) => /[\r\n\0]/.test(part)))
      throw new Error("invalid");
    return { vault: decoded[0] ?? "", item: decoded[1] ?? "" };
  } catch {
    throw new Error("Secret reference is malformed");
  }
}
function requestHeader(header: string): Binding["header"] {
  const normalized = header.toLowerCase();
  if (normalized === "authorization") return "Authorization";
  if (normalized === "x-api-key") return "X-API-Key";
  throw new Error("Request secret header must be Authorization or X-API-Key");
}
export function prepareRequest(options: RequestOptions): PreparedRequest {
  let url: URL;
  try {
    url = new URL(options.url);
  } catch {
    throw new Error("Request URL must be a valid HTTPS URL");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    (url.port && url.port !== "443")
  )
    throw new Error(
      "Request URL must use HTTPS on port 443 without userinfo or a fragment",
    );
  if (options.url.length > 2048 || /[\r\n\0]/.test(options.url))
    throw new Error("Request URL is invalid");
  referenceLocation(options.reference);
  const header = requestHeader(options.header ?? "Authorization");
  const prefix = options.prefix ?? "Bearer ";
  if (/[\r\n\0]/.test(prefix) || prefix.length > 64)
    throw new Error("Request header prefix is invalid");
  const binding: Binding = {
    capability: "request",
    method: "GET",
    reference: options.reference,
    destination: url.origin,
    destinationFingerprint: bytesToHex(
      sha256(new TextEncoder().encode(url.href)),
    ),
    header,
    prefix,
  };
  return { url, header, prefix, binding };
}
export function describeRequest(options: RequestOptions): Binding {
  return prepareRequest(options).binding;
}
function echoes(body: string, secret: string): number {
  return [...new Set([secret, JSON.stringify(secret).slice(1, -1)])]
    .filter(Boolean)
    .reduce((count, variant) => count + body.split(variant).length - 1, 0);
}
const responseSchema = z.object({
  status: z.number().int().min(100).max(599),
  body: z.string(),
  bytes: z.number().int().min(0).max(requestLimits.maxBytes),
});
export async function requestWith(
  options: RequestOptions,
  ports: RequestPorts,
) {
  const prepared = prepareRequest(options);
  const hostname = prepared.url.hostname.replace(/^\[|\]$/g, "");
  let addresses: readonly Address[];
  try {
    addresses = z
      .array(
        z.object({
          address: z.string(),
          family: z.union([z.literal(4), z.literal(6)]),
        }),
      )
      .parse(await ports.addresses(hostname));
  } catch {
    throw new Error(
      "Could not resolve request destination (details suppressed)",
    );
  }
  const address = addresses[0];
  if (!address || addresses.some((value) => !isPublicAddress(value)))
    throw new Error(
      "Request destination did not resolve exclusively to public addresses",
    );
  let secret: string;
  try {
    secret = (await ports.resolve(options.reference)).replace(/\r?\n$/, "");
  } catch {
    throw new Error(
      "Could not resolve request credential (details suppressed)",
    );
  }
  if (!secret.length || /[\r\n\0]/.test(secret))
    throw new Error("Request credential cannot be used in an HTTP header");
  try {
    const response = responseSchema.parse(
      await ports.send(prepared, secret, address, requestLimits),
    );
    if (
      new TextEncoder().encode(response.body).byteLength >
      requestLimits.maxBytes
    )
      throw new Error("oversized");
    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      destination: prepared.binding.destination,
      destinationFingerprint: prepared.binding.destinationFingerprint,
      reference: options.reference,
      responseBytes: response.bytes,
      secretEchoes: echoes(response.body, secret),
    };
  } catch {
    throw new Error("HTTPS request failed (details suppressed)");
  }
}
