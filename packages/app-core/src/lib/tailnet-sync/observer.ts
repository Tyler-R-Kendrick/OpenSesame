/**
 * Keeps the open vault in step with its tailnet drive (ADR 0140): a pass on
 * unlock, a pass shortly after each change, and one a minute while the vault
 * stays open. Runs only while `networking.tailnet` is active, only for a
 * vault paired with a drive, and never for a guest.
 */
import { GUEST_TOMB, vaultStore } from "../vault/store.js";
import { adoptFromDrive } from "./adopt.js";
import {
  holdPendingPairing,
  readDriveConfig,
  takePendingPairing,
  writeDriveConfig,
} from "./config.js";
import { type DriveTransport, defaultTransport, syncOnce } from "./engine.js";
import { type DrivePairing, parsePairingCode } from "./pairing.js";

export type TailnetSyncPhase = "off" | "idle" | "syncing" | "error";

export type TailnetSyncState = {
  phase: TailnetSyncPhase;
  /** The drive's label and address; null when this vault has no drive. */
  drive: { label: string; url: string } | null;
  lastSyncedAt: string | null;
  error: string | null;
};

const OFF: TailnetSyncState = {
  phase: "off",
  drive: null,
  lastSyncedAt: null,
  error: null,
};

/** What tests replace: the drive transport, the timings and the clock. */
export type TailnetSyncSeams = {
  transport: DriveTransport;
  debounceMs: number;
  intervalMs: number;
  now: () => string;
};

export const tailnetSyncSeams: TailnetSyncSeams = {
  transport: defaultTransport,
  debounceMs: 1_500,
  intervalMs: 60_000,
  now: () => new Date().toISOString(),
};

let state: TailnetSyncState = OFF;
const listeners = new Set<() => void>();
let pairing: DrivePairing | null = null;
let inflight: Promise<void> | null = null;
let again = false;
let started = false;
let unsubscribe: (() => void) | null = null;
let debounce: ReturnType<typeof setTimeout> | null = null;
let interval: ReturnType<typeof setInterval> | null = null;
let seenKey = "";

function set(next: Partial<TailnetSyncState>): void {
  state = { ...state, ...next };
  for (const listener of listeners) listener();
}

export function tailnetSyncState(): TailnetSyncState {
  return state;
}

export function subscribeTailnetSync(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function syncable(): boolean {
  const snap = vaultStore.getSnapshot();
  return snap.status === "unlocked" && !snap.guest && snap.tomb !== GUEST_TOMB;
}

function describe(drive: DrivePairing | null) {
  return drive ? { label: drive.label, url: drive.url } : null;
}

async function pass(): Promise<void> {
  if (!pairing || !syncable()) return;
  set({ phase: "syncing" });
  try {
    await syncOnce(vaultStore, pairing, tailnetSyncSeams.transport);
    set({ phase: "idle", lastSyncedAt: tailnetSyncSeams.now(), error: null });
  } catch (error) {
    set({
      phase: "error",
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Run a pass now, or once more after the one in flight. */
export async function syncTailnetNow(): Promise<void> {
  if (inflight) {
    again = true;
    return inflight;
  }
  inflight = (async () => {
    do {
      again = false;
      await pass();
    } while (again);
  })().finally(() => {
    inflight = null;
  });
  return inflight;
}

/** Read (or seal) this vault's pairing after an unlock; clear it after a lock. */
async function loadPairing(): Promise<void> {
  if (!syncable()) {
    pairing = null;
    set(OFF);
    return;
  }
  const tomb = vaultStore.activeTomb();
  const held = takePendingPairing();
  if (held) await writeDriveConfig(tomb, held);
  pairing = held ?? (await readDriveConfig(tomb));
  set({ ...OFF, phase: pairing ? "idle" : "off", drive: describe(pairing) });
  if (pairing) void syncTailnetNow();
}

function vaultKey(): string {
  const snap = vaultStore.getSnapshot();
  return `${snap.tomb}:${snap.status}:${snap.guest}`;
}

function onVaultChange(): void {
  const key = vaultKey();
  if (key !== seenKey) {
    seenKey = key;
    void loadPairing();
    return;
  }
  if (!pairing || !syncable()) return;
  if (debounce) clearTimeout(debounce);
  debounce = setTimeout(() => {
    debounce = null;
    void syncTailnetNow();
  }, tailnetSyncSeams.debounceMs);
}

/**
 * Pair this device with a drive from a pasted code. With a vault open, the
 * first pass must succeed before the pairing is kept — a drive holding another
 * vault is refused, not overwritten. With none (a new device, or a guest
 * session, which never touches the personal tomb), the vault is set up from
 * the drive and the pairing waits for it to be unlocked.
 */
export async function pairTailnetDrive(
  code: string,
): Promise<"paired" | "adopted"> {
  const next = parsePairingCode(code);
  if (!next) throw new Error("That is not a drive pairing code.");
  const snap = vaultStore.getSnapshot();
  if (snap.status === "empty" || snap.guest) {
    await adoptFromDrive(next, tailnetSyncSeams.transport);
    holdPendingPairing(next);
    if (snap.guest) vaultStore.lock({ recordLastVault: false });
    vaultStore.rehydrate();
    return "adopted";
  }
  if (!syncable()) throw new Error("Unlock the vault to pair it with a drive.");
  await syncOnce(vaultStore, next, tailnetSyncSeams.transport);
  await writeDriveConfig(vaultStore.activeTomb(), next);
  pairing = next;
  set({
    phase: "idle",
    drive: describe(next),
    lastSyncedAt: tailnetSyncSeams.now(),
    error: null,
  });
  return "paired";
}

/** Stop syncing this vault. The drive keeps its copy; the operator removes the slot. */
export async function forgetTailnetDrive(): Promise<void> {
  if (!syncable()) return;
  await writeDriveConfig(vaultStore.activeTomb(), null);
  pairing = null;
  set(OFF);
}

export function startTailnetSync(): () => void {
  if (started) return stopTailnetSync;
  started = true;
  seenKey = vaultKey();
  unsubscribe = vaultStore.subscribe(onVaultChange);
  interval = setInterval(
    () => void syncTailnetNow(),
    tailnetSyncSeams.intervalMs,
  );
  void loadPairing();
  return stopTailnetSync;
}

export function stopTailnetSync(): void {
  started = false;
  unsubscribe?.();
  unsubscribe = null;
  if (debounce) clearTimeout(debounce);
  if (interval) clearInterval(interval);
  debounce = null;
  interval = null;
  pairing = null;
  state = OFF;
  for (const listener of listeners) listener();
}
