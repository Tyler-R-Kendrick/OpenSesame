import type { ServerResponse } from "node:http";
import { fakeSupportPageContext } from "@opensesame/support-agent";
import { afterEach, beforeEach, expect, it } from "vitest";
import { aiConnectionDraft } from "./ai-connections/presets.js";
import {
  type CapturedAiRequest,
  aiHttpFixture,
} from "./ai-connections/protocol.test-support.js";
import { saveAiConnection } from "./ai-connections/runtime.js";
import {
  readAiConnection,
  savedAiConnections,
} from "./ai-connections/store.js";
import { bindAiConnectionTransport } from "./ai-connections/transport.js";
import type { AiConnectionDraft } from "./ai-connections/types.js";
import {
  DEVICE_CONNECTOR_KEYS,
  readDeviceRows,
  readDeviceSecrets,
} from "./device-connector-records.js";
import { bindHostedModelAuthority } from "./hosted-model-authority.js";
import { kvFlush, kvForgetAll, kvGet, kvHydrate } from "./kv.js";
import {
  type AiModelChoice,
  MODEL_PROVIDER_KEY,
  NO_MODEL_PROVIDER,
  loadModelProvider,
  saveModelProvider,
  withInference,
} from "./model-provider.js";
import { choiceFromSlug, inferenceSlugOptions } from "./model-slugs.js";
import { createSavedModelSupportAgent } from "./saved-model-agent.js";
import {
  deferred,
  runtimeFixture,
  runtimePassword,
} from "./secret-backends/runtime.test-support.js";
import { initializeVaultCredentialCustody } from "./vault-credential-custody.js";
import { vaultStore } from "./vault/store.js";
import { vfsFlush } from "./vfs.js";

const request = {
  question: "Where is lock? Email person@example.com, token=private-token",
  history: [{ role: "user" as const, text: "private history" }],
  context: fakeSupportPageContext(),
};
type Target = {
  key: string;
  bearer: boolean;
  responses: boolean;
  answer: string;
};
let vault: Awaited<ReturnType<typeof runtimeFixture>>;
let http: Awaited<ReturnType<typeof aiHttpFixture>>;
let hold:
  | {
      started: ReturnType<typeof deferred<void>>;
      closed: ReturnType<typeof deferred<void>>;
      response?: ServerResponse;
    }
  | undefined;
