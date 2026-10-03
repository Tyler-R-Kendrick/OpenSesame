/**
 * The routes a live-session link may carry (ADR 0150 §6): the owner's ICE
 * servers, whether to relay only, and the carriers that pass the pairing
 * codes — each read strictly, so a link naming anything else is refused
 * whole. The door (core) only checks the segment's shape; this is the
 * capability's, run by the join screen before anything is contacted. The
 * owner's own profile, and what mints credentials from it, is
 * `transport.ts`.
 */

import {
  type BoundaryValue,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";
import { fromB64url, toB64url } from "./b64.js";
import type { LiveLink } from "./link.js";

export const CARRIER_KINDS = [
  "nostr",
  "mqtt",
  "nats",
  "ntfy",
  "broadcast",
] as const;
export type CarrierKind = (typeof CARRIER_KINDS)[number];

export type CarrierSpec = Readonly<{
  kind: CarrierKind;
  /** wss:// (nostr, mqtt, nats) or https:// (ntfy); empty for broadcast. */
  url: string;
  username?: string;
  password?: string;
  /** A bearer token (ntfy access token, NATS token). */
  token?: string;
}>;

export type IceServerSpec = Readonly<{
  urls: readonly string[];
  username?: string;
  credential?: string;
}>;

/** An ICE server as the owner keeps it: a REST secret mints credentials. */
export type IceServerSetting = IceServerSpec & Readonly<{ secret?: string }>;

/** What a link carries for the joiner. */
export type LiveRoutes = Readonly<{
  ice: readonly IceServerSpec[];
  relay: boolean;
  carriers: readonly CarrierSpec[];
}>;

/** An ICE server or carrier as it is read, before it is handed on. */
type IceServerDraft = {
  urls: string[];
  username?: string;
  credential?: string;
  secret?: string;
};
type CarrierDraft = {
  kind: CarrierKind;
  url: string;
  username?: string;
  password?: string;
  token?: string;
};

export const NO_ROUTES: LiveRoutes = { ice: [], relay: false, carriers: [] };

export const MAX_SERVERS = 6;
const MAX_URLS = 4;
export const MAX_CARRIERS = 6;
const TEXT_MAX = 512;

const ICE_URL =
  /^(stuns?|turns?):(?:\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]+)(?::(\d{1,5}))?(\?transport=(?:udp|tcp))?$/;
const HOST_LABEL = /^[A-Za-z0-9.-]+$|^\[[0-9A-Fa-f:.]+\]$/;

/**
 * A URL `RTCPeerConnection` accepts: the port is 1 to 65535, and only a TURN
 * URL takes `?transport=` (Chromium throws a SyntaxError for the rest, which
 * would fail the session at its first connection, not at the Form).
 */
export function isIceUrl(value: string): boolean {
  if (value.length > TEXT_MAX) return false;
  const match = ICE_URL.exec(value);
  if (!match) return false;
  const [, scheme = "", port, query] = match;
  if (port !== undefined && (Number(port) < 1 || Number(port) > 65535))
    return false;
  return query === undefined || scheme.startsWith("turn");
}

/** `turn:` or `turns:`, the only URLs a relay can go through. */
export function isTurnUrl(value: string): boolean {
  return value.startsWith("turn");
}

function loopback(host: string): boolean {
  return (
    host === "localhost" ||
    host === "[::1]" ||
    /^127\.\d+\.\d+\.\d+$/.test(host)
  );
}

/**
 * A carrier's address: secure transport unless it is this device (a page
 * served over https may not open plain sockets elsewhere), no credentials or
 * fragment in the URL itself.
 */
export function isCarrierUrl(kind: CarrierKind, value: string): boolean {
  if (kind === "broadcast") return value === "";
  if (value.length > TEXT_MAX) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.username || url.password || url.hash) return false;
  if (!HOST_LABEL.test(url.hostname)) return false;
  const local = loopback(url.hostname);
  if (kind === "ntfy")
    return url.protocol === "https:" || (local && url.protocol === "http:");
  return url.protocol === "wss:" || (local && url.protocol === "ws:");
}

export type Errors = string[];

function optionalText(
  value: BoundaryValue | undefined,
  name: string,
  errors: Errors,
): string | undefined {
  if (value === undefined) return undefined;
  if (!isString(value) || value.length === 0 || value.length > TEXT_MAX) {
    errors.push(`${name} must be a non-empty string.`);
    return undefined;
  }
  return value;
}

/** A nested object names only what it may: anything else is refused. */
function refuseUnknown(
  value: Readonly<Record<string, BoundaryValue>>,
  allowed: readonly string[],
  at: string,
  errors: Errors,
): void {
  for (const key of Object.keys(value))
    if (!allowed.includes(key))
      errors.push(`${at} has an unknown key "${key}".`);
}

export function readIceServer(
  value: BoundaryValue,
  at: string,
  errors: Errors,
  secrets: boolean,
): IceServerSetting | null {
  if (!isJsonObject(value)) {
    errors.push(`${at} must be an object.`);
    return null;
  }
  refuseUnknown(
    value,
    secrets
      ? ["urls", "username", "credential", "secret"]
      : ["urls", "username", "credential"],
    at,
    errors,
  );
  const urls = readIceUrls(value.urls, at, errors);
  if (!urls) return null;
  const username = optionalText(value.username, `${at}.username`, errors);
  const credential = optionalText(value.credential, `${at}.credential`, errors);
  const secret = secrets
    ? optionalText(value.secret, `${at}.secret`, errors)
    : undefined;
  const server: IceServerDraft = { urls };
  if (username) server.username = username;
  if (credential) server.credential = credential;
  if (secret) server.secret = secret;
  checkCredentials(server, at, errors);
  return server;
}

