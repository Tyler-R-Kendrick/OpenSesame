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
import { assertNotDecoySession } from "../decoy-session.js";
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

/**
 * How a drive request goes out. An `https:` drive (Tailscale Serve) carries no
 * `targetAddressSpace` hint: the hint only exempts a plain-`http:` request from
 * mixed-content blocking, and a hint Chrome cannot confirm — a browser behind
 * a proxy sees the proxy's address, not the tailnet's — fails the request
 * outright. Without it Chrome still asks for local network access wherever the
 * name resolves to a private address.
 */
export function driveRequest(
  url: string,
  init: LocalNetworkFetchInit,
): LocalNetworkFetchInit {
  return {
    timeoutMs: DRIVE_TIMEOUT_MS,
    ...init,
    ciphertextDrive: true,
    skipAddressSpace: url.startsWith("https:"),
  };
}

export const driveClientSeams = {
  fetch: (url: string, init: LocalNetworkFetchInit) =>
    localNetworkFetch(url, driveRequest(url, init)),
};

/** The slot's address on its drive; its snapshot and parts hang off it. */
export function slotBase(pairing: DrivePairing): string {
  return `${pairing.url}/v1/vault-drive/slots/${encodeURIComponent(pairing.slot)}`;
}

function slotUrl(pairing: DrivePairing): string {
  return `${slotBase(pairing)}/snapshot`;
}

/** The slot key as a bearer, and the saved tailnet connector's headers. */
export function driveHeaders(
  pairing: DrivePairing,
  contentType = "application/json",
): HeadersInit {
  assertNotDecoySession();
  return tailnetSyncHeaders(
    { Authorization: `Bearer ${pairing.key}`, "Content-Type": contentType },
    currentTailnet(),
  );
}

function headers(pairing: DrivePairing): HeadersInit {
  return driveHeaders(pairing);
}

function generationOf(json: BoundaryValue): number {
  if (!isJsonObject(json) || !isNumber(json.generation)) {
    throw new DriveError("The drive answered without a generation.", 502);
  }
  return json.generation;
}

export async function readJson(response: Response): Promise<BoundaryValue> {
  try {
    return await response.json();
  } catch {
    throw new DriveError("The drive answered with something unreadable.", 502);
  }
}

export function refused(response: Response): DriveError {
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
  assertNotDecoySession();
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
  const authorityGeneration = assertNotDecoySession();
  const response = await getSlot(pairing, waitMs);
  assertNotDecoySession(authorityGeneration);
  if (!response.ok) throw refused(response);
}

export async function readDrive(pairing: DrivePairing): Promise<DriveRead> {
  const authorityGeneration = assertNotDecoySession();
  const response = await getSlot(pairing);
  assertNotDecoySession(authorityGeneration);
  if (!response.ok) throw refused(response);
  const json = await readJson(response);
  assertNotDecoySession(authorityGeneration);
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
  const authorityGeneration = assertNotDecoySession();
  const response = await driveClientSeams.fetch(slotUrl(pairing), {
    method: "PUT",
    headers: headers(pairing),
    credentials: "omit",
    body: JSON.stringify({ expected_generation: expectedGeneration, snapshot }),
  });
  assertNotDecoySession(authorityGeneration);
  if (response.status !== 409 && !response.ok) throw refused(response);
  const json = await readJson(response);
  assertNotDecoySession(authorityGeneration);
  return { ok: response.status !== 409, generation: generationOf(json) };
}
