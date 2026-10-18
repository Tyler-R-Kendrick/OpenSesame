/** @vitest-environment jsdom */
import assert from "node:assert/strict";
import { aiConnectionDraft } from "@opensesame/app-core/lib/ai-connections/presets.js";
import {
  performSavedAiInference,
  saveAiConnection,
} from "@opensesame/app-core/lib/ai-connections/runtime.js";
import { approvedPlan } from "@opensesame/app-core/lib/capabilities/__tests__/plan-fixtures.js";
import { describeCapability } from "@opensesame/app-core/lib/capabilities/catalog.js";
import { createEgressPort } from "@opensesame/app-core/lib/capabilities/egress.js";
import { runtimeFixture } from "@opensesame/app-core/lib/secret-backends/runtime.test-support.js";
import { afterAll, beforeAll, test, vi } from "vitest";
import { createActivation } from "../../src/modules/activation.ts";
import { bindAiConnectionRuntime } from "../../src/modules/connectors.external/ai-connection-runtime.ts";
import { createTestContext } from "../../src/modules/test-context.ts";
import { aiCompletionSnapshot } from "../../src/verification/ai-completion-verifier.ts";
import {
  AI_FIXTURE_KEY,
  AI_FIXTURE_MODEL,
  createAiConnectionHttpFixture,
} from "./ai-connection-http-fixture.mjs";
import { joinAiCompletions } from "./ai-positive-completion.mjs";
import { AI_EXCHANGE_HEADER } from "./ai-request-lifecycle.mjs";

let vault;
let fixture;
let activation;
let seed;
const nativeRows = [];
const endpoint = "https://owned-matcher.example/custom/v1";
beforeAll(async () => {
  vault = await runtimeFixture();
  fixture = await createAiConnectionHttpFixture({ port: 0 });
  const descriptor = describeCapability("connectors.external");
  assert(descriptor);
  const plan = approvedPlan(["connectors.external"]);
  const admitted = {
    ...plan,
    network: {
      ...plan.network,
      externalServices: "allow",
      allowedServiceOrigins: [new URL(endpoint).origin],
    },
  };
  const egress = createEgressPort({
    capability: descriptor,
    plan: () => admitted,
    allowedOrigins: [window.location.origin],
    async fetchImpl(input, init) {
      const url = new URL(String(input));
      assert.equal(url.origin, new URL(endpoint).origin);
      const local = new URL(fixture.baseUrl);
      url.protocol = local.protocol;
      url.host = local.host;
      const response = await fetch(url, init);
      nativeRows.push({
        id: `serialized-unit-${nativeRows.length + 1}`,
        document: `document-${aiCompletionSnapshot().epoch}`,
        origin: fixture.origin,
        method: init.method,
        status: response.status,
        correlation: response.headers.get(AI_EXCHANGE_HEADER),
        terminal: "finished",
        disposition: "finished",
        hold: null,
      });
      return response;
    },
  });
  const ctx = { ...createTestContext().ctx, egress };
  activation = createActivation(ctx, "connectors.external");
  bindAiConnectionRuntime(ctx, activation);
  const draft = {
    ...aiConnectionDraft("byo-ai"),
    baseUrl: endpoint,
    model: AI_FIXTURE_MODEL,
    apiKey: AI_FIXTURE_KEY,
  };
  const first = await saveAiConnection(draft);
  const chunks = [];
  const answer = await performSavedAiInference(
    first.connectionId,
    {
      model: AI_FIXTURE_MODEL,
      messages: [{ role: "user", content: "Actual matcher capture" }],
    },
    undefined,
    (text) => chunks.push(text),
  );
  assert(answer.answer.includes("Fixture"));
  assert(chunks.length > 0);
  await saveAiConnection({ ...draft, name: "Independent actual Save" });
  await vi.waitFor(() =>
    assert(fixture.producers.every((row) => row.closeAt !== null)),
  );
  seed = {
    fixtureOrigin: fixture.origin,
    native: { requests: nativeRows, failures: [], cancellations: [] },
    producers: structuredClone(fixture.producers),
    captures: [
      {
        document: `document-${aiCompletionSnapshot().epoch}`,
        snapshot: aiCompletionSnapshot(),
      },
    ],
  };
  assert.equal(seed.captures[0].snapshot.requests.length, 3);
  assert.deepEqual(seed.captures[0].snapshot.faults, []);
});
afterAll(async () => {
  activation?.dispose();
  await fixture?.close();
  await vault?.close();
});
function input() {
  return structuredClone(seed);
}
function witness(value) {
  return value.captures[0].snapshot.requests[0];
}

