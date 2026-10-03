/**
 * The open vault's plugin-daemon pairing (ADR 0150 §7): read from the tomb
 * once the vault is open, dropped when it locks or another vault opens, and
 * never held for a guest.
 *
 * It follows the vault store only while something is listening — the plugin
 * panels, through their daemon port — so nothing runs at import or on a
 * capability's activation. Both plugin panels share it: pairing from one
 * shows in the other.
 */

import { GUEST_TOMB, vaultStore } from "../vault/store.js";
import {
  type PluginDaemonPairing,
  readPluginDaemonConfig,
  writePluginDaemonConfig,
} from "./plugin-pairing.js";

let pairing: PluginDaemonPairing | null = null;
/** The tomb `pairing` was read from; any other open vault has none. */
let pairedTomb: string | null = null;
let seenKey = "";
/**
 * Opaque counter, bumped on every change of the pairing (kept, dropped, read
 * again after a vault change, forgotten on the last unsubscribe). It lets a
 * caller tell "the same daemon, paired again" from "the pairing it started
 * with"; it is not a secret and is not derived from the key.
 */
let revision = 0;
let unfollow: (() => void) | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  revision += 1;
  for (const listener of listeners) listener();
}

/** An open vault that is not a guest's: the only place a key can be sealed. */
export function pluginPairingPossible(): boolean {
  const snap = vaultStore.getSnapshot();
  return snap.status === "unlocked" && !snap.guest && snap.tomb !== GUEST_TOMB;
}

function vaultKey(): string {
  const snap = vaultStore.getSnapshot();
  return `${snap.tomb}:${snap.status}:${snap.guest}`;
}

/** The revision of the pairing in force; changes whenever the pairing does. */
export function pluginPairingRevision(): number {
  return revision;
}

/** The pairing of the vault open now, or null. */
export function currentPluginPairing(): PluginDaemonPairing | null {
  if (!pairing || !pluginPairingPossible()) return null;
  return vaultStore.activeTomb() === pairedTomb ? pairing : null;
}

/**
 * Read this vault's pairing after an unlock; forget it after a lock. A read
 * that finishes after the vault changed again is discarded.
 */
async function load(): Promise<void> {
  const had = pairing !== null;
  pairing = null;
  pairedTomb = null;
  if (had) notify();
  else revision += 1;
  if (!pluginPairingPossible()) return;
  const key = vaultKey();
  const tomb = vaultStore.activeTomb();
  const loaded = await readPluginDaemonConfig(tomb).catch(() => null);
  if (vaultKey() !== key || unfollow === null) return;
  pairing = loaded;
  pairedTomb = loaded ? tomb : null;
  if (loaded) notify();
}

function onVaultChange(): void {
  const key = vaultKey();
  if (key === seenKey) return;
  seenKey = key;
  void load();
}

/** Told when the pairing may have changed; follows the vault while anyone listens. */
export function subscribePluginPairing(listener: () => void): () => void {
  listeners.add(listener);
  if (unfollow === null) {
    seenKey = vaultKey();
    unfollow = vaultStore.subscribe(onVaultChange);
    void load();
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size > 0 || unfollow === null) return;
    unfollow();
    unfollow = null;
    pairing = null;
    pairedTomb = null;
    revision += 1;
  };
}

/** Seal a traded pairing into the vault open now. */
export async function keepPluginPairing(
  next: PluginDaemonPairing,
): Promise<void> {
  if (!pluginPairingPossible()) throw new Error("locked");
  const tomb = vaultStore.activeTomb();
  await writePluginDaemonConfig(tomb, next);
  if (vaultStore.activeTomb() !== tomb) throw new Error("locked");
  pairing = next;
  pairedTomb = tomb;
  notify();
}

/** Forget this vault's pairing; the daemon revokes the key separately. */
export async function dropPluginPairing(): Promise<void> {
  if (!pluginPairingPossible()) return;
  await writePluginDaemonConfig(vaultStore.activeTomb(), null);
  pairing = null;
  pairedTomb = null;
  notify();
}
