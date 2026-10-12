/** What every operation of the broker shares: the ledger, the proof cache, the ports and the policy. */
import type { BoundaryValue } from "@opensesame/os-domain";
import { ProofReplayCache } from "./dpop.js";
import { type ModelKeyRefusal, isRefusal } from "./errors.js";
import { KeyLedger } from "./ledger.js";
import type {
  BrokerPolicy,
  BrokerPorts,
  KeyRecord,
  ModelKeyEvent,
} from "./types.js";
import { KEY_PATTERN, KEY_PREFIX } from "./vocabulary.js";

export type Reservation = {
  readonly id: string;
  readonly keyId: string;
  readonly requests: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  settled: boolean;
};

export type BrokerCore = Readonly<{
  ledger: KeyLedger;
  replay: ProofReplayCache;
  ports: BrokerPorts;
  policy: BrokerPolicy;
  reservations: Map<string, Reservation>;
}>;

export function newCore(ports: BrokerPorts, policy: BrokerPolicy): BrokerCore {
  return {
    ledger: new KeyLedger(),
    replay: new ProofReplayCache(),
    ports,
    policy,
    reservations: new Map(),
  };
}

export function emit(
  core: BrokerCore,
  event: Omit<ModelKeyEvent, "at">,
  at: number,
): void {
  try {
    core.ports.audit({ ...event, at });
  } catch {
    // An audit sink that throws must not turn a refusal into a success or an
    // outage into a leak: the decision has been made, and is not the sink's.
  }
}

/** A fresh key and the digest it is found by; the key is returned once and not kept. */
export async function mintKey(core: BrokerCore) {
  const token = `${KEY_PREFIX}${core.ports.random(32)}`;
  if (!KEY_PATTERN.test(token))
    throw new Error("the random port returned a malformed key");
  return { token, digest: await core.ports.sha256(token) };
}

export function newId(core: BrokerCore): string {
  return `mk_${core.ports.random(12)}`;
}

/** What an audit line says about a refusal: the reason, and who and what it concerned. */
export function refusalEvent(
  type: "exchange.refused" | "call.refused",
  error: ModelKeyRefusal,
  record: KeyRecord | null,
  clientId: string | undefined,
): Omit<ModelKeyEvent, "at"> {
  let event: Omit<ModelKeyEvent, "at"> = { type, reason: error.reason };
  if (record)
    event = {
      ...event,
      keyId: record.id,
      providerId: record.provider.providerId,
    };
  if (clientId) event = { ...event, clientId };
  return event;
}

export function asRefusal(error: BoundaryValue): ModelKeyRefusal | null {
  return isRefusal(error) ? error : null;
}
