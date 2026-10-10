/**
 * Client for a paired vault relay (ADR 0181).
 *
 * Live join does not call this. A device pushes a sealed snapshot only
 * after a separate consent, and a second device pulls that ciphertext.
 * The relay is not asked to merge, and this module does not hold a vault key.
 */

import {
  type BoundaryValue,
  isJsonObject,
  isNumber,
  isString,
} from "@opensesame/os-domain";
import {
  type LocalNetworkFetchInit,
  localNetworkFetch,
} from "../local-network-fetch.js";

export const RELAY_SNAPSHOT_FORMAT = "opensesame-vault-drive-snapshot";

export type RelayOwnerKind = "user" | "organization";

/** Organization directory role (ADR 0181). A member may list and may not publish. */
export type OrgDirectoryRole = "owner" | "admin" | "member";

export type OrgVaultRecord = {
  readonly ownerKind: RelayOwnerKind;
  readonly owner: string;
  readonly slug: string;
};

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
  /** RS256 registration JWT when the relay pins `OPENSESAME_VAULT_RELAY_ISSUER`. */
  readonly relayRegistrationToken?: string;
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

function originOf(baseUrl: string): string {
  return baseUrl.replace(/\/$/, "");
}

function endpoint(target: RelayTarget): string {
  return `${originOf(target.baseUrl)}/v1/vault-relay/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.slug)}/snapshot`;
}

/**
 * Ciphertext on a paired relay is the tailnet drive's exception: no operator
 * token, and loopback is allowed without local-operator authority.
 */
function fetchOf(target: { readonly fetch?: typeof fetch }): typeof fetch {
  if (target.fetch) return target.fetch;
  return (input, init) =>
    localNetworkFetch(String(input), {
      ...(init ?? {}),
      ciphertextDrive: true,
      timeoutMs: 15_000,
      skipAddressSpace: String(input).startsWith("https:"),
    } satisfies LocalNetworkFetchInit);
}

function applyRegistrationToken(value: Headers, token?: string): void {
  if (!token) return;
  value.set("authorization", `Bearer ${token}`);
}

function headers(target: RelayTarget): Headers {
  const value = new Headers();
  value.set("x-opensesame-slot-key", target.slotKey);
  if (target.principal) value.set("x-opensesame-principal", target.principal);
  if (target.ownerKind) value.set("x-opensesame-owner-kind", target.ownerKind);
  applyRegistrationToken(value, target.relayRegistrationToken);
  return value;
}

async function readJson(response: Response): Promise<BoundaryValue> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function generationOf(body: BoundaryValue): number | null {
  if (!isJsonObject(body)) return null;
  const generation = body.generation;
  return isNumber(generation) ? generation : null;
}

function isSnapshot(snapshot: BoundaryValue): snapshot is RelaySnapshot {
  if (!isJsonObject(snapshot)) return false;
  const body = snapshot.body;
  const header = snapshot.header;
  return (
    snapshot.format === RELAY_SNAPSHOT_FORMAT &&
    snapshot.v === 1 &&
    isString(snapshot.tomb) &&
    isJsonObject(header) &&
    header.v === 1 &&
    isString(header.createdAt) &&
    isJsonObject(body) &&
    isString(body.ivB64) &&
    isString(body.ctB64) &&
    isNumber(snapshot.rev)
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
  const fetchImpl = fetchOf(target);
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
  const fetchImpl = fetchOf(target);
  const response = await fetchImpl(endpoint(target), {
    method: "GET",
    headers: headers(target),
  });
  const body = await readJson(response);
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new RelayRequestError(response.status, generationOf(body));
  }
  if (!isJsonObject(body) || !("snapshot" in body)) {
    throw new RelayRequestError(response.status, null);
  }
  const snapshot = body.snapshot;
  const generation = generationOf(body);
  if (!isSnapshot(snapshot) || generation === null) {
    throw new RelayRequestError(response.status, generation);
  }
  return { generation, snapshot };
}

function isOwnerKind(value: BoundaryValue): value is RelayOwnerKind {
  return value === "user" || value === "organization";
}

function isOrgVault(record: BoundaryValue): record is OrgVaultRecord {
  if (!isJsonObject(record)) return false;
  return (
    isOwnerKind(record.ownerKind) &&
    isString(record.owner) &&
    isString(record.slug)
  );
}

export type OrgVaultDirectory = {
  readonly baseUrl: string;
  readonly relayRegistrationToken?: string;
  readonly fetch?: typeof fetch;
};

/** Create `owner/slug` for a principal. The same principal may repeat it. */
export async function createOrgVault(
  target: OrgVaultDirectory & {
    readonly owner: string;
    readonly slug: string;
    readonly ownerKind: RelayOwnerKind;
    readonly principal: string;
    readonly orgRole?: OrgDirectoryRole;
  },
): Promise<OrgVaultRecord> {
  const fetchImpl = fetchOf(target);
  const headers = new Headers({ "content-type": "application/json" });
  if (!target.relayRegistrationToken) {
    headers.set("x-opensesame-principal", target.principal);
    if (target.orgRole) headers.set("x-opensesame-org-role", target.orgRole);
  }
  applyRegistrationToken(headers, target.relayRegistrationToken);
  const response = await fetchImpl(
    `${originOf(target.baseUrl)}/v1/org-vaults`,
    {
      method: "POST",
      headers: Object.fromEntries(headers.entries()),
      body: JSON.stringify({
        ownerKind: target.ownerKind,
        owner: target.owner,
        slug: target.slug,
      }),
    },
  );
  const body = await readJson(response);
  if (!response.ok) {
    throw new RelayRequestError(response.status, generationOf(body));
  }
  if (!isJsonObject(body)) {
    throw new RelayRequestError(response.status, null);
  }
  if (!isOrgVault(body.vault))
    throw new RelayRequestError(response.status, null);
  return body.vault;
}

/**
 * Vaults for an owner, a principal, or both. An empty filter is an empty list:
 * the relay does not dump every address.
 */
export async function listOrgVaults(
  target: OrgVaultDirectory & {
    readonly owner?: string;
    readonly principal?: string;
    readonly orgRole?: OrgDirectoryRole;
  },
): Promise<readonly OrgVaultRecord[]> {
  const fetchImpl = fetchOf(target);
  const query = new URLSearchParams();
  if (target.owner) query.set("owner", target.owner);
  if (target.principal) query.set("principal", target.principal);
  const headers = new Headers();
  if (!target.relayRegistrationToken && target.orgRole) {
    headers.set("x-opensesame-org-role", target.orgRole);
  }
  applyRegistrationToken(headers, target.relayRegistrationToken);
  const response = await fetchImpl(
    `${originOf(target.baseUrl)}/v1/org-vaults?${query.toString()}`,
    { method: "GET", headers },
  );
  const body = await readJson(response);
  if (!response.ok) {
    throw new RelayRequestError(response.status, generationOf(body));
  }
  if (!isJsonObject(body)) {
    throw new RelayRequestError(response.status, null);
  }
  const vaults = body.vaults;
  if (!Array.isArray(vaults) || !vaults.every(isOrgVault)) {
    throw new RelayRequestError(response.status, null);
  }
  return vaults;
}
