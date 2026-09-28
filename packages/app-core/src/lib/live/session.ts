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
import type { LiveLink } from "./link.js";
import type { SharePolicy } from "./messages.js";
import { DIRECT_ONLY, type IceSettings, type PeerFactory } from "./peer.js";
import { type ShareScope, vaultCatalog, vaultField } from "./vault-share.js";

export const liveSeams = {
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
  ice?: IceSettings;
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
  const next = await LiveHost.start({
    admission: input.admission,
    ice: input.ice ?? DIRECT_ONLY,
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
  stopLockWatch = liveSeams.onLock(() => endHosting());
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

/**
 * Start asking to join: the request code comes back for the person to send
 * the owner. Any session this tab had joined is left first.
 */
export async function joinLive(input: JoinInput): Promise<LiveGuest> {
  leaveLive();
  const next = new LiveGuest({
    link: input.link,
    code: input.code,
    name: input.name,
    note: input.note,
    ice: input.ice ?? DIRECT_ONLY,
    peers: input.peers,
  });
  guest = next;
  changed();
  await next.start();
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
