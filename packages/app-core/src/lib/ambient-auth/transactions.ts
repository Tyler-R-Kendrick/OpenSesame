/**
 * Versioned OIDC transaction records with claim/consume ownership.
 *
 * Indexed by unguessable state. Legacy single-slot PKCE records without
 * timestamps or intent cannot be used as ambient authentication.
 */

import {
  type BoundaryValue,
  type JsonObject,
  isJsonObject,
  isNumber,
  isString,
  overlapCast,
} from "@opensesame/os-domain";
import type { AuthenticationIntent } from "./types.js";
import { AUTHENTICATION_INTENT_KINDS } from "./types.js";
import type { AmbientTransport } from "./types.js";
import type { ProviderConnectionKey } from "./types.js";

export const TX_SCHEMA = 1 as const;
export const TX_STORE_KEY = "opensesame:ambient-auth:tx";
export const TX_MAX_AGE_MS = 10 * 60 * 1000;
export const TX_MAX_RECORDS = 8;
const LEGACY_PKCE_KEY = "opensesame:federation:pkce";

export type TransactionStatus =
  | "pending"
  | "claimed"
  | "consumed"
  | "cancelled"
  | "expired";

export type FederationTransaction = {
  schemaVersion: typeof TX_SCHEMA;
  transactionId: string;
  state: string;
  nonce: string;
  verifier: string;
  createdAt: number;
  expiresAt: number;
  issuer: string;
  clientId: string;
  redirectUri: string;
  tokenEndpoint: string;
  jwksUri: string;
  intent: AuthenticationIntent;
  policyRevision: string;
  generation: number;
  providerKey: ProviderConnectionKey;
  organizationBinding?: string;
  expectedAccountKey?: string;
  transport: AmbientTransport;
  returnRoute?: string;
  status: TransactionStatus;
  claimOwner?: string;
};

export type TransactionStore = {
  get(state: string): FederationTransaction | null;
  put(record: FederationTransaction): void;
  delete(state: string): void;
  list(): FederationTransaction[];
};

function memoryStore(
  seed: Map<string, FederationTransaction> = new Map(),
): TransactionStore {
  const map = seed;
  return {
    get: (state) => map.get(state) ?? null,
    put: (record) => {
      map.set(record.state, record);
    },
    delete: (state) => {
      map.delete(state);
    },
    list: () => [...map.values()],
  };
}

function readAll(): Map<string, FederationTransaction> {
  try {
    const raw = globalThis.localStorage?.getItem(TX_STORE_KEY);
    if (!raw) return new Map();
    const parsed: BoundaryValue = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Map();
    const map = new Map<string, FederationTransaction>();
    for (const entry of parsed) {
      const record = asTransaction(entry);
      if (record) map.set(record.state, record);
    }
    return map;
  } catch {
    return new Map();
  }
}

function writeAll(map: Map<string, FederationTransaction>): void {
  const records = [...map.values()]
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, TX_MAX_RECORDS);
  try {
    // ast-grep-ignore: ts-localstorage-set
    globalThis.localStorage?.setItem(TX_STORE_KEY, JSON.stringify(records));
  } catch {
    /* quota / private mode */
  }
}

export const localTransactionStore: TransactionStore = {
  get(state) {
    return readAll().get(state) ?? null;
  },
  put(record) {
    const map = readAll();
    map.set(record.state, record);
    writeAll(map);
  },
  delete(state) {
    const map = readAll();
    map.delete(state);
    writeAll(map);
  },
  list() {
    return [...readAll().values()];
  },
};

let activeStore: TransactionStore = localTransactionStore;

export function useTransactionStore(store: TransactionStore): TransactionStore {
  const previous = activeStore;
  activeStore = store;
  return previous;
}

export function resetTransactionStore(): void {
  activeStore = localTransactionStore;
}

export function createMemoryTransactionStore(): TransactionStore {
  return memoryStore();
}

function asIntent(value: BoundaryValue): AuthenticationIntent | null {
  if (!isJsonObject(value) || !isString(value.kind)) return null;
  if (
    // SAFETY: test/fixture or boundary-checked value matches readonly string[]).includes(value.kind).
    !(AUTHENTICATION_INTENT_KINDS as readonly string[]).includes(value.kind)
  ) {
    return null;
  }
  // SAFETY: test/fixture or boundary-checked value matches AuthenticationIntent.
  return value as AuthenticationIntent;
}

