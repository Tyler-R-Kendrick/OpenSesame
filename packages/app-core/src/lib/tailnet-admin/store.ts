/**
 * The open vault's tailnet admin pairing (ADR 0169 §3), as
 * `plugin-daemon-store.ts` keeps the plugin pairing: read from the tomb once
 * the vault is open, dropped when it locks or another vault opens, and never
 * held for a guest. It follows the vault only while a panel listens, so
 * nothing runs at import or on activation.
 */

import { GUEST_TOMB, vaultStore } from "../vault/store.js";
import { TailnetAdminError } from "./errors.js";
import {
  type TailnetAdminPairing,
  readTailnetAdminConfig,
  writeTailnetAdminConfig,
} from "./pairing.js";

let pairing: TailnetAdminPairing | null = null;
let pairedTomb: string | null = null;
let seenKey = "";
/**
 * Opaque counter, bumped on every change of the pairing. A call records it
 * when it begins, so a pairing made or dropped meanwhile is never confused
 * with the one it started under. Not a secret, not derived from the key.
 */
let revision = 0;
let unfollow: (() => void) | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  revision += 1;
  for (const listener of listeners) listener();
}

/** An open vault that is not a guest's: the only place a key can be sealed. */
export function tailnetPairingPossible(): boolean {
  const snap = vaultStore.getSnapshot();
  return snap.status === "unlocked" && !snap.guest && snap.tomb !== GUEST_TOMB;
}

function vaultKey(): string {
  const snap = vaultStore.getSnapshot();
  return `${snap.tomb}:${snap.status}:${snap.guest}`;
}

export function tailnetPairingRevision(): number {
  return revision;
}

export type TailnetBinding = Readonly<{ tomb: string; revision: number }>;

export function bindTailnetPairing(): TailnetBinding {
  return { tomb: vaultStore.activeTomb(), revision };
}

/** The pairing of the vault open now, or null. */
export function currentTailnetPairing(): TailnetAdminPairing | null {
  if (!pairing || !tailnetPairingPossible()) return null;
  return vaultStore.activeTomb() === pairedTomb ? pairing : null;
}

async function load(): Promise<void> {
  const had = pairing !== null;
  pairing = null;
  pairedTomb = null;
  if (had) notify();
  else revision += 1;
  if (!tailnetPairingPossible()) return;
  const key = vaultKey();
  const tomb = vaultStore.activeTomb();
  const loaded = await readTailnetAdminConfig(tomb).catch(() => null);
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
export function subscribeTailnetPairing(listener: () => void): () => void {
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

/** Seal a traded pairing, provided the vault and the pairing have not moved since `began`. */
export async function keepTailnetPairing(
  next: TailnetAdminPairing,
  began: TailnetBinding,
): Promise<void> {
  if (!tailnetPairingPossible()) throw new TailnetAdminError("locked");
  const tomb = vaultStore.activeTomb();
  if (tomb !== began.tomb) throw new TailnetAdminError("locked");
  if (revision !== began.revision)
    throw new TailnetAdminError("target-changed");
  await writeTailnetAdminConfig(tomb, next);
  if (vaultStore.activeTomb() !== tomb) throw new TailnetAdminError("locked");
  pairing = next;
  pairedTomb = tomb;
  notify();
}

/** Forget this vault's pairing, but only the one in force at `expected`. */
export async function dropTailnetPairing(expected: number): Promise<void> {
  if (!tailnetPairingPossible() || revision !== expected) return;
  await writeTailnetAdminConfig(vaultStore.activeTomb(), null);
  pairing = null;
  pairedTomb = null;
  notify();
}
