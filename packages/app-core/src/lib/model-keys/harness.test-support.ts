/**
 * A broker with a fixed clock, a catalog of three protocols, saved connections
 * that can be broken, and a signer that can make proofs good and bad. The
 * tests drive the real broker, the real prover and the real `jose`; only time,
 * the catalog and the connections are stood in for.
 *
 * The parts are built in `harness.helpers.test-support.ts`; everything a test
 * may import from the harness is exported from here.
 */
import { type BoundaryValue, overlapCast } from "@opensesame/os-domain";
import { ModelKeyRefusal } from "./errors.js";
import {
  brokerRig,
  caller,
  chat,
  exchangeParams,
  exchanger,
  rootIssuer,
} from "./harness.helpers.test-support.js";
import type { BrokerPolicy } from "./types.js";

export {
  ANTHROPIC,
  ENDPOINT,
  GEMINI,
  OPENAI,
  OPENROUTER,
  T0,
  baseDraft,
  makeProof,
  newSigner,
} from "./harness.helpers.test-support.js";
export type {
  Bindable,
  CallRequest,
  ExchangeOptions,
  Gate,
  ProofOptions,
  Signer,
} from "./harness.helpers.test-support.js";

export function harness(policy: Partial<BrokerPolicy> = {}) {
  const rig = brokerRig(policy);
  return {
    ...rig,
    root: rootIssuer(rig.broker, rig.clock),
    exchange: exchanger(rig.broker, rig.clock),
    call: caller(rig.broker, rig.clock),
    params: exchangeParams,
    chat,
  };
}

export const FULL_BUDGET = {
  requests: 10,
  input_tokens: 10_000,
  output_tokens: 5_000,
  max_output_tokens: 1024,
};

/** Assert that `work` was refused with exactly this wire error and audit reason. */
export async function expectRefused<T>(
  work: Promise<T> | (() => T | PromiseLike<T>),
  error: string,
  reason: string,
): Promise<void> {
  const { expect } = await import("vitest");
  let caught: BoundaryValue = null;
  try {
    await (work instanceof Function ? work() : work);
  } catch (thrown) {
    // A caught value is anything at all; the instanceof checks below are the test.
    caught = overlapCast(thrown);
  }
  expect(caught, `expected a refusal ${error}/${reason}`).toBeInstanceOf(
    ModelKeyRefusal,
  );
  if (caught instanceof ModelKeyRefusal) {
    expect({ error: caught.error, reason: caught.reason }).toEqual({
      error,
      reason,
    });
  }
}

/**
 * What a caller is shown when `work` is refused (RFC 6749 §5.2), or null when it
 * was not. Anything thrown that is not a refusal is rethrown: it fails the test.
 */
export async function wireOf<T>(work: Promise<T>) {
  try {
    await work;
    return null;
  } catch (thrown) {
    if (thrown instanceof ModelKeyRefusal) return thrown.toWire();
    throw thrown;
  }
}
