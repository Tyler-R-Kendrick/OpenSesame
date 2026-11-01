/**
 * The connector bridge as the connections see it (ADR 0199): whether a bridge
 * is present, which hosts a person has allowed, whether a provider's browser
 * road is the bridge, and the one `fetch` that sends a request through it. The
 * Pages shell binds a client once a connections capability is active; with none
 * bound the bridge is absent and every provider behaves as it did.
 */
import {
  authoritiesOf,
  connectorBridgeTable,
  isBridgeHost,
  isNamedHost,
  oauthAuthoritiesOf,
  providerOfHost,
} from "@opensesame/connector-bridge";
import type {
  BridgeFetchRequest,
  HeaderPair,
} from "@opensesame/connector-bridge";
import {
  BridgeCallError,
  type BridgeClient,
} from "./connector-bridge-client.js";
import { canonicalProviderId } from "./connector-catalog.js";
import { NativeApiError } from "./native-api-http.js";

export type BridgeSnapshot = {
  present: boolean;
  version: string | null;
  /** The hosts a person has allowed in the bridge. */
  granted: readonly string[];
};

const ABSENT: BridgeSnapshot = { present: false, version: null, granted: [] };
const listeners = new Set<() => void>();
let client: BridgeClient | null = null;
let snapshot: BridgeSnapshot = ABSENT;
let asking = 0;

function publish(next: BridgeSnapshot) {
  const same =
    next.present === snapshot.present &&
    next.version === snapshot.version &&
    next.granted.length === snapshot.granted.length &&
    next.granted.every((host, index) => host === snapshot.granted[index]);
  if (same) return;
  snapshot = next;
  for (const listener of [...listeners]) listener();
}

/** The Pages shell hands over its client; nothing is asked of the extension until it does. */
export function bindNativeBridge(next: BridgeClient): () => void {
  client = next;
  return () => {
    if (client !== next) return;
    client = null;
    publish(ABSENT);
  };
}

export const nativeBridgeStore = {
  getSnapshot: (): BridgeSnapshot => snapshot,
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};

/**
 * Ask the extension who it is and what it holds; a bridge that never answers is
 * absent. Only the latest question may change what the page believes: a person
 * who installs the bridge while the first, unanswered, question is still timing
 * out must not be told it is absent by that stale silence.
 */
export async function refreshNativeBridge(): Promise<BridgeSnapshot> {
  const asked = client;
  if (!asked) return snapshot;
  const turn = ++asking;
  const hello = await asked.hello();
  if (client !== asked || turn !== asking) return snapshot;
  publish(
    hello
      ? {
          present: true,
          version: hello.version,
          granted: [...hello.granted].sort(),
        }
      : ABSENT,
  );
  return snapshot;
}

/** The literal hosts a provider is carried at: its API-key check and its registered OAuth application (ADR 0218). */
export function bridgeHostsFor(providerId: string): readonly string[] {
  // The app keeps the alias it was asked for; the table is the catalog's.
  const id = canonicalProviderId(providerId) ?? providerId;
  return [
    ...new Set([
      ...authoritiesOf(connectorBridgeTable, id),
      ...oauthAuthoritiesOf(connectorBridgeTable, id),
    ]),
  ];
}

/** Whether a provider is one a browser cannot reach by itself, so the bridge is its road. */
export function bridgeEligible(providerId: string): boolean {
  return bridgeHostsFor(providerId).length > 0;
}

/** Whether the bridge is present and holds at least one host this provider is called at. */
export function bridgeAdmits(providerId: string): boolean {
  return (
    snapshot.present &&
    bridgeHostsFor(providerId).some((host) => snapshot.granted.includes(host))
  );
}

/** The provider a host belongs to in the bridge's table, if the bridge holds the host. */
export function bridgeCarries(url: URL): string | null {
  if (!snapshot.present || !snapshot.granted.includes(url.hostname))
    return null;
  return providerOfHost(connectorBridgeTable, url.hostname);
}

export type BridgeGuidance = {
  state: "absent" | "needs-host";
  /** The hosts a person should allow in the bridge. */
  hosts: readonly string[];
};

export type BridgeOAuthAdvice = {
  /** What to tell a person who registers their own OAuth application with this provider. */
  text: string;
  /** The hosts the table names for it; a tenant family is shown as `*.suffix`. */
  hosts: readonly string[];
};

const BRIDGE_README =
  "https://github.com/OpenSesame-Labs/OpenSesame/tree/main/apps/browser-extension-bridge";
export const BRIDGE_README_URL = BRIDGE_README;

/**
 * What a person registering their own OAuth application should know about the
 * provider's servers (ADR 0218). `null` when a web page can read every endpoint
 * the connection calls, so the bridge has nothing to carry.
 */
