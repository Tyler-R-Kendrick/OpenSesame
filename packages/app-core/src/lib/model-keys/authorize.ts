/**
 * The last hop: may this call go out on this key? (ADR 0192 §5)
 *
 * Everything the key was narrowed to is enforced here, once, on the call as it
 * will be sent. The caller never supplies a host, a header or a credential:
 * `authorize` answers with the URL, the method and the body to send, and the
 * connection whose credential the executor will put on it. A key that is
 * unknown, ended, someone else's or for another resource is one answer
 * (`invalid_token`) however it failed.
 *
 * The order is deliberate. What the call *is* (a route and a body) is read
 * before anything about the grant is consulted, and proof of possession comes
 * before the grant's policy, so a thief who holds only a key can learn nothing
 * about what it would allow, only that it is not theirs to use.
 */
import {
  type BoundaryValue,
  isString,
  overlapCast,
  parseResourceScope,
  scopeMatches,
} from "@opensesame/os-domain";
import {
  type BrokerCore,
  type Reservation,
  asRefusal,
  emit,
  refusalEvent,
} from "./core.js";
import { verifyDpopProof } from "./dpop.js";
import { refuse } from "./errors.js";
import {
  type CallOperation,
  type CallProtocol,
  type InspectedCall,
  inspectCall,
  reportedUsage,
} from "./protocols.js";
import { canonicalResource } from "./resource.js";
import type { KeyRecord, ModelKeyEvent } from "./types.js";
import { CAP_OUTPUT_TOKENS, KEY_PATTERN, LIMITS } from "./vocabulary.js";

export type PresentedKey = Readonly<{
  token: string;
  /** The `DPoP` proof for this call, when the key is bound to a key. */
  dpopProof?: string;
  /** The client the channel authenticated. */
  clientId: string;
}>;

export type ModelCall = Readonly<{
  operation: CallOperation;
  /** The resource the key is being used on: the provider's canonical base URL. */
  resource: string;
  method: string;
  /** A route relative to the provider's base URL, such as `/chat/completions`. */
  path: string;
  body?: BoundaryValue;
}>;

export type AuthorizedCall = Readonly<{
  keyId: string;
  providerId: string;
  protocol: CallProtocol;
  connectionId: string;
  url: string;
  method: "GET" | "POST";
  /** What to send: the body that was inspected, never a second reading of the caller's. */
  body: InspectedCall["body"];
  model: string | null;
  outputTokens: number | null;
  reservation: Reservation;
}>;

export type CallOutcome = Readonly<{
  /** Did the request leave? A call that never went out costs nothing. */
  sent: boolean;
  /** What the provider answered, for its own usage report. */
  answer?: BoundaryValue;
}>;

function liveRecord(core: BrokerCore, digest: string, now: number): KeyRecord {
  const record = core.ledger.findByDigest(digest);
  if (!record || !core.ledger.isActive(record, now))
    return refuse("invalid_token", "key.inactive");
  return record;
}

function modelAllowed(record: KeyRecord, model: string): boolean {
  const resource = `model:${record.provider.providerId}/${model}`;
  return record.grant.resources.some((selector) =>
    scopeMatches(parseResourceScope(selector), resource),
  );
}

function policyAllows(
  core: BrokerCore,
  record: KeyRecord,
  call: ModelCall,
  inspected: InspectedCall,
): void {
  const connection = core.ports.connection(record.grant.connectionId ?? "");
  if (
    !connection ||
    !connection.verified ||
    connection.providerId !== record.provider.providerId
  )
    refuse("invalid_token", "connection.unavailable");
  if (
    canonicalResource(call.resource) !== record.grant.constraints.audiences[0]
  )
    refuse("invalid_token", "aud.mismatch");
  if (!record.grant.actions.includes(inspected.action))
    refuse("insufficient_scope", "escalation.action");
  if (inspected.model !== null && !modelAllowed(record, inspected.model))
    refuse("insufficient_scope", "escalation.model");
  const cap = record.grant.constraints.budgets[CAP_OUTPUT_TOKENS] ?? 0;
  if (inspected.outputTokens !== null && inspected.outputTokens > cap)
    refuse("insufficient_scope", "escalation.tokens");
}

/** Take what the call may cost out of the key's budget, all or nothing. */
function reserve(
  core: BrokerCore,
  record: KeyRecord,
  inspected: InspectedCall,
): Reservation {
  const input = inspected.inputEstimate;
  const output = inspected.outputTokens ?? 0;
  if (record.inflight >= LIMITS.maxInFlightPerKey)
    refuse("insufficient_scope", "inflight.limit");
  const { remaining } = record;
  if (
    remaining.requests < 1 ||
    remaining.input_tokens < input ||
    remaining.output_tokens < output
  )
    refuse("insufficient_scope", "budget.exhausted");
  remaining.requests -= 1;
  remaining.input_tokens -= input;
  remaining.output_tokens -= output;
  record.inflight += 1;
  const reservation: Reservation = {
    id: core.ports.random(12),
    keyId: record.id,
    requests: 1,
    inputTokens: input,
    outputTokens: output,
    settled: false,
  };
  core.reservations.set(reservation.id, reservation);
  return reservation;
}