function hasTxStrings(raw: JsonObject): boolean {
  return (
    isString(raw.transactionId) &&
    isString(raw.state) &&
    isString(raw.nonce) &&
    isString(raw.verifier) &&
    isString(raw.issuer) &&
    isString(raw.clientId) &&
    isString(raw.redirectUri) &&
    isString(raw.tokenEndpoint) &&
    isString(raw.jwksUri) &&
    isString(raw.policyRevision) &&
    isString(raw.providerKey) &&
    isString(raw.transport) &&
    isString(raw.status)
  );
}

export function asTransaction(
  value: BoundaryValue,
): FederationTransaction | null {
  const raw: BoundaryValue = overlapCast(value);
  if (!isJsonObject(raw) || raw.schemaVersion !== 1) return null;
  if (!hasTxStrings(raw)) return null;
  if (
    !isNumber(raw.createdAt) ||
    !isNumber(raw.expiresAt) ||
    !isNumber(raw.generation)
  ) {
    return null;
  }
  const intent = asIntent(overlapCast(raw.intent));
  const nonce = raw.nonce;
  if (!intent || !isString(nonce) || nonce.length < 16) return null;
  // SAFETY: test/fixture or boundary-checked value matches FederationTransaction.
  return raw as FederationTransaction;
}

export function createTransaction(
  input: Omit<FederationTransaction, "schemaVersion" | "status">,
): FederationTransaction {
  return {
    schemaVersion: 1,
    status: "pending",
    ...input,
  };
}

export function persistTransaction(record: FederationTransaction): void {
  pruneExpired(Date.now());
  activeStore.put(record);
}

export function lookupTransaction(state: string): FederationTransaction | null {
  if (!state) return null;
  const record = activeStore.get(state);
  if (!record) return null;
  if (record.expiresAt <= Date.now() || record.status === "expired") {
    return { ...record, status: "expired" };
  }
  return record;
}

export function claimTransaction(
  state: string,
  owner: string,
  now = Date.now(),
): FederationTransaction | null {
  const record = lookupTransaction(state);
  if (!record || record.status === "expired") return null;
  if (record.status === "consumed" || record.status === "cancelled")
    return null;
  if (record.status === "claimed" && record.claimOwner !== owner) return null;
  const claimed: FederationTransaction = {
    ...record,
    status: "claimed",
    claimOwner: owner,
  };
  if (claimed.expiresAt <= now) return null;
  activeStore.put(claimed);
  return claimed;
}

export function consumeTransaction(state: string, owner: string): boolean {
  const record = activeStore.get(state);
  if (!record) return false;
  if (record.status === "claimed" && record.claimOwner !== owner) return false;
  if (record.status === "consumed" || record.status === "cancelled")
    return false;
  activeStore.put({ ...record, status: "consumed", claimOwner: owner });
  return true;
}

export function cancelTransaction(state: string): void {
  const record = activeStore.get(state);
  if (!record) return;
  if (record.status === "consumed") return;
  activeStore.put({ ...record, status: "cancelled" });
}

export function cancelAllTransactions(): void {
  for (const record of activeStore.list()) {
    if (record.status === "pending" || record.status === "claimed") {
      activeStore.put({ ...record, status: "cancelled" });
    }
  }
}

export function pruneExpired(now: number): void {
  for (const record of activeStore.list()) {
    if (record.expiresAt <= now && record.status !== "consumed") {
      activeStore.delete(record.state);
    }
  }
}

export type LegacyPending = {
  state: string;
  createdAt?: number;
  intentMissing: boolean;
};

export function inspectLegacyPending(): LegacyPending | null {
  try {
    const raw =
      globalThis.localStorage?.getItem(LEGACY_PKCE_KEY) ??
      globalThis.sessionStorage?.getItem(LEGACY_PKCE_KEY);
    if (!raw) return null;
    const parsed: BoundaryValue = overlapCast(JSON.parse(raw));
    if (!isJsonObject(parsed) || !isString(parsed.state)) return null;
    return {
      state: parsed.state,
      createdAt: isNumber(parsed.createdAt) ? parsed.createdAt : undefined,
      intentMissing: parsed.intent === undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Legacy single-slot records cannot become ambient intent. They may still
 * complete an explicit sign-in when timestamps exist and state matches.
 */
export function legacyPendingUsableForAmbient(): false {
  return false;
}

export async function withTransactionLock<T>(
  name: string,
  run: () => Promise<T> | T,
): Promise<T> {
  const locks = globalThis.navigator?.locks;
  if (!locks?.request) return await run();
  return await locks.request(name, { mode: "exclusive" }, async () => run());
}
