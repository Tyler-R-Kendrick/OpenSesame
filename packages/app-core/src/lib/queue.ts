import { isString, isTypeofObject, overlapCast } from "@opensesame/os-domain";
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
  | { kind: "claim_complete"; claimToken: string; userCode: string };

export type QueuedAction = QueuedActionInput & {
  id: string;
  createdAt: string;
};

type DeviceAction = Extract<QueuedAction, { kind: "device_approve" }>;
type ClaimAction = Extract<QueuedAction, { kind: "claim_complete" }>;

const KEY = "outbox.v1";
export const QUEUE_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_QUEUE_LENGTH = 32;

/** Staged claims, newest last. Never written to disk. */
let stagedClaims: ClaimAction[] = [];

function loadDeviceActions(): DeviceAction[] {
  let parsed: QueuedAction[];
  try {
    const raw = kvGet(KEY);
    if (!raw) return [];
    parsed = overlapCast(JSON.parse(raw));
    if (!Array.isArray(parsed)) return [];
  } catch {
    return [];
  }
  const devices = parsed
    .filter((item): item is DeviceAction => {
      if (!item || !isTypeofObject(item)) return false;
      if (item.kind !== "device_approve") return false;
      if (!item.id || !item.userCode || !isString(item.createdAt)) return false;
      const createdAt = Date.parse(item.createdAt);
      return !Number.isNaN(createdAt) && Date.now() - createdAt <= QUEUE_TTL_MS;
    })
    .slice(-MAX_QUEUE_LENGTH);
  // An older build wrote claim tokens here. Rewrite on sight so a bearer
  // credential does not sit on disk waiting for an unrelated write.
  if (devices.length !== parsed.length) saveDeviceActions(devices);
  return devices;
}

function saveDeviceActions(items: DeviceAction[]): void {
  kvSet(KEY, JSON.stringify(items.slice(-MAX_QUEUE_LENGTH)));
}

function loadQueueDefault(): QueuedAction[] {
  return [...loadDeviceActions(), ...stagedClaims];
}

function enqueueDefault(action: QueuedActionInput): QueuedAction {
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

function dequeueDefault(id: string): void {
  stagedClaims = stagedClaims.filter((item) => item.id !== id);
  saveDeviceActions(loadDeviceActions().filter((item) => item.id !== id));
}

/** Drop every staged claim token. Called on vault lock. */
function clearStagedClaimTokensDefault(): void {
  stagedClaims = [];
  // Also purges any claim row an older build left on disk.
  loadDeviceActions();
}

export const queueSeams = {
  loadQueue: loadQueueDefault,
  enqueue: enqueueDefault,
  dequeue: dequeueDefault,
  clearStagedClaimTokens: clearStagedClaimTokensDefault,
};

export function loadQueue(): QueuedAction[] {
  return queueSeams.loadQueue();
}

export function enqueue(action: QueuedActionInput): QueuedAction {
  return queueSeams.enqueue(action);
}

export function dequeue(id: string): void {
  queueSeams.dequeue(id);
}

export function clearStagedClaimTokens(): void {
  queueSeams.clearStagedClaimTokens();
}
