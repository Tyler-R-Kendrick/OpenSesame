/**
 * Client for a paired vault relay (ADR 0181).
 *
 * Live join does not call this. A device pushes a sealed snapshot only
 * after a separate consent, and a second device pulls that ciphertext.
 * The relay is not asked to merge, and this module does not hold a vault key.
 */

export const RELAY_SNAPSHOT_FORMAT = "opensesame-vault-drive-snapshot";

export type RelayOwnerKind = "user" | "organization";

export type RelaySnapshot = {
  readonly format: typeof RELAY_SNAPSHOT_FORMAT;
  readonly v: 1;
  readonly tomb: string;
  readonly header: { readonly v: 1; readonly createdAt: string };
  readonly body: { readonly ivB64: string; readonly ctB64: string };
  readonly rev: number;
};

export type RelayTarget = {
  readonly baseUrl: string;
  readonly owner: string;
  readonly slug: string;
  readonly slotKey: string;
  readonly principal?: string;
  readonly ownerKind?: RelayOwnerKind;
  readonly fetch?: typeof fetch;
};

export type RelayCiphertextMeta = {
  readonly format: typeof RELAY_SNAPSHOT_FORMAT;
  readonly tomb: string;
  readonly generation: number;
  readonly ctB64: string;
};

export class RelayRequestError extends Error {
  readonly status: number;
  readonly generation: number | null;

  constructor(status: number, generation: number | null) {
    super(`relay answered ${status}`);
    this.name = "RelayRequestError";
    this.status = status;
    this.generation = generation;
  }
}

function endpoint(target: RelayTarget): string {
  const base = target.baseUrl.replace(/\/$/, "");
  return `${base}/v1/vault-relay/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.slug)}/snapshot`;
}

function headers(target: RelayTarget): Headers {
  const value = new Headers();
  value.set("x-opensesame-slot-key", target.slotKey);
  if (target.principal) value.set("x-opensesame-principal", target.principal);
  if (target.ownerKind) value.set("x-opensesame-owner-kind", target.ownerKind);
  return value;
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function generationOf(body: unknown): number | null {
  if (!body || typeof body !== "object" || !("generation" in body)) return null;
  const generation = body.generation;
  return typeof generation === "number" ? generation : null;
}

function isSnapshot(value: unknown): value is RelaySnapshot {
  if (!value || typeof value !== "object") return false;
  const snapshot = value as Record<string, unknown>;
  const body = snapshot.body;
  const header = snapshot.header;
  return (
    snapshot.format === RELAY_SNAPSHOT_FORMAT &&
    snapshot.v === 1 &&
    typeof snapshot.tomb === "string" &&
    !!header &&
    typeof header === "object" &&
    (header as { v?: unknown }).v === 1 &&
    typeof (header as { createdAt?: unknown }).createdAt === "string" &&
    !!body &&
    typeof body === "object" &&
    typeof (body as { ivB64?: unknown }).ivB64 === "string" &&
    typeof (body as { ctB64?: unknown }).ctB64 === "string" &&
    typeof snapshot.rev === "number"
  );
}

/** What a second device keeps from a pull: ciphertext metadata, no item name. */
export function relayCiphertextMeta(
  generation: number,
  snapshot: RelaySnapshot,
): RelayCiphertextMeta {
  return {
    format: snapshot.format,
    tomb: snapshot.tomb,
    generation,
    ctB64: snapshot.body.ctB64,
  };
}

/** Push a sealed snapshot. Returns the generation the relay stored. */
export async function pushRelaySnapshot(
  target: RelayTarget,
  snapshot: RelaySnapshot,
  expectedGeneration: number,
): Promise<number> {
  const fetchImpl = target.fetch ?? fetch;
  const response = await fetchImpl(endpoint(target), {
    method: "PUT",
    headers: headers(target),
    body: JSON.stringify({
      expected_generation: expectedGeneration,
      snapshot,
    }),
  });
  const body = await readJson(response);
  if (!response.ok) {
    throw new RelayRequestError(response.status, generationOf(body));
  }
  const generation = generationOf(body);
  if (generation === null) throw new RelayRequestError(response.status, null);
  return generation;
}

/**
 * Pull the slot. `null` when the address has not been claimed.
 * A wrong key throws {@link RelayRequestError}.
 */
export async function pullRelaySnapshot(
  target: RelayTarget,
): Promise<{ generation: number; snapshot: RelaySnapshot } | null> {
  const fetchImpl = target.fetch ?? fetch;
  const response = await fetchImpl(endpoint(target), {
    method: "GET",
    headers: headers(target),
  });
  const body = await readJson(response);
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new RelayRequestError(response.status, generationOf(body));
  }
  if (!body || typeof body !== "object" || !("snapshot" in body)) {
    throw new RelayRequestError(response.status, null);
  }
  const snapshot = body.snapshot;
  const generation = generationOf(body);
  if (!isSnapshot(snapshot) || generation === null) {
    throw new RelayRequestError(response.status, generation);
  }
  return { generation, snapshot };
}
