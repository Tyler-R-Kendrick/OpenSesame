/** Positive operation evidence is separate from immutable raw native outcomes. */
import { z } from "zod";

const id = z.number().int().positive();
const stamp = id.nullable();
const exchange = z.string().regex(/^[A-Za-z0-9:_-]{1,128}$/);
const requestSchema = z.strictObject({
  id,
  owner: id,
  exchange: exchange.nullable(),
  requestAt: id,
  bodyAt: stamp,
  operationAt: stamp,
  bytes: z.number().int().nonnegative().max(4194304).nullable(),
  format: z.enum(["json", "sse"]).nullable(),
  httpSignal: z.number().int().nonnegative(),
  fetchSignal: stamp,
  transportLive: z.boolean(),
  signalsLiveThroughOperation: z.boolean().nullable(),
});
const bodySchema = z.strictObject({
  response: id,
  owner: id,
  exchange: exchange.nullable(),
  at: id,
  bytes: z.number().int().nonnegative().max(4194304),
  format: z.enum(["json", "sse"]),
});
const snapshotSchema = z.strictObject({
  version: z.literal(2),
  epoch: z.string().uuid(),
  sequence: z.number().int().nonnegative(),
  faults: z.array(z.string().max(80)).max(16),
  links: z.number().int().nonnegative().max(512),
  requests: z.array(requestSchema).max(512),
  signals: z.array(z.object({ id, abortedAt: stamp }).strict()).max(2048),
  bodies: z.array(bodySchema).max(512),
  operations: z.array(z.object({ owner: id, at: id }).strict()).max(512),
  signalLinks: z
    .array(z.object({ httpSignal: id, fetchSignal: id, at: id }).strict())
    .max(512),
});
const producerSchema = z.strictObject({
  exchange,
  bytes: z.number().int().nonnegative(),
  writes: z.number().int().nonnegative(),
  endAt: stamp,
  endReturned: z.boolean(),
  finishAt: stamp,
  writableFinished: z.boolean(),
  closeAt: stamp,
  prematureClose: z.boolean(),
  errored: z.boolean(),
  callFailed: z.boolean(),
});
class EvidenceError extends Error {
  constructor(code) {
    super("AI completion evidence failed");
    this.code = code;
  }
}
function requireFact(condition, code) {
  if (!condition) throw new EvidenceError(code);
}
function unique(rows, key) {
  requireFact(
    new Set(rows.map((row) => row[key])).size === rows.length,
    "duplicate-phase-identity",
  );
}
function signalLive(snapshot, signal, at) {
  const fact = snapshot.signals.find((row) => row.id === signal);
  return fact && (fact.abortedAt === null || fact.abortedAt > at);
}
function phaseChain(request, snapshot) {
  const body = snapshot.bodies.find((row) => row.response === request.id);
  const operation = snapshot.operations.find(
    (row) => row.owner === request.owner,
  );
  const link = snapshot.signalLinks.find(
    (row) =>
      row.httpSignal === request.httpSignal &&
      row.fetchSignal === request.fetchSignal,
  );
  if (!body || !operation || !link) return false;
  return (
    operation.at === request.operationAt &&
    link.at < request.requestAt &&
    request.requestAt < body.at &&
    body.at < operation.at &&
    request.bytes > 0 &&
    request.transportLive &&
    request.signalsLiveThroughOperation === true &&
    signalLive(snapshot, link.httpSignal, operation.at) &&
    signalLive(snapshot, link.fetchSignal, operation.at)
  );
}
function validateSnapshot(snapshot) {
  requireFact(!snapshot.faults.length, "collector-faults");
  unique(snapshot.requests, "id");
  unique(snapshot.signals, "id");
  unique(snapshot.bodies, "response");
  unique(snapshot.operations, "owner");
  unique(snapshot.signalLinks, "httpSignal");
  unique(snapshot.signalLinks, "fetchSignal");
  requireFact(
    snapshot.links === snapshot.signalLinks.length,
    "missing-signal-link-seal",
  );
  const times = [
    ...snapshot.requests.map((row) => row.requestAt),
    ...snapshot.bodies.map((row) => row.at),
    ...snapshot.operations.map((row) => row.at),
    ...snapshot.signalLinks.map((row) => row.at),
    ...snapshot.signals.map((row) => row.abortedAt).filter((at) => at !== null),
  ];
  requireFact(
    times.every((at) => at <= snapshot.sequence) &&
      new Set(times).size === times.length,
    "invalid-phase-sequence",
  );
  for (const body of snapshot.bodies) {
    const request = snapshot.requests.find((row) => row.id === body.response);
    requireFact(
      request &&
        body.owner === request.owner &&
        body.exchange === request.exchange &&
        body.at === request.bodyAt &&
        body.bytes === request.bytes &&
        body.format === request.format,
      "cross-request-body-seal",
    );
  }
  for (const operation of snapshot.operations)
    requireFact(
      snapshot.requests.some(
        (row) =>
          row.owner === operation.owner && row.operationAt === operation.at,
      ),
      "cross-owner-operation-seal",
    );
  for (const link of snapshot.signalLinks)
    requireFact(
      snapshot.signals.some((row) => row.id === link.httpSignal) &&
        snapshot.signals.some((row) => row.id === link.fetchSignal),
      "missing-linked-signal",
    );
}
function stableRows(previous, next, key, progressive = []) {
  for (const row of previous) {
    const current = next.find((item) => item[key] === row[key]);
    requireFact(
      current &&
        Object.keys(row).every(
          (field) =>
            (progressive.includes(field) && row[field] === null) ||
            row[field] === current[field],
        ),
      "phase-identity-changed-or-evicted",
    );
  }
}
function monotonic(previous, next) {
  requireFact(
    previous.epoch === next.epoch && previous.sequence <= next.sequence,
    "changed-or-stale-document",
  );
  stableRows(previous.requests, next.requests, "id", [
    "bodyAt",
    "operationAt",
    "bytes",
    "format",
    "signalsLiveThroughOperation",
  ]);
  stableRows(previous.bodies, next.bodies, "response");
  stableRows(previous.operations, next.operations, "owner");
  stableRows(previous.signalLinks, next.signalLinks, "httpSignal");
  stableRows(previous.signals, next.signals, "id", ["abortedAt"]);
  for (const row of previous.signals) {
    const current = next.signals.find((item) => item.id === row.id);
    if (current.abortedAt !== null && row.abortedAt === null)
      requireFact(
        current.abortedAt > previous.sequence,
        "backdated-signal-withdrawal",
      );
  }
}
function documentsFrom(captures) {
  const documents = new Map();
  const epochs = new Map();
  for (const capture of captures) {
    z.string()
      .regex(/^document-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i)
      .parse(capture.document);
    const snapshot = snapshotSchema.parse(capture.snapshot);
    requireFact(
      capture.document === `document-${snapshot.epoch}`,
      "capture-document-epoch-mismatch",
    );
    validateSnapshot(snapshot);
    requireFact(
      !epochs.has(snapshot.epoch) ||
        epochs.get(snapshot.epoch) === capture.document,
      "epoch-reused-across-documents",
    );
    epochs.set(snapshot.epoch, capture.document);
    const previous = documents.get(capture.document);
    if (previous) monotonic(previous, snapshot);
    documents.set(capture.document, snapshot);
  }
  return documents;
}
function clientBindings(documents) {
  const witnesses = new Map();
  for (const [document, snapshot] of documents) {
    for (const request of snapshot.requests) {
      if (!request.exchange) continue;
      requireFact(
        !witnesses.has(request.exchange),
        "duplicate-client-exchange",
      );
      witnesses.set(request.exchange, { document, snapshot, request });
    }
  }
  return witnesses;
}
function producerComplete(producer, request) {
  return (
    producer.endAt &&
    producer.endReturned &&
    producer.finishAt > producer.endAt &&
    producer.writableFinished &&
    producer.closeAt > producer.finishAt &&
    !producer.prematureClose &&
    !producer.errored &&
    !producer.callFailed &&
    producer.bytes === request.bytes
  );
}
function heldValid(row, client, native) {
  const proof = native.cancellations.find(
    (item) => item.id === row.hold && item.request === row.id,
  );
  if (!proof?.proven || row.disposition !== "proven-cancellation") return false;
  if (!client) return true;
  return (
    client.request.operationAt === null &&
    client.request.bodyAt === null &&
    !client.snapshot.operations.some(
      (operation) => operation.owner === client.request.owner,
    )
  );
}
function joinRow(row, native, fixtureOrigin, clients, producers) {
  requireFact(
    row.terminal === "finished" || row.terminal === "failed",
    "unfinished-native-request",
  );
  const client = clients.get(row.correlation);
  if (row.hold) {
    requireFact(
      heldValid(row, client, native),
      "unproven-or-completed-cancellation",
    );
    return null;
  }
  if (row.origin !== fixtureOrigin || row.method !== "POST") {
    requireFact(
      row.terminal === "finished" && !row.correlation,
      "strict-non-operation-native-failure",
    );
    return null;
  }
  const producer = producers.get(row.correlation);
  requireFact(
    client &&
      producer &&
      client.document === row.document &&
      row.status === 200,
    "unbound-positive-operation",
  );
  requireFact(
    phaseChain(client.request, client.snapshot) &&
      producerComplete(producer, client.request),
    "missing-positive-phase-or-producer",
  );
  return {
    native: row.id,
    document: row.document,
    epoch: client.snapshot.epoch,
    exchange: row.correlation,
    response: client.request.id,
    owner: client.request.owner,
    bytes: client.request.bytes,
    format: client.request.format,
    rawTerminal: row.terminal,
  };
}
/** Serialized unit rows do not establish PW identity; actual attachment is authoritative. */
export function joinAiCompletions({
  native,
  producers,
  captures,
  fixtureOrigin,
}) {
  try {
    const clients = clientBindings(documentsFrom(captures));
    const producerMap = new Map();
    for (const value of producers) {
      const producer = producerSchema.parse(value);
      requireFact(
        !producerMap.has(producer.exchange),
        "duplicate-producer-exchange",
      );
      producerMap.set(producer.exchange, producer);
    }
    // Separate row-derived native outcomes from structural errors; retain the original list untouched.
    const rowOutcomes = new Set(
      native.requests
        .filter((row) => !row.hold && row.terminal === "failed")
        .map((row) => `ordinary-native-failure:${row.id}`),
    );
    requireFact(
      native.failures.every((failure) => rowOutcomes.has(failure)),
      "structural-native-failure",
    );
    unique(native.requests, "id");
    const seen = new Set();
    const receipts = [];
    for (const row of native.requests) {
      if (row.correlation) {
        requireFact(!seen.has(row.correlation), "duplicate-native-exchange");
        seen.add(row.correlation);
      }
      const receipt = joinRow(row, native, fixtureOrigin, clients, producerMap);
      if (receipt) receipts.push(receipt);
    }
    requireFact(receipts.length > 0, "missing-positive-operations");
    for (const value of [...clients.keys(), ...producerMap.keys()])
      requireFact(seen.has(value), "orphan-client-or-producer-exchange");
    return {
      version: "ai-positive-operation-v2",
      passed: true,
      failures: [],
      receipts,
    };
  } catch (error) {
    const known = z.instanceof(EvidenceError).safeParse(error);
    return {
      version: "ai-positive-operation-v2",
      passed: false,
      failures: [known.success ? known.data.code : "invalid-completion-facts"],
      receipts: [],
    };
  }
}
export function createAiCompletionHarvest() {
  const captures = [];
  const failures = [];
  return {
    async harvest(page, currentDocument) {
      try {
        requireFact(captures.length < 64, "capture-limit");
        const document = await currentDocument();
        const snapshot = await page.evaluate(
          () =>
            Object.getOwnPropertyDescriptor(
              globalThis,
              "__opensesameAiCompletion",
            )?.value.snapshot() ?? null,
        );
        requireFact(
          document && document === (await currentDocument()),
          "changed-document",
        );
        captures.push({ document, snapshot: snapshotSchema.parse(snapshot) });
      } catch {
        failures.push("completion-harvest-failed");
      }
    },
    snapshot: () => ({ captures, failures }),
    evaluate(native, producers, fixtureOrigin) {
      const result = joinAiCompletions({
        native,
        producers,
        captures,
        fixtureOrigin,
      });
      result.failures.push(...failures);
      result.passed = result.failures.length === 0;
      return result;
    },
  };
}
