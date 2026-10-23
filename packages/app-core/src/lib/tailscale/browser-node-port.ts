import {
  b64ToBytes as base64ToBytes,
  bytesToB64 as bytesToBase64,
} from "@opensesame/vault-core/bytes.js";
import { z } from "zod";
import type { TailscaleHTTPRouteConfiguration } from "./browser-node-peer-http.js";

function nativeOrigin(text: string): boolean {
  try {
    const url = new URL(text);
    return url.protocol === "https:" && url.origin === text;
  } catch {
    return false;
  }
}
function nativePrefix(text: string): boolean {
  const [address = "", width = "", extra] = text.split("/");
  if (extra !== undefined || !/^(0|[1-9][0-9]{0,2})$/.test(width)) return false;
  const v4 = z.ipv4().safeParse(address).success;
  if (!v4 && !z.ipv6().safeParse(address).success) return false;
  const bits = v4 ? 32 : 128;
  if (Number(width) > bits) return false;
  const value = v4
    ? address
        .split(".")
        .reduce((part, octet) => (part << 8n) | BigInt(octet), 0n)
    : nativeIPv6(address);
  if (!v4 && value >> 32n === 65535n) return false;
  return (value & ((1n << BigInt(bits - Number(width))) - 1n)) === 0n;
}
function nativeIPv6(input: string): bigint {
  let address = input;
  const dotted = address.lastIndexOf(":");
  if (address.includes(".")) {
    const octets = address
      .slice(dotted + 1)
      .split(".")
      .map(Number);
    const high = ((octets[0] ?? 0) << 8) | (octets[1] ?? 0);
    const low = ((octets[2] ?? 0) << 8) | (octets[3] ?? 0);
    address = `${address.slice(0, dotted + 1)}${high.toString(16)}:${low.toString(16)}`;
  }
  const halves = address.split("::");
  const left = halves[0]?.split(":").filter(Boolean) ?? [];
  const right = halves[1]?.split(":").filter(Boolean) ?? [];
  const groups =
    halves.length === 1
      ? left
      : [...left, ...Array(8 - left.length - right.length).fill("0"), ...right];
  return groups.reduce(
    (value, group) => (value << 16n) | BigInt(`0x${group}`),
    0n,
  );
}
function completeDER(bytes: Uint8Array): boolean {
  if (bytes[0] !== 48 || bytes[1] === undefined) return false;
  const first = bytes[1];
  if (first < 128) return first === bytes.length - 2;
  const count = first & 127;
  if (count < 1 || count > 4 || bytes[2] === 0) return false;
  let size = 0;
  for (const byte of bytes.slice(2, 2 + count)) size = size * 256 + byte;
  return size >= 128 && size === bytes.length - 2 - count;
}
/** Syntax/size only. The captured Go constructor validates every actual CA and key usage. */
function nativePEM(text: string): boolean {
  const pattern =
    /-----BEGIN CERTIFICATE-----\r?\n([A-Za-z0-9+/=\r\n]+)-----END CERTIFICATE-----/g;
  let end = 0;
  let count = 0;
  try {
    for (const match of text.matchAll(pattern)) {
      if (text.slice(end, match.index).trim()) return false;
      const encoded = (match[1] ?? "").replace(/[\r\n]/g, "");
      const bytes = base64ToBytes(encoded);
      if (bytesToBase64(bytes) !== encoded || !completeDER(bytes)) return false;
      end = match.index + match[0].length;
      count++;
    }
    return count > 0 && count <= 8 && !text.slice(end).trim();
  } catch {
    return false;
  }
}
const NativeTargets = z
  .array(
    z
      .object({
        origin: z.string().max(2048).refine(nativeOrigin),
        prefixes: z
          .array(z.string().max(64).refine(nativePrefix))
          .min(1)
          .max(16),
      })
      .strict(),
  )
  .min(1)
  .max(16)
  .refine(
    (targets) =>
      new Set(targets.map((target) => target.origin)).size === targets.length,
  );
