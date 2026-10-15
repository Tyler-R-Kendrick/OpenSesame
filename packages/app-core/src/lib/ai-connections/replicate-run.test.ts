import { afterEach, expect, it, vi } from "vitest";
import { aiHttpFixture } from "./protocol.test-support.js";
import { runReplicatePrediction } from "./replicate-run.js";
import {
  type ReplicateConnection,
  ReplicatePredictionInterrupted,
} from "./replicate-types.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
  vi.restoreAllMocks();
});
const connection = (baseUrl: string): ReplicateConnection => ({
  baseUrl,
  model: "owner/model",
  authentication: "api-key",
  apiKey: "replicate-private-token",
});

it("waits for real terminal output after starting and processing states", async () => {
  let polls = 0;
  const fixture = await aiHttpFixture((request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        id: "run-1",
        status:
          request.method === "POST"
            ? "starting"
            : ++polls === 1
              ? "processing"
              : "succeeded",
        output:
          polls === 2
            ? {
                text: "Actual prediction",
                images: ["https://files.example/result.png"],
              }
            : undefined,
      }),
    );
  });
  cleanups.push(fixture.close);
  const states: string[] = [];
  const result = await runReplicatePrediction(
    connection(fixture.baseUrl),
    { prompt: "Hello" },
    fixture.transport,
    fixture.transport.assertCurrent,
    {
      pollIntervalMs: 10,
      onPrediction: (prediction) => states.push(prediction.status),
    },
  );
  expect(states).toEqual(["starting", "processing", "succeeded"]);
  expect(result.output).toEqual({
    text: "Actual prediction",
    images: ["https://files.example/result.png"],
  });
  expect(fixture.requests.map((r) => r.method)).toEqual(["POST", "GET", "GET"]);
});

it.each([
  {
    status: "failed",
    output: undefined,
    error: "The Replicate prediction failed.",
  },
  {
    status: "canceled",
    output: undefined,
    error: "The Replicate prediction was canceled.",
  },
  {
    status: "succeeded",
    output: undefined,
    error: "The prediction completed without output.",
  },
  {
    status: "succeeded",
    output: null,
    error: "The prediction completed without output.",
  },
])("does not treat $status metadata as model inference", async (terminal) => {
  const fixture = await aiHttpFixture((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        id: "run-2",
        ...terminal,
        error: "replicate-private-token",
      }),
    );
  });
  cleanups.push(fixture.close);
  await expect(
    runReplicatePrediction(
      connection(fixture.baseUrl),
      {},
      fixture.transport,
      fixture.transport.assertCurrent,
    ),
  ).rejects.toThrow(terminal.error);
  expect(fixture.requests).toHaveLength(1);
});

it.each([false, true])(
  "user cancellation reaches the real cancel API; rejection=%s is reported honestly",
  async (rejectCancellation) => {
    const user = new AbortController();
    const fixture = await aiHttpFixture((request, response) => {
      const cancel = request.path.endsWith("/cancel");
      response.writeHead(cancel && rejectCancellation ? 503 : 200, {
        "content-type": "application/json",
      });
      response.end(
        JSON.stringify({
          id: "run-3",
          status: cancel ? "canceled" : "starting",
        }),
      );
    });
    cleanups.push(fixture.close);
    const run = runReplicatePrediction(
      connection(fixture.baseUrl),
      {},
      fixture.transport,
      fixture.transport.assertCurrent,
      {
        signal: user.signal,
        onPrediction: () => user.abort(),
      },
    );
    await expect(run).rejects.toMatchObject({
      name: "ReplicatePredictionInterrupted",
      cancellationRequested: !rejectCancellation,
    });
    expect(fixture.requests.map((r) => r.path)).toEqual([
      "/custom/v1/models/owner/model/predictions",
      "/custom/v1/predictions/run-3/cancel",
    ]);
  },
);

