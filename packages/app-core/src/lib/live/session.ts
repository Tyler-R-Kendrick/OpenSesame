/**
 * The one live session this tab hosts, and the one it has joined
 * (ADR 0150 §2).
 *
 * They live here rather than in the capability module's activation: a
 * module is disposed and activated again on every lock, unlock and consent
 * commit, and a joiner mid-session must not be dropped because the page
 * re-planned. A hosted session is different on purpose — locking the vault
 * ends it, because the vault it reads from is gone.
 */

import type { VaultItem } from "@opensesame/vault-core";
import { vaultStore } from "../vault/store.js";
import { LiveGuest } from "./guest.js";
import { type Admission, LiveHost, MAX_SESSION_MS } from "./host.js";
import type { LiveLink } from "./link.js";
import type { SharePolicy } from "./messages.js";
import { DIRECT_ONLY, type IceSettings, type PeerFactory } from "./peer.js";
import { type CarrierFactory, Rendezvous } from "./rendezvous.js";
import { NO_ROUTES, linkRoutes } from "./routes.js";
import {
  type CarrierSpec,
  DIRECT_TRANSPORT,
  type IceServerSpec,
  type LiveTransport,
  routesFor,
} from "./transport.js";
import { type ShareScope, vaultCatalog, vaultField } from "./vault-share.js";

export const liveSeams = {
  items: (): readonly VaultItem[] => vaultStore.getSnapshot().items,
  onLock: (handler: () => void): (() => void) => vaultStore.onLock(handler),
};

let host: LiveHost | null = null;
let hostCarriers: Rendezvous | null = null;
let stopLockWatch: (() => void) | null = null;
let guest: LiveGuest | null = null;
let guestCarriers: Rendezvous | null = null;

/** How long a first post waits for a carrier to connect. */
const CARRIER_WAIT_MS = 8000;

function rtcServers(servers: readonly IceServerSpec[]): RTCIceServer[] {
  return servers.map((server) => {
    const out: RTCIceServer = { urls: [...server.urls] };
    if (server.username) out.username = server.username;
    if (server.credential) out.credential = server.credential;
    return out;
  });
}

/** Open the carriers, if any are named and the shell supplied them. */
function openCarriers(
  specs: readonly CarrierSpec[],
  secret: string,
  factory: CarrierFactory | undefined,
  onCode: (code: string) => void,
): Rendezvous | null {
  if (!factory || specs.length === 0) return null;
  return Rendezvous.open(specs, secret, factory, onCode);
}

/** Post once a carrier is up (or has had its chance). */
function poster(rendezvous: Rendezvous): (code: string) => Promise<void> {
  return async (code) => {
    await rendezvous.whenReady(CARRIER_WAIT_MS);
    await rendezvous.post(code);
  };
}
const listeners = new Set<() => void>();

function changed(): void {
  for (const listener of listeners) listener();
}

/** Hear when the hosted or joined session is replaced or cleared. */
export function onLiveSessionChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export type HostInput = Readonly<{
  title: string;
  scope: ShareScope;
  policy: SharePolicy;
  admission: Admission;
  /** Minutes; the host clamps it to eight hours. */
  minutes: number;
  peers: PeerFactory;
  /** The owner's transport profile; direct only when absent. */
  transport?: LiveTransport;
  /** The shell's carrier clients, for a profile that names carriers. */
  carriers?: CarrierFactory;
}>;

/** Start hosting; any session this tab was hosting ends first. */
export async function startHosting(input: HostInput): Promise<LiveHost> {
  endHosting();
  // The host clamps the lifetime; the catalog states the clamped one.
  const expiresAt = Math.min(
    Date.now() + input.minutes * 60_000,
    Date.now() + MAX_SESSION_MS,
  );
  const items = liveSeams.items;
  const transport = input.transport ?? DIRECT_TRANSPORT;
  const routes = await routesFor(transport, expiresAt);
  const ice: IceSettings = {
    iceServers: rtcServers(routes.ice),
    relay: transport.relay,
    addresses: transport.addresses,
  };
  let post: ((code: string) => Promise<void>) | null = null;
  const next = await LiveHost.start({
    admission: input.admission,
    ice,
    routes,
    post: (code) => void post?.(code),
    expiresAt,
    catalog: () =>
      vaultCatalog({
        title: input.title,
        policy: input.policy,
        expiresAt,
        scope: input.scope,
        items,
      }),
    readField: vaultField({ scope: input.scope, items }),
    peers: input.peers,
  });
  endHosting();
  host = next;
  const carriers = openCarriers(
    routes.carriers,
    next.link.secret,
    input.carriers,
    (code) => void next.receive(code),
  );
  hostCarriers = carriers;
  if (carriers) {
    post = poster(carriers);
    next.subscribe((state) => {
      if (state.status === "ended") carriers.close();
    });
  }
  stopLockWatch = liveSeams.onLock(() => endHosting());
  changed();
  return next;
}

export function currentHost(): LiveHost | null {
  return host;
}

/** The carriers the hosted session listens on, if its profile names any. */
export function currentHostCarriers(): Rendezvous | null {
  return hostCarriers;
}

/** End the hosted session for everyone. */
export function endHosting(): void {
  stopLockWatch?.();
  stopLockWatch = null;
  hostCarriers?.close();
  hostCarriers = null;
  if (!host) return;
  host.end("owner");
  host = null;
  changed();
}

export type JoinInput = Readonly<{
  link: LiveLink;
  code: string | null;
  name: string;
  note: string;
  peers: PeerFactory;
  /**
   * Whether to use what the link names — its ICE servers and carriers. The
   * person agreed to the hosts it lists; without that, direct only.
   */
  useRoutes: boolean;
  carriers?: CarrierFactory;
}>;

/**
 * Start asking to join: the request code comes back for the person to send
 * the owner, and goes out on the link's carriers where they agreed to them.
 * Any session this tab had joined is left first.
 */
export async function joinLive(input: JoinInput): Promise<LiveGuest> {
  leaveLive();
  // The join screen refuses a link whose routes do not read; direct here.
  const routes = linkRoutes(input.link) ?? NO_ROUTES;
  const ice: IceSettings = input.useRoutes
    ? { iceServers: rtcServers(routes.ice), relay: routes.relay, addresses: [] }
    : DIRECT_ONLY;
  let next: LiveGuest | null = null;
  const carriers = input.useRoutes
    ? openCarriers(
        routes.carriers,
        input.link.secret,
        input.carriers,
        (code) => void next?.accept(code),
      )
    : null;
  guestCarriers = carriers;
  next = new LiveGuest({
    link: input.link,
    code: input.code,
    name: input.name,
    note: input.note,
    ice,
    peers: input.peers,
    carriers: carriers
      ? { post: poster(carriers), close: () => carriers.close() }
      : null,
  });
  guest = next;
  changed();
  await next.start();
  return next;
}

export function currentGuest(): LiveGuest | null {
  return guest;
}

/** The carriers the joined session's request goes out on, if any. */
export function currentGuestCarriers(): Rendezvous | null {
  return guestCarriers;
}

/** Leave the joined session, dropping everything it held. */
export function leaveLive(): void {
  guestCarriers?.close();
  guestCarriers = null;
  if (!guest) return;
  guest.leave();
  guest = null;
  changed();
}