test("matches genuine public Save/inference client and producer facts; serialized rows do not establish PW identity", () => {
  const value = input();
  value.captures.push(structuredClone(value.captures[0]));
  const result = joinAiCompletions(value);
  assert.equal(result.passed, true, result.failures.join(","));
  assert.equal(result.receipts.length, 3);
  assert.deepEqual(
    result.receipts.map((row) => row.format),
    ["json", "sse", "json"],
  );
});
test("applies identical positive predicate to raw finished and raw failed without rewriting either outcome", () => {
  const value = input();
  value.native.requests[0].terminal = "failed";
  value.native.requests[0].disposition = "failed";
  value.native.failures.push(
    `ordinary-native-failure:${value.native.requests[0].id}`,
  );
  const before = structuredClone(value.native);
  const result = joinAiCompletions(value);
  assert.equal(result.passed, true, result.failures.join(","));
  assert.equal(result.receipts[0].rawTerminal, "failed");
  assert.deepEqual(value.native, before);
});
test.each([
  [
    "missing body",
    (value) => {
      witness(value).bodyAt = null;
    },
  ],
  [
    "missing operation",
    (value) => {
      witness(value).operationAt = null;
    },
  ],
  [
    "missing exact signal",
    (value) => {
      witness(value).fetchSignal = null;
    },
  ],
  [
    "withdrawn signal",
    (value) => {
      witness(value).signalsLiveThroughOperation = false;
    },
  ],
  [
    "cross-request signal",
    (value) => {
      witness(value).httpSignal =
        value.captures[0].snapshot.requests[1].httpSignal;
    },
  ],
  [
    "cross-owner operation",
    (value) => {
      witness(value).owner = value.captures[0].snapshot.requests[1].owner;
    },
  ],
  [
    "cross-document",
    (value) => {
      value.native.requests[0].document = `document-${crypto.randomUUID()}`;
    },
  ],
  [
    "duplicate client exchange",
    (value) => {
      witness(value).exchange = value.captures[0].snapshot.requests[1].exchange;
    },
  ],
  [
    "foreign exchange",
    (value) => {
      witness(value).exchange = "foreign-exchange";
    },
  ],
  [
    "duplicate producer",
    (value) => {
      value.producers.push(structuredClone(value.producers[0]));
    },
  ],
  [
    "wrong byte count",
    (value) => {
      value.producers[0].bytes++;
    },
  ],
  [
    "producer unfinished",
    (value) => {
      value.producers[0].finishAt = null;
    },
  ],
  [
    "producer premature close",
    (value) => {
      value.producers[0].prematureClose = true;
    },
  ],
  [
    "producer call failure",
    (value) => {
      value.producers[0].callFailed = true;
    },
  ],
  [
    "native unended",
    (value) => {
      value.native.requests[0].terminal = null;
    },
  ],
  [
    "collector fault",
    (value) => {
      value.captures[0].snapshot.faults.push("test-fault");
    },
  ],
])(
  "rejects %s even when original serialized native terminal was finished",
  (_name, mutate) => {
    const value = input();
    mutate(value);
    assert.equal(joinAiCompletions(value).passed, false);
  },
);
test("rejects stale epoch, removed proof and borrowed epoch across actual captured documents", () => {
  const changedEpoch = input();
  const second = structuredClone(changedEpoch.captures[0]);
  second.snapshot.epoch = crypto.randomUUID();
  changedEpoch.captures.push(second);
  assert.equal(joinAiCompletions(changedEpoch).passed, false);
  const evicted = input();
  const lost = structuredClone(evicted.captures[0]);
  lost.snapshot.requests.shift();
  evicted.captures.push(lost);
  assert.equal(joinAiCompletions(evicted).passed, false);
  const borrowed = input();
  borrowed.captures.push({
    ...structuredClone(borrowed.captures[0]),
    document: `document-${crypto.randomUUID()}`,
  });
  assert.equal(joinAiCompletions(borrowed).passed, false);
});
test("preserves structural/static native errors and forbids an operation seal on a held cancellation", () => {
  const structural = input();
  structural.native.failures.push("native-terminal-checkpoint-timeout");
  assert.equal(joinAiCompletions(structural).passed, false);
  const foreign = input();
  foreign.native.requests[0].origin = "https://foreign.example";
  foreign.native.requests[0].terminal = "failed";
  assert.equal(joinAiCompletions(foreign).passed, false);
  const held = input();
  held.native.requests[0].hold = "existing-hold";
  held.native.requests[0].disposition = "proven-cancellation";
  assert.equal(joinAiCompletions(held).passed, false);
});

test.each(["owner", "exchange"])(
  "rejects paired request %s swaps against independent phase seals",
  (field) => {
    const value = input();
    const rows = value.captures[0].snapshot.requests;
    const original = rows[0][field];
    rows[0][field] = rows[2][field];
    rows[2][field] = original;
    assert.equal(rows[0].bytes, rows[2].bytes);
    const result = joinAiCompletions(value);
    assert.equal(result.passed, false);
    assert.deepEqual(result.failures, ["cross-request-body-seal"]);
  },
);
test("rejects independent phase rewrites, missing seals and out-of-bounds actual sequence", () => {
  for (const phase of ["bodies", "operations", "signalLinks"]) {
    const value = input();
    value.captures[0].snapshot[phase].shift();
    assert.equal(joinAiCompletions(value).passed, false);
  }
  const future = input();
  future.captures[0].snapshot.bodies[0].at =
    future.captures[0].snapshot.sequence + 1;
  assert.equal(joinAiCompletions(future).passed, false);
  const changed = input();
  const later = structuredClone(changed.captures[0]);
  later.snapshot.signalLinks[0].fetchSignal =
    later.snapshot.signalLinks[1].fetchSignal;
  changed.captures.push(later);
  assert.equal(joinAiCompletions(changed).passed, false);
});

test.each(["finished", "failed"])(
  "requires independent body seal for raw %s with the same predicate",
  (terminal) => {
    const value = input();
    const row = value.native.requests[0];
    row.terminal = terminal;
    if (terminal === "failed")
      value.native.failures.push(`ordinary-native-failure:${row.id}`);
    value.captures[0].snapshot.bodies.shift();
    const result = joinAiCompletions(value);
    assert.equal(result.passed, false);
    assert.deepEqual(result.failures, ["missing-positive-phase-or-producer"]);
  },
);
