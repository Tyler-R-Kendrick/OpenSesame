/**
 * Offline outbox.
 *
 * Device user codes are short-lived, low-value, and worth keeping across a
 * reload, so they persist. A claim token is a bearer credential for an entire
 * claim, so staged claims live in memory for this tab only — they do not reach
 * OPFS and do not survive a reload or a vault lock.
 */

import { kvGet, kvSet } from "./kv.js";

export type QueuedActionInput =
  | { kind: "device_approve"; userCode: string }
  | { kind: "claim_complete"; claimToken: string };

export type QueuedAction = QueuedActionInput & {
  id: string;
  createdAt: string;
};

type DeviceAction = Extract<QueuedAction, { kind: "device_approve" }>;
type ClaimAction = Extract<QueuedAction, { kind: "claim_complete" }>;

const KEY = "outbox.v1";

/** Staged claims, newest last. Never written to disk. */
let stagedClaims: ClaimAction[] = [];

function loadDeviceActions(): DeviceAction[] {
  let parsed: QueuedAction[];
  try {
    const raw = kvGet(KEY);
    if (!raw) return [];
    parsed = JSON.parse(raw) as QueuedAction[];
    if (!Array.isArray(parsed)) return [];
  } catch {
    return [];
  }
  const devices = parsed.filter(
    (item): item is DeviceAction => item.kind === "device_approve",
  );
  // An older build wrote claim tokens here. Rewrite on sight so a bearer
  // credential does not sit on disk waiting for an unrelated write.
  if (devices.length !== parsed.length) saveDeviceActions(devices);
  return devices;
}

function saveDeviceActions(items: DeviceAction[]): void {
  kvSet(KEY, JSON.stringify(items));
}

export function loadQueue(): QueuedAction[] {
  return [...loadDeviceActions(), ...stagedClaims];
}

export function enqueue(action: QueuedActionInput): QueuedAction {
  const item: QueuedAction = {
    ...action,
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
  };
  if (item.kind === "claim_complete") {
    stagedClaims = [...stagedClaims, item];
    return item;
  }
  saveDeviceActions([...loadDeviceActions(), item]);
  return item;
}

export function dequeue(id: string): void {
  stagedClaims = stagedClaims.filter((item) => item.id !== id);
  saveDeviceActions(loadDeviceActions().filter((item) => item.id !== id));
}

/** Drop every staged claim token. Called on vault lock. */
export function clearStagedClaimTokens(): void {
  stagedClaims = [];
  // Also purges any claim row an older build left on disk.
  loadDeviceActions();
}
