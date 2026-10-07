import type { ObjectStore } from "@opensesame/vault-core";
import { maybeEnvironment, maybePage } from "../../ports.js";
/**
 * Keeps the open vault in step with its tailnet drive (ADR 0144): a pass on
 * unlock, a pass shortly after each change, one a minute while the vault
 * stays open, and one whenever the app comes back to the foreground or the
 * device comes back online — a phone that slept catches up as soon as it is
 * looked at. Runs only while `networking.tailnet` is active, only for a vault
 * paired with a drive, and never for a guest.
 *
 * Passes nobody asked for never raise the browser's Local Network Access
 * prompt; they wait, `blocked`, until a person syncs (`network-access.ts`).
 */
import { assertNotDecoySession } from "../decoy-session.js";
import { addFileStoreSource, localFileStore } from "../file-parts-store.js";
import { refreshProjectsView } from "../projects.js";
import { GUEST_TOMB, vaultStore } from "../vault/store.js";
import { switchVault } from "../vaults.js";
import { adoptSnapshot, isProjectTomb } from "./adopt.js";
import { reachDrive } from "./client.js";
import {
  holdPendingPairing,
  readDriveConfig,
  takePendingPairing,
  writeDriveConfig,
} from "./config.js";
import { type DriveTransport, defaultTransport, syncOnce } from "./engine.js";
import { failureMessage, openTheWay } from "./observer-network.js";
import { type DrivePairing, parsePairingCode } from "./pairing.js";
import { driveFileStore, putMissingParts } from "./parts.js";

/** `blocked`: waiting on the browser's local network permission (`error` says what to do). */
export type TailnetSyncPhase = "off" | "idle" | "syncing" | "blocked" | "error";

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
  /** The first request of a pass a person asked for, given time to be allowed. */
  reach: (pairing: DrivePairing, waitMs: number) => Promise<void>;
  debounceMs: number;
  intervalMs: number;
  now: () => string;
  /** This device's own file parts; rejects where it keeps none (`parts.ts`). */
  localFiles: () => Promise<ObjectStore>;
  /** Put the parts the drive lacks; how many went up. */
  putParts: typeof putMissingParts;
};

export const tailnetSyncSeams: TailnetSyncSeams = {
  transport: defaultTransport,
  reach: reachDrive,
  debounceMs: 1_500,
  intervalMs: 60_000,
  now: () => new Date().toISOString(),
  localFiles: localFileStore,
  putParts: putMissingParts,
};

let state: TailnetSyncState = OFF;
const listeners = new Set<() => void>();
let pairing: DrivePairing | null = null;
/** The tomb `pairing` was read from; a pass for any other vault does nothing. */
let pairedTomb: string | null = null;
let inflight: Promise<void> | null = null;
let again = false;
let againInteractive = false;
let started = false;
let unsubscribe: (() => void) | null = null;
let debounce: ReturnType<typeof setTimeout> | null = null;
let interval: ReturnType<typeof setInterval> | null = null;
let stopWaking: (() => void) | null = null;
let stopFiles: (() => void) | null = null;
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

/**
 * The drive the open vault is paired with — the daemon a person configured —
 * or null: no pairing, a guest, a locked vault, or another vault open. For
 * the plugin panels' daemon port (`plugin-daemon.ts`), never for the page.
 */
export function pairedDrive(): DrivePairing | null {
  if (!pairing || !syncable()) return null;
  return vaultStore.activeTomb() === pairedTomb ? pairing : null;
}

function describe(drive: DrivePairing | null) {
  return drive ? { label: drive.label, url: drive.url } : null;
}

/** The parts this vault's files name that the drive still lacks, put. */
async function putParts(
  drive: DrivePairing,
  generation: number,
): Promise<void> {
  assertNotDecoySession(generation);
  const local = await tailnetSyncSeams.localFiles().catch(() => null);
  assertNotDecoySession(generation);
  if (!local) return;
  await tailnetSyncSeams.putParts(drive, vaultStore.getSnapshot().items, local);
  assertNotDecoySession(generation);
}

async function pass(interactive: boolean): Promise<void> {
  const drive = pairing;
  if (!drive || !syncable() || vaultStore.activeTomb() !== pairedTomb) return;
  const generation = assertNotDecoySession();
  set({ phase: "syncing" });
  try {
    const blocked = await openTheWay(
      drive,
      interactive,
      generation,
      tailnetSyncSeams.reach,
    );
    assertNotDecoySession(generation);
    if (blocked) {
      set({ phase: "blocked", error: blocked });
      return;
    }
    await syncOnce(vaultStore, drive, tailnetSyncSeams.transport);
    assertNotDecoySession(generation);
    await putParts(drive, generation);
    assertNotDecoySession(generation);
    set({ phase: "idle", lastSyncedAt: tailnetSyncSeams.now(), error: null });
  } catch (error) {
    try {
      assertNotDecoySession(generation);
    } catch {
      return;
    }
    const message = await failureMessage(
      error instanceof Error ? error : String(error),
    );
    try {
      assertNotDecoySession(generation);
    } catch {
      return;
    }
    set({
      phase: "error",
      error: message,
    });
  }
}

export type SyncRequest = {
  /** A person asked (Sync now): it may raise the browser's permission prompt. */
  interactive?: boolean;
};