it("vault lock aborts polling and sends no further authenticated cancellation", async () => {
  const fixture = await aiHttpFixture((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ id: "run-4", status: "starting" }));
  });
  cleanups.push(fixture.close);
  await expect(
    runReplicatePrediction(
      connection(fixture.baseUrl),
      {},
      fixture.transport,
      fixture.transport.assertCurrent,
      {
        onPrediction: () => fixture.lifetime.abort(),
      },
    ),
  ).rejects.toThrow();
  expect(fixture.requests).toHaveLength(1);
});

it("revoked custody rejects late create output without polling or cancellation", async () => {
  let current = true;
  const fixture = await aiHttpFixture((_request, response) => {
    current = false;
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        id: "run-5",
        status: "succeeded",
        output: "Must not surface",
      }),
    );
  });
  cleanups.push(fixture.close);
  const check = () => {
    if (!current) throw new Error("Credential custody changed");
  };
  await expect(
    runReplicatePrediction(
      connection(fixture.baseUrl),
      {},
      fixture.transport,
      check,
    ),
  ).rejects.toThrow("Credential custody changed");
  expect(fixture.requests).toHaveLength(1);
});

it("rechecks custody after a progress callback before returning successful output", async () => {
  let current = true;
  const fixture = await aiHttpFixture((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        id: "run-callback",
        status: "succeeded",
        output: "Must not surface",
      }),
    );
  });
  cleanups.push(fixture.close);
  const check = () => {
    if (!current) throw new Error("Credential custody changed in callback");
  };
  await expect(
    runReplicatePrediction(
      connection(fixture.baseUrl),
      {},
      fixture.transport,
      check,
      {
        onPrediction: () => {
          current = false;
        },
      },
    ),
  ).rejects.toThrow("Credential custody changed in callback");
  expect(fixture.requests).toHaveLength(1);
});

it("aborts an in-flight poll and cancels using the still-current credential lifetime", async () => {
  const user = new AbortController();
  const fixture = await aiHttpFixture((request, response) => {
    if (request.method === "GET") {
      user.abort();
      return;
    }
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        id: "run-6",
        status: request.path.endsWith("/cancel") ? "canceled" : "starting",
      }),
    );
  });
  cleanups.push(fixture.close);
  await expect(
    runReplicatePrediction(
      connection(fixture.baseUrl),
      {},
      fixture.transport,
      fixture.transport.assertCurrent,
      {
        signal: user.signal,
        pollIntervalMs: 10,
      },
    ),
  ).rejects.toBeInstanceOf(ReplicatePredictionInterrupted);
  expect(fixture.requests.map((r) => r.method)).toEqual([
    "POST",
    "GET",
    "POST",
  ]);
  expect(fixture.requests.at(-1)?.path).toBe(
    "/custom/v1/predictions/run-6/cancel",
  );
});

it("bounds unfinished predictions and requests cancellation on the deadline", async () => {
  const deadline = new AbortController();
  const nativeTimeout = AbortSignal.timeout.bind(AbortSignal);
  const timeout = vi
    .spyOn(AbortSignal, "timeout")
    .mockImplementation((ms) =>
      ms === 100 ? deadline.signal : nativeTimeout(ms),
    );
  const fixture = await aiHttpFixture((request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        id: "run-7",
        status: request.path.endsWith("/cancel") ? "canceled" : "processing",
      }),
    );
  });
  cleanups.push(fixture.close);
  await expect(
    runReplicatePrediction(
      connection(fixture.baseUrl),
      {},
      fixture.transport,
      fixture.transport.assertCurrent,
      {
        pollIntervalMs: 10,
        timeoutMs: 100,
        onPrediction: () => deadline.abort(),
      },
    ),
  ).rejects.toMatchObject({ cancellationRequested: true });
  expect(fixture.requests.at(-1)?.path).toBe(
    "/custom/v1/predictions/run-7/cancel",
  );
  expect(timeout).toHaveBeenCalledWith(100);
  expect(fixture.requests).toHaveLength(2);
});
