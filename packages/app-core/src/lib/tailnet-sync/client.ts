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
import { localNetworkFetch } from "../local-network-fetch.js";
import type { DrivePairing } from "./pairing.js";
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

export const driveClientSeams = {
  fetch: (url: string, init: RequestInit) =>
    localNetworkFetch(url, {
      ...init,
      ciphertextDrive: true,
      timeoutMs: 15_000,
    }),
};

function slotUrl(pairing: DrivePairing): string {
  return `${pairing.url}/v1/vault-drive/slots/${encodeURIComponent(pairing.slot)}/snapshot`;
}

function headers(pairing: DrivePairing): HeadersInit {
  return {
    Authorization: `Bearer ${pairing.key}`,
    "Content-Type": "application/json",
  };
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

export async function readDrive(pairing: DrivePairing): Promise<DriveRead> {
  const response = await driveClientSeams.fetch(slotUrl(pairing), {
    method: "GET",
    headers: headers(pairing),
    credentials: "omit",
    cache: "no-store",
  });
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