/** Run a pass now, or once more after the one in flight. */
export async function syncTailnetNow(request: SyncRequest = {}): Promise<void> {
  if (!syncable()) return;
  const generation = assertNotDecoySession();
  const interactive = request.interactive === true;
  if (inflight) {
    again = true;
    againInteractive = againInteractive || interactive;
    return inflight;
  }
  inflight = (async () => {
    let asked = interactive;
    do {
      again = false;
      try {
        assertNotDecoySession(generation);
      } catch {
        break;
      }
      await pass(asked);
      asked = againInteractive;
      againInteractive = false;
    } while (again);
  })().finally(() => {
    inflight = null;
  });
  return inflight;
}

/**
 * Read (or seal) this vault's pairing after an unlock; clear it after a lock.
 * The old vault's pairing is dropped before anything is awaited, and a read
 * that finishes after the vault changed again is discarded — the newer
 * change's own load owns the result.
 */
async function loadPairing(): Promise<void> {
  pairing = null;
  pairedTomb = null;
  if (!syncable()) {
    set(OFF);
    return;
  }
  const generation = assertNotDecoySession();
  const key = vaultKey();
  const tomb = vaultStore.activeTomb();
  const held = takePendingPairing(tomb);
  if (held) await writeDriveConfig(tomb, held);
  assertNotDecoySession(generation);
  const loaded = held ?? (await readDriveConfig(tomb));
  assertNotDecoySession(generation);
  if (vaultKey() !== key) return;
  pairing = loaded;
  pairedTomb = loaded ? tomb : null;
  set({ ...OFF, phase: loaded ? "idle" : "off", drive: describe(loaded) });
  if (loaded) void syncTailnetNow();
}

function vaultKey(): string {
  const snap = vaultStore.getSnapshot();
  return `${snap.tomb}:${snap.status}:${snap.guest}`;
}

function onVaultChange(): void {
  const key = vaultKey();
  if (key !== seenKey) {
    seenKey = key;
    void loadPairing().catch(() => undefined);
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
  const generation = assertNotDecoySession();
  const next = parsePairingCode(code);
  if (!next) throw new Error("That is not a drive pairing code.");
  const snap = vaultStore.getSnapshot();
  try {
    const blocked = await openTheWay(
      next,
      true,
      generation,
      tailnetSyncSeams.reach,
    );
    assertNotDecoySession(generation);
    if (blocked) throw new Error(blocked);
  } catch (error) {
    throw new Error(
      await failureMessage(error instanceof Error ? error : String(error)),
    );
  }
  assertNotDecoySession(generation);
  const theirs = (await tailnetSyncSeams.transport.read(next)).snapshot;
  assertNotDecoySession(generation);
  // A project vault this device does not have open lands beside its vaults.
  const project =
    theirs !== null &&
    isProjectTomb(theirs.tomb) &&
    theirs.tomb !== vaultStore.activeTomb();
  if (snap.status === "empty" || snap.guest || project) {
    if (!theirs) {
      throw new Error(
        "The drive is empty. Sync from a device that holds the vault first.",
      );
    }
    await adoptSnapshot(theirs);
    assertNotDecoySession(generation);
    holdPendingPairing(next, theirs.tomb);
    if (project) {
      // Its unlock screen is next — or it opens, sharing this session's key.
      await refreshProjectsView();
      assertNotDecoySession(generation);
      await switchVault(theirs.tomb);
      return "adopted";
    }
    if (snap.guest) vaultStore.lock({ recordLastVault: false });
    vaultStore.rehydrate();
    return "adopted";
  }
  if (!syncable()) throw new Error("Unlock the vault to pair it with a drive.");
  const tomb = vaultStore.activeTomb();
  await syncOnce(vaultStore, next, tailnetSyncSeams.transport);
  assertNotDecoySession(generation);
  if (vaultStore.activeTomb() !== tomb)
    throw new Error("The vault changed while pairing; pair it again.");
  await writeDriveConfig(tomb, next);
  assertNotDecoySession(generation);
  pairing = next;
  pairedTomb = tomb;
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
  const generation = assertNotDecoySession();
  if (!syncable()) return;
  await writeDriveConfig(vaultStore.activeTomb(), null);
  assertNotDecoySession(generation);
  pairing = null;
  pairedTomb = null;
  set(OFF);
}

/** Catch up when the app is looked at again or the device is back online. */
function watchForWaking(): () => void {
  const page = maybePage();
  const stopVisible = page?.onVisibilityChange(() => {
    if (page.visibilityState === "visible") void syncTailnetNow();
  });
  const stopOnline = maybeEnvironment()?.onOnlineChange((online) => {
    if (online) void syncTailnetNow();
  });
  return () => {
    stopVisible?.();
    stopOnline?.();
  };
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
  stopWaking = watchForWaking();
  // Files read from, and sealed to, the drive this vault is paired with.
  stopFiles = addFileStoreSource((local) => {
    const drive = pairedDrive();
    return drive ? [driveFileStore(drive, local)] : [];
  });
  void loadPairing().catch(() => undefined);
  return stopTailnetSync;
}

export function stopTailnetSync(): void {
  started = false;
  unsubscribe?.();
  unsubscribe = null;
  stopWaking?.();
  stopWaking = null;
  stopFiles?.();
  stopFiles = null;
  if (debounce) clearTimeout(debounce);
  if (interval) clearInterval(interval);
  debounce = null;
  interval = null;
  pairing = null;
  pairedTomb = null;
  state = OFF;
  for (const listener of listeners) listener();
}