const NativeBase = z.object({
  version: z.literal(1),
  exitNodeID: z
    .string()
    .min(1)
    .max(256)
    .refine(
      (value) =>
        value.trim() === value &&
        !Array.from(value).some(
          (character) =>
            character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127,
        ) &&
        new TextEncoder().encode(value).length <= 256,
    ),
  targets: NativeTargets,
});
export const TailscaleNativeHTTPConfiguration = z.discriminatedUnion(
  "trustMode",
  [
    NativeBase.extend({ trustMode: z.literal("public") }).strict(),
    NativeBase.extend({
      trustMode: z.literal("operator"),
      operatorCAPEM: z.string().min(1).max(65536).refine(nativePEM),
    }).strict(),
  ],
);
export type TailscaleNativeHTTPConfiguration = z.infer<
  typeof TailscaleNativeHTTPConfiguration
>;
/** Shared server trust only: no provider route, client certificate or TLS bypass. */
export const TailscaleServerTrustConfiguration = z.discriminatedUnion(
  "trustMode",
  [
    TailscaleNativeHTTPConfiguration.options[0].pick({ trustMode: true }),
    TailscaleNativeHTTPConfiguration.options[1].pick({
      trustMode: true,
      operatorCAPEM: true,
    }),
  ],
);
export type TailscaleServerTrustConfiguration = z.infer<
  typeof TailscaleServerTrustConfiguration
>;
export type TailscaleNativeHTTPPort = {
  fetch: typeof fetch;
  assertCurrent: () => void;
  readonly signal: AbortSignal;
};

/** The optional Networking module owns the browser WASM client and its lifetime. */
export type TailscaleNodeConfiguration = Readonly<{
  hostname: string;
  controlURL: string;
  authKey?: string;
  nativeHTTP?: TailscaleHTTPRouteConfiguration;
  peerTLS?: TailscaleServerTrustConfiguration;
}>;
/** Shared public identity validation for the persisted editor and actual browser-node controller. */
export function normalizeTailscaleNodeIdentity(
  input: Pick<TailscaleNodeConfiguration, "hostname" | "controlURL">,
) {
  if (
    input.hostname.length > 63 ||
    !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(input.hostname)
  )
    throw new Error(
      "Use a lowercase browser hostname with letters, digits and interior hyphens, up to 63 characters.",
    );
  let url: URL;
  try {
    url = new URL(input.controlURL);
  } catch {
    throw new Error(
      "Use an HTTPS control server or an HTTP loopback test server.",
    );
  }
  if (
    (url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      )) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new Error(
      "Use an HTTPS control server or an HTTP loopback test server.",
    );
  return { hostname: input.hostname, controlURL: url.origin };
}
export type TailscaleNodeSnapshot = Readonly<{
  status: "stopped" | "starting" | "login" | "approval" | "connected" | "error";
  hostname: string;
  controlURL: string;
  authURL: string;
  addresses: readonly string[];
  peerCount: number;
  failure: string;
}>;
export type TailscaleBrowserNode = {
  /** Captures this saved node and authority; failure never falls back to ambient fetch. */
  captureNativeHTTP?(owner: AbortSignal): TailscaleNativeHTTPPort;
  authorization?(): { connectionId: string; connected: boolean } | null;
  snapshot(): TailscaleNodeSnapshot;
  subscribe(listener: () => void): () => void;
  start(config: TailscaleNodeConfiguration): Promise<void>;
  stop(): void;
  forget(): Promise<void>;
  login(): void;
  get(url: string): Promise<{ status: number; text: string }>;
};
let current: TailscaleBrowserNode | null = null;
const watchers = new Set<() => void>();
export function subscribeTailscaleBrowserNode(
  listener: () => void,
): () => void {
  watchers.add(listener);
  return () => watchers.delete(listener);
}
export function bindTailscaleBrowserNode(
  node: TailscaleBrowserNode,
): () => void {
  current = node;
  for (const listener of watchers) listener();
  return () => {
    node.stop();
    if (current === node) current = null;
    for (const listener of watchers) listener();
  };
}
export function tailscaleBrowserNode(): TailscaleBrowserNode | null {
  return current;
}

/** Optional drivers without a current guarded proof never provide live access. */
export function tailscaleNodeAuthorization() {
  const node = current;
  try {
    const result = node?.authorization?.() ?? null;
    return current === node ? result : null;
  } catch {
    return null;
  }
}
