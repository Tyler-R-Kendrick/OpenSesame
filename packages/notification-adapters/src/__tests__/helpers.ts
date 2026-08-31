/**
 * Test seams. No network, no credentials, no module mocking.
 *
 * Every adapter takes its `fetch` as configuration, so a suite that wants to
 * see what would have gone over the wire records it here instead of
 * intercepting anything. The recorder also proves a negative that matters
 * more than once below: that an unconfigured adapter made no call at all.
 */

import type { FetchLike, RenderInput } from "../contract.js";

export interface RecordedRequest {
  url: string;
  method: string;
  headers: Readonly<Record<string, string>>;
  body: string;
  bodyBytes: Uint8Array;
}

export interface FetchRecorder {
  calls: RecordedRequest[];
  impl: FetchLike;
}

function headerRecord(init: RequestInit | undefined) {
  // `Headers` already normalizes names to lower case, which is the same
  // normalization every verifier in this package assumes of its caller.
  const entries: [string, string][] = [];
  new Headers(init?.headers).forEach((value, key) => {
    entries.push([key, value]);
  });
  return Object.fromEntries(entries);
}

function bodyBytes(init: RequestInit | undefined): Uint8Array {
  const body = init?.body;
  if (!body) return new Uint8Array();
  if (body instanceof Uint8Array) return body;
  return new TextEncoder().encode(String(body));
}

/** Record every call and answer with whatever `respond` returns. */
export function recordFetch(
  respond: (call: RecordedRequest) => Response,
): FetchRecorder {
  const calls: RecordedRequest[] = [];
  const impl: FetchLike = async (input, init) => {
    const bytes = bodyBytes(init);
    const call: RecordedRequest = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: headerRecord(init),
      body: new TextDecoder().decode(bytes),
      bodyBytes: bytes,
    };
    calls.push(call);
    return respond(call);
  };
  return { calls, impl };
}

/** A recorder that answers every call with the given JSON and status. */
export function jsonFetch(payload: string, status = 200): FetchRecorder {
  return recordFetch(
    () =>
      new Response(payload, {
        status,
        headers: { "content-type": "application/json" },
      }),
  );
}

/** A recorder that fails the way a dead socket does. */
export function throwingFetch(): FetchRecorder {
  const calls: RecordedRequest[] = [];
  const impl: FetchLike = async (input, init) => {
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: headerRecord(init),
      body: "",
      bodyBytes: new Uint8Array(),
    });
    throw new TypeError("fetch failed");
  };
  return { calls, impl };
}

export const FIXED_NOW = new Date("2026-08-31T12:00:00.000Z");

/**
 * A representative render input. Every optional string is present and every
 * one of them is hostile, so a test that forgets to sanitize fails loudly.
 */
export function renderInput(overrides: Partial<RenderInput> = {}): RenderInput {
  const base: RenderInput = {
    kind: "slack",
    confidentiality: "descriptive",
    notificationClass: "authorization_request",
    eventType: "authority.invocation.requested",
    rendezvousRef: "rz-QHXT-KPLM",
    rendezvousUrl: "https://os.example/approve/rz-QHXT-KPLM",
    bindingMessage: "Transfer funds to account ending 4417",
    actionLabel: "payment.initiate",
  };
  return { ...base, ...overrides };
}

/**
 * A tiny deterministic generator for the fuzz sweeps.
 *
 * Seeded rather than random: a verifier that throws on one input in a
 * thousand must fail the same way on every machine and in every rerun, or
 * the failure gets closed as flaky.
 */
export function seededBytes(seed: number, length: number): Uint8Array {
  const out = new Uint8Array(length);
  let state = seed >>> 0;
  for (let index = 0; index < length; index += 1) {
    // Numerical Recipes' LCG constants; the quality bar here is "varied",
    // not "unpredictable".
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    out[index] = (state >>> 16) & 0xff;
  }
  return out;
}
