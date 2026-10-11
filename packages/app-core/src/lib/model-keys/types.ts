/**
 * The shapes the broker keeps and the ports it is given (ADR 0190).
 *
 * The broker is pure: time, randomness, hashing, the catalog and the saved
 * connections come in as ports, and what it writes goes out as audit events.
 * That is what lets a test drive it with a fixed clock and a refusing
 * connection, and what lets another plane replay the same vectors.
 */
import type { AuthorityGrant } from "@opensesame/os-domain";
import type { CallProtocol } from "./protocols.js";
import type { Consumable } from "./vocabulary.js";

/** Where a resource indicator points: the provider a catalog row names. */
export type ProviderTarget = Readonly<{
  providerId: string;
  protocol: CallProtocol;
  /** Canonical, and the audience a key for this provider carries. */
  baseUrl: string;
}>;

export type ConnectionFacts = Readonly<{
  connectionId: string;
  providerId: string;
  /** Only a verified connection can back a key. */
  verified: boolean;
}>;

export type ModelKeyEvent = Readonly<{
  type:
    | "root.issued"
    | "exchange.issued"
    | "exchange.refused"
    | "call.authorized"
    | "call.refused"
    | "call.settled"
    | "key.revoked";
  at: number;
  /** The key concerned, when one was identified; never the token. */
  keyId?: string;
  parentId?: string;
  clientId?: string;
  providerId?: string;
  /** The stable refusal reason, value-blind. */
  reason?: string;
  model?: string;
}>;

export type BrokerPorts = Readonly<{
  now: () => number;
  /** A fresh random string of `bytes` bytes, base64url. */
  random: (bytes: number) => string;
  sha256: (text: string) => Promise<string>;
  providerForResource: (resource: string) => ProviderTarget | null;
  connection: (connectionId: string) => ConnectionFacts | null;
  audit: (event: ModelKeyEvent) => void;
}>;

export type BrokerPolicy = Readonly<{
  /** `dpop_required` keys are bound to a key at issue; the default. */
  senderConstraint: "dpop_required" | "dpop_optional";
  rootMaxLifetimeSeconds: number;
  maxLifetimeSeconds: number;
  defaultLifetimeSeconds: number;
  maxDelegationDepth: number;
  /** The largest `max_output_tokens` any key may carry. */
  outputTokenCeiling: number;
}>;

export const DEFAULT_POLICY: BrokerPolicy = {
  senderConstraint: "dpop_required",
  rootMaxLifetimeSeconds: 8 * 60 * 60,
  maxLifetimeSeconds: 60 * 60,
  defaultLifetimeSeconds: 15 * 60,
  maxDelegationDepth: 2,
  outputTokenCeiling: 32_768,
};

export type Allocation = Readonly<Record<Consumable, number>>;

/** One link of the RFC 8693 `act` chain: who acted, newest first. */
export type Actor = Readonly<{
  clientId: string;
  keyThumbprint: string | null;
}>;

export type KeyRecord = {
  readonly id: string;
  readonly digest: string;
  readonly grant: AuthorityGrant;
  readonly provider: ProviderTarget;
  readonly rootId: string;
  readonly actors: readonly Actor[];
  /** Unspent consumables. A child's allocation is carved out of its parent's. */
  remaining: Record<Consumable, number>;
  inflight: number;
  revokedAt: number | null;
  /** True once its unspent allocation went back to its parent. */
  returned: boolean;
};

export type KeyView = Readonly<{
  id: string;
  parentId: string | null;
  clientId: string;
  providerId: string;
  connectionId: string;
  actions: readonly string[];
  models: readonly string[];
  remaining: Allocation;
  maxOutputTokens: number;
  depth: number;
  bound: boolean;
  expiresAt: number;
  status: "active" | "expired" | "revoked";
}>;
