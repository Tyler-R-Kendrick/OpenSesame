/**
 * The wire: an HTTP POST out, an AG-UI event stream back.
 *
 * `@ag-ui/client` is loaded here and only here, through a dynamic import
 * inside the run path. It pulls rxjs, zod, protobufjs and a JSON-patch
 * implementation behind it — megabytes of transitive dependency for a feature
 * most deployments never turn on — so it must not be in the chunk that boots
 * the vault. Nothing in this directory imports it statically, and a test in
 * this directory reads these files to prove it.
 *
 * The port below is what the rest of the adapter sees: a request in, untrusted
 * JSON values out. AG-UI's own types stop at this file, so a test drives the
 * normalizer with plain objects and never loads the library at all.
 */

import { type JsonValue, overlapCast } from "@opensesame/os-domain";
import { SupportError } from "@opensesame/support-agent";
import type { AgUiEndpoint } from "./endpoint.js";
import type { AgUiOutboundBody } from "./outbound.js";

export type AgUiTransportRequest = {
  readonly endpoint: AgUiEndpoint;
  readonly body: AgUiOutboundBody;
  readonly signal: AbortSignal;
};

/**
 * Events exactly as the server sent them: parsed JSON and nothing more. No
 * field has been checked, and none may be believed — the caller re-reads every
 * one through a guard.
 */
export type AgUiTransport = (
  request: AgUiTransportRequest,
) => AsyncIterable<JsonValue>;

export type AgUiEventObserver = {
  next: (event: JsonValue) => void;
  error: (cause: Error) => void;
  complete: () => void;
};

export type AgUiEventSubscription = { unsubscribe: () => void };

export type AgUiEventSource = {
  subscribe: (observer: AgUiEventObserver) => AgUiEventSubscription;
};

/** Deferred: the request is not made until the source is subscribed. */
export type AgUiHttpOpen = () => Promise<Response>;

/** The whole of `@ag-ui/client` this adapter uses, named in our own terms. */
export type AgUiClient = {
  open: (request: AgUiHttpOpen) => AgUiEventSource;
};

export type AgUiClientLoader = () => Promise<AgUiClient>;

export type AgUiFetch = (input: string, init: RequestInit) => Promise<Response>;

export type AgUiTransportOptions = {
  readonly loadClient?: AgUiClientLoader;
  readonly fetchImpl?: AgUiFetch;
};

/**
 * A hostile or broken server can emit faster than this consumer drains. The
 * consumer is a string append, so a backlog this deep is not slowness — it is
 * a flood, and the run ends rather than growing a buffer without a bound.
 */
const MAX_PENDING_EVENTS = 512;

async function loadAgUiClientDefault(): Promise<AgUiClient> {
  const client = await import("@ag-ui/client");
  return {
    open: (request) => {
      const events = client.transformHttpEventStream(
        client.runHttpRequest(request),
      );
      return {
        subscribe: (observer) =>
          events.subscribe({
            next: (event) => {
              // SAFETY: an AG-UI event is JSON parsed off the wire at the
              // boundary below; JsonValue names that already-parsed data, and
              // every field is re-read through a guard before it is used.
              observer.next(overlapCast(event));
            },
            error: (cause: Error) => {
              observer.error(cause);
            },
            complete: () => {
              observer.complete();
            },
          }),
      };
    },
  };
}

/**
 * One POST, with everything ambient switched off: no cookies, no referrer, no
 * cache entry, and no redirect. A redirect is the interesting one — following
 * it would replay this body at a host the endpoint check never saw.
 */
async function sendSupportRequest(
  request: AgUiTransportRequest,
  fetchImpl: AgUiFetch,
): Promise<Response> {
  const response = await fetchImpl(request.endpoint.url, {
    method: "POST",
    headers: Object.fromEntries(request.endpoint.headers),
    body: JSON.stringify(request.body),
    signal: request.signal,
    credentials: "omit",
    mode: "cors",
    cache: "no-store",
    redirect: "error",
    referrerPolicy: "no-referrer",
  });
  if (!response.ok) {
    throw new SupportError(
      "AGENT_PROTOCOL_ERROR",
      `the support endpoint answered ${response.status}`,
    );
  }
  return response;
}

type PumpState = {
  done: boolean;
  overflowed: boolean;
  failure: Error | null;
};

/**
 * Turn a push stream into a pull one, with a bounded buffer and an abort that
 * actually reaches the subscription.
 */
async function* pump(
  source: AgUiEventSource,
  signal: AbortSignal,
): AsyncGenerator<JsonValue> {
  const queue: JsonValue[] = [];
  const state: PumpState = { done: false, overflowed: false, failure: null };
  let resume: (() => void) | null = null;
  const notify = (): void => {
    const waiting = resume;
    resume = null;
    waiting?.();
  };
  const subscription = source.subscribe({
    next: (event) => {
      if (state.done) return;
      if (queue.length >= MAX_PENDING_EVENTS) {
        state.overflowed = true;
        state.done = true;
      } else {
        queue.push(event);
      }
      notify();
    },
    error: (cause) => {
      state.failure = cause;
      state.done = true;
      notify();
    },
    complete: () => {
      state.done = true;
      notify();
    },
  });
  const onAbort = (): void => {
    state.done = true;
    notify();
  };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    for (;;) {
      if (signal.aborted) return;
      const event = queue.shift();
      if (event !== undefined) {
        yield event;
        continue;
      }
      if (state.failure !== null) throw state.failure;
      if (state.overflowed) {
        throw new SupportError(
          "AGENT_PROTOCOL_ERROR",
          "the support endpoint streamed more events than this client will buffer",
        );
      }
      if (state.done) return;
      await new Promise<void>((settle) => {
        resume = settle;
      });
    }
  } finally {
    state.done = true;
    signal.removeEventListener("abort", onAbort);
    subscription.unsubscribe();
  }
}

async function* runAgUiTransport(
  request: AgUiTransportRequest,
  loadClient: AgUiClientLoader,
  fetchImpl: AgUiFetch,
): AsyncGenerator<JsonValue> {
  const client = await loadClient();
  if (request.signal.aborted) return;
  const source = client.open(() => sendSupportRequest(request, fetchImpl));
  yield* pump(source, request.signal);
}

/** The default transport: lazy `@ag-ui/client`, real `fetch`, no credentials. */
export function createAgUiTransport(
  options: AgUiTransportOptions = {},
): AgUiTransport {
  const loadClient = options.loadClient ?? loadAgUiClientDefault;
  const fetchImpl =
    options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  return (request) => runAgUiTransport(request, loadClient, fetchImpl);
}