function readIceUrls(
  value: BoundaryValue | undefined,
  at: string,
  errors: Errors,
): string[] | null {
  const raw = isString(value) ? [value] : value;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_URLS) {
    errors.push(`${at}.urls must list 1 to ${MAX_URLS} URLs.`);
    return null;
  }
  const urls: string[] = [];
  for (const url of raw) {
    if (isString(url) && isIceUrl(url)) urls.push(url);
    else errors.push(`${at}.urls has one that is not a stun: or turn: URL.`);
  }
  return urls;
}

/** A TURN server needs credentials: static, or minted from a secret. */
function checkCredentials(
  server: IceServerDraft,
  at: string,
  errors: Errors,
): void {
  const { username, credential, secret } = server;
  if (secret && credential)
    errors.push(`${at} takes a credential or a secret, not both.`);
  const turn = server.urls.some(isTurnUrl);
  if (turn && !secret && (!username || !credential))
    errors.push(`${at} is TURN: give username and credential, or a secret.`);
}

export function readCarrier(
  value: BoundaryValue,
  at: string,
  errors: Errors,
): CarrierSpec | null {
  if (!isJsonObject(value)) {
    errors.push(`${at} must be an object.`);
    return null;
  }
  refuseUnknown(
    value,
    ["kind", "url", "username", "password", "token"],
    at,
    errors,
  );
  const kind = CARRIER_KINDS.find((entry) => entry === value.kind);
  if (!kind) {
    errors.push(`${at}.kind must be one of ${CARRIER_KINDS.join(", ")}.`);
    return null;
  }
  const url = value.url ?? "";
  if (!isString(url) || !isCarrierUrl(kind, url)) {
    errors.push(
      kind === "broadcast"
        ? `${at} (broadcast) takes no url.`
        : `${at}.url must be ${kind === "ntfy" ? "https" : "wss"}:// (or plain on this device).`,
    );
    return null;
  }
  const username = optionalText(value.username, `${at}.username`, errors);
  const password = optionalText(value.password, `${at}.password`, errors);
  const token = optionalText(value.token, `${at}.token`, errors);
  const carrier: CarrierDraft = { kind, url };
  if (username) carrier.username = username;
  if (password) carrier.password = password;
  if (token) carrier.token = token;
  return carrier;
}

export function list(
  value: BoundaryValue | undefined,
  name: string,
  max: number,
  errors: Errors,
): readonly BoundaryValue[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    errors.push(`${name} must be a list.`);
    return [];
  }
  if (value.length > max) errors.push(`${name} holds at most ${max}.`);
  return value.slice(0, max);
}

/** The routes a link carries, as read from the link: strict, or null. */
export function readRoutes(value: BoundaryValue): LiveRoutes | null {
  if (!isJsonObject(value)) return null;
  const errors: Errors = [];
  for (const key of Object.keys(value))
    if (key !== "ice" && key !== "relay" && key !== "carriers") return null;
  const ice = list(value.ice, "ice", MAX_SERVERS, errors)
    .map((entry, at) => readIceServer(entry, `ice[${at}]`, errors, false))
    .filter((entry) => entry !== null);
  const carriers = list(value.carriers, "carriers", MAX_CARRIERS, errors)
    .map((entry, at) => readCarrier(entry, `carriers[${at}]`, errors))
    .filter((entry) => entry !== null);
  const relay = value.relay ?? false;
  if (errors.length > 0 || (relay !== true && relay !== false)) return null;
  // Relay only with no TURN server is a peer with nowhere to relay through,
  // as the owner's profile already refuses; a link must not get past it.
  if (relay && !ice.some((server) => server.urls.some(isTurnUrl))) return null;
  return { ice, relay, carriers };
}

export function hasRoutes(routes: LiveRoutes): boolean {
  return routes.ice.length > 0 || routes.carriers.length > 0 || routes.relay;
}

/** A link's routes, strictly: none when it names none, null when unreadable. */
export function linkRoutes(link: LiveLink): LiveRoutes | null {
  if (link.routes === null) return NO_ROUTES;
  const bytes = fromB64url(link.routes);
  if (!bytes) return null;
  try {
    const value: BoundaryValue = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
    return readRoutes(value);
  } catch {
    return null;
  }
}

/** `link.ts` reads a segment of at most this many characters. */
export const MAX_ROUTES_SEGMENT = 6000;

/** Routes a link cannot carry: the joiner's parser would refuse the link. */
export class LiveRoutesRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LiveRoutesRefused";
  }
}

/**
 * The routes segment for a link, or null when there is nothing to carry.
 * Throws `LiveRoutesRefused` when it is longer than the joiner's parser
 * reads: no session starts on a link nobody can open.
 */
export function routesSegment(routes: LiveRoutes): string | null {
  if (!hasRoutes(routes)) return null;
  const value: Record<string, BoundaryValue> = {};
  if (routes.ice.length > 0)
    value.ice = routes.ice.map((server) => ({
      ...server,
      urls: [...server.urls],
    }));
  if (routes.relay) value.relay = true;
  if (routes.carriers.length > 0)
    value.carriers = routes.carriers.map((carrier) => ({ ...carrier }));
  const segment = toB64url(new TextEncoder().encode(JSON.stringify(value)));
  if (segment.length > MAX_ROUTES_SEGMENT)
    throw new LiveRoutesRefused(
      `These routes are too long for a link (${segment.length} of ${MAX_ROUTES_SEGMENT}): drop a server or a credential.`,
    );
  return segment;
}