const targets = new Map<string, Target>();
const releases: (() => void)[] = [];
function connections() {
  return savedAiConnections().map(({ draft, view }) => ({
    connectionId: view.connectionId,
    providerId: view.providerId,
    status: view.status,
    method: view.configuration.method,
    model: draft.model,
    endpoint: draft.baseUrl,
    name: draft.name,
  }));
}
function reply(captured: CapturedAiRequest, response: ServerResponse) {
  const target = targets.get(captured.path);
  const body = JSON.parse(captured.body);
  const valid =
    target &&
    captured.method === "POST" &&
    body.model === "shared-deployment" &&
    body.stream === false &&
    captured.headers["api-key"] === (target.bearer ? undefined : target.key) &&
    captured.headers.authorization ===
      (target.bearer ? `Bearer ${target.key}` : undefined) &&
    Array.isArray(target.responses ? body.input : body.messages);
  if (!valid) {
    response.writeHead(400).end();
    return;
  }
  if (hold) {
    const pending = hold;
    pending.response = response;
    response.on("close", () => {
      if (!response.writableEnded) pending.closed.resolve();
    });
    pending.started.resolve();
    return;
  }
  response.setHeader("content-type", "application/json");
  response.end(
    JSON.stringify(
      target.responses
        ? {
            status: "completed",
            output: [
              {
                type: "message",
                content: [{ type: "output_text", text: target.answer }],
              },
            ],
          }
        : { choices: [{ message: { content: target.answer } }] },
    ),
  );
}
beforeEach(async () => {
  targets.clear();
  hold = undefined;
  vault = await runtimeFixture();
  http = await aiHttpFixture(reply);
  releases.push(bindAiConnectionTransport(http.transport));
  releases.push(
    bindHostedModelAuthority({
      fetch,
      assertCurrent: http.transport.assertCurrent,
      connections,
      read: (id) =>
        connections().find((row) => row.connectionId === id) ?? null,
      execute: async () => {
        throw new Error("Saved Azure must use its AI runtime.");
      },
    }),
  );
});
afterEach(async () => {
  hold?.response?.end();
  for (const release of releases.splice(0).reverse()) release();
  await http.close();
  await vault.close();
});
function draft(
  providerId: string,
  mount: string,
  responses = false,
  dated = false,
): AiConnectionDraft {
  const value: AiConnectionDraft = {
    ...aiConnectionDraft(providerId),
    name: `Azure ${mount}`,
    baseUrl: `${http.baseUrl}/${mount}`,
    model: "shared-deployment",
    apiKey: `fixture-${mount}-credential`,
    family: responses ? "openai_responses" : "openai_chat",
    azure: dated
      ? {
          api: "dated-chat",
          apiVersion: "2024-06-01",
          credential: "entra-token",
        }
      : { api: "v1", credential: responses ? "entra-token" : "api-key" },
  };
  const path = dated
    ? `/custom/v1/${mount}/openai/deployments/shared-deployment/chat/completions?api-version=2024-06-01`
    : `/custom/v1/${mount}/openai/v1/${responses ? "responses" : "chat/completions"}`;
  targets.set(path, {
    key: value.apiKey,
    bearer: dated || responses,
    responses,
    answer: `Answer from ${mount}`,
  });
  return value;
}
function choice(id: string) {
  const options = inferenceSlugOptions({
    browserReady: false,
    connectedProviderIds: [],
  });
  const result = choiceFromSlug(`connection:${id}`, options);
  if (!result) throw new Error("Saved Features choice missing.");
  return result;
}
async function select(value: AiModelChoice) {
  await saveModelProvider(withInference(NO_MODEL_PROVIDER, value));
}
async function restore() {
  await vaultStore.flushPendingWrites();
  await vfsFlush();
  await kvFlush();
  vaultStore.lock();
  await vfsFlush();
  await kvFlush();
  kvForgetAll();
  expect(readDeviceRows()).toHaveLength(0);
  expect(loadModelProvider()).toEqual(NO_MODEL_PROVIDER);
  await kvHydrate([MODEL_PROVIDER_KEY, ...DEVICE_CONNECTOR_KEYS]);
  await vaultStore.unlock(runtimePassword);
  await initializeVaultCredentialCustody();
}
function supportTransport() {
  return { fetch, assertCurrent: http.transport.assertCurrent };
}
function agent() {
  const result = createSavedModelSupportAgent(supportTransport());
  if (!result) throw new Error("Selected saved Support agent missing.");
  return result;
}
function checkPayload(captured: CapturedAiRequest) {
  const body = JSON.parse(captured.body);
  const messages = body.messages ?? body.input;
  expect(messages).toHaveLength(2);
  expect(messages[0].role).toBe("system");
  expect(messages[1].role).toBe("user");
  const payload = JSON.parse(messages[1].content);
  expect(payload).toEqual({
    version: 2,
    question: "Where is lock? Email [redacted address], [redacted credential]",
    pageId: request.context.pageId,
    route: request.context.route,
    featureIds: request.context.goals.map((goal) => goal.id),
  });
  for (const secret of [
    "person@example.com",
    "private-token",
    "private history",
    ...[...targets.values()].map((target) => target.key),
  ])
    expect(captured.body).not.toContain(secret);
  expect(body.stream).toBe(false);
  expect(body.max_completion_tokens ?? body.max_output_tokens).toBe(1024);
}
const cases = [
  { provider: "azure-openai", responses: false, dated: false },
  { provider: "azure-openai", responses: true, dated: false },
  { provider: "byo-ai", responses: false, dated: true },
  { provider: "byo-ai", responses: true, dated: false },
];
it.each(cases)(
  "restores exact $provider Responses=$responses dated=$dated Features selection and asks its actual agent",
  async ({ provider, responses, dated }) => {
    const first = await saveAiConnection(
      draft(provider, "first", responses, dated),
    );
    const second = await saveAiConnection(
      draft(provider, "second", responses, dated),
    );
    expect(connections()).toHaveLength(2);
    for (const [saved, mount] of [
      [first, "first"],
      [second, "second"],
    ] as const) {
      const selected = choice(saved.connectionId);
      await select(selected);
      await restore();
      expect(loadModelProvider().inference).toEqual(selected);
      const before = http.requests.length;
      const current = agent();
      expect(await current.availability()).toEqual({ kind: "ready" });
      expect(http.requests).toHaveLength(before);
      const turn = await current.run(request, { signal: http.lifetime.signal });
      expect(turn.answer).toBe(`Answer from ${mount}`);
      expect(http.requests).toHaveLength(before + 1);
      const sent = http.requests[before];
      if (!sent) throw new Error("Actual selected HTTP request missing.");
      expect(sent.path).toContain(`/custom/v1/${mount}/openai/`);
      checkPayload(sent);
      current.destroy();
    }
    const publicData = JSON.stringify([
      readDeviceRows(),
      readDeviceSecrets(),
      kvGet(MODEL_PROVIDER_KEY),
    ]);
    for (const target of targets.values()) {
      expect(publicData).not.toContain(target.key);
      expect([...vault.files.values()].join()).not.toContain(target.key);
    }
  },
);
it("refuses missing, mismatched and ambiguous actual choices, and changed-target blank-key Save before dispatch", async () => {
  const value = draft("azure-openai", "same");
  const first = await saveAiConnection(value);
  await saveAiConnection({ ...value, name: "Duplicate eligible native Azure" });
  const chosen = choice(first.connectionId);
  const before = http.requests.length;
  const { connectionId: _id, ...withoutId } = chosen;
  const invalid = [
    withoutId,
    { ...chosen, connectionId: "missing-connection" },
    { ...chosen, provider: "byo-ai" },
    { ...chosen, model: "different-deployment" },
    { ...chosen, endpoint: `${chosen.endpoint}/decoy` },
  ];
  for (const selection of invalid) {
    await select(selection);
    expect(createSavedModelSupportAgent(supportTransport())).toBeNull();
  }
  await select(chosen);
  const current = agent();
  await select(withoutId);
  expect(await current.availability()).toEqual({
    kind: "unavailable",
    reason: "no_remote_endpoint",
  });
  await expect(
    current.run(request, { signal: http.lifetime.signal }),
  ).rejects.toMatchObject({ code: "AGENT_UNAVAILABLE" });
  const saved = readAiConnection(first.connectionId);
  if (!saved) throw new Error("Saved public Azure missing.");
  await expect(
    saveAiConnection(
      { ...saved, baseUrl: `${saved.baseUrl}/decoy` },
      first.connectionId,
    ),
  ).rejects.toThrow(/new API key/);
  expect(readAiConnection(first.connectionId)).toEqual(saved);
  expect(http.requests).toHaveLength(before);
  current.destroy();
});
it.each(["destroy", "abort"])(
  "%s closes a held actual selected JSON response and prevents a late answer",
  async (operation) => {
    const saved = await saveAiConnection(draft("byo-ai", "held", true));
    await select(choice(saved.connectionId));
    await restore();
    const current = agent();
    const signal = new AbortController();
    hold = { started: deferred<void>(), closed: deferred<void>() };
    const before = http.requests.length;
    const running = current.run(request, { signal: signal.signal });
    const rejected = expect(running).rejects.toMatchObject({
      code: "AGENT_ABORTED",
    });
    await hold.started.promise;
    expect(http.requests).toHaveLength(before + 1);
    if (operation === "destroy") current.destroy();
    else signal.abort();
    await rejected;
    await hold.closed.promise;
    expect(hold.response?.writableEnded).toBe(false);
    hold.response?.end('{"late":"answer"}');
    current.destroy();
    await expect(
      current.run(request, { signal: http.lifetime.signal }),
    ).rejects.toMatchObject({ code: "AGENT_ABORTED" });
    expect(http.requests).toHaveLength(before + 1);
  },
);
