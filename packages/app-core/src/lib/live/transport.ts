/**
 * How a live session's two browsers find each other when they are not on
 * one network (ADR 0148 §6). Every part is optional. With none of it,
 * pairing is by hand-passed codes and a direct route, and nothing else is
 * contacted.
 *
 * - **addresses** — IP literals where this device is reachable: its
 *   Tailscale address, a WireGuard, Pangolin, Cloudflare WARP, ZeroTier or
 *   NetBird address, a LAN address. They are added to the owner's answer
 *   beside the candidates the browser hides behind mDNS names, so a joiner
 *   on the same tailnet reaches the owner's browser through the tunnel. One
 *   side's address is enough; ICE learns the other side's from the checks.
 * - **ice** — STUN and TURN servers (TURN over UDP, TCP or TLS on 443, which
 *   passes a Pangolin raw resource, a Tailscale Funnel or any TCP proxy). A
 *   TURN server that shares a REST `secret` (coturn's `use-auth-secret`)
 *   gets credentials minted per session, so the link carries nothing that
 *   outlives it.
 * - **relay** — relay only (`iceTransportPolicy: "relay"`): neither browser
 *   learns the other's address.
 * - **carriers** — relays that pass the pairing codes instead of the two
 *   people: Nostr, MQTT or NATS over WebSocket, ntfy, or this browser's own
 *   tabs. They see only sealed codes on a topic derived from the link
 *   secret (`rendezvous.ts`).
 *
 * The link carries what the joiner needs of it (`LiveRoutes`): the ICE
 * servers, relay only, and the carriers. Addresses stay with the owner.
 */

import {
  type BoundaryValue,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";
import { toB64url } from "./b64.js";
import {
  type CarrierSpec,
  type Errors,
  type IceServerSetting,
  type IceServerSpec,
  type LiveRoutes,
  MAX_CARRIERS,
  MAX_SERVERS,
  list,
  readCarrier,
  readIceServer,
} from "./routes.js";

export {
  CARRIER_KINDS,
  type CarrierKind,
  type CarrierSpec,
  type IceServerSetting,
  type IceServerSpec,
  type LiveRoutes,
  NO_ROUTES,
  hasRoutes,
  isCarrierUrl,
  isIceUrl,
  readRoutes,
} from "./routes.js";

const MAX_ADDRESSES = 8;
const IPV4 =
  /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const IPV6 = /^[0-9A-Fa-f:.]{2,45}$/;
/** An IP literal a peer can be sent to: not unspecified, not multicast. */
export function isAddress(value: string): boolean {
  if (IPV4.test(value)) {
    const first = Number(value.split(".")[0]);
    return value !== "0.0.0.0" && (first < 224 || first > 239) && first < 240;
  }
  if (!IPV6.test(value) || !value.includes(":")) return false;
  if (value === "::" || /^ff/i.test(value)) return false;
  try {
    return new URL(`http://[${value}]/`).hostname.length > 2;
  } catch {
    return false;
  }
}

export type LiveTransport = Readonly<{
  addresses: readonly string[];
  ice: readonly IceServerSetting[];
  relay: boolean;
  carriers: readonly CarrierSpec[];
}>;

export const DIRECT_TRANSPORT: LiveTransport = {
  addresses: [],
  ice: [],
  relay: false,
  carriers: [],
};

export type TransportRead =
  | Readonly<{ ok: true; transport: LiveTransport }>
  | Readonly<{ ok: false; errors: readonly string[] }>;

const KEYS = new Set(["addresses", "ice", "relay", "carriers"]);

/** The owner's transport profile (`settings/live/transport.json`). */
export function readTransport(value: BoundaryValue): TransportRead {
  const errors: Errors = [];
  if (!isJsonObject(value))
    return { ok: false, errors: ["The profile must be a JSON object."] };
  for (const key of Object.keys(value))
    if (!KEYS.has(key)) errors.push(`Unknown key "${key}".`);
  const addresses: string[] = [];
  for (const entry of list(value.addresses, "addresses", MAX_ADDRESSES, errors))
    if (isString(entry) && isAddress(entry)) addresses.push(entry);
    else errors.push("addresses has one that is not an IP address.");
  const ice = list(value.ice, "ice", MAX_SERVERS, errors)
    .map((entry, at) => readIceServer(entry, `ice[${at}]`, errors, true))
    .filter((entry) => entry !== null);
  const carriers = list(value.carriers, "carriers", MAX_CARRIERS, errors)
    .map((entry, at) => readCarrier(entry, `carriers[${at}]`, errors))
    .filter((entry) => entry !== null);
  const relay = value.relay ?? false;
  if (relay !== true && relay !== false)
    errors.push("relay must be true or false.");
  const hasTurn = ice.some((server) =>
    server.urls.some((url) => url.startsWith("turn")),
  );
  if (relay === true && !hasTurn)
    errors.push("relay needs at least one TURN server.");
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    transport: { addresses, ice, relay: relay === true, carriers },
  };
}