export function bridgeOAuthAdvice(
  providerId: string,
): BridgeOAuthAdvice | null {
  const id = canonicalProviderId(providerId) ?? providerId;
  const literal = oauthAuthoritiesOf(connectorBridgeTable, id);
  const tenants =
    connectorBridgeTable.find((row) => row.providerId === id)?.tenants ?? [];
  if (literal.length === 0 && tenants.length === 0) return null;
  const named = [...literal, ...tenants];
  const where = tenants.length
    ? literal.length
      ? "at its own hosts and at your tenant"
      : "at your own tenant"
    : "at its own hosts";
  return {
    hosts: named,
    text: `This provider's OAuth servers refuse web pages ${where}, so a page cannot read the token exchange or the account check there. With the optional connector bridge installed, switched on for this site and allowed for ${named.join(", ")}${tenants.length ? " (type your tenant host first and it appears in the bridge)" : ""}, those requests go through it. Your client secret stays sealed in your vault and is sent only to those hosts, and the bridge keeps nothing.`,
  };
}

/** What a person has to do before the bridge can carry a provider; `null` when nothing is left to do. */
export function bridgeGuidance(providerId: string): BridgeGuidance | null {
  const hosts = bridgeHostsFor(providerId);
  if (hosts.length === 0 || bridgeAdmits(providerId)) return null;
  return { state: snapshot.present ? "needs-host" : "absent", hosts };
}

/** Put the provider's hosts in the bridge's popup, ready to be allowed; the bridge allows nothing by being asked. */
export async function askBridgeFor(
  providerId: string,
  typed: readonly string[] = [],
): Promise<void> {
  const asked = client;
  // A host a person typed (their own tenant) is asked for only if the table gives it to this provider.
  const id = canonicalProviderId(providerId) ?? providerId;
  const tenants = typed.filter(
    (host) =>
      isNamedHost(connectorBridgeTable, host) &&
      providerOfHost(connectorBridgeTable, host) === id,
  );
  const hosts = [
    ...new Set([...bridgeHostsFor(providerId), ...tenants]),
  ].filter(isBridgeHost);
  if (!asked || !snapshot.present || hosts.length === 0) return;
  try {
    await asked.need(hosts);
  } catch (error) {
    if (!(error instanceof BridgeCallError)) throw error;
  }
}

function headerPairs(headers: Headers): HeaderPair[] {
  const pairs: HeaderPair[] = [];
  headers.forEach((value, name) => pairs.push([name, value]));
  return pairs;
}

/** A text body, or a refusal: the bridge carries text, and a request it cannot carry is not sent. */
function bodyText(body: BodyInit | null | undefined): string | null {
  if (body === null || body === undefined) return null;
  if (body instanceof URLSearchParams) return body.toString();
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(body);
    } catch {
      throw new NativeApiError("bridge");
    }
  }
  // What is left is a string, or an object the bridge cannot carry as text.
  if (Object(body) !== body) return String(body);
  throw new NativeApiError("bridge");
}

const NO_BODY = new Set([204, 205, 304]);

function throwIfAborted(signal: AbortSignal | null | undefined): void {
  if (signal?.aborted)
    throw signal.reason ?? new DOMException("aborted", "AbortError");
}

function bridgeRequest(
  providerId: string,
  url: URL,
  init: RequestInit | undefined,
): BridgeFetchRequest {
  return {
    providerId,
    url: url.href,
    method: methodOf(init?.method),
    headers: headerPairs(new Headers(init?.headers)),
    body: bodyText(init?.body),
  };
}

/** One request through the bridge, answered as the `Response` a direct call would have given. */
export async function bridgedFetch(
  input: URL | string,
  init?: RequestInit,
): Promise<Response> {
  const url = input instanceof URL ? input : new URL(input);
  const providerId = bridgeCarries(url);
  const bridge = client;
  if (!bridge || !providerId) throw new NativeApiError("bridge");
  throwIfAborted(init?.signal);
  const request = bridgeRequest(providerId, url, init);
  try {
    const sent = await bridge.fetch(request);
    throwIfAborted(init?.signal);
    return new Response(NO_BODY.has(sent.status) ? null : sent.body, {
      status: sent.status,
      headers: new Headers(sent.headers),
    });
  } catch (error) {
    if (error instanceof BridgeCallError) throw failureOf(error);
    throw error;
  }
}

function methodOf(method: string | undefined): BridgeFetchRequest["method"] {
  const upper = (method ?? "GET").toUpperCase();
  const known = (
    ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"] as const
  ).find((entry) => entry === upper);
  if (!known) throw new NativeApiError("bridge");
  return known;
}

/** A refusal or failure from the bridge, as the error a connection already knows how to show. */
function failureOf(error: BridgeCallError): NativeApiError {
  if (
    error.code === "network" ||
    error.code === "timeout" ||
    error.code === "unanswered"
  )
    return new NativeApiError("network");
  return new NativeApiError("bridge");
}

/** Forget everything: for tests. */
export function resetNativeBridgeForTest(): void {
  client = null;
  snapshot = ABSENT;
  asking = 0;
  listeners.clear();
}
