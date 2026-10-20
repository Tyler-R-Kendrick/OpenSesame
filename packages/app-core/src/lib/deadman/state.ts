/**
 * The public deadman record and the sealed private half (ADR 0209).
 *
 * The public record is device-local and signed with the device's deadman
 * signing key. It carries the last successful authentication time, the
 * deadline, the package digest and the public key — never an item name, an
 * item value or a relay token. The sealed VFS record carries the private key,
 * the relay bearer and the webhook destination, so none of those can be read
 * before the vault is open.
 */

import type { BoundaryValue, JsonObject } from "@opensesame/os-domain";
import {
  isJsonObject,
  isNumber,
  isString,
  overlapCast,
} from "@opensesame/os-domain";
import { kvDeleteDurable, kvGet, kvSetDurable } from "../kv.js";
import { VfsError } from "../vfs-error.js";
import { deleteFile, readFile, writeFile } from "../vfs.js";
import { canonicalJson, signText, verifyText } from "./crypto.js";
import {
  DEADMAN_CONFIG_PATH,
  DEADMAN_MAX_ITEMS,
  DEADMAN_MAX_TIMEOUT_DAYS,
  deadmanStateKey,
} from "./keys.js";
import {
  type DeadmanPackage,
  deleteDeadmanPackage,
  readDeadmanPackage,
} from "./package.js";
import { sendHeartbeat } from "./relay.js";

const DAY_MS = 86_400_000;

export type DeadmanState = Readonly<{
  v: 1;
  id: string;
  tomb: string;
  armedAt: string;
  lastAuthenticatedAt: number;
  timeoutDays: number;
  packageDigest: string;
  itemCount: number;
  publicKeyJwk: JsonWebKey;
  relayUrl: string;
  sequence: number;
  signature: string;
}>;

export type DeadmanConfig = Readonly<{
  v: 1;
  id: string;
  privateKeyJwk: JsonWebKey;
  relayToken: string;
  webhookUrl: string;
}>;

export type DeadmanStatus = Readonly<{
  id: string;
  tomb: string;
  armedAt: string;
  lastAuthenticatedAt: number;
  timeoutDays: number;
  itemCount: number;
  relayUrl: string;
  availableAt: number;
  remainingMs: number;
  triggered: boolean;
  /** The package exists and carries the digest the record names. */
  packageReady: boolean;
  /** The signed record did not verify; nothing releases from it. */
  damaged: boolean;
}>;

export const deadmanSeams = {
  now: (): number => Date.now(),
};

function stateText(state: DeadmanState): string {
  return canonicalJson({
    v: 1,
    id: state.id,
    tomb: state.tomb,
    armedAt: state.armedAt,
    lastAuthenticatedAt: state.lastAuthenticatedAt,
    timeoutDays: state.timeoutDays,
    packageDigest: state.packageDigest,
    itemCount: state.itemCount,
    // SAFETY: JsonWebKey uses JSON-compatible fields; this identity overlap
    // preserves the same public key for canonicalJson's existing serializer.
    publicKeyJwk: overlapCast(state.publicKeyJwk),
    relayUrl: state.relayUrl,
    sequence: state.sequence,
  });
}

export async function signDeadmanState(
  state: Omit<DeadmanState, "signature">,
  privateKeyJwk: JsonWebKey,
): Promise<DeadmanState> {
  const unsigned: DeadmanState = { ...state, signature: "" };
  const signature = await signText(privateKeyJwk, stateText(unsigned));
  return { ...state, signature };
}

export async function verifyDeadmanState(
  state: DeadmanState,
): Promise<boolean> {
  return verifyText(state.publicKeyJwk, stateText(state), state.signature);
}

function invalidAuthenticationWindow(value: JsonObject): boolean {
  return (
    !isNumber(value.lastAuthenticatedAt) ||
    !Number.isSafeInteger(value.lastAuthenticatedAt) ||
    value.lastAuthenticatedAt < 0 ||
    !isNumber(value.timeoutDays) ||
    !Number.isSafeInteger(value.timeoutDays) ||
    value.timeoutDays < 1 ||
    value.timeoutDays > DEADMAN_MAX_TIMEOUT_DAYS
  );
}

function invalidReleaseRecord(value: JsonObject): boolean {
  return (
    !isString(value.packageDigest) ||
    !/^[A-Za-z0-9_-]{43}$/u.test(value.packageDigest) ||
    !isNumber(value.itemCount) ||
    !Number.isSafeInteger(value.itemCount) ||
    value.itemCount < 1 ||
    value.itemCount > DEADMAN_MAX_ITEMS ||
    !isJsonObject(value.publicKeyJwk) ||
    !isString(value.relayUrl) ||
    value.relayUrl.length > 2048 ||
    !isNumber(value.sequence) ||
    !Number.isSafeInteger(value.sequence) ||
    value.sequence < 1 ||
    !isString(value.signature) ||
    !/^[A-Za-z0-9_-]{86}$/u.test(value.signature)
  );
}

export function parseDeadmanState(raw: string | null): DeadmanState | null {
  if (!raw) return null;
  try {
    const value: BoundaryValue = JSON.parse(raw);
    if (
      !isJsonObject(value) ||
      value.v !== 1 ||
      !isString(value.id) ||
      value.id.length > 80 ||
      !isString(value.tomb) ||
      value.tomb.length > 80 ||
      !isString(value.armedAt) ||
      invalidAuthenticationWindow(value) ||
      invalidReleaseRecord(value)
    )
      return null;
    return overlapCast(value);
  } catch {
    return null;
  }
}

