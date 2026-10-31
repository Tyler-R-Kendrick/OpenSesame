/** @vitest-environment jsdom */
import type { ServerResponse } from "node:http";
import { aiConnectionDraft } from "@opensesame/app-core/lib/ai-connections/presets.js";
import {
  type CapturedAiRequest,
  aiHttpFixture,
} from "@opensesame/app-core/lib/ai-connections/protocol.test-support.js";
import {
  performSavedAiInference,
  saveAiConnection,
  testAiConnection,
} from "@opensesame/app-core/lib/ai-connections/runtime.js";
import { approvedPlan } from "@opensesame/app-core/lib/capabilities/__tests__/plan-fixtures.js";
import { describeCapability } from "@opensesame/app-core/lib/capabilities/catalog.js";
import { createEgressPort } from "@opensesame/app-core/lib/capabilities/egress.js";
import {
  EMAIL,
  gcpKeyFile,
  gcpPublicKey,
  installGcpKey,
} from "@opensesame/app-core/lib/native-gcp.test-support.js";
import {
  deferred,
  runtimeFixture,
} from "@opensesame/app-core/lib/secret-backends/runtime.test-support.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { afterEach, beforeEach, expect, it } from "vitest";
import { classify } from "../../lib/capabilities/classification.js";
import { createActivation } from "../activation.js";
import { createTestContext } from "../test-context.js";
import { bindAiConnectionRuntime } from "./ai-connection-runtime.js";

installGcpKey();
const tokenOrigin = "https://oauth2.googleapis.com";
const resourceOrigin = "https://us-central1-aiplatform.googleapis.com";
const accessToken = "ya29.actual-token-retirement-fixture-0123456789";
const model = "gemini-2.5-flash";
const resourcePath = `/v1/projects/my-project-123/locations/us-central1/publishers/google/models/${model}:generateContent`;
let vault: Awaited<ReturnType<typeof runtimeFixture>>;
let http: Awaited<ReturnType<typeof aiHttpFixture>>;
let activation: ReturnType<typeof createActivation>;
let held: ServerResponse | undefined;
let mode: "valid" | "held-token" | "oversized-token" | "malformed-token";
let tokenHeaders: ReturnType<typeof deferred<void>>;
let closed: ReturnType<typeof deferred<void>>;
const captures: { url: string; response: Response; signal: AbortSignal }[] = [];
const faults: unknown[] = [];

async function tokenAssertion(body: string) {
  const form = new URLSearchParams(body);
  expect(form.get("grant_type")).toBe(
    "urn:ietf:params:oauth:grant-type:jwt-bearer",
  );
  const [header, claims, signature] = (form.get("assertion") ?? "").split(".");
  if (!header || !claims || !signature)
    throw new Error("Actual signed JWT missing");
  const decode = (value: string) =>
    new Uint8Array(Buffer.from(value, "base64url"));
  expect(JSON.parse(new TextDecoder().decode(decode(header))).alg).toBe(
    "RS256",
  );
  const value = JSON.parse(new TextDecoder().decode(decode(claims)));
  expect(value).toMatchObject({
    iss: EMAIL,
    aud: `${tokenOrigin}/token`,
    scope: "https://www.googleapis.com/auth/cloud-platform",
  });
  expect(value.exp - value.iat).toBe(3600);
  expect(Math.abs(Date.now() / 1000 - value.iat)).toBeLessThan(5);
  expect(
    await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      gcpPublicKey(),
      decode(signature),
      new TextEncoder().encode(`${header}.${claims}`),
    ),
  ).toBe(true);
}
async function respond(request: CapturedAiRequest, response: ServerResponse) {
  response.setHeader("content-type", "application/json");
  if (request.path === "/token") {
    await tokenAssertion(request.body);
    if (mode === "held-token" || mode === "oversized-token") {
      held = response;
      response.on("close", () => {
        if (!response.writableEnded) closed.resolve();
      });
      response.write(
        mode === "oversized-token"
          ? `{"access_token":"${"x".repeat(16 * 1024)}`
          : '{"access_token":"',
      );
    } else
      response.end(
        mode === "malformed-token"
          ? "{"
          : JSON.stringify({ access_token: accessToken }),
      );
    return;
  }
  expect(request.path).toBe(resourcePath);
  expect(request.headers.authorization).toBe(`Bearer ${accessToken}`);
  expect(["Reply with OK.", "Actual Vertex question"]).toContain(
    JSON.parse(request.body).contents[0].parts[0].text,
  );
  response.end(
    JSON.stringify({
      candidates: [{ content: { parts: [{ text: "Actual Vertex answer" }] } }],
    }),
  );
}

