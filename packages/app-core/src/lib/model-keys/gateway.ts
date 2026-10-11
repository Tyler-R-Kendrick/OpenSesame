/**
 * Spend a model key (ADR 0188 §5–§6): authorize, send through the connection's
 * own authority, settle.
 *
 * The caller names a key, a route relative to the provider and a body. It never
 * names a host, a header or a credential: the broker answers with the URL and
 * the body to send and the connection whose credential the authority attaches,
 * and the authority re-checks the host against the connection's own egress.
 * Whatever happens after the broker said yes, the reservation is settled
 * exactly once, so a failed call neither leaks an in-flight slot nor goes free.
 */
import { type BoundaryValue, overlapCast } from "@opensesame/os-domain";
import {
  type HostedModelFence,
  type HostedModelOperation,
  hostedModelAuthority,
} from "../hosted-model-authority.js";
import { activeModelKeyBroker } from "./active.js";
import type { ModelCall, PresentedKey } from "./authorize.js";
import { refuse } from "./errors.js";
import type { CallProtocol } from "./protocols.js";

export type ModelKeyResult = Readonly<{
  providerId: string;
  model: string | null;
  /** What the provider answered, exactly as it came back. */
  answer: BoundaryValue;
}>;

/** Headers a protocol needs that the credential header does not cover. */
const PROTOCOL_HEADERS = {
  openai_chat: {},
  anthropic_messages: {
    "anthropic-version": "2023-06-01",
    "anthropic-dangerous-direct-browser-access": "true",
  },
  gemini_generate_content: {},
} as const satisfies Readonly<
  Record<CallProtocol, Readonly<Record<string, string>>>
>;

export async function invokeWithModelKey(
  presented: PresentedKey,
  call: ModelCall,
  fence: HostedModelFence,
): Promise<ModelKeyResult> {
  const broker = activeModelKeyBroker();
  if (!broker) return refuse("access_denied", "broker.unavailable");
  const authority = hostedModelAuthority();
  if (!authority) return refuse("access_denied", "authority.unavailable");
  const authorized = await broker.authorize(presented, call);
  let sent = false;
  let received: { answer: BoundaryValue } | null = null;
  try {
    fence.signal.throwIfAborted();
    fence.assertCurrent();
    const target = new URL(authorized.url);
    const definition: HostedModelOperation = {
      providerId: authorized.providerId,
      operationId: call.operation === "list" ? "model.list" : "model.inference",
      method: authorized.method,
      origin: target.origin,
      path: target.pathname,
      headers: { ...PROTOCOL_HEADERS[authorized.protocol] },
    };
    sent = true;
    received = {
      answer: await authority.execute(
        authorized.connectionId,
        definition,
        authorized.body === null ? null : overlapCast(authorized.body),
        (body) => body,
        fence,
      ),
    };
  } finally {
    // Stopped before anything left means nothing was spent; after that the worst case stands.
    broker.settle(
      authorized.reservation,
      received ? { sent, answer: received.answer } : { sent },
    );
  }
  return {
    providerId: authorized.providerId,
    model: authorized.model,
    answer: received.answer,
  };
}