export function readDeadmanState(tomb: string): DeadmanState | null {
  return parseDeadmanState(kvGet(deadmanStateKey(tomb)));
}

export async function writeDeadmanState(
  tomb: string,
  state: DeadmanState,
): Promise<void> {
  await kvSetDurable(deadmanStateKey(tomb), JSON.stringify(state));
}

export function parseDeadmanConfig(raw: string | null): DeadmanConfig | null {
  if (!raw) return null;
  try {
    const value: BoundaryValue = JSON.parse(raw);
    if (
      !isJsonObject(value) ||
      value.v !== 1 ||
      !isString(value.id) ||
      !isJsonObject(value.privateKeyJwk) ||
      !isString(value.privateKeyJwk.d) ||
      !isString(value.relayToken) ||
      value.relayToken.length > 4096 ||
      !isString(value.webhookUrl) ||
      value.webhookUrl.length > 2048
    )
      return null;
    return overlapCast(value);
  } catch {
    return null;
  }
}

export async function readDeadmanConfig(
  tomb: string,
): Promise<DeadmanConfig | null> {
  try {
    const bytes = await readFile(tomb, DEADMAN_CONFIG_PATH);
    return parseDeadmanConfig(new TextDecoder().decode(bytes));
  } catch (error) {
    if (error instanceof VfsError && error.code === "not-found") return null;
    throw error;
  }
}

export async function writeDeadmanConfig(
  tomb: string,
  config: DeadmanConfig,
): Promise<void> {
  await writeFile(
    tomb,
    DEADMAN_CONFIG_PATH,
    new TextEncoder().encode(JSON.stringify(config)),
  );
}

export async function deleteDeadmanConfig(tomb: string): Promise<void> {
  await deleteFile(tomb, DEADMAN_CONFIG_PATH);
}

function statusOf(
  state: DeadmanState,
  packageValue: DeadmanPackage | null,
  damaged: boolean,
  now: number,
): DeadmanStatus {
  const availableAt = state.lastAuthenticatedAt + state.timeoutDays * DAY_MS;
  const packageReady =
    packageValue !== null &&
    packageValue.id === state.id &&
    packageValue.digest === state.packageDigest &&
    packageValue.itemCount === state.itemCount;
  return {
    id: state.id,
    tomb: state.tomb,
    armedAt: state.armedAt,
    lastAuthenticatedAt: state.lastAuthenticatedAt,
    timeoutDays: state.timeoutDays,
    itemCount: state.itemCount,
    relayUrl: state.relayUrl,
    availableAt,
    remainingMs: Math.max(0, availableAt - now),
    triggered: !damaged && packageReady && now >= availableAt,
    packageReady,
    damaged,
  };
}

/**
 * The locked-screen reading. It cannot verify the signature synchronously, so
 * it only opens the door to the release screen; that screen verifies before it
 * asks for the release key.
 */
export function deadmanStatusForUnlock(
  tomb: string,
  now = deadmanSeams.now(),
): DeadmanStatus | null {
  const state = readDeadmanState(tomb);
  if (!state) return null;
  return statusOf(state, readDeadmanPackage(tomb), false, now);
}

export async function loadDeadmanStatus(
  tomb: string,
  now = deadmanSeams.now(),
): Promise<DeadmanStatus | null> {
  const state = readDeadmanState(tomb);
  if (!state) return null;
  const valid = await verifyDeadmanState(state);
  return statusOf(state, readDeadmanPackage(tomb), !valid, now);
}

/** Whether this device should draw the deadman entry on its locked screen. */
export function deadmanReleaseOffered(tomb: string): boolean {
  return deadmanStatusForUnlock(tomb)?.triggered === true;
}

/**
 * Move the deadline after a successful unlock. The local record is written
 * before the heartbeat leaves, so a relay outage cannot move the device's own
 * deadline backwards. A relay failure is deliberately not an unlock failure:
 * the owner is in, and the switch still has a local last-authenticated time.
 */
export async function recordDeadmanAuthentication(tomb: string): Promise<void> {
  try {
    const state = readDeadmanState(tomb);
    if (!state || !(await verifyDeadmanState(state))) return;
    const config = await readDeadmanConfig(tomb);
    if (!config || config.id !== state.id) return;
    const now = deadmanSeams.now();
    if (now <= state.lastAuthenticatedAt) return;
    const next = await signDeadmanState(
      {
        ...state,
        lastAuthenticatedAt: now,
        sequence: state.sequence + 1,
      },
      config.privateKeyJwk,
    );
    await writeDeadmanState(tomb, next);
    const heartbeat = {
      v: 1 as const,
      type: "opensesame.deadman.heartbeat" as const,
      id: next.id,
      at: now,
      sequence: next.sequence,
    };
    const signature = await signText(
      config.privateKeyJwk,
      canonicalJson(heartbeat),
    );
    void sendHeartbeat(
      { relayUrl: next.relayUrl, relayToken: config.relayToken },
      { ...heartbeat, signature },
    ).catch(() => undefined);
  } catch {
    // A deadman record is a convenience, never a condition of opening a vault.
  }
}

export async function deleteDeadmanLocal(tomb: string): Promise<void> {
  await deleteDeadmanConfig(tomb).catch(() => undefined);
  await deleteDeadmanPackage(tomb).catch(() => undefined);
  await kvDeleteDurable(deadmanStateKey(tomb)).catch(() => undefined);
}

/** Exposed for tests and the panel's "what will leave" sentence. */
export function deadmanPackageDigest(tomb: string): string | null {
  return readDeadmanPackage(tomb)?.digest ?? null;
}
