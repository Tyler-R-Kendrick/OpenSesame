import { afterEach, expect, it } from "vitest";
import { aiHttpFixture } from "./protocol.test-support.js";
import type { ReplicateConnection } from "./replicate-types.js";
import {
  cancelReplicatePrediction,
  createReplicatePrediction,
  getReplicatePrediction,
} from "./replicate.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

const version = "a".repeat(64);
const connection = (
  baseUrl: string,
  model = "owner/model",
): ReplicateConnection => ({
  baseUrl,
  model,
  authentication: "api-key",
  apiKey: "replicate-private-token",
});

it.each([
  {
    model: "owner/model",
    path: "/custom/v1/models/owner/model/predictions",
    version: undefined,
  },
  { model: `owner/model:${version}`, path: "/custom/v1/predictions", version },
  { model: version, path: "/custom/v1/predictions", version },
])(
  "creates actual $model predictions with the documented target/body",
  async (target) => {
    const fixture = await aiHttpFixture((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          id: "prediction-1",
          status: "succeeded",
          output: ["https://files.example/output.png"],
        }),
      );
    });
    cleanups.push(fixture.close);
    const input = { prompt: "Draw a tree", width: 512, options: { seed: 12 } };
    const result = await createReplicatePrediction(
      connection(fixture.baseUrl, target.model),
      input,
      fixture.transport,
      fixture.transport.assertCurrent,
    );
    expect(result.output).toEqual(["https://files.example/output.png"]);
    const request = fixture.requests[0];
    expect(request?.path).toBe(target.path);
    expect(request?.method).toBe("POST");
    expect(request?.headers.authorization).toBe(
      "Bearer replicate-private-token",
    );
    const body = JSON.parse(request?.body ?? "null");
    if (target.version)
      expect(body).toEqual({ input, version: target.version });
    else expect(body).toEqual({ input });
    expect(request?.headers.cookie).toBeUndefined();
  },
);

it("gets and cancels by the retained ID, ignoring server-supplied callback URLs", async () => {
  const fixture = await aiHttpFixture((request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        id: "prediction-2",
        status: request.method === "POST" ? "canceled" : "processing",
        urls: {
          get: "https://untrusted.example/steal",
          cancel: "https://untrusted.example/cancel",
        },
      }),
    );
  });
  cleanups.push(fixture.close);
  const config = connection(fixture.baseUrl);
  await getReplicatePrediction(
    config,
    "prediction-2",
    fixture.transport,
    fixture.transport.assertCurrent,
  );
  await cancelReplicatePrediction(
    config,
    "prediction-2",
    fixture.transport,
    fixture.transport.assertCurrent,
  );
  expect(
    fixture.requests.map(({ method, path }) => ({ method, path })),
  ).toEqual([
    { method: "GET", path: "/custom/v1/predictions/prediction-2" },
    { method: "POST", path: "/custom/v1/predictions/prediction-2/cancel" },
  ]);
  expect(
    fixture.requests.every(
      (r) => r.headers.authorization === "Bearer replicate-private-token",
    ),
  ).toBe(true);
  expect(fixture.requests[1]?.body).toBe("");
});

it.each([
  "owner/model:latest",
  "owner/../escape",
  "https://untrusted.example/model",
  "owner/model?token=secret",
])("refuses invalid model target %s before HTTP", async (model) => {
  const fixture = await aiHttpFixture((_request, response) => response.end());
  cleanups.push(fixture.close);
  expect(() =>
    createReplicatePrediction(
      connection(fixture.baseUrl, model),
      {},
      fixture.transport,
      fixture.transport.assertCurrent,
    ),
  ).toThrow(/owner\/model/);
  expect(fixture.requests).toEqual([]);
});

it("rejects traversal IDs and oversized input before sending credentials", async () => {
  const fixture = await aiHttpFixture((_request, response) => response.end());
  cleanups.push(fixture.close);
  const config = connection(fixture.baseUrl);
  expect(() =>
    getReplicatePrediction(
      config,
      "../another-job",
      fixture.transport,
      fixture.transport.assertCurrent,
    ),
  ).toThrow("Invalid prediction ID");
  expect(() =>
    createReplicatePrediction(
      config,
      { prompt: "x".repeat(32769) },
      fixture.transport,
      fixture.transport.assertCurrent,
    ),
  ).toThrow(/32 KiB/);
  expect(fixture.requests).toEqual([]);
});

it.each([401, 403, 429, 500])(
  "does not expose credential-bearing HTTP %s response bodies",
  async (status) => {
    const fixture = await aiHttpFixture((_request, response) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify({ detail: "replicate-private-token" }));
    });
    cleanups.push(fixture.close);
    await expect(
      createReplicatePrediction(
        connection(fixture.baseUrl),
        {},
        fixture.transport,
        fixture.transport.assertCurrent,
      ),
    ).rejects.toThrow(
      status === 401 || status === 403
        ? /refused the credential/
        : /request failed/,
    );
    expect(fixture.requests).toHaveLength(1);
  },
);

it.each([
  { id: "different-id", status: "succeeded", output: "ok" },
  { id: "prediction-3", status: "successful", output: "ok" },
  {
    id: "prediction-3",
    status: "succeeded",
    output: "replicate-private-token",
  },
])(
  "rejects mismatched IDs, unknown states and credential material",
  async (body) => {
    const fixture = await aiHttpFixture((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(body));
    });
    cleanups.push(fixture.close);
    await expect(
      getReplicatePrediction(
        connection(fixture.baseUrl),
        "prediction-3",
        fixture.transport,
        fixture.transport.assertCurrent,
      ),
    ).rejects.toThrow(/invalid prediction|credential material/);
  },
);

it("bounds response bytes and rejects redirect-based credential forwarding", async () => {
  const fixture = await aiHttpFixture((request, response) => {
    if (request.method === "POST") {
      response.writeHead(302, { location: "/custom/v1/forwarded" });
      response.end();
    } else {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          id: "prediction-4",
          status: "succeeded",
          output: "x".repeat(513 * 1024),
        }),
      );
    }
  });
  cleanups.push(fixture.close);
  const config = connection(fixture.baseUrl);
  await expect(
    createReplicatePrediction(
      config,
      {},
      fixture.transport,
      fixture.transport.assertCurrent,
    ),
  ).rejects.toThrow(/Could not reach/);
  await expect(
    getReplicatePrediction(
      config,
      "prediction-4",
      fixture.transport,
      fixture.transport.assertCurrent,
    ),
  ).rejects.toThrow(/exceeds/);
  expect(fixture.requests.map((r) => r.path)).not.toContain(
    "/custom/v1/forwarded",
  );
});