beforeEach(async () => {
  vault = await runtimeFixture();
  mode = "valid";
  held = undefined;
  tokenHeaders = deferred<void>();
  closed = deferred<void>();
  captures.length = 0;
  faults.length = 0;
  http = await aiHttpFixture((request, response) => {
    void respond(request, response).catch((error) => {
      faults.push(error);
      response.destroy();
    });
  });
  const descriptor = describeCapability("connectors.external");
  if (!descriptor) throw new Error("External connector capability missing");
  const plan = approvedPlan(["connectors.external"]);
  const admitted = {
    ...plan,
    network: {
      ...plan.network,
      externalServices: "allow" as const,
      allowedServiceOrigins: [tokenOrigin, resourceOrigin],
    },
  };
  const egress = createEgressPort({
    capability: descriptor,
    plan: () => admitted,
    allowedOrigins: [window.location.origin],
    async fetchImpl(input, init) {
      if (!init?.signal)
        throw new Error("Original physical Fetch signal missing");
      const url = new URL(String(input));
      expect([tokenOrigin, resourceOrigin]).toContain(url.origin);
      const logical = url.href;
      const local = new URL(http.baseUrl);
      url.protocol = local.protocol;
      url.host = local.host;
      const response = await fetch(url, init);
      captures.push({ url: logical, response, signal: init.signal });
      if (logical === `${tokenOrigin}/token`) tokenHeaders.resolve();
      return response;
    },
  });
  const pages = createTestContext();
  const ctx = { ...pages.ctx, egress };
  activation = createActivation(ctx, "connectors.external");
  bindAiConnectionRuntime(ctx, activation);
});
afterEach(async () => {
  held?.destroy();
  activation.dispose();
  await http.close();
  await vault.close();
  expect(faults).toEqual([]);
});
function draft() {
  return {
    ...aiConnectionDraft("google-vertex"),
    model,
    apiKey: gcpKeyFile(),
    vertex: {
      project: "my-project-123",
      location: "us-central1",
      credential: "service-account" as const,
    },
  };
}
function tokenResponse() {
  const response = [...captures]
    .reverse()
    .find((entry) => entry.url === `${tokenOrigin}/token`);
  if (!response) throw new Error("Actual token response missing");
  return response;
}

it("saves and invokes actual Vertex inference while completed token and resource responses stay retired", async () => {
  const saved = await saveAiConnection(draft());
  const result = await performSavedAiInference(saved.connectionId, {
    model,
    messages: [{ role: "user", content: "Actual Vertex question" }],
  });
  expect(result.answer).toBe("Actual Vertex answer");
  expect(http.requests.map((request) => request.path)).toEqual([
    "/token",
    resourcePath,
    "/token",
    resourcePath,
  ]);
  expect(captures).toHaveLength(4);
  activation.dispose();
  expect(captures.every((entry) => !entry.signal.aborted)).toBe(true);
  expect(
    captures.every(
      (entry) => entry.response.bodyUsed && !entry.response.body?.locked,
    ),
  ).toBe(true);
  expect(JSON.stringify(vaultStore.getSnapshot().items)).not.toContain(
    accessToken,
  );
});

it("closes a real held token body on caller withdrawal without inference or custody", async () => {
  mode = "held-token";
  const caller = new AbortController();
  const job = testAiConnection(draft(), undefined, undefined, {
    signal: caller.signal,
  });
  const rejected = expect(job).rejects.toThrow();
  await tokenHeaders.promise;
  caller.abort();
  await rejected;
  await closed.promise;
  expect(held?.writableEnded).toBe(false);
  expect(tokenResponse().signal.aborted).toBe(true);
  expect(http.requests).toHaveLength(1);
  expect(vaultStore.getSnapshot().items).toHaveLength(0);
});

it("cancels a real oversized token body at the unchanged16KiB cap", async () => {
  mode = "oversized-token";
  await expect(testAiConnection(draft())).rejects.toThrow();
  await closed.promise;
  expect(held?.writableEnded).toBe(false);
  expect(http.requests).toHaveLength(1);
  expect(vaultStore.getSnapshot().items).toHaveLength(0);
});

it("does not infer success or leak an active physical link from malformed token JSON", async () => {
  mode = "malformed-token";
  await expect(testAiConnection(draft())).rejects.toThrow();
  activation.dispose();
  expect(tokenResponse().signal.aborted).toBe(false);
  expect(http.requests).toHaveLength(1);
  expect(vaultStore.getSnapshot().items).toHaveLength(0);
});

it("keeps neutral response ownership under the existing connector capability", () => {
  for (const name of [
    "native-response-lifetime",
    "native-response-body",
    "native-response-text",
  ])
    expect(classify(`src/lib/${name}.ts`)).toMatchObject({
      classification: "optional",
      capability: "connectors.external",
    });
});
