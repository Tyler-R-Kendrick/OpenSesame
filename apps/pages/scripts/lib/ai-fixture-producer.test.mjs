import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test, vi } from "vitest";
import { z } from "zod";
import {
  AI_FIXTURE_KEY,
  AI_FIXTURE_MODEL,
  AZURE_FIXTURE_KEY,
  createAiConnectionHttpFixture,
} from "./ai-connection-http-fixture.mjs";
import { createAiFixtureProducer } from "./ai-fixture-producer.mjs";
import { AI_EXCHANGE_HEADER } from "./ai-request-lifecycle.mjs";

const origin = "https://owned-pwa.example";
const question = [{ role: "user", content: "Fixture question" }];
const cases = [
  {
    name: "Chat",
    path: "/custom/v1/chat/completions",
    headers: { authorization: `Bearer ${AI_FIXTURE_KEY}` },
    body: { model: AI_FIXTURE_MODEL, messages: question, max_tokens: 20 },
  },
  {
    name: "Responses",
    path: "/custom/v1/responses",
    headers: { authorization: `Bearer ${AI_FIXTURE_KEY}` },
    body: { model: AI_FIXTURE_MODEL, input: question, max_output_tokens: 20 },
  },
  {
    name: "Anthropic",
    path: "/custom/v1/messages",
    headers: {
      "x-api-key": AI_FIXTURE_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: { model: AI_FIXTURE_MODEL, messages: question, max_tokens: 20 },
  },
  {
    name: "Gemini",
    path: `/custom/v1/models/${AI_FIXTURE_MODEL}:generateContent`,
    headers: { "x-goog-api-key": AI_FIXTURE_KEY },
    body: {
      contents: [{ parts: [{ text: "Fixture question" }] }],
      generationConfig: { maxOutputTokens: 20 },
    },
  },
];
const azure = {
  path: "/azure/native-chat/openai/v1/chat/completions",
  headers: { "api-key": AZURE_FIXTURE_KEY },
  body: { model: "native-chat-deployment", messages: question, max_tokens: 20 },
};
function request(fixture, target, options = {}) {
  return fetch(`${fixture.origin}${target.path}`, {
    method: "POST",
    headers: {
      origin,
      "content-type": "application/json",
      ...target.headers,
    },
    body: JSON.stringify({ ...target.body, stream: options.stream ?? false }),
    signal: options.signal,
  });
}
function producerFor(fixture, response) {
  const exchange = response.headers.get(AI_EXCHANGE_HEADER);
  assert(exchange);
  const facts = fixture.producers.filter((fact) => fact.exchange === exchange);
  assert.equal(facts.length, 1);
  return facts[0];
}
async function finished(fact, bytes) {
  await vi.waitFor(() => assert.notEqual(fact.closeAt, null));
  assert.equal(fact.bytes, bytes);
  assert.equal(fact.endReturned, true);
  assert.equal(fact.writableFinished, true);
  assert(fact.finishAt > fact.endAt);
  assert(fact.closeAt > fact.finishAt);
  assert.equal(fact.prematureClose, false);
  assert.equal(fact.errored, false);
  assert.equal(fact.callFailed, false);
}

test.each(cases)(
  "records actual $name JSON bytes and exposes only the opaque exchange header",
  async (target) => {
    const fixture = await createAiConnectionHttpFixture({
      port: 0,
      appOrigin: origin,
    });
    try {
      const preflight = await fetch(`${fixture.origin}${target.path}`, {
        method: "OPTIONS",
        headers: {
          origin,
          "access-control-request-method": "POST",
          "access-control-request-headers": "content-type,authorization",
        },
      });
      assert.equal(preflight.status, 204);
      assert.equal(
        preflight.headers.get("access-control-allow-origin"),
        origin,
      );
      assert.equal(
        preflight.headers.get("access-control-expose-headers"),
        AI_EXCHANGE_HEADER,
      );
      const response = await request(fixture, target);
      assert.equal(response.status, 200);
      assert.equal(
        response.headers.get("access-control-expose-headers"),
        AI_EXCHANGE_HEADER,
      );
      const fact = producerFor(fixture, response);
      const body = await response.arrayBuffer();
      assert(JSON.parse(new TextDecoder().decode(body)));
      await finished(fact, body.byteLength);
      assert.equal(fixture.requests.length, 1);
      assert.equal(fixture.requests[0].authenticated, true);
      assert.equal(fact.exchange, fixture.requests[0].correlation);
      assert.deepEqual(fixture.errors, []);
      const serialized = JSON.stringify(fact);
      assert(!serialized.includes(AI_FIXTURE_KEY));
      assert(!serialized.includes("Fixture question"));
      assert(!serialized.includes("answer"));
    } finally {
      await fixture.close();
    }
  },
);

test("forwards actual write/end returns and counts Unicode wire bytes without retaining chunks", async () => {
  let producer;
  const prefix = "Grüße ";
  const suffix = "λ 👋";
  const server = createServer((_request, response) => {
    producer = createAiFixtureProducer(response, "unicode-exchange");
    response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    assert([true, false].includes(producer.write(prefix)));
    assert.equal(producer.end(suffix), response);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = z
      .object({ port: z.number().int().positive() })
      .parse(server.address());
    const response = await fetch(`http://127.0.0.1:${address.port}`);
    const bytes = await response.arrayBuffer();
    assert.equal(new TextDecoder().decode(bytes), prefix + suffix);
    assert(bytes.byteLength > (prefix + suffix).length);
    await finished(producer.fact, bytes.byteLength);
    assert.equal(producer.fact.writes, 1);
    assert(!JSON.stringify(producer.fact).includes(prefix));
    assert.equal(producer.destroyed, true);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("actual held SSE progress is not end/finish and client abort records premature socket close", async () => {
  const fixture = await createAiConnectionHttpFixture({ port: 0 });
  const lifetime = new AbortController();
  const hold = fixture.holdNext(azure.path, true);
  let reader;
  try {
    const response = await request(fixture, azure, {
      stream: true,
      signal: lifetime.signal,
    });
    assert.equal(response.status, 200);
    const fact = producerFor(fixture, response);
    reader = response.body.getReader();
    const first = await reader.read();
    assert.equal(first.done, false);
    assert(first.value.byteLength > 0);
    assert.equal(fact.bytes, first.value.byteLength);
    assert.equal(fact.endAt, null);
    assert.equal(fact.endReturned, false);
    assert.equal(fact.finishAt, null);
    lifetime.abort();
    await assert.rejects(reader.read());
    await vi.waitFor(() => assert.equal(hold.closed, true));
    assert.equal(fact.prematureClose, true);
    assert.equal(fact.finishAt, null);
    assert.equal(fact.writableFinished, false);
    assert.equal(fact.endReturned, false);
  } finally {
    lifetime.abort();
    reader?.releaseLock();
    await fixture.close();
  }
});

test("concurrent normal B cannot complete held A; actual A release completes only its own exchange", async () => {
  const fixture = await createAiConnectionHttpFixture({ port: 0 });
  const hold = fixture.holdNext(azure.path, true);
  const lifetime = new AbortController();
  let reader;
  try {
    const responseA = await request(fixture, azure, {
      stream: true,
      signal: lifetime.signal,
    });
    const factA = producerFor(fixture, responseA);
    reader = responseA.body.getReader();
    const first = await reader.read();
    assert(first.value.byteLength > 0);
    const responseB = await request(fixture, cases[1]);
    const factB = producerFor(fixture, responseB);
    const bytesB = await responseB.arrayBuffer();
    await finished(factB, bytesB.byteLength);
    assert.notEqual(factA.exchange, factB.exchange);
    assert.equal(factA.finishAt, null);
    assert.equal(factA.endReturned, false);
    assert.equal(factA.bytes, first.value.byteLength);
    hold.release();
    let bytesA = first.value.byteLength;
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      bytesA += next.value.byteLength;
    }
    await finished(factA, bytesA);
    assert.equal(factB.bytes, bytesB.byteLength);
    assert.equal(fixture.producers.length, 2);
    assert.deepEqual(fixture.errors, []);
  } finally {
    lifetime.abort();
    reader?.releaseLock();
    await fixture.close();
  }
});
