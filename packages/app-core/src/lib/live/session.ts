/**
 * The one live session this tab hosts, and the one it has joined
 * (ADR 0148 §2).
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
import { type LiveLink, loadLiveRelays } from "./link.js";
import type { SharePolicy } from "./messages.js";
import type { IceSettings, PeerFactory } from "./peer.js";
import { DEFAULT_RELAYS, relayTransport } from "./relays.js";
import type { SignalTransport } from "./signal.js";
import { type ShareScope, vaultCatalog, vaultField } from "./vault-share.js";

/** Two public STUN servers: they learn an address, never the session. */
export const DEFAULT_ICE: IceSettings = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun.cloudflare.com:3478" },
  ],
  relayOnly: false,
};

export const liveSeams = {
  transport: (): SignalTransport => relayTransport(),
  /** The relays Settings names (`liveRelays`); empty means the defaults. */
  relays: (): readonly string[] => loadLiveRelays(),
  items: (): readonly VaultItem[] => vaultStore.getSnapshot().items,
  onLock: (handler: () => void): (() => void) => vaultStore.onLock(handler),
};

let host: LiveHost | null = null;
let stopLockWatch: (() => void) | null = null;
let guest: LiveGuest | null = null;
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
  relays?: readonly string[];
  ice?: IceSettings;
}>;

/** The session's relays: the caller's, else Settings', else the defaults. */
function relaysFor(named: readonly string[] | undefined): readonly string[] {
  if (named?.length) return named;
  const configured = liveSeams.relays();
  return configured.length ? configured : DEFAULT_RELAYS;
}

/** Start hosting; any session this tab was hosting ends first. */
export function startHosting(input: HostInput): LiveHost {
  endHosting();
  // The host clamps the lifetime; the catalog states the clamped one.
  const expiresAt = Math.min(
    Date.now() + input.minutes * 60_000,
    Date.now() + MAX_SESSION_MS,
  );
  const items = liveSeams.items;
  const next: LiveHost = new LiveHost({
    admission: input.admission,
    relays: relaysFor(input.relays),
    ice: input.ice ?? DEFAULT_ICE,
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
    transport: liveSeams.transport(),
    peers: input.peers,
  });
  host = next;
  stopLockWatch = liveSeams.onLock(() => endHosting());
  next.start();
  changed();
  return next;
}

export function currentHost(): LiveHost | null {
  return host;
}

/** End the hosted session for everyone. */
export function endHosting(): void {
  stopLockWatch?.();
  stopLockWatch = null;
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
  ice?: IceSettings;
}>;

/** Ask to join; any session this tab had joined is left first. */
export async function joinLive(input: JoinInput): Promise<LiveGuest> {
  leaveLive();
  const next = new LiveGuest({
    link: input.link,
    code: input.code,
    name: input.name,
    note: input.note,
    relays: input.link.relays.length ? input.link.relays : DEFAULT_RELAYS,
    ice: input.ice ?? DEFAULT_ICE,
    transport: liveSeams.transport(),
    peers: input.peers,
  });
  guest = next;
  changed();
  await next.ask();
  return next;
}

export function currentGuest(): LiveGuest | null {
  return guest;
}

/** Leave the joined session, dropping everything it held. */
export function leaveLive(): void {
  if (!guest) return;
  guest.leave();
  guest = null;
  changed();
}
