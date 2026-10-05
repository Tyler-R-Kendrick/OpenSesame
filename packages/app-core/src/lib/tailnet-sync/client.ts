/**
 * The drive's wire protocol (ADR 0144): one ciphertext snapshot per slot,
 * replaced by compare-and-set on a generation counter the drive keeps.
 *
 *   GET  {url}/v1/vault-drive/slots/{slot}/snapshot
 *        → 200 { generation, snapshot | null }
 *   PUT  {url}/v1/vault-drive/slots/{slot}/snapshot
 *        { expected_generation, snapshot }
 *        → 200 { generation } | 409 { generation }
 *
 * Both carry the slot key as a bearer token. The drive never sees a vault key,
 * so the worst it can do is refuse, lose, or replay a snapshot — and the merge
 * on the device makes a replayed one harmless.
 */
import {
  type BoundaryValue,
  isJsonObject,
  isNumber,
} from "@opensesame/os-domain";
import {
  type LocalNetworkFetchInit,
  localNetworkFetch,
} from "../local-network-fetch.js";
import type { DrivePairing } from "./pairing.js";
import { currentTailnet, tailnetSyncHeaders } from "./saved-connector.js";
import { type DriveSnapshot, parseDriveSnapshot } from "./snapshot.js";

export type DriveRead = { generation: number; snapshot: DriveSnapshot | null };

export type DriveWrite =
  | { ok: true; generation: number }
  | { ok: false; generation: number };

/** A drive answered with something other than the protocol above. */
export class DriveError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "DriveError";
  }
}

/** How long a drive request may take before it is given up as unanswered. */
export const DRIVE_TIMEOUT_MS = 15_000;

export const driveClientSeams = {
  fetch: (url: string, init: LocalNetworkFetchInit) =>
    localNetworkFetch(url, {
      timeoutMs: DRIVE_TIMEOUT_MS,
      ...init,
      ciphertextDrive: true,
    }),
};

function slotUrl(pairing: DrivePairing): string {
  return `${pairing.url}/v1/vault-drive/slots/${encodeURIComponent(pairing.slot)}/snapshot`;
}

function headers(pairing: DrivePairing): HeadersInit {
  return tailnetSyncHeaders(
    {
      Authorization: `Bearer ${pairing.key}`,
      "Content-Type": "application/json",
    },
    currentTailnet(),
  );
}

function generationOf(json: BoundaryValue): number {
  if (!isJsonObject(json) || !isNumber(json.generation)) {
    throw new DriveError("The drive answered without a generation.", 502);
  }
  return json.generation;
}

async function readJson(response: Response): Promise<BoundaryValue> {
  try {
    return await response.json();
  } catch {
    throw new DriveError("The drive answered with something unreadable.", 502);
  }
}

function refused(response: Response): DriveError {
  if (response.status === 401 || response.status === 404) {
    return new DriveError(
      "The drive no longer knows this device's key. Pair again.",
      response.status,
    );
  }
  if (response.status === 413) {
    return new DriveError("The vault is larger than the drive accepts.", 413);
  }
  return new DriveError(
    `The drive refused the request (${response.status}).`,
    response.status,
  );
}

function getSlot(pairing: DrivePairing, timeoutMs?: number) {
  return driveClientSeams.fetch(slotUrl(pairing), {
    ...(timeoutMs ? { timeoutMs } : undefined),
    method: "GET",
    headers: headers(pairing),
    credentials: "omit",
    cache: "no-store",
  });
}

/**
 * One read given `waitMs` to be answered: the first request of a pass a
 * person asked for, which may sit on the browser's Local Network Access
 * prompt until they answer it (`network-access.ts`). Once they allow it,
 * every later request of the pass goes straight out.
 */
export async function reachDrive(
  pairing: DrivePairing,
  waitMs: number,
): Promise<void> {
  const response = await getSlot(pairing, waitMs);
  if (!response.ok) throw refused(response);
}

export async function readDrive(pairing: DrivePairing): Promise<DriveRead> {
  const response = await getSlot(pairing);
  if (!response.ok) throw refused(response);
  const json = await readJson(response);
  const generation = generationOf(json);
  const raw = isJsonObject(json) ? json.snapshot : null;
  return {
    generation,
    snapshot:
      raw === null || raw === undefined ? null : parseDriveSnapshot(raw),
  };
}

export async function writeDrive(
  pairing: DrivePairing,
  expectedGeneration: number,
  snapshot: DriveSnapshot,
): Promise<DriveWrite> {
  const response = await driveClientSeams.fetch(slotUrl(pairing), {
    method: "PUT",
    headers: headers(pairing),
    credentials: "omit",
    body: JSON.stringify({ expected_generation: expectedGeneration, snapshot }),
  });
  if (response.status === 409) {
    return { ok: false, generation: generationOf(await readJson(response)) };
  }
  if (!response.ok) throw refused(response);
  return { ok: true, generation: generationOf(await readJson(response)) };
}