/** The profile as its file holds it: empty lists and `false` left out. */
export function transportFileText(transport: LiveTransport): string {
  const file: Record<string, BoundaryValue> = {};
  if (transport.addresses.length > 0) file.addresses = [...transport.addresses];
  if (transport.ice.length > 0)
    file.ice = transport.ice.map((server) => ({
      ...server,
      urls: [...server.urls],
    }));
  if (transport.relay) file.relay = true;
  if (transport.carriers.length > 0)
    file.carriers = transport.carriers.map((carrier) => ({ ...carrier }));
  return `${JSON.stringify(file, null, 2)}\n`;
}

const encoder = new TextEncoder();

/**
 * TURN REST credentials (draft-uberti-behave-turn-rest, coturn's
 * `use-auth-secret`): `username = <expiry>:osl`, `credential =
 * base64(HMAC-SHA1(secret, username))`, good until the session ends.
 */
/** A TURN username and the credential that goes with it. */
export type TurnCredential = Readonly<{ username: string; credential: string }>;

export async function turnRestCredential(
  secret: string,
  expiresAt: number,
): Promise<TurnCredential> {
  const username = `${Math.ceil(expiresAt / 1000)}:osl`;
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, encoder.encode(username)),
  );
  const credential = toB64url(mac).replace(/-/g, "+").replace(/_/g, "/");
  return {
    username,
    credential: credential + "=".repeat((4 - (credential.length % 4)) % 4),
  };
}

/** The ICE servers as both sides use them: secrets become credentials. */
export async function iceServersFor(
  settings: readonly IceServerSetting[],
  expiresAt: number,
): Promise<IceServerSpec[]> {
  return Promise.all(
    settings.map(async ({ secret, ...server }) =>
      secret
        ? {
            urls: server.urls,
            ...(await turnRestCredential(secret, expiresAt)),
          }
        : server,
    ),
  );
}

/** What a session's link carries of the owner's profile. */
export async function routesFor(
  transport: LiveTransport,
  expiresAt: number,
): Promise<LiveRoutes> {
  return {
    ice: await iceServersFor(transport.ice, expiresAt),
    relay: transport.relay,
    carriers: transport.carriers,
  };
}

/** The host part of a stun:/turn: URL. */
function iceHost(url: string): string {
  const rest = url.replace(/^[a-z]+:/, "");
  return rest.startsWith("[")
    ? rest.slice(0, rest.indexOf("]") + 1)
    : rest.replace(/[:?].*$/, "");
}

/** The hosts a joiner's browser would contact for these routes. */
export function routeHosts(routes: LiveRoutes): string[] {
  const hosts = new Set<string>();
  for (const server of routes.ice)
    for (const url of server.urls) hosts.add(iceHost(url));
  for (const carrier of routes.carriers)
    hosts.add(
      carrier.kind === "broadcast" ? "this browser" : new URL(carrier.url).host,
    );
  return [...hosts];
}