export async function authorizeCall(
  core: BrokerCore,
  presented: PresentedKey,
  call: ModelCall,
): Promise<AuthorizedCall> {
  const now = core.ledger.clock(core.ports.now());
  let record: KeyRecord | null = null;
  try {
    if (!isString(presented.token) || !KEY_PATTERN.test(presented.token))
      return refuse("invalid_token", "key.shape");
    const digest = await core.ports.sha256(presented.token);
    record = liveRecord(core, digest, now);
    if (record.grant.clientId !== presented.clientId)
      return refuse("invalid_token", "key.foreign_client");
    const inspected = inspectCall({
      protocol: record.provider.protocol,
      baseUrl: record.provider.baseUrl,
      operation: call.operation,
      method: call.method,
      path: call.path,
      body: call.body,
    });
    const bound = record.grant.proofKeyThumbprint;
    if (bound !== null) {
      if (presented.dpopProof === undefined)
        return refuse("invalid_dpop_proof", "dpop.required");
      await verifyDpopProof({
        proof: presented.dpopProof,
        method: inspected.method,
        url: inspected.url,
        token: presented.token,
        now,
        expectedJkt: bound,
        replay: core.replay,
      });
    }
    // The proof was awaited: look again before spending anything.
    const at = core.ledger.clock(core.ports.now());
    record = liveRecord(core, digest, at);
    core.ledger.reclaim(at);
    policyAllows(core, record, call, inspected);
    const reservation = reserve(core, record, inspected);
    let event: Omit<ModelKeyEvent, "at"> = {
      type: "call.authorized",
      keyId: record.id,
      clientId: presented.clientId,
      providerId: record.provider.providerId,
    };
    if (inspected.model) event = { ...event, model: inspected.model };
    emit(core, event, at);
    return {
      keyId: record.id,
      providerId: record.provider.providerId,
      protocol: record.provider.protocol,
      connectionId: record.grant.connectionId ?? "",
      url: inspected.url,
      method: inspected.method,
      body: inspected.body,
      model: inspected.model,
      outputTokens: inspected.outputTokens,
      reservation,
    };
  } catch (error) {
    // A caught value is anything at all; `asRefusal` is the check.
    const refusal = asRefusal(overlapCast(error));
    if (refusal)
      emit(
        core,
        refusalEvent("call.refused", refusal, record, presented.clientId),
        now,
      );
    throw error;
  }
}

type Spent = Readonly<{ input: number; output: number }>;

/** What a call used: nothing if it never left, else the provider's own report or what was held. */
function spentTokens(
  record: KeyRecord,
  held: Reservation,
  outcome: CallOutcome,
): Spent {
  if (!outcome.sent) return { input: 0, output: 0 };
  const usage = reportedUsage(record.provider.protocol, outcome.answer);
  return {
    input: usage?.input ?? held.inputTokens,
    output: usage?.output ?? held.outputTokens,
  };
}

/** Funds go back to the key, or to its parent when the key ended meanwhile. */
function refundTarget(core: BrokerCore, record: KeyRecord): KeyRecord | null {
  return record.returned && record.grant.parentGrantId
    ? core.ledger.find(record.grant.parentGrantId)
    : record;
}

/** Give back what was held and not spent; the request itself only if the call never left. */
function refund(
  target: KeyRecord,
  held: Reservation,
  sent: boolean,
  spent: Spent,
): void {
  target.remaining.requests += sent ? 0 : held.requests;
  target.remaining.input_tokens = Math.max(
    0,
    target.remaining.input_tokens + held.inputTokens - spent.input,
  );
  target.remaining.output_tokens = Math.max(
    0,
    target.remaining.output_tokens + held.outputTokens - spent.output,
  );
}

/**
 * Close a reservation: refund what the call did not use, charge what it used
 * beyond what was reserved (never below zero), and give a call that never left
 * its request back. Settling twice does nothing the second time.
 */
export function settleCall(
  core: BrokerCore,
  reservation: Reservation,
  outcome: CallOutcome,
): void {
  const held = core.reservations.get(reservation.id);
  if (!held || held.settled) return;
  held.settled = true;
  core.reservations.delete(held.id);
  const now = core.ledger.clock(core.ports.now());
  const record = core.ledger.find(held.keyId);
  if (!record) return;
  record.inflight = Math.max(0, record.inflight - 1);
  const spent = spentTokens(record, held, outcome);
  const target = refundTarget(core, record);
  if (target && !target.returned) refund(target, held, outcome.sent, spent);
  emit(
    core,
    {
      type: "call.settled",
      keyId: record.id,
      providerId: record.provider.providerId,
    },
    now,
  );
}
