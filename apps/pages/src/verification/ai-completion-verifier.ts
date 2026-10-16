import {
  type AiCompletionObservation,
  aiCompletionSeams,
} from "@opensesame/app-core/lib/ai-completion-observation.js";

type Owner = Extract<AiCompletionObservation, { phase: "operation" }>["owner"];
type SignalFact = {
  id: number;
  abortedAt: number | null;
  users: number;
  dispose?: () => void;
};
type Link = { http: SignalFact; fetch: SignalFact; used: boolean };
type OwnerFact = {
  id: number;
  operationAt: number | null;
  requests: RequestFact[];
};
type RequestFact = {
  id: number;
  owner: number;
  exchange: string | null;
  requestAt: number;
  bodyAt: number | null;
  operationAt: number | null;
  bytes: number | null;
  format: "json" | "sse" | null;
  httpSignal: number;
  fetchSignal: number | null;
  transportLive: boolean;
  signalsLiveThroughOperation: boolean | null;
  link: Link | null;
};

const limit = 512;
const epoch = crypto.randomUUID();
const responses = new WeakMap<Response, RequestFact>();
const owners = new WeakMap<Owner, OwnerFact>();
const signals = new WeakMap<AbortSignal, SignalFact>();
const links = new WeakMap<AbortSignal, Link>();
const requests: RequestFact[] = [];
const signalFacts: SignalFact[] = [];
const faults = new Set<string>();
let sequence = 0;
let ownerCount = 0;
let linkCount = 0;

function fault(code: string): void {
  if (faults.size < 16) faults.add(code);
}

function retainSignal(signal: AbortSignal): SignalFact {
  let fact = signals.get(signal);
  if (!fact) {
    if (signalFacts.length >= limit * 4) throw new Error("signal-limit");
    fact = {
      id: signalFacts.length + 1,
      abortedAt: signal.aborted ? ++sequence : null,
      users: 0,
    };
    signals.set(signal, fact);
    signalFacts.push(fact);
  }
  if (fact.users === 0) {
    const target = fact;
    const abort = () => {
      target.abortedAt ??= ++sequence;
    };
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    fact.dispose = () => signal.removeEventListener("abort", abort);
  }
  fact.users++;
  return fact;
}

function releaseSignal(fact: SignalFact): void {
  fact.users--;
  if (fact.users === 0) {
    fact.dispose?.();
    fact.dispose = undefined;
  }
}

function observeSignal(
  event: Extract<AiCompletionObservation, { phase: "signal" }>,
): void {
  if (links.has(event.httpSignal)) {
    fault("duplicate-signal-link");
    return;
  }
  if (++linkCount > limit) {
    fault("signal-link-limit");
    return;
  }
  links.set(event.httpSignal, {
    http: retainSignal(event.httpSignal),
    fetch: retainSignal(event.fetchSignal),
    used: false,
  });
}

function ownerFact(owner: Owner): OwnerFact {
  let fact = owners.get(owner);
  if (!fact) {
    if (ownerCount >= limit) throw new Error("owner-limit");
    fact = { id: ++ownerCount, operationAt: null, requests: [] };
    owners.set(owner, fact);
  }
  return fact;
}

function observeRequest(
  event: Extract<AiCompletionObservation, { phase: "request" }>,
): void {
  if (responses.has(event.response) || requests.length >= limit) {
    fault("duplicate-response-or-request-limit");
    return;
  }
  const owner = ownerFact(event.owner);
  if (owner.operationAt !== null) fault("request-after-operation");
  const link = links.get(event.httpSignal) ?? null;
  if (link?.used) fault("reused-signal-link");
  if (link) link.used = true;
  const header = event.response.headers.get("x-opensesame-ai-exchange");
  const exchange =
    header && /^[A-Za-z0-9:_-]{1,128}$/.test(header) ? header : null;
  const fact: RequestFact = {
    id: requests.length + 1,
    owner: owner.id,
    exchange,
    requestAt: ++sequence,
    bodyAt: null,
    operationAt: null,
    bytes: null,
    format: null,
    httpSignal: link?.http.id ?? 0,
    fetchSignal: link?.fetch.id ?? null,
    transportLive: !event.transportSignal.aborted,
    signalsLiveThroughOperation: null,
    link,
  };
  responses.set(event.response, fact);
  requests.push(fact);
  owner.requests.push(fact);
}

function observeBody(
  event: Extract<AiCompletionObservation, { phase: "body" }>,
): void {
  const fact = responses.get(event.response);
  const owner = owners.get(event.owner);
  if (!fact || fact.owner !== owner?.id || fact.bodyAt !== null) {
    fault("unbound-or-duplicate-body");
    return;
  }
  if (
    owner.operationAt !== null ||
    !Number.isSafeInteger(event.bytes) ||
    event.bytes < 0 ||
    event.bytes > 4 * 1024 * 1024
  ) {
    fault("invalid-body-fact");
    return;
  }
  fact.bodyAt = ++sequence;
  fact.bytes = event.bytes;
  fact.format = event.format;
}

function observeOperation(owner: Owner): void {
  const fact = ownerFact(owner);
  if (fact.operationAt !== null) {
    fault("duplicate-operation");
    return;
  }
  fact.operationAt = ++sequence;
  for (const request of fact.requests) {
    request.operationAt = fact.operationAt;
    const link = request.link;
    request.signalsLiveThroughOperation = link
      ? link.http.abortedAt === null && link.fetch.abortedAt === null
      : false;
    if (link) {
      releaseSignal(link.http);
      releaseSignal(link.fetch);
      request.link = null;
    }
  }
}

/** Facts only: never call an owner, read a body or change request behavior. */
function observe(event: AiCompletionObservation): void {
  try {
    switch (event.phase) {
      case "signal":
        observeSignal(event);
        break;
      case "request":
        observeRequest(event);
        break;
      case "body":
        observeBody(event);
        break;
      case "operation":
        observeOperation(event.owner);
        break;
      default:
        fault("unknown-phase");
    }
  } catch {
    fault("collector-fault");
  }
}

function snapshot() {
  return {
    version: 1,
    epoch,
    sequence,
    faults: [...faults],
    links: linkCount,
    requests: requests.map(({ link: _link, ...fact }) => ({ ...fact })),
    signals: signalFacts.map(({ id, abortedAt }) => ({ id, abortedAt })),
  };
}

if (aiCompletionSeams.observe) fault("observer-already-installed");
aiCompletionSeams.observe = observe;
try {
  Object.defineProperty(globalThis, "__opensesameAiCompletion", {
    value: Object.freeze({ snapshot }),
    configurable: false,
    writable: false,
  });
} catch {
  fault("snapshot-api-unavailable");
}
addEventListener("pagehide", () => {
  for (const signal of signalFacts) {
    signal.dispose?.();
    signal.dispose = undefined;
  }
});
